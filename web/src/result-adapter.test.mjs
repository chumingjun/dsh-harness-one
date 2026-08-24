import assert from 'node:assert/strict';
import { artifactPreviewKind } from './artifact-preview.js';
import {
  adaptRunResults,
  buildArtifactSavePayload,
  formatClock,
  formatDuration,
  getArtifactIds,
  getRunId,
  isRunResultsReady,
  isTechnicalArtifact,
  loadRunResults,
  normalizeRunEvent,
  RUN_ARTIFACT_SAVE_PATH,
  saveRunArtifacts,
  savedArtifactNames,
} from './result-adapter.js';
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
    input: { status: 'success', durationMs: 10, startedAt: '2026-08-21T06:00:00.000Z' },
    agent: { status: 'success', durationMs: 26817, startedAt: '2026-08-21T06:00:01.000Z', artifacts: ['report.md'] },
    output: { status: 'success', durationMs: 2, startedAt: '2026-08-21T06:00:28.000Z' },
  },
};

assert.equal(getRunId(runDetail, {}, {}), 'run-42');
assert.equal(getRunId(null, { runId: 'run-live' }, null), 'run-live');
assert.deepEqual(getRunStatusMeta('interrupted'), { label: '异常中断', tone: 'danger' });

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
// 过程 tab：步骤卡片需要原始 durationMs + startedAt，meta 统一为秒级文案
assert.equal(fallback.nodeTimeline[0].durationMs, 10);
assert.equal(fallback.nodeTimeline[0].startedAt, '2026-08-21T06:00:00.000Z');
assert.equal(fallback.nodeTimeline[0].meta, '不到 1 秒');
assert.equal(fallback.nodeTimeline[1].meta, '27 秒');

assert.equal(formatDuration(undefined), '');
assert.equal(formatDuration(0), '不到 1 秒');
assert.equal(formatDuration(999), '不到 1 秒');
assert.equal(formatDuration(1500), '1.5 秒');
assert.equal(formatDuration(26817), '27 秒');
assert.equal(formatDuration(57722), '58 秒');
assert.equal(formatDuration(60000), '1 分钟');
assert.equal(formatDuration(92000), '1 分 32 秒');
assert.equal(formatClock('2026-08-21T06:00:00.000Z').length > 0, true);
assert.equal(formatClock('not-a-date'), '');
assert.equal(formatClock(undefined), '');
assert.equal(fallback.processResults.some((row) => row.nodeId === 'note'), false);
assert.equal(fallback.issues.length, 0);
assert.equal(fallback.input, '原始输入');

const partialEvents = adaptRunResults({}, {
  runDetail,
  events: [{ nodeId: 'agent', status: 'running', message: '处理中' }],
});
assert.equal(partialEvents.nodeTimeline.length, 3, '不完整 SSE 不能覆盖完整流程节点');
assert.equal(partialEvents.nodeTimeline.find((row) => row.nodeId === 'agent').status, 'running');

// live 运行：agent-progress 事件带轮次与流式输出预览，运行中节点在时间线上可见实时过程
const liveRun = adaptRunResults({}, {
  runDetail: { runId: 'run-live', workflowName: '直播', graph: runDetail.graph, nodeStates: { input: { status: 'success', durationMs: 10 } } },
  events: [{ nodeId: 'agent', status: 'running', turns: 3, preview: '正在起草报告…' }],
});
const liveAgentRow = liveRun.nodeTimeline.find((row) => row.nodeId === 'agent');
assert.equal(liveAgentRow.status, 'running');
assert.equal(liveAgentRow.turns, 3, '运行中节点合并 live 轮次');
assert.equal(liveAgentRow.preview, '正在起草报告…', '运行中节点合并 live 输出预览');
// 终态 live 事件（node-status success/error）覆盖启动快照里的旧状态与旧耗时
const terminalLive = adaptRunResults({}, {
  runDetail: { runId: 'run-t', workflowName: '终态', graph: runDetail.graph, nodeStates: { agent: { status: 'running' } } },
  events: [{ nodeId: 'agent', status: 'success', durationMs: 1200 }],
});
const terminalRow = terminalLive.nodeTimeline.find((row) => row.nodeId === 'agent');
assert.equal(terminalRow.status, 'success', 'live 终态事件覆盖快照状态');
assert.equal(terminalRow.meta, '1.2 秒');
// detail 尚未 fetch 到（runDetail 空）：live 事件补出时间线行
const earlyLive = adaptRunResults({}, {
  runDetail: { runId: 'run-early' },
  events: [{ nodeId: 'agent', nodeLabel: '报告', status: 'running', turns: 1, preview: 'p' }],
});
assert.equal(earlyLive.nodeTimeline.length, 1, '无骨架时 live 事件补行');
assert.equal(earlyLive.nodeTimeline[0].nodeId, 'agent');
assert.equal(earlyLive.nodeTimeline[0].preview, 'p');

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
  turns: undefined, preview: undefined, durationMs: undefined, startedAt: undefined,
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

