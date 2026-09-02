import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_CHILD_RUNS_PER_ROOT,
  MAX_SUBWORKFLOW_DEPTH,
  SubworkflowError,
  resolveSubworkflowInputs,
  resolveSubworkflowValue,
  selectWorkflowResult,
  subworkflowTemplateFields,
  validateSubworkflowInputs,
  validateSubworkflowNode,
} from '../lib/subworkflow.js';

const context = {
  outputs: new Map([['up', 'hello'], ['json', '{"ok":true}']]),
  structuredOutputs: new Map([
    ['up', { version: 1, type: 'text', value: 'hello' }],
    ['json', { version: 1, type: 'json', value: { ok: true } }],
  ]),
  labels: new Map([['up', '上游']]),
  incomingIds: ['up', 'json'],
  triggerInput: 'trigger',
  nodeStates: { up: { status: 'success' }, json: { status: 'success' } },
  runInputs: { ticket: { id: 7 } },
  globalVariables: { enabled: true },
  workflowVariables: { mode: 'test' },
};
const render = (value) => ({ text: String(value).replace('{{node["up"].text}}', 'hello').replace('{{$upstream}}', 'hello') });

test('subworkflow resolves typed refs, templates, arrays, and objects', () => {
  assert.deepEqual(resolveSubworkflowValue({ $ref: 'inputs["ticket"]' }, context, render), { id: 7 });
  assert.equal(resolveSubworkflowValue('{{node["up"].text}} / x', context, render), 'hello / x');
  assert.deepEqual(resolveSubworkflowValue([{ $ref: 'vars.global["enabled"]' }, 2], context, render), [true, 2]);
  assert.equal(resolveSubworkflowValue('$upstream', context, render), 'hello');
  assert.deepEqual(resolveSubworkflowInputs({ inputMap: { triggerInput: { $ref: 'node["json"].data' }, runInputs: { text: { $ref: 'node["up"].text' } } } }, context, render), {
    triggerInput: { ok: true }, runInputs: { text: 'hello' },
  });
});

test('subworkflow input validation applies defaults and rejects invalid fields', () => {
  const schema = { fields: [
    { key: 'required', type: 'string', required: true },
    { key: 'count', type: 'number', defaultValue: 1 },
  ] };
  assert.deepEqual(validateSubworkflowInputs({ required: 'x' }, schema), { required: 'x', count: 1 });
  assert.throws(() => validateSubworkflowInputs({}, schema), (error) => error instanceof SubworkflowError && error.code === 'SUBWORKFLOW_INPUT_REQUIRED');
  assert.throws(() => validateSubworkflowInputs({ required: 'x', extra: true }, schema), (error) => error.code === 'SUBWORKFLOW_INPUT_UNKNOWN');
  assert.throws(() => validateSubworkflowInputs({ required: 1 }, schema), (error) => error.code === 'SUBWORKFLOW_INPUT_TYPE');
});

test('subworkflow result selects output nodes and falls back to final business node', () => {
  const outputResult = selectWorkflowResult({
    graph: { nodes: [{ id: 'a', type: 'agent' }, { id: 'o1', type: 'output' }, { id: 'o2', type: 'output' }] },
    nodeOrder: ['a', 'o1', 'o2'],
    nodeStates: { a: { status: 'success' }, o1: { status: 'success', artifacts: ['a.md'] }, o2: { status: 'success', artifacts: ['b.md'] } },
    outputs: { a: 'agent', o1: 'first', o2: 'second' },
    structuredOutputs: { o2: { version: 1, type: 'text', value: 'second' } },
  });
  assert.equal(outputResult.output, 'first\n\nsecond');
  assert.deepEqual(outputResult.artifacts, ['a.md', 'b.md']);
  assert.equal(outputResult.sourceNodeIds.join(','), 'o1,o2');
  const fallback = selectWorkflowResult({
    graph: { nodes: [{ id: 'a', type: 'agent' }, { id: 'b', type: 'script' }] },
    nodeOrder: ['a', 'b'],
    nodeStates: { a: { status: 'success' }, b: { status: 'success' } },
    outputs: { a: 'A', b: 'B' }, structuredOutputs: {},
  });
  assert.equal(fallback.output, 'B');
});

test('subworkflow node lint rejects missing target, async mode, retry, and invalid input map', () => {
  const issues = validateSubworkflowNode({ id: 'sub', data: { label: '调用', waitForCompletion: false, retryCount: 2, inputMap: [] } });
  assert.deepEqual(issues.map((issue) => issue.code), ['SUBWORKFLOW_WORKFLOW_REQUIRED', 'SUBWORKFLOW_ASYNC_UNSUPPORTED', 'SUBWORKFLOW_RETRY_UNSUPPORTED', 'SUBWORKFLOW_INPUT_MAP']);
  assert.equal(MAX_SUBWORKFLOW_DEPTH, 3);
  assert.equal(MAX_CHILD_RUNS_PER_ROOT, 16);
});

test('subworkflow node lint resolves target workflow for existence and input schema', () => {
  const childDoc = { id: 'wf_child', inputSchema: { fields: [{ key: 'ticket', type: 'string' }] } };
  const resolveTargetWorkflow = (id) => (id === 'wf_child' ? childDoc : null);
  const node = { id: 'sub', data: { label: '调用', workflowId: 'wf_child', inputMap: { runInputs: { extra: 'x' } } } };
  const issues = validateSubworkflowNode(node, { resolveTargetWorkflow });
  assert.deepEqual(issues.map((issue) => issue.code), ['SUBWORKFLOW_INPUT_UNKNOWN']);
  const ok = validateSubworkflowNode({ id: 'sub', data: { workflowId: 'wf_child', inputMap: { runInputs: { ticket: 'a' } } } }, { resolveTargetWorkflow });
  assert.deepEqual(ok, []);
  const missing = validateSubworkflowNode({ id: 'sub', data: { label: '调用', workflowId: 'wf_gone' } }, { resolveTargetWorkflow });
  assert.deepEqual(missing.map((issue) => issue.code), ['SUBWORKFLOW_NOT_FOUND']);
  // 无解析器时（引擎离线单测等）跳过存在性与字段校验，不报错
  const skipped = validateSubworkflowNode({ id: 'sub', data: { workflowId: 'wf_any', inputMap: { runInputs: { whatever: 1 } } } });
  assert.deepEqual(skipped, []);
});

test('subworkflow template fields collect triggerInput, nested runInputs strings, and wrapped $ref', () => {
  const fields = subworkflowTemplateFields({
    inputMap: {
      triggerInput: '{{node["up"].text}} 前缀',
      runInputs: {
        ticket: { $ref: 'node["up"].data' },
        list: ['常量', { nested: '{{vars.global["g"]}}' }],
        num: 42,
      },
    },
  });
  assert.deepEqual(fields, ['{{node["up"].text}} 前缀', '{{node["up"].data}}', '常量', '{{vars.global["g"]}}']);
  assert.deepEqual(subworkflowTemplateFields({}), []);
  assert.deepEqual(subworkflowTemplateFields({ inputMap: { triggerInput: '$upstream' } }), ['$upstream']);
});
