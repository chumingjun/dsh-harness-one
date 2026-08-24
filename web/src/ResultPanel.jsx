import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Check, ChevronRight, Clock3, FolderDown, History, LoaderCircle, RefreshCw, Timer, X } from 'lucide-react';
import { apiUrl } from './api.js';
import {
  adaptRunResults,
  formatClock,
  formatDuration,
  getArtifactIds,
  getRunId,
  isRunResultsReady,
  loadRunResults,
  RUN_ARTIFACT_SAVE_PATH,
  saveRunArtifacts,
} from './result-adapter.js';
import { deriveRunViewState, RESULT_TABS } from './run-view-state.js';
import ResultViewer, { ProcessArtifacts } from './ResultViewer.jsx';
import './result-panel.css';

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

const STEP_STATUS_META = {
  success: { label: '已完成', tone: 'success' },
  running: { label: '执行中', tone: 'running' },
  waiting: { label: '等待审批', tone: 'waiting' },
  queued: { label: '排队中', tone: 'pending' },
  pending: { label: '排队中', tone: 'pending' },
  skipped: { label: '已跳过', tone: 'skipped' },
  canceled: { label: '已取消', tone: 'danger' },
  error: { label: '失败', tone: 'danger' },
};

function stepStatusMeta(status) {
  return STEP_STATUS_META[status] || { label: status || '未知', tone: 'pending' };
}

