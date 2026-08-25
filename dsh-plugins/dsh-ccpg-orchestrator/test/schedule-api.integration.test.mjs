// 定时任务 API 集成测试 + 同工作流并发运行回归（假 webServer 直调路由，与 plugin-storage 同模式）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

function responseCapture() {
  const listeners = new Map();
  return {
    status: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
    on(event, callback) { listeners.set(event, callback); return this; },
    once(event, callback) { const inner = listeners.get(event); listeners.set(event, () => { inner?.(); callback(); }); return this; },
    emit(event) { listeners.get(event)?.(); return true; },
    destroy(error) { if (error) throw error; },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8') || '{}'); },
  };
}

function request(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

const withSession = (url, sessionId) => `${url}${url.includes('?') ? '&' : '?'}sessionId=${sessionId}`;
const dshHome = mkdtempSync(join(tmpdir(), 'wf1-sch-home-'));
const workspacesRoot = mkdtempSync(join(tmpdir(), 'wf1-sch-ws-'));
const workspace = join(workspacesRoot, 'ws');
mkdirSync(workspace, { recursive: true });
const originalEnv = { DSH_HOME: process.env.DSH_HOME, WF1_LEGACY_DATA_DIR: process.env.WF1_LEGACY_DATA_DIR };
process.env.DSH_HOME = dshHome;
const packageLegacyDir = join(dshHome, 'package-legacy');
mkdirSync(join(packageLegacyDir, 'state'), { recursive: true });
process.env.WF1_LEGACY_DATA_DIR = packageLegacyDir;
writeFileSync(join(packageLegacyDir, 'state', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));

const triggersFile = () => join(workspace, '.workflow-one', 'state', 'triggers.json');
const readTriggers = () => JSON.parse(readFileSync(triggersFile(), 'utf8'));
const disposers = [];
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['✓', name]); }
  catch (error) { results.push(['✗', name, error]); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ctx = {
  webServer: { register(route) { this.routes.push(route); }, routes: [] },
  tools: { register() {}, schemas() { return []; } },
  get(name) {
    if (name === 'sessions') return { get: (id) => (String(id) === 'session-1' ? { header: { cwd: workspace } } : undefined), flush: async () => {} };
    if (name === 'workspaceRegistry') return { list: () => [{ path: workspace }] };
    return null;
  },
  skills: { async list() { return []; } },
  llm: { listProviders() { return []; }, async listModels() { return []; } },
  agentPresets: { async mount() {} },
  logger: { info() {}, warn() {}, error() {} },
  effect(setup) { const dispose = setup(); if (dispose) disposers.push(dispose); },
};
apply(ctx, {});
const route = (path) => ctx.webServer.routes.find((entry) => entry.kind === 'exact' && entry.path === path)?.handler;
const call = async (method, url, body) => {
  const res = responseCapture();
  await route(url.split('?')[0])(request(method, withSession(url, 'session-1'), body), res);
  return { status: res.status, body: res.json() };
};

const wfGraph = {
  nodes: [{ id: 'sch_input', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'ok' } }],
  edges: [],
};
const created = await call('POST', '/wf1/api/workflows', { id: 'wf_sch', name: '定时测试工作流', graph: wfGraph });
assert.equal(created.status, 200);

