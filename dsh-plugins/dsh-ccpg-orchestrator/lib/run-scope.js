import { createHash } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

const EMPTY_ARRAY_DEFAULTS = new Set(['tools', 'skills', 'attachments']);
const FALSE_DEFAULTS = new Set(['planMode', 'continueOnFail', 'allowPrivate']);

function semanticNodeData(data = {}) {
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => {
    if (value === undefined) return false;
    if (EMPTY_ARRAY_DEFAULTS.has(key) && Array.isArray(value) && value.length === 0) return false;
    if (FALSE_DEFAULTS.has(key) && value === false) return false;
    return true;
  }));
}

export function graphFingerprint(graph) {
  const normalized = {
    nodes: (graph?.nodes || []).map((node) => ({ id: node.id, type: node.type, data: semanticNodeData(node.data) })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    edges: (graph?.edges || []).map((edge) => ({ source: edge.source, target: edge.target, branch: edge.branch || edge.data?.branch || null }))
      .sort((a, b) => `${a.source}>${a.target}>${a.branch}`.localeCompare(`${b.source}>${b.target}>${b.branch}`)),
  };
  return createHash('sha256').update(JSON.stringify(stable(normalized))).digest('hex').slice(0, 24);
}

export function upstreamGraphFingerprint(graph, targetNodeId) {
  if (!targetNodeId) return graphFingerprint(graph);
  const edges = graph?.edges || [];
  const ancestors = new Set();
  const pending = edges.filter((edge) => edge.target === targetNodeId).map((edge) => edge.source);
  while (pending.length) {
    const id = pending.pop();
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    for (const edge of edges) {
      if (edge.target === id && !ancestors.has(edge.source)) pending.push(edge.source);
    }
  }
  return graphFingerprint({
    nodes: (graph?.nodes || []).filter((node) => ancestors.has(node.id)),
    edges: edges.filter((edge) => ancestors.has(edge.source)
      && (ancestors.has(edge.target) || edge.target === targetNodeId)),
  });
}

export function runMatchesGraphScope(run, graph, targetNodeId) {
  if (!graph || !run) return true;
  if (run.graph) {
    return upstreamGraphFingerprint(run.graph, targetNodeId) === upstreamGraphFingerprint(graph, targetNodeId);
  }
  return !run.graphFingerprint || run.graphFingerprint === graphFingerprint(graph);
}

export function selectScopedRun({ runId, workflowId, graph }, { readRun, runs = [] }) {
  if (runId) {
    const run = readRun(runId);
    return run ? { run, scope: 'runId' } : { error: '运行记录不存在', status: 404 };
  }
  if (workflowId) {
    const run = runs.find((item) => item.workflowId === workflowId);
    return run ? { run, scope: 'workflowId' } : { run: null, scope: 'workflowId' };
  }
  if (graph) {
    const fingerprint = graphFingerprint(graph);
    const run = runs.find((item) => item.graphFingerprint === fingerprint);
    return { run: run || null, scope: 'graph', fingerprint };
  }
  return { run: null, scope: 'draft' };
}

const STATE_SUMMARY_KEYS = ['status', 'chars', 'durationMs', 'model', 'runtime', 'turns', 'usage', 'writeback', 'toleratedError', 'error'];

export function summarizeNodeStates(nodeStates = {}) {
  return Object.fromEntries(Object.entries(nodeStates || {}).map(([nodeId, state]) => [nodeId,
    Object.fromEntries(STATE_SUMMARY_KEYS.filter((key) => state?.[key] !== undefined).map((key) => [key, state[key]])),
  ]));
}

export function summarizeOutputs(outputs = {}, structuredOutputs = {}) {
  return Object.fromEntries(Object.entries(outputs || {}).map(([nodeId, output]) => [
    nodeId,
    structuredOutputs?.[nodeId]?.type === 'json' ? '(结构化输出，请在节点详情查看)' : output,
  ]));
}

export function summarizeStructuredOutputs(structuredOutputs = {}) {
  return Object.fromEntries(Object.entries(structuredOutputs || {}).map(([nodeId, envelope]) => [nodeId, {
    hasStructured: envelope?.type === 'json',
    outputType: envelope?.type || 'text',
    ...(envelope?.mediaType ? { mediaType: envelope.mediaType } : {}),
  }]));
}
