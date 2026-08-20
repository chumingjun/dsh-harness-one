const RUNTIME_NODE_FIELDS = new Set([
  'runStatus',
  'runOutput',
  'runError',
  'runChars',
  'runtimeStructuredOutput',
  'livePreview',
  'artifacts',
  'sessionId',
  'durationMs',
  'runtimeModel',
  'test',
]);

export function buildVariableScopeSnapshot(graph, targetNodeId, runtime = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map();

  for (const edge of edges) {
    if (!incomingByTarget.has(edge.target)) incomingByTarget.set(edge.target, []);
    incomingByTarget.get(edge.target).push(edge.source);
  }

  const ancestorIds = new Set();
  const visit = (nodeId) => {
    for (const sourceId of incomingByTarget.get(nodeId) || []) {
      if (ancestorIds.has(sourceId)) continue;
      ancestorIds.add(sourceId);
      visit(sourceId);
    }
  };
  visit(targetNodeId);

  const scopeIds = new Set([...ancestorIds, targetNodeId]);
  const scopedNodes = [...scopeIds]
    .map((id) => nodeById.get(id))
    .filter(Boolean)
    .map((node) => node.id === targetNodeId
      ? { id: node.id, type: node.type, data: {} }
      : { ...node, data: stripRuntimeFields(node.data || {}) })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const scopedEdges = edges
    .filter((edge) => scopeIds.has(edge.source) && scopeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.branch || edge.data?.branch ? { branch: edge.branch || edge.data?.branch } : {}),
    }))
    .sort((a, b) => `${a.source}>${a.target}>${a.id || ''}`.localeCompare(`${b.source}>${b.target}>${b.id || ''}`));

  const directIds = [...new Set(incomingByTarget.get(targetNodeId) || [])].sort();
  const scopedRuntime = {
    outputs: pickKeys(runtime.outputs, directIds),
    structuredOutputs: pickKeys(runtime.structuredOutputs, directIds),
    nodeStates: pickKeys(runtime.nodeStates, directIds),
    triggerInput: runtime.triggerInput,
    runInputs: runtime.runInputs,
    workflowVariables: runtime.workflowVariables,
    inputSchema: runtime.inputSchema,
    globalVariableEpoch: runtime.globalVariableEpoch,
  };
  const scopedGraph = { nodes: scopedNodes, edges: scopedEdges };
  const key = stableStringify({
    targetNodeId,
    graph: scopedGraph,
    runtime: scopedRuntime,
    workflowId: runtime.workflowId || null,
    runId: runtime.runId || null,
  });

  return {
    key,
    graph: scopedGraph,
    targetNodeId,
    directIds,
    ...scopedRuntime,
  };
}

function stripRuntimeFields(data) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !RUNTIME_NODE_FIELDS.has(key)));
}

function pickKeys(value, keys) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
  }
  return result;
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
