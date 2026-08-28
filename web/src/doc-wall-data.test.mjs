import assert from 'node:assert/strict';
import { buildDocWallModel, clipDocContent, fileKind, DOC_CLIP_CHARS, STRIP_CARD_LIMIT } from './doc-wall-data.js';

const runResults = {
  runId: 'run1',
  workflowName: '物业手册',
  status: 'success',
  finalFiles: [
    { id: 'a1', nodeId: 'out1', nodeLabel: '验收输出', name: '验收报告.md', previewUrl: '/p1', downloadUrl: '/d1' },
    { id: 'a2', nodeId: 'out1', nodeLabel: '验收输出', name: '平面图.png', previewUrl: '/p2', downloadUrl: '/d2' },
  ],
  links: [{ type: 'writeback', nodeId: 'out1', nodeLabel: '验收输出', url: 'https://feishu.example/doc' }],
  processFiles: [
    { nodeId: 'n1', nodeLabel: 'A1 底稿', name: '事实底稿.md', previewUrl: '/p3' },
    { nodeId: 'n2', nodeLabel: 'A3 核查', name: 'so1.html', previewUrl: '/p4' },
    { nodeId: 'n2', nodeLabel: 'A3 核查', name: '标准核查.md', previewUrl: '/p5' },
    { nodeId: 'n2', nodeLabel: 'A3 核查', name: 's.sh' },
    { nodeId: 'nx', nodeLabel: '孤儿文件', name: 'lost.md' }, // nodeId 不在时间线 → 忽略
  ],
  nodeTimeline: [
    { nodeId: 'n1', nodeLabel: 'A1 底稿', nodeType: 'agent', status: 'success', output: '# 底稿' },
    { nodeId: 'n2', nodeLabel: 'A3 核查', nodeType: 'agent', status: 'success' },
    { nodeId: 'out1', nodeLabel: '验收输出', nodeType: 'output', status: 'success', output: 'done' },
  ],
};

const model = buildDocWallModel({ runResults });

// —— 结构 ——
assert.equal(model.runId, 'run1');
assert.equal(model.hasRun, true);
assert.equal(model.nodes.length, 2, 'output 节点不进过程区');
assert.deepEqual(model.nodes.map((n) => n.nodeLabel), ['A1 底稿', 'A3 核查'], '保持拓扑序');

// —— 成果带 ——
assert.equal(model.finals.docs.length, 2);
assert.equal(model.finals.docs[0].kind, 'doc');
assert.equal(model.finals.docs[1].kind, 'image');
assert.equal(model.finals.links[0].url, 'https://feishu.example/doc');

// —— kind 分发 ——
assert.equal(fileKind({ name: 'a.MD' }), 'doc');
assert.equal(fileKind({ name: 'v.mp4' }), 'video');
assert.equal(fileKind({ name: 'noext' }), 'data');

// —— 文件分桶（nodeId 优先，nodeLabel 兜底；孤儿丢弃；stateArtifacts 也进桶）——
// n2 三文件来自 processFiles：so1.html→data、标准核查.md→doc、s.sh→data；
// nodeStates 补充 n1 一个 md（scoped artifact URL），与 processFiles 的 n1 文件按 nodeId:name 去重
const model2 = buildDocWallModel({
  runResults,
  nodeStates: { n1: { artifacts: ['workspace/事实底稿.md'] }, n2: { status: 'success' } },
});
assert.equal(model2.nodes[0].docs.length, 1, 'n1 一张卡（processFiles 与 stateArtifacts 同名去重）');
assert.equal(model2.nodes[0].docs[0].kind, 'doc');
assert.match(model2.nodes[0].docs[0].previewUrl, /\/wf1\/api\/artifact\?run=run1&node=n1/, '同名去重时带 downloadUrl 的 stateArtifacts 行胜出');
assert.equal(model2.nodes[1].docs.length, 1, 'processFiles 的 md 进 n2 卡');
assert.equal(model2.nodes[1].dataFiles.length, 2, 'html/sh 折成 dataFiles');
assert.ok(model2.totals.docs >= 4);
assert.ok(model2.totals.dataFiles >= 2);

