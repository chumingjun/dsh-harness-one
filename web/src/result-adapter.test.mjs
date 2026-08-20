import assert from 'node:assert/strict';
import { adaptRunResults, getRunId, normalizeRunEvent } from './result-adapter.js';
import { deriveRunViewState, getRunStatusMeta } from './run-view-state.js';

const runDetail = {
  runId: 'run-42',
  status: 'success',
  workflowName: '交付工作流',
  triggerInput: '原始输入',
  nodeOrder: ['input', 'agent', 'output'],
  graph: {
    nodes: [
      { id: 'input', type: 'input', data: { label: '输入' } },
      { id: 'agent', type: 'agent', data: { label: '写报告' } },
      { id: 'output', type: 'output', data: { label: '最终交付' } },
    ],
  },
  outputs: {
    input: 'input text',
    agent: 'draft',
    output: '# 最终报告\n\n参见 https://example.com/report',
  },
  nodeStates: {
    input: { status: 'success', durationMs: 10 },
    agent: { status: 'success', durationMs: 20, artifacts: ['report.md'] },
    output: { status: 'success', durationMs: 2 },
  },
};

assert.equal(getRunId(runDetail, {}, {}), 'run-42');
assert.equal(getRunId(null, { runId: 'run-live' }, null), 'run-live');

const fallback = adaptRunResults({}, { runDetail });
assert.equal(fallback.runId, 'run-42');
assert.equal(fallback.coreText, runDetail.outputs.output);
assert.equal(fallback.files.length, 1);
assert.deepEqual(fallback.files[0], {
  name: 'report.md', path: 'report.md', nodeId: 'agent', nodeLabel: '写报告',
});
assert.deepEqual(fallback.links, [{ url: 'https://example.com/report', label: 'https://example.com/report' }]);
assert.equal(fallback.events.length, 3);
assert.equal(fallback.issues.length, 0);
assert.equal(fallback.input, '原始输入');

const explicit = adaptRunResults({
  runId: 'run-42',
  status: 'error',
  result: {
    coreText: '接口核心文本',
    files: [
      { name: 'data.csv', url: '/download/data.csv' },
      { name: 'data.csv', url: '/download/data.csv' },
    ],
    links: [{ title: '文档', href: 'https://docs.example.com' }],
    issues: [{ nodeId: 'agent', message: '格式不完整' }],
  },
  review: { decision: 'approved', note: '符合要求', reviewedBy: '审核人' },
}, { runDetail, events: [{ nodeId: 'agent', status: 'running', message: '处理中' }] });
assert.equal(explicit.coreText, '接口核心文本');
assert.equal(explicit.files.length, 2, '重复接口文件去重，同时保留旧运行详情中的节点产物');
assert.deepEqual(explicit.files.map((file) => file.name).sort(), ['data.csv', 'report.md']);
assert.equal(explicit.links[0].label, '文档');
assert.equal(explicit.events[0].text, '处理中');
assert.equal(explicit.issues[0].message, '格式不完整');
assert.equal(explicit.review.status, 'approved');
assert.equal(explicit.review.comment, '符合要求');

const backendShape = adaptRunResults({
  runId: 'run-backend',
  status: 'success',
  primaryResult: { output: '# 后端核心结果' },
  artifacts: [{ name: 'deliverable.pdf', relativePath: 'deliverable.pdf', downloadUrl: '/artifact', previewUrl: '/preview', mediaType: 'application/pdf', nodeLabel: '报告节点' }],
  inputs: { triggerInput: '后端输入' },
  review: { status: 'accepted', by: '验收人', updatedAt: '2026-08-20T10:00:00.000Z' },
});
assert.equal(backendShape.coreText, '# 后端核心结果');
assert.equal(backendShape.files[0].url, '/artifact');
assert.equal(backendShape.files[0].previewUrl, '/preview');
assert.equal(backendShape.files[0].mimeType, 'application/pdf');
assert.equal(backendShape.input, '后端输入');
assert.equal(backendShape.review.reviewer, '验收人');

const withFailure = adaptRunResults({}, {
  runDetail: {
    ...runDetail,
    status: 'error',
    nodeStates: { agent: { status: 'error', error: '模型超时' } },
  },
});
assert.deepEqual(withFailure.issues[0], {
  id: 'issue-0', status: 'error', nodeId: 'agent', nodeLabel: '写报告', message: '模型超时',
});

assert.deepEqual(normalizeRunEvent({ type: 'node-status', node: { id: 'n1', label: '节点一' }, state: 'success', timestamp: 123 }), {
  id: '123-0', time: 123, kind: 'node-status', status: 'success', nodeId: 'n1', nodeLabel: '节点一', text: '', meta: undefined,
  raw: { type: 'node-status', node: { id: 'n1', label: '节点一' }, state: 'success', timestamp: 123 },
});

const state = deriveRunViewState(fallback, 'bad-tab');
assert.equal(state.activeTab, 'result');
assert.deepEqual(state.counts, { result: 3, process: 3, issues: 0 });
assert.equal(state.canExport, true);
assert.equal(state.canReview, true);
assert.equal(state.isEmpty, false);
assert.deepEqual(getRunStatusMeta('mystery'), { label: 'mystery', tone: 'neutral' });

console.log('result adapter frontend tests: all pass');