// fetch_err.json 这类技术转储文件不进「过程文件」列表，但保留在 files 索引（正文行内引用仍可点）
const withTechnical = adaptRunResults({
  runId: 'run-technical',
  status: 'success',
  outputResults: [{ nodeId: 'output', nodeLabel: '最终交付', nodeType: 'output', status: 'success', output: 'done' }],
  artifacts: [
    { id: 'a1', name: 'report.md', relativePath: 'report.md', downloadUrl: '/r', nodeId: 'output', nodeLabel: '最终交付' },
    { id: 'a2', name: 'fetch_err.json', relativePath: 'fetch_err.json', downloadUrl: '/e1', nodeId: 'agent', nodeLabel: '抓取' },
    { id: 'a3', name: 'fetch_err2.json', relativePath: 'fetch_err2.json', downloadUrl: '/e2', nodeId: 'agent', nodeLabel: '抓取' },
    { id: 'a4', name: 'notes.md', relativePath: 'notes.md', downloadUrl: '/n', nodeId: 'agent', nodeLabel: '抓取' },
  ],
});
assert.deepEqual(withTechnical.processFiles.map((f) => f.name), ['notes.md']);
assert.equal(withTechnical.files.length, 4);
assert.equal(isTechnicalArtifact({ name: 'fetch_err.json' }), true);
assert.equal(isTechnicalArtifact({ name: 'FETCH_ERR2.JSON' }), true);
assert.equal(isTechnicalArtifact({ name: 'notes.md' }), false);

assert.equal(RUN_ARTIFACT_SAVE_PATH, '/run-artifacts/save');
assert.deepEqual(getArtifactIds([
  { id: 'a1' }, { artifactId: 'a2' }, { id: 'a1' }, 'a3', null,
]), ['a1', 'a2', 'a3']);
assert.deepEqual(buildArtifactSavePayload({
  runId: 'run-save',
  files: [{ id: 'final-1' }, { id: 'final-1' }, { id: 'final-2' }],
  sessionId: 'session-9',
}), { runId: 'run-save', artifactIds: ['final-1', 'final-2'], sessionId: 'session-9' });
assert.deepEqual(savedArtifactNames(['/Users/demo/report.pdf', 'folder\\slides.pptx', 'report.pdf']), ['report.pdf', 'slides.pptx']);
assert.equal(isRunResultsReady({ runId: 'r1', status: 'running' }, true), false);
assert.equal(isRunResultsReady({ runId: 'r1', status: 'success' }, false), false);
assert.equal(isRunResultsReady({ runId: 'r1', status: 'success' }, true), true);

let resultRequests = 0;
const completedResults = await loadRunResults('/run-results?id=r1', { waitUntilReady: true }, async () => {
  resultRequests += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ runId: 'r1', status: resultRequests === 1 ? 'running' : 'success' }),
  };
});
assert.equal(resultRequests, 2, '运行结束后应跳过旧的 running 快照并继续拉取最终成果');
assert.equal(completedResults.status, 'success');

let saveRequest;
const saveResponse = await saveRunArtifacts('/wf1/api/run-artifacts/save', {
  runId: 'run-save', artifactIds: ['a1', 'a2', 'a1'], sessionId: 'session-9',
}, async (url, request) => {
  saveRequest = { url, request };
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, savedCount: 2, names: ['/tmp/report.pdf', 'slides.pptx'] }),
  };
});
assert.equal(saveRequest.url, '/wf1/api/run-artifacts/save');
assert.equal(saveRequest.request.method, 'POST');
assert.deepEqual(JSON.parse(saveRequest.request.body), {
  runId: 'run-save', artifactIds: ['a1', 'a2'], sessionId: 'session-9',
});
assert.deepEqual(saveResponse, { ok: true, savedCount: 2, names: ['report.pdf', 'slides.pptx'] });
await assert.rejects(() => saveRunArtifacts('/save', { runId: 'r' }, async () => ({
  ok: false, status: 409, json: async () => ({ error: '工作目录不可用' }),
})), /工作目录不可用/);

console.log('result adapter frontend tests: all pass');