// —— stateArtifacts 单独成桶：scoped artifact URL 形状（缺省裸形状）——
const scoped = buildDocWallModel({
  runResults: { runId: 'r9', nodeTimeline: [{ nodeId: 'a', nodeLabel: 'A', nodeType: 'agent', status: 'success' }] },
  nodeStates: { a: { artifacts: ['ws/报告.md'] } },
});
assert.equal(scoped.nodes[0].docs.length, 1);
assert.match(scoped.nodes[0].docs[0].previewUrl, /\/wf1\/api\/artifact\?run=r9&node=a&file=ws%2F%E6%8A%A5%E5%91%8A\.md&preview=1/);
assert.match(scoped.nodes[0].docs[0].downloadUrl, /\/wf1\/api\/artifact\?run=r9&node=a&file=/);

// —— scopedArtifactUrl 工厂注入：真实环境经 apiUrl 包 sessionId/base ——
const injected = buildDocWallModel({
  runResults: { runId: 'r9', nodeTimeline: [{ nodeId: 'a', nodeLabel: 'A', nodeType: 'agent', status: 'success' }] },
  nodeStates: { a: { artifacts: ['ws/报告.md'] } },
  scopedArtifactUrl: (runId, nodeId, path) => `/injected?run=${runId}&node=${nodeId}&file=${encodeURIComponent(path)}`,
});
assert.equal(injected.nodes[0].docs[0].downloadUrl, '/injected?run=r9&node=a&file=ws%2F%E6%8A%A5%E5%91%8A.md');
assert.equal(injected.nodes[0].docs[0].previewUrl, '/injected?run=r9&node=a&file=ws%2F%E6%8A%A5%E5%91%8A.md&preview=1');

// —— 截断 ——
assert.equal(clipDocContent('short'), 'short');
assert.equal(clipDocContent('x'.repeat(9999)).length, DOC_CLIP_CHARS + 1, '截断到上限+省略号');

// —— STRIP_CARD_LIMIT 常量 ——
assert.ok(STRIP_CARD_LIMIT >= 6 && STRIP_CARD_LIMIT <= 24);

// —— 空运行 ——
const empty = buildDocWallModel({ runResults: {} });
assert.equal(empty.hasRun, false);
assert.equal(empty.nodes.length, 0);

// —— live 状态（progressByNode）——
const liveModel = buildDocWallModel({ runResults, progressByNode: { n1: { turns: 2, preview: '生成中' } } });
assert.equal(liveModel.nodes[0].live, true);
assert.equal(liveModel.nodes[1].live, false);

// —— 缺 finalFiles 的旧响应：不炸、成果带空 ——
const legacy = buildDocWallModel({ runResults: { runId: 'r2', nodeTimeline: [{ nodeId: 'a', nodeLabel: 'A', nodeType: 'agent', status: 'success' }] } });
assert.equal(legacy.finals.docs.length, 0);
assert.equal(legacy.nodes.length, 1);

// —— 失败节点：error 透出、状态保留（流卡变错误态的数据基础）——
const failed = buildDocWallModel({
  runResults: { runId: 'r3', nodeTimeline: [
    { nodeId: 'ok', nodeLabel: '成功节点', nodeType: 'agent', status: 'success' },
    { nodeId: 'bad', nodeLabel: '失败节点', nodeType: 'agent', status: 'error', error: 'LLM 超时' },
  ] },
});
assert.equal(failed.nodes[1].status, 'error');
assert.equal(failed.nodes[1].error, 'LLM 超时');

// —— 取消节点 ——
const canceled = buildDocWallModel({
  runResults: { runId: 'r4', nodeTimeline: [{ nodeId: 'c', nodeLabel: '被取消', nodeType: 'agent', status: 'canceled' }] },
});
assert.equal(canceled.nodes[0].status, 'canceled');

// —— 多文件节点：分桶不丢文件（视图层负责截断）——
const bulkModel = buildDocWallModel({
  runResults: { runId: 'r5', nodeTimeline: [{ nodeId: 'bulk', nodeLabel: '批量节点', nodeType: 'agent', status: 'success' }] },
  nodeStates: { bulk: { artifacts: Array.from({ length: STRIP_CARD_LIMIT + 5 }, (_, i) => `ws/doc-${i}.md`) } },
});
const bulkDocs = bulkModel.nodes[0].docs;
assert.equal(bulkDocs.length, STRIP_CARD_LIMIT + 5, '分桶不超源数（视图层负责截断）');

console.log('doc-wall-data tests: all pass');
