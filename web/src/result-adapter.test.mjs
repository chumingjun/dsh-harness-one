import assert from 'node:assert/strict';
import { artifactPreviewKind } from './artifact-preview.js';
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
      { id: 'note', type: 'note', data: { label: '画布说明' } },
      { id: 'output', type: 'output', data: { label: '最终交付' } },
    ],
    edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
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
assert.equal(fallback.outputResults.length, 1);
assert.equal(fallback.outputResults[0].nodeId, 'output');
assert.equal(fallback.processResults.length, 2);
assert.equal(fallback.finalFiles.length, 0);
assert.equal(fallback.processFiles.length, 1);
assert.deepEqual(fallback.links, [{ url: 'https://example.com/report', label: 'https://example.com/report' }]);
assert.deepEqual(fallback.nodeTimeline.map((row) => row.nodeId), ['input', 'agent', 'output']);
assert.equal(fallback.processResults.some((row) => row.nodeId === 'note'), false);
assert.equal(fallback.issues.length, 0);
assert.equal(fallback.input, '原始输入');

const partialEvents = adaptRunResults({}, {
  runDetail,
  events: [{ nodeId: 'agent', status: 'running', message: '处理中' }],
});
assert.equal(partialEvents.nodeTimeline.length, 3, '不完整 SSE 不能覆盖完整流程节点');
assert.equal(partialEvents.nodeTimeline.find((row) => row.nodeId === 'agent').status, 'running');

const backendShape = adaptRunResults({
  runId: 'run-backend',
  status: 'success',
  finalStatus: 'available',
  outputResults: [{ nodeId: 'output', nodeLabel: '最终交付', nodeType: 'output', status: 'success', output: '# 后端最终结果' }],
  processResults: [{ nodeId: 'agent', nodeLabel: '报告节点', nodeType: 'agent', status: 'success', output: '中间草稿' }],
  nodeTimeline: [
    { nodeId: 'agent', nodeLabel: '报告节点', nodeType: 'agent', status: 'success' },
    { nodeId: 'output', nodeLabel: '最终交付', nodeType: 'output', status: 'success' },
  ],
  artifacts: [
    { id: 'a1', name: 'deliverable.pdf', relativePath: 'deliverable.pdf', downloadUrl: '/artifact', previewUrl: '/preview', mediaType: 'application/pdf', nodeId: 'output', nodeLabel: '最终交付' },
    { id: 'a2', name: 'debug.json', relativePath: 'debug.json', downloadUrl: '/debug', previewUrl: '/debug-preview', mediaType: 'application/json', nodeId: 'agent', nodeLabel: '报告节点' },
  ],
  finalArtifacts: [{ id: 'a1', name: 'deliverable.pdf', relativePath: 'deliverable.pdf', downloadUrl: '/artifact', previewUrl: '/preview', mediaType: 'application/pdf', nodeId: 'output', nodeLabel: '最终交付' }],
  processArtifacts: [{ id: 'a2', name: 'debug.json', relativePath: 'debug.json', downloadUrl: '/debug', previewUrl: '/debug-preview', mediaType: 'application/json', nodeId: 'agent', nodeLabel: '报告节点' }],
  inputs: { triggerInput: '后端输入' },
}, { runDetail });
assert.equal(backendShape.coreText, '# 后端最终结果');
assert.equal(backendShape.finalFiles[0].url, '/artifact');
assert.equal(backendShape.processFiles[0].url, '/debug');
assert.equal(backendShape.input, '后端输入');

const failedOutput = adaptRunResults({}, {
  runDetail: {
    ...runDetail,
    status: 'error',
    outputs: { input: 'input text', agent: '中间结果' },
    nodeStates: {
      input: { status: 'success' },
      agent: { status: 'success' },
      output: { status: 'skipped' },
    },
  },
});
assert.equal(failedOutput.finalStatus, 'unavailable');
assert.equal(failedOutput.coreText, '', '有输出节点时不得用中间结果冒充最终成果');
assert.equal(failedOutput.outputResults[0].status, 'skipped');

const legacy = adaptRunResults({}, {
  runDetail: {
    runId: 'legacy', status: 'success', nodeOrder: ['agent'],
    graph: { nodes: [{ id: 'agent', type: 'agent', data: { label: '旧节点' } }], edges: [] },
    outputs: { agent: '旧结果' }, nodeStates: { agent: { status: 'success' } },
  },
});
assert.equal(legacy.finalStatus, 'legacy-inferred');
assert.equal(legacy.outputResults[0].legacyInferred, true);

const withFailure = adaptRunResults({}, {
  runDetail: {
    ...runDetail,
    status: 'error',
    nodeStates: { agent: { status: 'error', error: '模型超时' } },
  },
});
assert.equal(withFailure.issues[0].message, '模型超时');

assert.deepEqual(normalizeRunEvent({ type: 'node-status', node: { id: 'n1', label: '节点一' }, state: 'success', timestamp: 123 }), {
  id: '123-0', time: 123, kind: 'node-status', status: 'success', nodeId: 'n1', nodeLabel: '节点一', text: '', meta: undefined,
  raw: { type: 'node-status', node: { id: 'n1', label: '节点一' }, state: 'success', timestamp: 123 },
});

assert.equal(artifactPreviewKind('report.md'), 'markdown');
assert.equal(artifactPreviewKind('data.json'), 'json');
assert.equal(artifactPreviewKind('notes.txt'), 'text');
assert.equal(artifactPreviewKind('table.csv'), 'csv');
assert.equal(artifactPreviewKind('photo.png'), 'image');
assert.equal(artifactPreviewKind('document.pdf'), 'pdf');
assert.equal(artifactPreviewKind('document.docx'), 'docx');
assert.equal(artifactPreviewKind('workbook.xls'), 'sheet');
assert.equal(artifactPreviewKind('workbook.xlsx'), 'sheet');
assert.equal(artifactPreviewKind('slides.pptx'), 'pptx');
assert.equal(artifactPreviewKind('legacy.doc'), null);
assert.equal(artifactPreviewKind('legacy.ppt'), null);
assert.equal(artifactPreviewKind('archive.zip'), null);
assert.equal(artifactPreviewKind('unsafe.svg'), null);

const state = deriveRunViewState(fallback, 'bad-tab');
assert.equal(state.activeTab, 'result');
assert.deepEqual(state.counts, { result: 2, process: 3, issues: 0 });
assert.equal(state.canExport, true);
assert.equal(state.isEmpty, false);
assert.deepEqual(getRunStatusMeta('mystery'), { label: 'mystery', tone: 'neutral' });

console.log('result adapter frontend tests: all pass');
