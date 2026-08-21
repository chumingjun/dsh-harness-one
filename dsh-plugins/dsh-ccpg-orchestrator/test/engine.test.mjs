// 引擎离线单测：不依赖 dsh 运行时，agent 节点用 mock runner。
// 用法：node test/engine.test.mjs
import assert from 'node:assert/strict';
import { Orchestrator, lintGraph } from '../lib/engine.js';

const renderTemplate = (tpl, ctx) => {
  // 简化版：只替换 {{label}} 与 {{$upstream}}（引擎语义测试够用）
  const upstream = ctx.incomingIds.length ? ctx.incomingIds.map((id) => `── 来自 [${ctx.labels.get(id) || id}] ──\n${ctx.outputs.get(id) || ''}`).join('\n\n') : '';
  let text = String(tpl ?? '');
  // $upstream 无上游渲染为空串（对齐 template.js，不能留字面量）
  text = text.replaceAll('{{$upstream}}', upstream);
  for (const id of ctx.incomingIds) {
    const label = ctx.labels.get(id) || id;
    text = text.replaceAll(`{{${label}}}`, ctx.outputs.get(id) || '');
  }
  text = text.replaceAll('{{$trigger}}', ctx.triggerInput || '');
  text = text.replaceAll('{{vars.global["g"]}}', String(ctx.globalVariables?.g ?? ''));
  text = text.replaceAll('{{vars.workflow["w"]}}', String(ctx.workflowVariables?.w ?? ''));
  text = text.replaceAll('{{inputs["i"]}}', String(ctx.runInputs?.i ?? ''));
  return { text };
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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

console.log('engine tests:');

await test('scoped execution context renders and persists runInputs only', async () => {
  const { orch } = makeOrch();
  const run = await orch.run({
    nodes: [{ id: 'in', type: 'input', data: { text: '{{vars.global["g"]}}/{{vars.workflow["w"]}}/{{inputs["i"]}}' } }],
    edges: [],
  }, { globalVariables: { g: 0 }, workflowVariables: { w: false }, runInputs: { i: '' } });
  assert.match(run.outputs.in, /0\/false\//);
  assert.deepEqual(run.runInputs, { i: '' });
  assert.equal(Object.prototype.hasOwnProperty.call(run, 'globalVariables'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(run, 'workflowVariables'), false);
});

await test('顺序执行 + 输出节点汇总', async () => {
  const { orch } = makeOrch(async (node) => ({ output: `[${node.data.label}] done` }));
  const run = await orch.run({
    nodes: [
      { id: 'a', type: 'input', data: { label: '输入', text: 'hello' } },
      { id: 'b', type: 'agent', data: { label: 'B' } },
      { id: 'c', type: 'output', data: { label: 'C' } },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'c' }],
  });
  assert.equal(run.status, 'success');
  assert.ok(run.outputs.a.includes('hello'));
  assert.equal(run.outputs.b, '[B] done');
  assert.ok(run.outputs.c.includes('[B] done'));
});

await test('条件分支：include 命中走 true，另一侧跳过', async () => {
  const { orch } = makeOrch(async (node) => ({ output: `[${node.data.label}]` }));
  const run = await orch.run({
    nodes: [
      { id: 'a', type: 'input', data: { label: 'A', text: '紧急漏水报修' } },
      { id: 'cond', type: 'condition', data: { label: '判断', include: '紧急' } },
      { id: 'hi', type: 'agent', data: { label: '紧急处理' } },
      { id: 'lo', type: 'agent', data: { label: '常规处理' } },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'cond' },
      { id: 'e2', source: 'cond', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'cond', target: 'lo', branch: 'false' },
    ],
  });
  assert.equal(run.status, 'success');
  assert.equal(run.nodeStates.hi.status, 'success');
  assert.equal(run.nodeStates.lo.status, 'skipped');
});

await test('条件分支 false 路径也工作', async () => {
  const { orch } = makeOrch(async (node) => ({ output: `[${node.data.label}]` }));
  const run = await orch.run({
    nodes: [
      { id: 'a', type: 'input', data: { label: 'A', text: '一般咨询' } },
      { id: 'cond', type: 'condition', data: { label: '判断', include: '紧急' } },
      { id: 'hi', type: 'agent', data: { label: 'H' } },
      { id: 'lo', type: 'agent', data: { label: 'L' } },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'cond' },
      { id: 'e2', source: 'cond', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'cond', target: 'lo', branch: 'false' },
    ],
  });
  assert.equal(run.nodeStates.hi.status, 'skipped');
  assert.equal(run.nodeStates.lo.status, 'success');
  assert.equal(run.status, 'success');
});