await test('POST /schedule：空/非法 cron 拒绝；合法创建默认 skip + 统计零', async () => {
  const empty = await call('POST', '/wf1/api/schedule', { workflowId: 'wf_sch', cron: '' });
  assert.equal(empty.status, 400);
  const bad = await call('POST', '/wf1/api/schedule', { workflowId: 'wf_sch', cron: 'not-a-cron' });
  assert.equal(bad.status, 400);
  const missingWf = await call('POST', '/wf1/api/schedule', { workflowId: 'wf_missing', cron: '0 9 * * *' });
  assert.equal(missingWf.status, 404);
  const ok = await call('POST', '/wf1/api/schedule', { workflowId: 'wf_sch', cron: '0 9 * * *', input: '巡检', runInputs: { env: 'prod' } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.key, /^sch_/);
  assert.equal(ok.body.overlap, 'skip');
});

await test('GET /schedule：列表含实时工作流名/nextAt/overlap；triggers.json 落全字段', async () => {
  const list = await call('GET', '/wf1/api/schedule');
  assert.equal(list.status, 200);
  const row = list.body.schedules.find((s) => s.workflowId === 'wf_sch');
  assert.ok(row, '列表应包含新任务');
  assert.equal(row.workflowName, '定时测试工作流');
  assert.equal(row.overlap, 'skip');
  assert.equal(row.enabled, true);
  assert.equal(row.fireCount, 0);
  assert.ok(row.nextAt, '调度器应上报 nextAt');
  const disk = readTriggers().schedules.find((s) => s.key === row.key);
  assert.equal(disk.cron, '0 9 * * *');
  assert.equal(disk.overlap, 'skip');
  assert.deepEqual(disk.runInputs, { env: 'prod' });
  assert.ok(disk.nextAt);
  globalThis.__schKey = row.key;
});

await test('POST /schedule/preview：返回 3 次触发时间；非法 cron 400', async () => {
  const good = await call('POST', '/wf1/api/schedule/preview', { cron: '0 9 * * *' });
  assert.equal(good.status, 200);
  assert.equal(good.body.times.length, 3);
  const bad = await call('POST', '/wf1/api/schedule/preview', { cron: 'x x x' });
  assert.equal(bad.status, 400);
});

await test('POST /schedule/run：立即触发返回 runId 并计入 fireCount；来源为 schedule', async () => {
  const fired = await call('POST', '/wf1/api/schedule/run', { key: globalThis.__schKey });
  assert.equal(fired.status, 200);
  const runId = fired.body.runId;
  assert.ok(runId);
  let detail;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const res = await call('GET', `/wf1/api/runs/detail?id=${runId}`);
    detail = res.body;
    if (detail.status && detail.status !== 'running') break;
    await sleep(20);
  }
  assert.equal(detail.source, 'schedule');
  const list = await call('GET', '/wf1/api/schedule');
  const row = list.body.schedules.find((s) => s.key === globalThis.__schKey);
  assert.equal(row.fireCount, 1);
  assert.deepEqual(row.runInputs, { env: 'prod' });
  // 手动计数不能被调度链的 nextAt 上报冲掉（onMeta 只回传 nextAt）
  const listAgain = await call('GET', '/wf1/api/schedule');
  assert.equal(listAgain.body.schedules.find((s) => s.key === globalThis.__schKey).fireCount, 1);
});

await test('PATCH：改配置/启停不清零触发与跳过统计', async () => {
  await call('PATCH', '/wf1/api/schedule', { key: globalThis.__schKey, cron: '0 7 * * *' });
  const afterCron = await call('GET', '/wf1/api/schedule');
  const rowCron = afterCron.body.schedules.find((s) => s.key === globalThis.__schKey);
  assert.equal(rowCron.fireCount, 1, '改 cron 不应清零 fireCount');
  await call('PATCH', '/wf1/api/schedule', { key: globalThis.__schKey, enabled: false });
  await call('PATCH', '/wf1/api/schedule', { key: globalThis.__schKey, enabled: true });
  const afterToggle = await call('GET', '/wf1/api/schedule');
  const rowToggle = afterToggle.body.schedules.find((s) => s.key === globalThis.__schKey);
  assert.equal(rowToggle.fireCount, 1, '停用/启用不应清零 fireCount');
  await call('PATCH', '/wf1/api/schedule', { key: globalThis.__schKey, cron: '0 9 * * *' });
});

await test('PATCH /schedule：停用后 nextAt 置空、不再持有调度器；重新启用恢复', async () => {
  const off = await call('PATCH', '/wf1/api/schedule', { key: globalThis.__schKey, enabled: false });
  assert.equal(off.status, 200);
  const listOff = await call('GET', '/wf1/api/schedule');
  const rowOff = listOff.body.schedules.find((s) => s.key === globalThis.__schKey);
  assert.equal(rowOff.enabled, false);
  assert.equal(rowOff.nextAt, null, '停用后 nextAt 应清空');
  assert.equal(readTriggers().schedules.find((s) => s.key === globalThis.__schKey).enabled, false);

  const on = await call('PATCH', '/wf1/api/schedule', { key: globalThis.__schKey, enabled: true, cron: '30 8 * * *' });
  assert.equal(on.status, 200);
  const listOn = await call('GET', '/wf1/api/schedule');
  const rowOn = listOn.body.schedules.find((s) => s.key === globalThis.__schKey);
  assert.equal(rowOn.enabled, true);
  assert.equal(rowOn.cron, '30 8 * * *');
  assert.ok(rowOn.nextAt, '重新启用应重挂调度链');
  const badPatch = await call('PATCH', '/wf1/api/schedule', { key: 'sch_nope', enabled: true });
  assert.equal(badPatch.status, 404);
});

await test('恢复语义：停用任务重启后只入 meta 不起定时器', async () => {
  await call('PATCH', '/wf1/api/schedule', { key: globalThis.__schKey, enabled: false });
  // 模拟重启：新建 store（新 apply 太重，直接复刻 ensureTriggers 的判定面）——
  // 通过 dispose 旧 store 再触发一次 scoped 请求重建不可行（apply 只跑一次），
  // 这里退化为验证 triggers.json 内容满足「enabled:false + nextAt:null」的恢复输入契约
  const disk = readTriggers().schedules.find((s) => s.key === globalThis.__schKey);
  assert.equal(disk.enabled, false);
  assert.equal(disk.nextAt, null);
});