function ProcessView({ events, runId, onFocusNode, onOpenNodeDetail }) {
  if (!events.length) return <p className="result-empty">暂无过程记录。</p>;
  return (
    <ol className="result-steps">
      {events.map((event, index) => {
        const meta = stepStatusMeta(event.status);
        const canOpenDetail = Boolean(event.nodeId && runId && !['running', 'queued', 'pending'].includes(event.status));
        const openDetail = canOpenDetail ? () => onOpenNodeDetail?.(runId, event.nodeId) : undefined;
        const startClock = formatClock(event.startedAt);
        const duration = event.status === 'running' ? '' : formatDuration(event.durationMs);
        return (
          <li
            className={`result-step result-step-${meta.tone}${canOpenDetail ? ' result-step-clickable' : ''}`}
            key={event.id}
            onClick={openDetail}
            onKeyDown={openDetail ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); }
            } : undefined}
            tabIndex={openDetail ? 0 : undefined}
            role={openDetail ? 'button' : undefined}
          >
            <span className="result-step-num" aria-hidden="true">
              {event.status === 'running' ? <LoaderCircle size={13} className="result-spin" /> : index + 1}
            </span>
            <div className="result-step-card">
              <div className="result-step-head">
                <button className="result-node-link" onClick={(e) => { e.stopPropagation(); onFocusNode?.(event.nodeId); }}>
                  {event.nodeLabel || event.nodeId}
                </button>
                <span className={`result-step-pill result-step-pill-${meta.tone}`}>{meta.label}</span>
              </div>
              {(startClock || duration) && (
                <div className="result-step-meta">
                  {startClock && <span><Clock3 size={11} />开始 {startClock}</span>}
                  {duration && <span><Timer size={11} />耗时 {duration}</span>}
                </div>
              )}
              {event.error && <p className="result-step-text">{event.error}</p>}
              {event.status === 'running' && (event.turns != null || event.preview) && (
                <div className="result-step-live">
                  {event.turns != null && <span className="result-step-live-turns">第 {event.turns} 轮</span>}
                  {event.preview && <pre className="result-step-live-preview">{event.preview}</pre>}
                </div>
              )}
              {canOpenDetail && <span className="result-detail-link">查看节点详情 <ChevronRight size={12} /></span>}
            </div>
          </li>
        );
      })}
    </ol>
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
  onClose,
  onFocusNode,
  onOpenNodeDetail,
  sessionId = '',
  resultsReadyToken,
  canSaveToWorkspace = false,
  className = '',
}) {
  const runId = getRunId(runDetail, status, results);
  const [activeTab, setActiveTab] = useState('result');
  const [remoteResults, setRemoteResults] = useState(undefined);
  const [selectedOutputId, setSelectedOutputId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedNames, setSavedNames] = useState([]);
  const initialReadyTokenRef = useRef(resultsReadyToken);
  const readyTokenRunRef = useRef(runId);
  const observedStatus = status?.running
    ? 'running'
    : (status?.last || status?.status || runDetail?.status);
  const runEnded = isRunResultsReady({ runId, status: observedStatus }, true);

  const loadResults = async (signal, waitUntilReady = false) => {
    if (!runId) return;
    setLoading(true);
    setLoadError('');
    try {
      const data = await loadRunResults(
        apiUrl(`/run-results?id=${encodeURIComponent(runId)}`),
        { signal, waitUntilReady },
      );
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
    setSaveError('');
    setSavedNames([]);
  }, [runId, results]);

  useEffect(() => {
    if (!runId || results !== undefined) return undefined;
    const controller = new AbortController();
    loadResults(controller.signal, runEnded);
    return () => controller.abort();
  }, [runId, results, runEnded]);

  useEffect(() => {
    if (readyTokenRunRef.current !== runId) {
      readyTokenRunRef.current = runId;
      initialReadyTokenRef.current = resultsReadyToken;
      return undefined;
    }
    if (resultsReadyToken === initialReadyTokenRef.current) return undefined;
    if (!runId || results !== undefined || resultsReadyToken === undefined) return undefined;
    const controller = new AbortController();
    loadResults(controller.signal, true);
    return () => controller.abort();
  }, [resultsReadyToken, runId, results]);

  const source = results !== undefined ? results : remoteResults;
  const model = useMemo(
    () => adaptRunResults(source || {}, { runDetail, events, status, triggerInput }),
    [source, runDetail, events, status, triggerInput],
  );
  const successfulOutputs = model.outputResults.filter((row) => row.status === 'success' && row.output);
  const selectedOutput = successfulOutputs.find((row) => row.nodeId === selectedOutputId) || successfulOutputs[0] || null;
  const selectedLinks = selectedOutput
    ? model.links.filter((link) => !link.nodeId || link.nodeId === selectedOutput.nodeId)
    : model.links;
  const selectedFiles = selectedOutput
    ? model.finalFiles.filter((file) => !file.nodeId || file.nodeId === selectedOutput.nodeId)
    : model.finalFiles;
  const viewState = deriveRunViewState(model, activeTab);
  const resultsReady = isRunResultsReady(model, source !== undefined);
  const finalArtifactIds = getArtifactIds(model.finalFiles);
  const canSave = Boolean(canSaveToWorkspace && sessionId && resultsReady && finalArtifactIds.length);

  const saveToWorkspace = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setSaveError('');
    setSavedNames([]);
    try {
      const data = await saveRunArtifacts(apiUrl(RUN_ARTIFACT_SAVE_PATH), {
        runId: model.runId,
        artifactIds: finalArtifactIds,
        sessionId,
      });
      setSavedNames(data.names);
    } catch (error) {
      setSaveError(error?.message || String(error));
    } finally {
      setSaving(false);
    }
  };

  const refresh = () => {
    if (!runId) return;
    const controller = new AbortController();
    loadResults(controller.signal, runEnded);
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
          {onClose && <button className="btn-icon" title="关闭面板" aria-label="关闭面板" onClick={onClose}><X size={16} /></button>}
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
        {activeTab === 'result' && model.runId && !resultsReady && !loadError && (
          <div className="result-loading"><LoaderCircle className="result-spin" size={17} />正在整理成果</div>
        )}
        {!loading && !model.runId && <p className="result-empty result-empty-run">运行工作流后，成果、过程和问题会显示在这里。</p>}

        {model.runId && activeTab === 'result' && resultsReady && (
          <>
            <div className="result-save-area">
              <button className="btn btn-primary result-save-button" onClick={saveToWorkspace} disabled={!canSave || saving}>
                {saving ? <LoaderCircle size={15} className="result-spin" /> : savedNames.length ? <Check size={15} /> : <FolderDown size={15} />}
                {saving ? '正在保存' : savedNames.length ? '已保存到工作目录' : '保存到工作目录'}
              </button>
              {!canSaveToWorkspace && <span className="result-save-hint">连接工作目录后可保存</span>}
              {canSaveToWorkspace && !sessionId && <span className="result-save-hint">工作目录尚未就绪</span>}
              {canSaveToWorkspace && finalArtifactIds.length === 0 && <span className="result-save-hint">没有可保存的成果文件</span>}
              {savedNames.length > 0 && <span className="result-save-success">已保存 {savedNames.length} 个文件</span>}
              {saveError && <span className="result-save-error">{saveError}</span>}
              {viewState.canExport && (
                <a className="result-zip-action" href={apiUrl(`/runs/export?id=${encodeURIComponent(model.runId)}`)} download>
                  <Archive size={13} />下载 ZIP
                </a>
              )}
            </div>
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
              artifacts={model.files}
              legacyInferred={Boolean(selectedOutput?.legacyInferred)}
              emptyText="本次运行没有成功生成输出节点成果。请查看过程和问题。"
            />
            <ProcessArtifacts results={model.processResults} files={model.processFiles} artifacts={model.files} />
          </>
        )}
        {model.runId && activeTab === 'process' && <ProcessView events={model.nodeTimeline} runId={model.runId} onFocusNode={onFocusNode} onOpenNodeDetail={onOpenNodeDetail} />}
        {model.runId && activeTab === 'issues' && <IssuesView issues={model.issues} runId={model.runId} onFocusNode={onFocusNode} onOpenNodeDetail={onOpenNodeDetail} />}
      </div>
    </aside>
  );
}

export default ResultPanel;
