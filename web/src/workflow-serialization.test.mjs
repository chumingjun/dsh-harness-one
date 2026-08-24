import assert from 'node:assert/strict';
import {
  WORKFLOW_SCHEMA_VERSION,
  createWorkflowDocument,
  defaultWorkflowMetadata,
  normalizeWorkflowDocument,
  serializeGraph,
  serializeWorkflowDocument,
} from './workflow-serialization.js';

const nodes = [{
  id: 'agent-1',
  type: 'propertyNode',
  position: { x: 10, y: 20 },
  selected: true,
  measured: { width: 240, height: 100 },
  data: {
    nodeType: 'agent',
    label: 'Agent',
    inputBindings: { customer: '{{node["input"].data.customer}}' },
    futureConfig: { nested: ['preserved'] },
    runStatus: 'success',
    runOutput: 'runtime output',
    runError: null,
    runChars: 14,
    runId: 'run-1',
    runtimeOutput: 'runtime output',
    runtimeStructuredOutput: { type: 'json', value: { runtime: true } },
    outputPreview: 'preview',
    livePreview: 'working',
    liveTurns: 2,
    progress: { turns: 2 },
    trace: { steps: [] },
    hasTrace: true,
    artifacts: ['result.md'],
    sessionId: 'session-1',
    durationMs: 123,
    runtimeModel: 'model-1',
    runStartedAt: '2026-08-24T00:00:00.000Z',
    runTurns: 3,
    artifactsRunId: 'run-1',
    test: true,
  },
}];
const edges = [{
  id: 'edge-1',
  source: 'input',
  target: 'agent-1',
  selected: true,
  animated: true,
  type: 'insertable',
  data: { branch: 'false', onInsert() {} },
}];

const graph = serializeGraph(nodes, edges);
assert.deepEqual(graph, {
  nodes: [{
    id: 'agent-1',
    type: 'agent',
    position: { x: 10, y: 20 },
    data: {
      label: 'Agent',
      inputBindings: { customer: '{{node["input"].data.customer}}' },
      futureConfig: { nested: ['preserved'] },
    },
  }],
  edges: [{ id: 'edge-1', source: 'input', target: 'agent-1', branch: 'false' }],
});
assert.equal(nodes[0].data.runStatus, 'success');
assert.equal(nodes[0].selected, true);

assert.deepEqual(defaultWorkflowMetadata(), {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  variables: [],
  inputSchema: { fields: [] },
  dependencies: { globalVariables: [], credentials: [] },
});

const legacy = normalizeWorkflowDocument({ schemaVersion: 1, nodes: [{ id: 'legacy' }], edges: [] });
assert.equal(legacy.schemaVersion, 3);
assert.deepEqual(legacy.variables, []);
assert.deepEqual(legacy.inputSchema, { fields: [] });
assert.deepEqual(legacy.dependencies, { globalVariables: [], credentials: [] });
assert.deepEqual(legacy.graph, { nodes: [{ id: 'legacy' }], edges: [] });
assert.equal('nodes' in legacy, false);

const loaded = normalizeWorkflowDocument({
  id: 'wf-1',
  name: 'Workflow',
  schemaVersion: 3,
  variables: [{ name: 'region', value: 'north' }],
  inputSchema: { title: 'Run input', fields: [{ name: 'query', type: 'string' }] },
  dependencies: {
    globalVariables: ['tenant'],
    credentials: [{ key: 'feishu', provider: 'feishu', required: true }],
    futureDependencyGroup: [{ id: 'skill-a', version: '1' }],
  },
  futureMetadata: { owner: 'ops' },
  graph: {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'agent-1', type: 'agent', position: { x: 0, y: 0 }, data: { inputBindings: { query: '$trigger' } } }],
    edges: [],
  },
});
assert.deepEqual(loaded.futureMetadata, { owner: 'ops' });
assert.equal(loaded.inputSchema.title, 'Run input');
assert.deepEqual(loaded.graph.viewport, { x: 0, y: 0, zoom: 1 });

const saved = serializeWorkflowDocument(loaded, nodes, edges);
assert.equal(saved.schemaVersion, 3);
assert.deepEqual(saved.variables, loaded.variables);
assert.deepEqual(saved.inputSchema, loaded.inputSchema);
assert.deepEqual(saved.dependencies, loaded.dependencies);
assert.deepEqual(saved.futureMetadata, loaded.futureMetadata);
assert.deepEqual(saved.graph, graph);
assert.equal(saved.id, 'wf-1');
assert.equal(saved.name, 'Workflow');

assert.deepEqual(createWorkflowDocument(), {
  schemaVersion: 3,
  variables: [],
  inputSchema: { fields: [] },
  dependencies: { globalVariables: [], credentials: [] },
  graph: { nodes: [], edges: [] },
});

assert.throws(
  () => normalizeWorkflowDocument({ schemaVersion: WORKFLOW_SCHEMA_VERSION + 1 }),
  /不支持的工作流文档版本/,
);

console.log('workflow serialization tests: all pass');
