import assert from 'node:assert/strict';
import { buildVariableScopeSnapshot } from './variable-scope.js';

const baseGraph = {
  nodes: [
    { id: 'input', type: 'input', data: { label: '输入', text: 'source' } },
    { id: 'condition', type: 'condition', data: { label: '判断', include: 'urgent' } },
    { id: 'agent', type: 'agent', data: { label: '处理', prompt: 'before', inputTemplate: '' } },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'condition' },
    { id: 'e2', source: 'condition', target: 'agent', branch: 'true' },
  ],
};
const runtime = {
  outputs: { condition: 'true', unrelated: 'ignore' },
  structuredOutputs: { condition: { version: 1, type: 'json', value: { branch: 'true' } } },
  nodeStates: { condition: { status: 'success' } },
  triggerInput: 'legacy trigger',
  runInputs: { ticket: { id: 7 } },
  workflowVariables: [{ key: 'region', value: 'north' }],
  inputSchema: { fields: [{ key: 'ticket', type: 'object' }] },
  workflowId: 'wf1',
  runId: 'run1',
};

const first = buildVariableScopeSnapshot(baseGraph, 'agent', runtime);
const targetEdited = buildVariableScopeSnapshot({
  ...baseGraph,
  nodes: baseGraph.nodes.map((node) => node.id === 'agent'
    ? { ...node, data: { ...node.data, prompt: 'after', inputTemplate: '{{node["condition"].text}}' } }
    : node),
}, 'agent', runtime);
assert.equal(targetEdited.key, first.key);
assert.deepEqual(first.graph.nodes.map((node) => node.id), ['agent', 'condition', 'input']);
assert.deepEqual(Object.keys(first.outputs), ['condition']);

const upstreamEdited = buildVariableScopeSnapshot({
  ...baseGraph,
  nodes: baseGraph.nodes.map((node) => node.id === 'condition'
    ? { ...node, data: { ...node.data, include: 'emergency' } }
    : node),
}, 'agent', runtime);
assert.notEqual(upstreamEdited.key, first.key);

const edgeEdited = buildVariableScopeSnapshot({
  ...baseGraph,
  edges: baseGraph.edges.map((edge) => edge.id === 'e2' ? { ...edge, branch: 'false' } : edge),
}, 'agent', runtime);
assert.notEqual(edgeEdited.key, first.key);

assert.notEqual(buildVariableScopeSnapshot(baseGraph, 'agent', {
  ...runtime,
  structuredOutputs: { condition: { version: 1, type: 'json', value: { branch: 'false' } } },
}).key, first.key);
assert.notEqual(buildVariableScopeSnapshot(baseGraph, 'agent', { ...runtime, triggerInput: 'changed trigger' }).key, first.key);
assert.notEqual(buildVariableScopeSnapshot(baseGraph, 'agent', { ...runtime, runInputs: { ticket: { id: 8 } } }).key, first.key);
assert.notEqual(buildVariableScopeSnapshot(baseGraph, 'agent', {
  ...runtime,
  workflowVariables: [{ key: 'region', value: 'south' }],
}).key, first.key);
assert.notEqual(buildVariableScopeSnapshot(baseGraph, 'agent', {
  ...runtime,
  inputSchema: { fields: [{ key: 'ticket', type: 'string' }] },
}).key, first.key);
assert.notEqual(buildVariableScopeSnapshot(baseGraph, 'agent', { ...runtime, runId: 'run2' }).key, first.key);
assert.notEqual(buildVariableScopeSnapshot(baseGraph, 'agent', { ...runtime, globalVariableEpoch: 2 }).key, first.key);

const reorderedRuntime = {
  ...runtime,
  runInputs: { ticket: { id: 7 } },
  inputSchema: { fields: [{ type: 'object', key: 'ticket' }] },
  workflowVariables: [{ value: 'north', key: 'region' }],
};
assert.equal(buildVariableScopeSnapshot(baseGraph, 'agent', reorderedRuntime).key, first.key);

console.log('variable scope tests: all pass');