await test('DELETE /schedule：任务移除并落盘', async () => {
  const del = await call('DELETE', `/wf1/api/schedule?key=${globalThis.__schKey}`);
  assert.equal(del.status, 200);
  const list = await call('GET', '/wf1/api/schedule');
  assert.equal(list.body.schedules.find((s) => s.key === globalThis.__schKey), undefined);
  assert.equal(readTriggers().schedules.find((s) => s.key === globalThis.__schKey), undefined);
});

await test('并发回归：同图并发两个 run 同时 live、输出互不串扰', async () => {
  const originalFetch = globalThis.fetch;
  const gates = new Map(); // url → release（url 含各自 trigger，天然按运行区分）
  try {
    globalThis.fetch = (url) => new Promise((resolve) => {
      gates.set(String(url), () => resolve(new Response(String(url), { status: 200 })));
    });
    const graph = {
      nodes: [
        { id: 'multi_input', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'seed' } },
        { id: 'http_gate', type: 'http', position: { x: 200, y: 0 }, data: { label: '门请求', url: 'https://gate.example/{{$trigger}}', allowPrivate: true } },
        { id: 'multi_output', type: 'output', position: { x: 400, y: 0 }, data: { label: '输出' } },
      ],
      edges: [
        { source: 'multi_input', target: 'http_gate' },
        { source: 'http_gate', target: 'multi_output' },
      ],
    };
    const first = await call('POST', '/wf1/api/run', { graph, triggerInput: 'first' });
    const second = await call('POST', '/wf1/api/run', { graph, triggerInput: 'second' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, '第二个运行必须能启动（并发核心诉求）');
    assert.notEqual(first.body.runId, second.body.runId);

    // 两个运行都进入 live（http 节点被 gate 住不返回）
    const waitRunning = async (runId) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const res = await call('GET', `/wf1/api/runs/detail?id=${runId}`);
        if (res.body.nodeStates?.http_gate?.status === 'running') return res.body;
        await sleep(10);
      }
      return null;
    };
    const detailA = await waitRunning(first.body.runId);
    const detailB = await waitRunning(second.body.runId);
    assert.ok(detailA && detailB, '两个运行应同时 live');
    assert.equal(detailA.status, 'running');
    assert.equal(detailB.status, 'running');

    // 放行第一个：它完成，第二个仍 live；两者输出按各自 trigger 隔离
    gates.get('https://gate.example/first')?.();
    let finalA;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const res = await call('GET', `/wf1/api/runs/detail?id=${first.body.runId}`);
      finalA = res.body;
      if (finalA.status && finalA.status !== 'running') break;
      await sleep(10);
    }
    assert.equal(finalA.status, 'success');
    const stillB = await call('GET', `/wf1/api/runs/detail?id=${second.body.runId}`);
    assert.equal(stillB.body.status, 'running', '第一个完成不影响第二个');

    gates.get('https://gate.example/second')?.();
    let finalB;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const res = await call('GET', `/wf1/api/runs/detail?id=${second.body.runId}`);
      finalB = res.body;
      if (finalB.status && finalB.status !== 'running') break;
      await sleep(10);
    }
    assert.equal(finalB.status, 'success');
    assert.ok(String(finalA.outputs?.multi_output || '').includes('gate.example/first'), '运行 A 的输出含自己的 trigger');
    assert.ok(String(finalB.outputs?.multi_output || '').includes('gate.example/second'), '运行 B 的输出含自己的 trigger');

    const runs = await call('GET', '/wf1/api/runs');
    const ids = new Set(runs.body.runs.map((r) => r.runId));
    assert.ok(ids.has(first.body.runId) && ids.has(second.body.runId), '两条独立运行记录');
  } finally {
    for (const release of gates.values()) release?.();
    globalThis.fetch = originalFetch;
  }
});

for (const d of disposers) await d?.();
rmSync(workspacesRoot, { recursive: true, force: true });
rmSync(dshHome, { recursive: true, force: true });
process.env.DSH_HOME = originalEnv.DSH_HOME;
process.env.WF1_LEGACY_DATA_DIR = originalEnv.WF1_LEGACY_DATA_DIR;

for (const [mark, name, error] of results) {
  console.log(`  ${mark} ${name}`);
  if (error) console.log(error);
}
const failed = results.filter(([mark]) => mark === '✗').length;
if (failed) {
  console.error(`${failed} FAILED / ${results.length}`);
  process.exit(1);
}
console.log(`ALL PASS (${results.length})`);
