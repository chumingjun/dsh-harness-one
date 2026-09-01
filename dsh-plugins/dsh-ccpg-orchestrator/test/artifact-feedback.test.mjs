import assert from 'node:assert/strict';
import { buildRevisionGraph, extractRevision, formatCommentBodies, revisionAgentNodeId } from '../lib/artifact-feedback.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

console.log('artifact feedback tests:');

test('formatCommentBodies dedups and clamps long bodies', () => {
  const lines = formatCommentBodies([
    { body: '改正式些' },
    { body: '改正式些' },
    { body: '   ' },
    { body: 'x'.repeat(2500) },
    { body: null },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '改正式些');
  assert.equal(lines[1].endsWith('（评论过长已截断）'), true);
  assert.equal(lines[1].length < 2500, true);
});

test('buildRevisionGraph 单 agent 微图：评论进 inputTemplate，文件名进指令', () => {
  const graph = buildRevisionGraph({
    comments: [{ body: '语气太随意' }, { body: '补充数据来源' }],
    originalName: '巡检报告.md',
    fileName: '巡检报告.md',
    instruction: '保持三段结构',
  });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
  const node = graph.nodes[0];
  assert.equal(node.id, revisionAgentNodeId());
  assert.equal(node.type, 'agent');
  assert.equal(node.data.skills.length, 0);
  assert.deepEqual(node.data.inputFiles, ['巡检报告.md']);
  assert.equal(node.data.prompt.includes('巡检报告.md'), true);
  assert.equal(node.data.inputTemplate.includes('1. 语气太随意'), true);
  assert.equal(node.data.inputTemplate.includes('2. 补充数据来源'), true);
  assert.equal(node.data.inputTemplate.includes('保持三段结构'), true);
  // 裸 {{变量}} 约束不适用（纯后端模板），但模板引擎的 {{ }} 占位不得出现在评论拼接结果里被误渲染
  assert.equal(node.data.inputTemplate.includes('{{'), false);
});

test('buildRevisionGraph 无评论时给通用润化占位', () => {
  const graph = buildRevisionGraph({ comments: [], originalName: 'a.md', fileName: 'a.md', instruction: '' });
  assert.equal(graph.nodes[0].data.inputTemplate.includes('（无具体评论'), true);
});

test('extractRevision 优先同名产物、读失败降级空正文', () => {
  const run = {
    runId: 'run_rev1', status: 'success',
    outputs: { revision_agent: '改了两处' },
    artifactIndex: [
      { id: 'x1', nodeId: 'other_node', name: 'notes.txt', snapshot: 's1' },
      { id: 'x2', nodeId: revisionAgentNodeId(), name: 'other.md', snapshot: 's2' },
      { id: 'x3', nodeId: revisionAgentNodeId(), name: '巡检报告.md', snapshot: 's3' },
    ],
  };
  const record = extractRevision({ run, fileName: '巡检报告.md', readFile: () => '# 新稿' });
  assert.equal(record.fileName, '巡检报告.md');
  assert.equal(record.content, '# 新稿');
  assert.equal(record.summary, '改了两处');
  assert.equal(record.revisionRunId, 'run_rev1');

  const broken = extractRevision({ run, fileName: '巡检报告.md', readFile: () => { throw new Error('gone'); } });
  assert.equal(broken.content, null);
  assert.equal(broken.fileName, '巡检报告.md');
});

test('extractRevision 失败/无产物 run 返回 null', () => {
  assert.equal(extractRevision({ run: { status: 'error', artifactIndex: [] }, fileName: 'a.md', readFile: () => '' }), null);
  assert.equal(extractRevision({ run: { status: 'success', artifactIndex: [] }, fileName: 'a.md', readFile: () => '' }), null);
  assert.equal(extractRevision({ run: null, fileName: 'a.md', readFile: () => '' }), null);
});

test('超长修订正文截断入库', () => {
  const run = {
    runId: 'r', status: 'success', outputs: {},
    artifactIndex: [{ id: 'x', nodeId: revisionAgentNodeId(), name: 'a.md', snapshot: 's' }],
  };
  const record = extractRevision({ run, fileName: 'a.md', readFile: () => 'x'.repeat(200 * 1024) });
  assert.equal(record.content.length < 200 * 1024, true);
  assert.equal(record.content.endsWith('（修订正文过长已截断）'), true);
});

console.log(passed > 0 ? `\n${passed} tests passed` : '');
