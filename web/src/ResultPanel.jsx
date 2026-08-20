import { useEffect, useMemo, useState } from 'react';
import { Archive, Check, ChevronRight, Clock3, History, LoaderCircle, RefreshCw } from 'lucide-react';
import { apiUrl } from './api.js';
import { adaptRunResults, getRunId } from './result-adapter.js';
import { deriveRunViewState, RESULT_TABS } from './run-view-state.js';
import ResultViewer from './ResultViewer.jsx';
import { useToast } from './ui.jsx';
import './result-panel.css';

const REVIEW_LABEL = {
  pending: '待验收', approved: '已通过', accepted: '已通过', rejected: '需修改', changes_requested: '需修改',
};

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function ProcessView({ events, runId, onFocusNode, onOpenNodeDetail }) {
  if (!events.length) return <p className="result-empty">暂无过程记录。</p>;
  return (
    <div className="result-timeline">
      {events.map((event) => (
        <div className={`result-event result-event-${event.status}`} key={event.id}>
          <span className="result-event-dot" aria-hidden="true" />
          <div className="result-event-body">
            <div className="result-event-head">
              {event.nodeId ? (
                <button className="result-node-link" onClick={() => onFocusNode?.(event.nodeId)}>{event.nodeLabel || event.nodeId}</button>
              ) : <strong>{event.kind === 'run' ? '运行' : event.kind}</strong>}
              {event.time && <time>{formatTime(event.time)}</time>}
            </div>
            {(event.text || event.meta) && <p>{event.text || event.meta}</p>}
            {event.nodeId && runId && event.status !== 'running' && (
              <button className="result-detail-link" onClick={() => onOpenNodeDetail?.(runId, event.nodeId)}>
                查看节点详情 <ChevronRight size={12} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function IssuesView({ issues, runId, onFocusNode, onOpenNodeDetail }) {
  if (!issues.length) return (
    <div className="result-ok-state"><Check size={18} /><span>未发现需要处理的问题。</span></div>
  );
  return (
    <div className="result-issues">
      {issues.map((issue) => (
        <div className={`result-issue result-issue-${issue.status}`} key={issue.id}>
          <div className="result-issue-title">
            <span>{issue.nodeLabel || issue.nodeId || '运行问题'}</span>
            {issue.nodeId && <button onClick={() => onFocusNode?.(issue.nodeId)}>定位节点</button>}
          </div>
          <p>{issue.message}</p>
          {issue.nodeId && runId && (
            <button className="result-detail-link" onClick={() => onOpenNodeDetail?.(runId, issue.nodeId)}>
              查看节点详情 <ChevronRight size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function ReviewBox({ model, disabled, onSubmit }) {
  const [comment, setComment] = useState(model.review.comment || '');
  const [submitting, setSubmitting] = useState('');
  useEffect(() => setComment(model.review.comment || ''), [model.runId, model.review.comment]);

  const submit = async (decision) => {
    setSubmitting(decision);
    try { await onSubmit(decision, comment); } catch { /* onSubmit 已向用户报告错误 */ } finally { setSubmitting(''); }
  };

  return (
    <section className="result-review">
      <div className="result-section-head">
        <Check size={15} />
        <h4>验收</h4>
        <span className={`result-review-state review-${model.review.status}`}>{REVIEW_LABEL[model.review.status] || model.review.status}</span>
      </div>
      {(model.review.reviewer || model.review.reviewedAt) && (
        <p className="result-review-meta">
          {model.review.reviewer || '已留痕'}{model.review.reviewedAt ? ` · ${formatTime(model.review.reviewedAt)}` : ''}
        </p>
      )}
      <textarea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="填写验收意见或修改要求" disabled={disabled || Boolean(submitting)} />
      <div className="result-review-actions">
        <button className="btn btn-sm" disabled={disabled || Boolean(submitting)} onClick={() => submit('rejected')}>
          {submitting === 'rejected' && <LoaderCircle className="result-spin" size={14} />} 需修改
        </button>
        <button className="btn btn-primary btn-sm" disabled={disabled || Boolean(submitting)} onClick={() => submit('accepted')}>
          {submitting === 'accepted' && <LoaderCircle className="result-spin" size={14} />} 通过验收
        </button>
      </div>
    </section>
  );
}

export function ResultPanel({
  runDetail,
  results,
  events = [],
  status,
  triggerInput = '',
  onTriggerChange,
  onOpenHistory,
  onFocusNode,
  onOpenNodeDetail,
  className = '',
}) {
  const toast = useToast();
  const runId = getRunId(runDetail, status, results);
  const [activeTab, setActiveTab] = useState('result');
  const [remoteResults, setRemoteResults] = useState(undefined);
  const [reviewOverride, setReviewOverride] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadResults = async (signal) => {
    if (!runId) return;
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetch(apiUrl(`/run-results?id=${encodeURIComponent(runId)}`), { signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `加载成果失败（HTTP ${response.status}）`);
      setRemoteResults(data);
    } catch (error) {
      if (error?.name !== 'AbortError') setLoadError(error?.message || String(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    setRemoteResults(undefined);
    setReviewOverride(null);
    setActiveTab('result');
    if (!runId || results !== undefined) return undefined;
    const controller = new AbortController();
    loadResults(controller.signal);
    return () => controller.abort();
  }, [runId, results]);

  const source = results !== undefined ? results : remoteResults;
  const model = useMemo(() => {
    const adapted = adaptRunResults(source || {}, { runDetail, events, status, triggerInput });
    return reviewOverride ? { ...adapted, review: reviewOverride } : adapted;
  }, [source, runDetail, events, status, triggerInput, reviewOverride]);
  const viewState = deriveRunViewState(model, activeTab);

  const submitReview = async (decision, comment) => {
    const response = await fetch(apiUrl('/runs/review'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: model.runId, status: decision, comment }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.error || '提交验收失败', 'error');
      throw new Error(data.error || '提交验收失败');
    }
    const nextReview = data.review || data.acceptance || { status: decision, comment };
    setReviewOverride(nextReview);
    setRemoteResults((current) => ({
      ...(current || source || {}),
      review: nextReview,
    }));
    toast(decision === 'accepted' ? '已通过验收' : '已记录修改要求', 'success');
  };

  const refresh = () => {
    if (!runId) return;
    const controller = new AbortController();
    loadResults(controller.signal);
  };

  return (
    <aside className={`panel result-panel ${className}`.trim()} aria-label="运行结果">
      <header className="result-panel-head">
        <div className="result-title-wrap">
          <span className={`result-status result-status-${viewState.status.tone}`}>{viewState.status.label}</span>
          <strong>{model.workflowName}</strong>
          {model.startedAt && <span className="result-run-time"><Clock3 size={12} />{formatTime(model.startedAt)}</span>}
        </div>
        <div className="result-head-actions">
          <button className="btn-icon" title="刷新成果" aria-label="刷新成果" onClick={refresh} disabled={!runId || loading}><RefreshCw size={15} className={loading ? 'result-spin' : ''} /></button>
          <button className="btn-icon" title="运行历史" aria-label="打开运行历史" onClick={onOpenHistory}><History size={15} /></button>
          <a className={`btn-icon ${viewState.canExport ? '' : 'result-action-disabled'}`} title="下载 ZIP" aria-label="下载全部成果 ZIP"
            href={viewState.canExport ? apiUrl(`/runs/export?id=${encodeURIComponent(model.runId)}`) : undefined} download>
            <Archive size={15} />
          </a>
        </div>
      </header>

      <div className="result-trigger">
        <label htmlFor="result-trigger-input">运行输入</label>
        <textarea id="result-trigger-input" rows={3} value={triggerInput} onChange={(event) => onTriggerChange?.(event.target.value)} placeholder="本次运行的补充输入" readOnly={!onTriggerChange} />
      </div>

      <div className="result-tabs" role="tablist" aria-label="结果视图">
        {RESULT_TABS.map((tab) => (
          <button type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'result-tab-on' : ''}
            onClick={() => setActiveTab(tab.id)} key={tab.id}>
            {tab.label}{viewState.counts[tab.id] > 0 && <span>{viewState.counts[tab.id]}</span>}
          </button>
        ))}
      </div>

      <div className="result-panel-body">
        {loadError && (
          <div className="result-load-error">
            <span>{loadError}</span>
            <button onClick={refresh}>重试</button>
          </div>
        )}
        {loading && !source && <div className="result-loading"><LoaderCircle className="result-spin" size={17} />正在整理运行成果</div>}
        {!loading && !model.runId && <p className="result-empty result-empty-run">运行工作流后，成果、过程和问题会显示在这里。</p>}

        {model.runId && activeTab === 'result' && (
          <>
            {model.summary && <p className="result-summary">{model.summary}</p>}
            {model.input && (
              <details className="result-input-snapshot">
                <summary>本次输入</summary>
                <pre>{model.input}</pre>
              </details>
            )}
            <ResultViewer coreText={model.coreText} files={model.files} links={model.links} />
            <ReviewBox model={model} disabled={!viewState.canReview} onSubmit={submitReview} />
          </>
        )}
        {model.runId && activeTab === 'process' && <ProcessView events={model.events} runId={model.runId} onFocusNode={onFocusNode} onOpenNodeDetail={onOpenNodeDetail} />}
        {model.runId && activeTab === 'issues' && <IssuesView issues={model.issues} runId={model.runId} onFocusNode={onFocusNode} onOpenNodeDetail={onOpenNodeDetail} />}
      </div>
    </aside>
  );
}

export default ResultPanel;
