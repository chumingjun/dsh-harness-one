import assert from 'node:assert/strict';
import { adoptRunStatusPatch, projectRunNodeStates, seedTerminalNodeIds } from './live-run-adopt.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('live run adopt tests:');

test('投影恢复运行中节点动画源字段（runStatus/runStartedAt）', () => {
  const [out] = projectRunNodeStates(
    [{ id: 'n1', data: { label: '撰写', runStatus: 'idle' } }],
    { nodeStates: { n1: { status: 'running', startedAt: '2026-09-01T01:00:00Z' } } },
    'run-1',
  );
  assert.equal(out.data.runStatus, 'running');
  assert.equal(out.data.runStartedAt, '2026-09-01T01:00:00Z');
});

test('投影恢复已完成节点输出与终态字段', () => {
  const nodes = [
    { id: 'a', data: {} },
    { id: 'b', data: {} },
  ];
  const detail = {
    nodeStates: {
      a: { status: 'success', chars: 12, durationMs: 3400, model: 'deepseek-chat' },
      b: { status: 'error', error: 'boom' },
    },
    outputs: { a: 'hello world' },
  };
  const out = projectRunNodeStates(nodes, detail, 'run-9');
  assert.equal(out[0].data.runStatus, 'success');
  assert.equal(out[0].data.runChars, 12);
  assert.equal(out[0].data.durationMs, 3400);
  assert.equal(out[0].data.runtimeModel, 'deepseek-chat');
  assert.equal(out[0].data.runOutput, 'hello world');
  assert.equal(out[1].data.runStatus, 'error');
  assert.equal(out[1].data.runError, 'boom');
  assert.equal(out[1].data.runOutput, undefined);
});

test('无状态节点原样保留；artifacts 挂 artifactsRunId', () => {
  const nodes = [{ id: 'x', data: { label: '孤立' } }, { id: 'y', data: {} }];
  const detail = { nodeStates: { y: { status: 'success', artifacts: [{ id: 'art-1' }] } } };
  const out = projectRunNodeStates(nodes, detail, 'run-2');
  assert.deepEqual(out[0].data, { label: '孤立' });
  assert.deepEqual(out[1].data.artifacts, [{ id: 'art-1' }]);
  assert.equal(out[1].data.artifactsRunId, 'run-2');
});

test('runStatus 补丁：running 时置进度并排除 notify 节点', () => {
  const patch = adoptRunStatusPatch({
    status: 'running',
    nodeStates: { a: { status: 'success' }, b: { status: 'running' }, c: { status: 'skipped' } },
    graph: { nodes: [{ id: 'a', type: 'agent' }, { id: 'b', type: 'agent' }, { id: 'c', type: 'agent' }, { id: 'n', type: 'notify' }] },
  }, 'run-3', 0);
  assert.equal(patch.running, true);
  assert.equal(patch.runId, 'run-3');
  assert.equal(patch.done, 2);
  assert.equal(patch.total, 3);
});

test('runStatus 补丁：拉详情期间运行已结束只回填终态不点亮 running', () => {
  const patch = adoptRunStatusPatch({ status: 'success', nodeStates: {} }, 'run-4', 5);
  assert.deepEqual(patch, { running: false, runId: 'run-4', last: 'success' });
});

test('runStatus 补丁：graph 缺失时回退 currentTotal', () => {
  const patch = adoptRunStatusPatch({ status: 'running', nodeStates: { a: { status: 'success' } } }, 'run-5', 7);
  assert.equal(patch.total, 7);
  assert.equal(patch.done, 1);
});

test('终态种子：仅收 success/error/canceled/skipped，queued/running 不进集合', () => {
  const seed = seedTerminalNodeIds({
    a: { status: 'success' },
    b: { status: 'running' },
    c: { status: 'queued' },
    d: { status: 'error' },
    e: { status: 'canceled' },
    f: { status: 'skipped' },
  });
  assert.deepEqual([...seed].sort(), ['a', 'd', 'e', 'f']);
  assert.deepEqual([...seedTerminalNodeIds()], []);
});

console.log(`${passed} passed`);