await test('失败传播：一个上游失败另一个成功 → 下游照常执行', async () => {
  const { orch } = makeOrch(async (node) => {
    if (node.data.label === '坏') throw new Error('boom');
    return { output: 'ok' };
  });
  const run = await orch.run({
    nodes: [
      { id: 'bad', type: 'agent', data: { label: '坏' } },
      { id: 'good', type: 'agent', data: { label: '好' } },
      { id: 'join', type: 'agent', data: { label: '合并' } },
    ],
    edges: [
      { id: 'e1', source: 'bad', target: 'join' },
      { id: 'e2', source: 'good', target: 'join' },
    ],
  });
  assert.equal(run.nodeStates.bad.status, 'error');
  assert.equal(run.nodeStates.join.status, 'success');
  assert.equal(run.status, 'error'); // 有 error 节点 → 运行整体 error
});

await test('失败传播：全部上游失败 → 下游跳过且计数不泄漏', async () => {
  const { orch } = makeOrch(async () => { throw new Error('boom'); });
  const run = await orch.run({
    nodes: [
      { id: 'b1', type: 'agent', data: { label: 'B1' } },
      { id: 'b2', type: 'agent', data: { label: 'B2' } },
      { id: 'join', type: 'agent', data: { label: 'J' } },
      { id: 'tail', type: 'output', data: { label: 'T' } },
    ],
    edges: [
      { id: 'e1', source: 'b1', target: 'join' },
      { id: 'e2', source: 'b2', target: 'join' },
      { id: 'e3', source: 'join', target: 'tail' },
    ],
  });
  assert.equal(run.nodeStates.b1.status, 'error');
  assert.equal(run.nodeStates.b2.status, 'error');
  assert.equal(run.nodeStates.join.status, 'skipped');
  assert.equal(run.nodeStates.tail.status, 'skipped');
});

await test('取消：运行中 cancel → 未开始节点 canceled，运行结束', async () => {
  const { orch } = makeOrch(async (node, run, s, ctl) => {
    if (node.id === 'slow') {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        ctl.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      throw new Error('运行已取消');
    }
    return { output: 'x' };
  });
  const p = orch.run({
    nodes: [
      { id: 'slow', type: 'agent', data: { label: 'S', timeoutSec: 10 } },
      { id: 'after', type: 'agent', data: { label: 'A' } },
    ],
    edges: [{ id: 'e1', source: 'slow', target: 'after' }],
  });
  await delay(150);
  orch.cancel('nonexistent'); // 不存在的 id 应返回 false
  const runId = orch.currentRunIds()[0];
  assert.ok(runId, '应有进行中运行');
  orch.cancel(runId, '用户取消');
  const run = await p;
  assert.equal(run.canceled, true);
  assert.equal(run.status, 'canceled');
});

await test('并发上限：4 槽位，6 就绪节点不超发', async () => {
  let inflight = 0;
  let peak = 0;
  const { orch } = makeOrch(async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    await delay(80);
    inflight--;
    return { output: 'ok' };
  });
  const graph = {
    nodes: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, type: 'agent', data: { label: `N${i}` } })),
    edges: [],
  };
  const run = await orch.run(graph);
  assert.equal(run.status, 'success');
  assert.ok(peak <= 4, `峰值并发 ${peak} 应 ≤ 4`);
  assert.ok(peak >= 2, '应有并发发生');
});

