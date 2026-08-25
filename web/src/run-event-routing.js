export function normalizeWorkflowId(value) {
  return value || null;
}

export function eventBelongsToCanvas(payload, { canvasId, workflowId }) {
  if (!payload) return false;
  const eventWorkflowId = normalizeWorkflowId(payload.workflowId);
  const currentWorkflowId = normalizeWorkflowId(workflowId);
  if (eventWorkflowId !== currentWorkflowId) return false;

  if (payload.canvasId) return payload.canvasId === canvasId;
  return eventWorkflowId !== null;
}

export function eventBelongsToRun(payload, activeRunId) {
  return Boolean(payload?.runId && activeRunId && payload.runId === activeRunId);
}

// run-start 是否应把视图跟随切换到新运行：
// 带本画布 canvasId 的启动（手动/续跑/助手）→ 跟随；定时/webhook 触发（无 canvasId）→ 不抢占视图。
export function shouldFollowRunStart(payload, { canvasId, workflowId }) {
  if (!payload?.runId) return false;
  if (payload.source === 'schedule' || payload.source === 'webhook') return false;
  return eventBelongsToCanvas(payload, { canvasId, workflowId });
}
