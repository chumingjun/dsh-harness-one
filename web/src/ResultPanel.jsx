import { useEffect, useMemo, useState } from 'react';
import { Archive, Check, ChevronRight, Clock3, History, LoaderCircle, RefreshCw } from 'lucide-react';
import { apiUrl } from './api.js';
import { adaptRunResults, getRunId } from './result-adapter.js';
import { deriveRunViewState, RESULT_TABS } from './run-view-state.js';
import ResultViewer, { ProcessArtifacts } from './ResultViewer.jsx';
import './result-panel.css';

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
              <button className="result-node-link" onClick={() => onFocusNode?.(event.nodeId)}>{event.nodeLabel || event.nodeId}</button>
              {event.meta && <time>{event.meta}</time>}
            </div>
            <p>{event.text}</p>
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
  const runId = getRunId(runDetail, status, results);
  const [activeTab, setActiveTab] = useState('result');
  const [remoteResults, setRemoteResults] = useState(undefined);
  const [selectedOutputId, setSelectedOutputId] = useState(null);
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
    setSelectedOutputId(null);
    setActiveTab('result');
    if (!runId || results !== undefined) return undefined;
    const controller = new AbortController();
    loadResults(controller.signal);
    return () => controller.abort();
  }, [runId, results]);

  const source = results !== undefined ? results : remoteResults;
  const model = useMemo(
    () => adaptRunResults(source || {}, { runDetail, events, status, triggerInput }),
    [source, runDetail, events, status, triggerInput],
  );
  const successfulOutputs = model.outputResults.filter((row) => row.status === 'success' && row.output);
  const selectedOutput = successfulOutputs.find((row) => row.nodeId === selectedOutputId) || successfulOutputs[0] || null;
  const selectedLinks = selectedOutput
    ? model.links.filter((link) => !link.nodeId || link.nodeId === selectedOutput.nodeId)
    : [];
  const selectedFiles = selectedOutput
    ? model.finalFiles.filter((file) => file.nodeId === selectedOutput.nodeId)
    : [];
  const viewState = deriveRunViewState(model, activeTab);

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
            aria-disabled={!viewState.canExport} tabIndex={viewState.canExport ? 0 : -1}
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
        {loadError && <div className="result-load-error"><span>{loadError}</span><button onClick={refresh}>重试</button></div>}
        {loading && !source && <div className="result-loading"><LoaderCircle className="result-spin" size={17} />正在整理运行成果</div>}
        {!loading && !model.runId && <p className="result-empty result-empty-run">运行工作流后，成果、过程和问题会显示在这里。</p>}

        {model.runId && activeTab === 'result' && (
          <>
            {model.summary && <p className="result-summary">{model.summary}</p>}
            {model.input && <details className="result-input-snapshot"><summary>本次输入</summary><pre>{model.input}</pre></details>}
            {successfulOutputs.length > 1 && (
              <div className="result-output-selector" role="tablist" aria-label="最终输出节点">
                {successfulOutputs.map((row) => (
                  <button key={row.nodeId} role="tab" aria-selected={selectedOutput?.nodeId === row.nodeId}
                    className={selectedOutput?.nodeId === row.nodeId ? 'result-output-on' : ''}
                    onClick={() => setSelectedOutputId(row.nodeId)}>{row.nodeLabel}</button>
                ))}
              </div>
            )}
            {model.finalStatus === 'partial' && <button className="result-partial" onClick={() => setActiveTab('issues')}>部分最终输出未生成，查看问题</button>}
            <ResultViewer
              coreText={selectedOutput?.output || ''}
              files={selectedFiles}
              links={selectedLinks}
              legacyInferred={Boolean(selectedOutput?.legacyInferred)}
              emptyText="本次运行没有成功生成输出节点成果。请查看过程和问题。"
            />
            <ProcessArtifacts results={model.processResults} files={model.processFiles} />
          </>
        )}
        {model.runId && activeTab === 'process' && <ProcessView events={model.nodeTimeline} runId={model.runId} onFocusNode={onFocusNode} onOpenNodeDetail={onOpenNodeDetail} />}
        {model.runId && activeTab === 'issues' && <IssuesView issues={model.issues} runId={model.runId} onFocusNode={onFocusNode} onOpenNodeDetail={onOpenNodeDetail} />}
      </div>
    </aside>
  );
}

export default ResultPanel;