await test('节点超时：timeoutSec 生效', async () => {
  const { orch } = makeOrch(async () => { await delay(5000); return { output: 'late' }; });
  const run = await orch.run({
    nodes: [{ id: 't', type: 'agent', data: { label: 'T', timeoutSec: 1 } }],
    edges: [],
  });
  assert.equal(run.nodeStates.t.status, 'error');
  assert.match(run.nodeStates.t.error, /超时/);
});

await test('环检测：有环拒绝执行', async () => {
  const { orch } = makeOrch(async () => ({ output: 'x' }));
  const run = await orch.run({
    nodes: [
      { id: 'a', type: 'agent', data: { label: 'A' } },
      { id: 'b', type: 'agent', data: { label: 'B' } },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
  });
  assert.equal(run.status, 'error');
  assert.match(run.error, /环/);
});

await test('未知节点类型：lint error 且运行时失败，不回落 agent runner', async () => {
  let runnerCalls = 0;
  const { orch } = makeOrch(async () => {
    runnerCalls += 1;
    return { output: 'should not run' };
  });
  const graph = {
    nodes: [{ id: 'mystery', type: 'not-registered', data: { label: '未知', continueOnFail: true } }],
    edges: [],
  };
  const lint = lintGraph(graph);
  assert.equal(lint.ok, false);
  assert.equal(lint.issues.find((issue) => issue.nodeId === 'mystery')?.level, 'error');
  assert.match(lint.issues.map((issue) => issue.message).join('\n'), /未知节点类型/);

  const run = await orch.run(graph);
  assert.equal(run.status, 'error');
  assert.equal(run.nodeStates.mystery.status, 'error');
  assert.match(run.nodeStates.mystery.error, /未知节点类型/);
  assert.equal(runnerCalls, 0);
});

await test('已注册 agent 类型仍通过注入 runner 执行', async () => {
  let runnerCalls = 0;
  const { orch } = makeOrch(async (node) => {
    runnerCalls += 1;
    return { output: `agent:${node.id}` };
  });
  const graph = {
    nodes: [{ id: 'registered-agent', type: 'agent', data: { label: 'Agent', prompt: 'work' } }],
    edges: [],
  };
  assert.equal(lintGraph(graph).ok, true);
  const run = await orch.run(graph);
  assert.equal(run.status, 'success');
  assert.equal(run.outputs['registered-agent'], 'agent:registered-agent');
  assert.equal(runnerCalls, 1);
});

await test('lint：模板引用缺失/空提示词/孤立输出可检出', () => {
  const r = lintGraph({
    nodes: [
      { id: 'a', type: 'agent', data: { label: 'A', prompt: '' } },
      { id: 'b', type: 'agent', data: { label: 'B', prompt: 'x', inputTemplate: '{{不存在}}' } },
      { id: 'c', type: 'output', data: { label: 'C' } },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  });
  assert.equal(r.ok, true); // 无 error 级
  const msgs = r.issues.map((i) => i.message).join('\n');
  assert.match(msgs, /未填写提示词/);
  assert.match(msgs, /没有该节点/);
  assert.match(msgs, /没有上游连线/);
});

await test('outputSink：输出节点后处理被调用并可改写输出', async () => {
  const { orch } = makeOrch(async () => ({ output: 'x' }));
  let sinkCalled = false;
  orch.outputSink = async (node, output) => {
    sinkCalled = true;
    assert.equal(node.type, 'output');
    return { output: `${output}+SINK`, writeback: { ok: true } };
  };
  const run = await orch.run({
    nodes: [{ id: 'out', type: 'output', data: { label: '输出' } }],
    edges: [],
  });
  assert.ok(sinkCalled);
  assert.ok(run.outputs.out.includes('+SINK'));
  assert.deepEqual(run.nodeStates.out.writeback, { ok: true });
});

await test('HTTP 节点：真实请求本地服务（allowPrivate 放行）', async () => {
  // 起一个一次性 HTTP 服务
  const srv = (await import('node:http')).createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ echoed: buf || null, method: req.method, path: req.url }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const { orch } = makeOrch(null);
  const run = await orch.run({
    nodes: [
      { id: 'h', type: 'http', data: { label: '调用', url: `http://127.0.0.1:${port}/ping?x=1`, method: 'POST', body: '{"k":"v"}', allowPrivate: true } },
    ],
    edges: [],
  });
  srv.close();
  assert.equal(run.status, 'success');
  const out = run.outputs.h;
  assert.ok(out.includes('HTTP 200'), `应含状态行: ${out.slice(0, 60)}`);
  assert.ok(out.includes('\"method\":\"POST\"'));
});

await test('HTTP 配置字段不自动拼接上游输出', async () => {
  let seenUrl = '';
  const srv = (await import('node:http')).createServer((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { orch } = makeOrch(null);
  const run = await orch.run({
    nodes: [
      { id: 'in', type: 'input', data: { text: '不能进入 URL' } },
      { id: 'h', type: 'http', data: { url: `http://127.0.0.1:${srv.address().port}/case`, allowPrivate: true } },
    ],
    edges: [{ source: 'in', target: 'h' }],
  });
  srv.close();
  assert.equal(run.status, 'success');
  assert.equal(seenUrl, '/case');
});

await test('HTTP 节点：结构化响应过滤敏感 headers', async () => {
  const srv = (await import('node:http')).createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'secret=1', Authorization: 'Bearer secret', 'X-Safe': 'yes' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { orch } = makeOrch(null);
  const run = await orch.run({ nodes: [{ id: 'h', type: 'http', data: { url: `http://127.0.0.1:${srv.address().port}/`, allowPrivate: true } }], edges: [] });
  srv.close();
  const headers = run.structuredOutputs.h.value.headers;
  assert.equal(headers['set-cookie'], undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-safe'], 'yes');
  assert.deepEqual(run.structuredOutputs.h.value.json, { ok: true });
});

await test('HTTP 节点：SSRF 防护拦截内网地址', async () => {
  const { orch } = makeOrch(null);
  const run = await orch.run({
    nodes: [{ id: 'h4', type: 'http', data: { label: '内网', url: 'http://127.0.0.1:9/x' } }],
    edges: [],
  });
  assert.equal(run.nodeStates.h4.status, 'error');
  assert.match(run.nodeStates.h4.error, /内网/);
});

await test('HTTP 节点：非 2xx 默认算失败，failOnError=false 放行', async () => {
  const srv = (await import('node:http')).createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'BOOM' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const { orch } = makeOrch(null);
  const run1 = await orch.run({
    nodes: [{ id: 'x1', type: 'http', data: { label: 'A', url: `http://127.0.0.1:${port}/`, allowPrivate: true } }],
    edges: [],
  });
  assert.equal(run1.nodeStates.x1.status, 'error');
  assert.match(run1.nodeStates.x1.error, /HTTP 500/);
  const run2 = await orch.run({
    nodes: [{ id: 'x2', type: 'http', data: { label: 'B', url: `http://127.0.0.1:${port}/`, allowPrivate: true, failOnError: false } }],
    edges: [],
  });
  srv.close();
  assert.equal(run2.status, 'success');
  assert.ok(run2.outputs.x2.includes('HTTP 500'));
});

await test('重试：retryCount=2 → 失败两次第三次成功', async () => {
  let calls = 0;
  const { orch, events } = makeOrch(async () => {
    calls += 1;
    if (calls < 3) throw new Error('模拟抖动');
    return { output: '终于成功' };
  });
  const run = await orch.run({
    nodes: [{ id: 'r', type: 'agent', data: { label: 'R', retryCount: 2 } }],
    edges: [],
  });
  assert.equal(run.status, 'success');
  assert.equal(calls, 3);
  const retries = events.filter(([e, p]) => e === 'node-status' && p.retrying);
  assert.equal(retries.length, 2, '应发出 2 次重试事件');
});

await test('重试耗尽：仍失败 → error，下游跳过', async () => {
  let calls = 0;
  const { orch } = makeOrch(async () => { calls += 1; throw new Error('一直失败'); });
  const run = await orch.run({
    nodes: [
      { id: 'r', type: 'agent', data: { label: 'R', retryCount: 2 } },
      { id: 'd', type: 'output', data: { label: 'D' } },
    ],
    edges: [{ id: 'e', source: 'r', target: 'd' }],
  });
  assert.equal(calls, 3);
  assert.equal(run.nodeStates.r.status, 'error');
  assert.equal(run.nodeStates.d.status, 'skipped');
});

await test('失败继续：continueOnFail → 节点 success，下游照常执行', async () => {
  const { orch } = makeOrch(async (node) => {
    if (node.id === 'f') throw new Error('故意失败');
    return { output: `[${node.data.label}]` };
  });
  const run = await orch.run({
    nodes: [
      { id: 'f', type: 'agent', data: { label: 'F', continueOnFail: true } },
      { id: 'd', type: 'output', data: { label: 'D', inputTemplate: '{{F}}' } },
    ],
    edges: [{ id: 'e', source: 'f', target: 'd' }],
  });
  assert.equal(run.status, 'success');
  assert.equal(run.nodeStates.f.status, 'success');
  assert.ok(run.nodeStates.f.toleratedError);
  assert.ok(String(run.outputs.d).includes('节点失败后继续'));
});

await test('注释节点：passThrough 不执行、透传上游', async () => {
  const { orch } = makeOrch(null);
  const run = await orch.run({
    nodes: [
      { id: 'a', type: 'input', data: { label: '输入', text: 'hello' } },
      { id: 'n', type: 'note', data: { label: '便签', text: '流程说明' } },
      { id: 'c', type: 'output', data: { label: 'C', inputTemplate: '收到：{{便签}}' } },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'n' }, { id: 'e2', source: 'n', target: 'c' }],
  });
  assert.equal(run.status, 'success');
  assert.equal(run.nodeStates.n.status, 'success');
  assert.ok(run.nodeStates.n.passThrough);
  assert.ok(String(run.outputs.n).includes('hello'), '注释节点应透传上游输出');
  assert.ok(String(run.outputs.c).includes('hello'), '下游经注释节点引用上游');
  // lint：注释节点不产生检查项
  const r = lintGraph({
    nodes: [{ id: 'n2', type: 'note', data: { label: '孤立便签' } }],
    edges: [],
  });
  assert.equal(r.ok, true);
});

await test('JSON 路径引用：{{节点.json.字段}} 从上游输出提取', async () => {
  // template.js 真实实现（不走简化 mock）
  const { renderTemplate } = await import('../lib/template.js');
  const r = renderTemplate('code={{API.json.code}} name={{API.json.data.items.0.name}}', {
    outputs: new Map([['a', 'HTTP 200\n{"code":200,"data":{"items":[{"name":"水槽报修"}]}}']]),
    labels: new Map([['a', 'API']]),
    incomingIds: ['a'],
    triggerInput: '',
  });
  assert.equal(r.text, 'code=200 name=水槽报修');
  assert.deepEqual(r.missing, []);
  const bad = renderTemplate('{{API.json.nope}}', {
    outputs: new Map([['a', 'HTTP 200\n{"code":1}']]),
    labels: new Map([['a', 'API']]),
    incomingIds: ['a'],
    triggerInput: '',
  });
  assert.ok(bad.missing.includes('API.json.nope'), '路径不存在应计入 missing');
});

await test('重试计数跨次运行不残留', async () => {
  let calls = 0;
  const { orch } = makeOrch(async () => { calls += 1; throw new Error('失败'); });
  const graph = { nodes: [{ id: 'r', type: 'agent', data: { label: 'R', retryCount: 1 } }], edges: [] };
  await orch.run(graph);
  await orch.run(graph); // 同一 graph 对象复用（webhook/schedule 场景）
  assert.equal(calls, 4, '每次运行都应有 2 次调用（1 次 + 1 重试）');
});

await test('HTTP 节点：非法 URL 报错', async () => {
  const { orch } = makeOrch(null);
  const run = await orch.run({
    nodes: [{ id: 'h2', type: 'http', data: { label: '坏URL', url: 'ftp://x' } }],
    edges: [],
  });
  assert.equal(run.nodeStates.h2.status, 'error');
  assert.match(run.nodeStates.h2.error, /合法 URL/);
});

await test('lint：HTTP 节点缺 URL 为 error', () => {
  const r = lintGraph({
    nodes: [{ id: 'h3', type: 'http', data: { label: 'H' } }],
    edges: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.issues.map((i) => i.message).join('\n'), /未配置 URL/);
});

await test('运行结果保留字符串输出并写入 v2 structured envelope', async () => {
  const { orch } = makeOrch(async () => ({
    output: 'agent text',
    structuredOutput: { version: 1, type: 'json', value: { ticket: 42 } },
  }));
  const run = await orch.run({ nodes: [{ id: 'a', type: 'agent', data: { label: 'A' } }], edges: [] });
  assert.equal(run.schemaVersion, 2);
  assert.equal(run.outputs.a, 'agent text');
  assert.deepEqual(run.structuredOutputs.a, { version: 1, type: 'json', value: { ticket: 42 } });
});

await test('sink merge 保留结构值与 extra，且不能覆盖引擎保留字段', async () => {
  const { orch } = makeOrch(null);
  orch.outputSink = async (_node, output) => ({ output: `${output}!`, status: 'evil', chars: 999, writeback: { ok: true } });
  const run = await orch.run({ nodes: [{ id: 'out', type: 'output', data: { label: 'O' } }], edges: [] });
  assert.equal(run.nodeStates.out.status, 'success');
  assert.equal(run.nodeStates.out.chars, run.outputs.out.length);
  assert.deepEqual(run.nodeStates.out.writeback, { ok: true });
  assert.equal(run.structuredOutputs.out.type, 'text');
  assert.equal(run.structuredOutputs.out.value, run.outputs.out);
});

await test('input 不重复注入 trigger 和隐式 upstream', async () => {
  const { orch } = makeOrch(null);
  const run = await orch.run({
    nodes: [
      { id: 'a', type: 'input', data: { label: 'A', text: 'upstream' } },
      { id: 'b', type: 'input', data: { label: 'B', text: 'trigger={{$trigger}}' } },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  }, { triggerInput: 'T' });
  assert.equal((run.outputs.b.match(/upstream/g) || []).length, 0);
  assert.equal((run.outputs.b.match(/T/g) || []).length, 1);
  assert.deepEqual(run.structuredOutputs.b.value.triggerInput, 'T');
});

await test('condition 与 HTTP 首批结构化输出可用', async () => {
  const { orch } = makeOrch(null);
  const run = await orch.run({
    nodes: [
      { id: 'i', type: 'input', data: { label: 'I', text: '紧急' } },
      { id: 'c', type: 'condition', data: { label: 'C', include: '紧急' } },
    ],
    edges: [{ id: 'e', source: 'i', target: 'c' }],
  });
  assert.equal(run.structuredOutputs.c.value.branch, 'true');
  assert.equal(run.structuredOutputs.c.type, 'json');
});

await test('lint 检出 canonical 非直接上游与无效 agent schema', () => {
  const r = lintGraph({
    nodes: [
      { id: 'a', type: 'input', data: { label: 'A' } },
      { id: 'b', type: 'input', data: { label: 'B' } },
      { id: 'c', type: 'agent', data: { label: 'C', inputTemplate: '{{node["a"].data.x}}', outputMode: 'structured', outputSchema: '{bad' } },
    ],
    edges: [{ id: 'e', source: 'b', target: 'c' }],
  });
  assert.equal(r.ok, false);
  const messages = r.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /只能引用直接上游/);
  assert.match(messages, /Schema 无效/);
});

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
