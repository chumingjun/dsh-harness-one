// 断点续跑（resume 种子）引擎离线单测。
// 用法：node test/engine-resume.test.mjs
import assert from 'node:assert/strict';
import { Orchestrator } from '../lib/engine.js';

const renderTemplate = (tpl, ctx) => {
  const upstream = ctx.incomingIds.length ? ctx.incomingIds.map((id) => `── 来自 [${ctx.labels.get(id) || id}] ──\n${ctx.outputs.get(id) || ''}`).join('\n\n') : '';
  let text = String(tpl ?? '');
  text = text.replaceAll('{{$upstream}}', upstream);
  for (const id of ctx.incomingIds) {
    const label = ctx.labels.get(id) || id;
    text = text.replaceAll(`{{${label}}}`, ctx.outputs.get(id) || '');
  }
  return { text };
};

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const makeOrch = (runner) => {
  const events = [];
  const orch = new Orchestrator(null, { onEvent: (e, p) => events.push([e, p]), renderTemplate });
  if (runner) orch.nodeRunner = runner;
  return { orch, events };
};

// 三节点链：in(输入) → mid(agent) → out(输出)；in 成功、mid 失败的“半程”运行
const chainGraph = () => ({
  nodes: [
    { id: 'in', type: 'input', data: { label: '输入', text: 'hello' } },
    { id: 'mid', type: 'agent', data: { label: '中转' } },
    { id: 'out', type: 'output', data: { label: '汇总' } },
  ],
  edges: [
    { source: 'in', target: 'mid' },
    { source: 'mid', target: 'out' },
  ],
});

console.log('engine resume tests:');

await test('续跑：success 节点免重跑，只执行未完成部分', async () => {
  const calls = [];
  const { orch: orch1 } = makeOrch(async (node) => {
    calls.push(node.id);
    if (node.id === 'mid') throw new Error('模拟中途失败');
    return `out:${node.id}`;
  });
  const first = await orch1.run(chainGraph(), { runId: 'run_half' });
  assert.equal(first.status, 'error');
  assert.equal(first.nodeStates.in.status, 'success');
  assert.equal(first.nodeStates.mid.status, 'error');
  assert.equal(first.nodeStates.out.status, 'skipped');

  // 续跑：mid 换成成功 runner；in 不应再执行
  const calls2 = [];
  const { orch: orch2, events } = makeOrch(async (node) => {
    calls2.push(node.id);
    return `out2:${node.id}`;
  });
  const resumed = await orch2.run(chainGraph(), {
    runId: 'run_resume',
    resume: {
      runId: 'run_half',
      nodeStates: first.nodeStates,
      outputs: first.outputs,
      structuredOutputs: first.structuredOutputs,
    },
  });
  assert.equal(resumed.status, 'success');
  assert.deepEqual(calls2, ['mid']); // in 未重跑（input/output 走内置执行器，runner 只拦 agent）
  // in 的输出被搬进新运行，out 能引用（渲染上游）
  assert.match(resumed.outputs.out, /out2:mid/);
  assert.equal(resumed.nodeStates.in.resumed, true);
  assert.equal(resumed.nodeStates.in.status, 'success');
  assert.equal(resumed.resumedFrom, 'run_half');
  // SSE：恢复节点发 success(resumed) 事件，前端能立即点亮
  const restored = events.find(([e, p]) => e === 'node-status' && p.resumed);
  assert.equal(restored[1].nodeId, 'in');
});

await test('续跑：条件分支跳过按原判定回放', async () => {
  // in → cond(条件) → a(true 分支)/b(false 分支)
  const graph = () => ({
    nodes: [
      { id: 'in', type: 'input', data: { label: '输入', text: '紧急报修' } },
      { id: 'cond', type: 'condition', data: { label: '判定', include: '紧急' } },
      { id: 'a', type: 'agent', data: { label: '加急' } },
      { id: 'b', type: 'agent', data: { label: '普通' } },
    ],
    edges: [
      { source: 'in', target: 'cond' },
      { source: 'cond', target: 'a', branch: 'true' },
      { source: 'cond', target: 'b', branch: 'false' },
    ],
  });
  // 第一次：in/cond 成功，a 失败
  const { orch: orch1 } = makeOrch(async (node) => {
    if (node.id === 'a') throw new Error('a 挂了');
    return `ok:${node.id}`;
  });
  const first = await orch1.run(graph(), { runId: 'run_branch' });
  assert.equal(first.nodeStates.b.status, 'skipped');

  // 续跑：cond 是 success，其 false 边依旧跳过 b；只重跑 a
  const calls = [];
  const { orch: orch2 } = makeOrch(async (node) => {
    calls.push(node.id);
    return `ok2:${node.id}`;
  });
  const resumed = await orch2.run(graph(), {
    runId: 'run_branch_resume',
    resume: {
      runId: 'run_branch',
      nodeStates: first.nodeStates,
      outputs: first.outputs,
      structuredOutputs: first.structuredOutputs,
    },
  });
  assert.equal(resumed.status, 'success');
  assert.deepEqual(calls, ['a']); // cond/b 都没重跑（b 维持 skipped）
  assert.equal(resumed.nodeStates.b.status, 'skipped');
});

await test('续跑种子为空对象时行为等同全新运行', async () => {
  const calls = [];
  const { orch } = makeOrch(async (node) => {
    calls.push(node.id);
    return `ok:${node.id}`;
  });
  const run = await orch.run(chainGraph(), { runId: 'run_fresh' });
  assert.equal(run.status, 'success');
  assert.deepEqual(calls, ['mid']); // 全新运行：agent 节点照常执行
  assert.equal(run.resumedFrom, undefined);
});

await test('续跑种子被裁剪时：不在种子里的 success 节点照常重跑', async () => {
  // 入口层按“子图指纹”裁剪失效节点后传入部分种子：mid 因自身被改被剔除，
  // 引擎应重跑 mid 并以其新输出渲染 out，同时 in 的旧输出照常复用。
  const { orch: orch1 } = makeOrch(async (node) => `old:${node.id}`);
  const first = await orch1.run(chainGraph(), { runId: 'run_prune' });
  assert.equal(first.status, 'success');

  const calls = [];
  const { orch: orch2 } = makeOrch(async (node) => {
    calls.push(node.id);
    return `new:${node.id}`;
  });
  const resumed = await orch2.run(chainGraph(), {
    runId: 'run_prune_resume',
    resume: {
      runId: 'run_prune',
      nodeStates: { in: first.nodeStates.in },
      outputs: { in: first.outputs.in },
      structuredOutputs: { in: first.structuredOutputs.in },
    },
  });
  assert.equal(resumed.status, 'success');
  assert.deepEqual(calls, ['mid']);
  assert.equal(resumed.nodeStates.in.resumed, true);
  assert.match(resumed.outputs.out, /new:mid/);
});

console.log(passed === 4 ? 'engine resume tests: ALL PASS' : 'engine resume tests: FAILED');
