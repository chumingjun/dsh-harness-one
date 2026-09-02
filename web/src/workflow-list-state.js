const TERMINAL = new Set(['success', 'error', 'canceled', 'skipped']);

export function progressFromNodeStates(nodeStates = {}, total = null) {
  const states = Object.values(nodeStates || {});
  const done = states.filter((state) => TERMINAL.has(state?.status)).length;
  const succeeded = states.filter((state) => state?.status === 'success').length;
  return { done, total: total ?? states.length, succeeded };
}

export function currentNodesFromNodeStates(nodeStates = {}, labels = {}) {
  return Object.entries(nodeStates || {})
    .filter(([, state]) => ['running', 'waiting'].includes(state?.status))
    .map(([id]) => ({ id, label: labels[id] || id }));
}

function byStartedAt(a, b) {
  return String(b?.startedAt || '').localeCompare(String(a?.startedAt || '')) || String(b?.runId || '').localeCompare(String(a?.runId || ''));
}

export function mergeRunSummary(runs, next) {
  if (!next?.runId) return runs || [];
  const current = (runs || []).find((run) => run.runId === next.runId);
  if (current && current.status !== 'running' && next.status === 'running') return runs;
  const merged = { ...(current || {}), ...next };
  const rest = (runs || []).filter((run) => run.runId !== next.runId);
  return [merged, ...rest].sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || byStartedAt(a, b));
}

export function applyRunEvent(runs, event, payload) {
  if (!payload?.runId) return runs || [];
  const existing = (runs || []).find((run) => run.runId === payload.runId) || {};
  if (event === 'run-start' || event === 'snapshot') {
    return mergeRunSummary(runs, {
      ...existing, runId: payload.runId, workflowId: payload.workflowId ?? existing.workflowId ?? null,
      workflowName: payload.workflowName ?? existing.workflowName ?? null, source: payload.source ?? existing.source ?? null,
      startedAt: payload.startedAt ?? existing.startedAt ?? new Date().toISOString(), status: 'running', live: true,
      nodeStates: payload.nodeStates || existing.nodeStates || {}, progress: payload.progress || progressFromNodeStates(payload.nodeStates, payload.nodeCount ?? payload.nodeIds?.length),
      currentNodes: payload.currentNodes || currentNodesFromNodeStates(payload.nodeStates),
    });
  }
  if (event === 'node-status') {
    if (existing.live === false) return runs || [];
    const nodeStates = { ...(existing.nodeStates || {}), [payload.nodeId]: { ...(existing.nodeStates?.[payload.nodeId] || {}), ...payload } };
    return mergeRunSummary(runs, { ...existing, runId: payload.runId, status: existing.status || 'running', live: true, nodeStates, progress: progressFromNodeStates(nodeStates, existing.progress?.total), currentNodes: currentNodesFromNodeStates(nodeStates) });
  }
  if (event === 'agent-progress') {
    if (existing.live === false) return runs || [];
    return mergeRunSummary(runs, { ...existing, runId: payload.runId, live: true, currentNodes: [{ id: payload.nodeId, label: existing.currentNodes?.find((node) => node.id === payload.nodeId)?.label || payload.nodeId }] });
  }
  if (event === 'run-end' || event === 'run-error') {
    return mergeRunSummary(runs, { ...existing, ...payload, runId: payload.runId, live: false, status: payload.status || 'error', finishedAt: payload.finishedAt || new Date().toISOString(), currentNodes: [] });
  }
  return runs || [];
}

export function workflowCards(workflows = [], runs = []) {
  return workflows.map((workflow) => {
    const liveFromRuns = runs.filter((run) => run.workflowId === workflow.id && run.live);
    const liveRuns = liveFromRuns.length ? liveFromRuns.sort(byStartedAt) : (workflow.liveRuns || []).sort(byStartedAt);
    const lastRun = runs.find((run) => run.workflowId === workflow.id && !run.live) || workflow.lastRun || liveRuns[0] || null;
    return { ...workflow, liveRuns, lastRun };
  });
}
