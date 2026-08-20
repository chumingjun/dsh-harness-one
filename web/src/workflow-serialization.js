export const WORKFLOW_SCHEMA_VERSION = 3;

const RUNTIME_NODE_DATA_FIELDS = new Set([
  'nodeType',
  'runStatus',
  'runOutput',
  'runError',
  'runChars',
  'runId',
  'runtimeOutput',
  'runtimeStructuredOutput',
  'outputPreview',
  'livePreview',
  'progress',
  'trace',
  'hasTrace',
  'artifacts',
  'sessionId',
  'durationMs',
  'runtimeModel',
  'test',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeDependencies = (value) => ({
  ...(isObject(value) ? value : {}),
  globalVariables: Array.isArray(value?.globalVariables) ? value.globalVariables : [],
  credentials: Array.isArray(value?.credentials) ? value.credentials : [],
});

function assertSupportedSchemaVersion(value) {
  if (value === undefined || value === null) return;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0 || version > WORKFLOW_SCHEMA_VERSION) {
    throw new Error(`不支持的工作流文档版本：${value}`);
  }
}

export function defaultWorkflowMetadata() {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    variables: [],
    inputSchema: { fields: [] },
    dependencies: { globalVariables: [], credentials: [] },
  };
}

export function stripCanvasRuntimeNodeData(data = {}) {
  if (!isObject(data)) return {};
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !RUNTIME_NODE_DATA_FIELDS.has(key)),
  );
}

export function serializeGraph(nodesOrGraph = [], edges = []) {
  const source = Array.isArray(nodesOrGraph)
    ? { nodes: nodesOrGraph, edges }
    : (isObject(nodesOrGraph) ? nodesOrGraph : {});

  return {
    nodes: (Array.isArray(source.nodes) ? source.nodes : []).map((node) => ({
      id: node.id,
      type: node.data?.nodeType || node.type,
      position: node.position,
      data: stripCanvasRuntimeNodeData(node.data),
    })),
    edges: (Array.isArray(source.edges) ? source.edges : []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.branch || edge.data?.branch ? { branch: edge.branch || edge.data?.branch } : {}),
    })),
  };
}

export function normalizeWorkflowDocument(value = {}) {
  const source = isObject(value) ? value : {};
  assertSupportedSchemaVersion(source.schemaVersion);
  const defaults = defaultWorkflowMetadata();
  const inputSchema = isObject(source.inputSchema) ? source.inputSchema : {};
  const graphSource = isObject(source.graph)
    ? source.graph
    : { nodes: source.nodes, edges: source.edges };
  const { nodes: _legacyNodes, edges: _legacyEdges, ...document } = source;

  return {
    ...document,
    schemaVersion: defaults.schemaVersion,
    variables: Array.isArray(source.variables) ? source.variables : defaults.variables,
    inputSchema: {
      ...inputSchema,
      fields: Array.isArray(inputSchema.fields) ? inputSchema.fields : defaults.inputSchema.fields,
    },
    dependencies: normalizeDependencies(source.dependencies),
    graph: {
      ...graphSource,
      nodes: Array.isArray(graphSource.nodes) ? graphSource.nodes : [],
      edges: Array.isArray(graphSource.edges) ? graphSource.edges : [],
    },
  };
}

export function serializeWorkflowDocument(document = {}, nodes, edges) {
  const normalized = normalizeWorkflowDocument(document);
  const graph = nodes === undefined
    ? serializeGraph(normalized.graph)
    : serializeGraph(nodes, edges);
  return { ...normalized, graph };
}

export function createWorkflowDocument(graph = {}) {
  return serializeWorkflowDocument({ graph });
}
