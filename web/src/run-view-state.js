export const RESULT_TABS = Object.freeze([
  { id: 'result', label: '成果' },
  { id: 'process', label: '过程' },
  { id: 'issues', label: '问题' },
]);

const STATUS_META = {
  idle: { label: '尚未运行', tone: 'neutral' },
  queued: { label: '等待运行', tone: 'neutral' },
  running: { label: '运行中', tone: 'running' },
  waiting: { label: '等待审批', tone: 'waiting' },
  success: { label: '已完成', tone: 'success' },
  error: { label: '运行失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
};

export function getRunStatusMeta(status) {
  return STATUS_META[status] || { label: status || '未知状态', tone: 'neutral' };
}

export function deriveRunViewState(model, activeTab = 'result') {
  const safe = model || {};
  const counts = {
    result: Number(Boolean(safe.coreText)) + (safe.files?.length || 0) + (safe.links?.length || 0),
    process: safe.events?.length || 0,
    issues: safe.issues?.length || 0,
  };
  const normalizedTab = RESULT_TABS.some((tab) => tab.id === activeTab) ? activeTab : 'result';
  return {
    activeTab: normalizedTab,
    counts,
    hasRun: Boolean(safe.runId),
    canExport: Boolean(safe.runId && counts.result),
    canReview: Boolean(safe.runId && ['success', 'error', 'canceled'].includes(safe.status)),
    isRunning: safe.status === 'running',
    isEmpty: counts.result + counts.process + counts.issues === 0,
    status: getRunStatusMeta(safe.status),
  };
}
