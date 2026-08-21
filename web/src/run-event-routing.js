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
