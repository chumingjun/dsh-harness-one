// webhook 对接加固集成测试（假 webServer 直调路由，与 schedule-api 同模式）：
// HMAC 签名 / timing-safe token / 幂等键 / 完成回调 / PATCH 配置 / 统一起跑校验。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, verifyHookSignature, matchHookIdempotency, buildHookCallbackPayload, secureTokenMatch } from '../lib/index.js';

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

// rawRequest：支持任意 Buffer body + 自定义 headers（HMAC 必须对原始字节签名）
function rawRequest(method, url, { raw, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  queueMicrotask(() => {
    if (raw !== undefined) req.emit('data', Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    req.emit('end');
  });
  return req;
}

const withSession = (url, sessionId) => `${url}${url.includes('?') ? '&' : '?'}sessionId=${sessionId}`;
const dshHome = mkdtempSync(join(tmpdir(), 'wf1-hook-home-'));
const workspacesRoot = mkdtempSync(join(tmpdir(), 'wf1-hook-ws-'));
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
const exactRoute = (path) => ctx.webServer.routes.find((entry) => entry.kind === 'exact' && entry.path === path)?.handler;
const prefixRoute = (path) => ctx.webServer.routes.find((entry) => entry.kind === 'prefix' && entry.path === path)?.handler;
const call = async (method, url, body) => {
  const res = responseCapture();
  await exactRoute(url.split('?')[0])(rawRequest(method, withSession(url, 'session-1'), { raw: JSON.stringify(body ?? {}) }), res);
  return { status: res.status, body: res.json() };
};
// webhook 触发路由（scoped:false，不需要 sessionId）
const fire = async ({ method = 'POST', hookId, token, body, headers = {} }) => {
  const res = responseCapture();
  const url = `/wf1/api/hooks/${hookId}${token ? `?token=${token}` : ''}`;
  const req = rawRequest(method, url, {
    raw: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
  await prefixRoute('/wf1/api/hooks')(req, res);
  return { status: res.status, body: res.json() };
};
const hmacHeaders = (secret, rawBody, { ts = Math.floor(Date.now() / 1000) } = {}) => ({
  'x-wf1-signature': `sha256=${createHmac('sha256', secret).update(rawBody).update(String(ts)).digest('hex')}`,
  'x-wf1-timestamp': String(ts),
});

const wfGraph = {
  nodes: [{ id: 'hk_input', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'ok' } }],
  edges: [],
};
const created = await call('POST', '/wf1/api/workflows', { id: 'wf_hook', name: 'webhook测试工作流', graph: wfGraph });
assert.equal(created.status, 200);
const hookCreated = await call('POST', '/wf1/api/hooks', { workflowId: 'wf_hook' });
assert.equal(hookCreated.status, 200);
const hookId = hookCreated.body.id;
const hookToken = hookCreated.body.token;

// ---- 纯函数 ----

await test('纯函数：secureTokenMatch 常数时间比较', () => {
  assert.equal(secureTokenMatch(hookToken, hookToken), true);
  assert.equal(secureTokenMatch(hookToken + 'x', hookToken), false);
  assert.equal(secureTokenMatch('', hookToken), false);
  assert.equal(secureTokenMatch(hookToken, ''), false);
});

await test('纯函数：verifyHookSignature 签名/时间窗判定', () => {
  const secret = 's'.repeat(16);
  const raw = Buffer.from('{"input":"x"}');
  const ok = hmacHeaders(secret, raw);
  assert.equal(verifyHookSignature({ signingSecret: secret, raw, signatureHeader: ok['x-wf1-signature'], timestampHeader: ok['x-wf1-timestamp'] }), null);
  assert.match(verifyHookSignature({ signingSecret: secret, raw, signatureHeader: '', timestampHeader: '' }), /X-WF1-Signature/);
  assert.match(verifyHookSignature({ signingSecret: secret, raw, signatureHeader: 'sha256=' + '0'.repeat(64), timestampHeader: ok['x-wf1-timestamp'] }), /签名不匹配/);
  assert.match(verifyHookSignature({ signingSecret: secret, raw, signatureHeader: ok['x-wf1-signature'], timestampHeader: String(Math.floor(Date.now() / 1000) - 3600) }), /时间窗/);
  assert.equal(verifyHookSignature({ signingSecret: '', raw }), null, '未配 secret 直接通过');
});

await test('纯函数：matchHookIdempotency 窗口与 key 判定', () => {
  const now = Date.now();
  const hook = { lastIdempotency: { key: 'k1', runId: 'run_a', at: new Date(now - 1000).toISOString() } };
  assert.equal(matchHookIdempotency(hook, 'k1', now), 'run_a');
  assert.equal(matchHookIdempotency(hook, 'k2', now), null);
  const stale = { lastIdempotency: { key: 'k1', runId: 'run_a', at: new Date(now - 25 * 3600 * 1000).toISOString() } };
  assert.equal(matchHookIdempotency(stale, 'k1', now), null, '窗口外不命中');
  assert.equal(matchHookIdempotency({ lastIdempotency: undefined }, 'k1', now), null);
  assert.equal(matchHookIdempotency(hook, '', now), null);
});

await test('纯函数：buildHookCallbackPayload 脱敏与截断', () => {
  const payload = buildHookCallbackPayload({ hookId: 'hk_x', run: { runId: 'r1', status: 'success', summary: 'password=abc123 完成' } });
  assert.equal(payload.event, 'workflow_run.finished');
  assert.equal(payload.hookId, 'hk_x');
  assert.equal(payload.status, 'success');
  assert.ok(!payload.summary.includes('abc123'), 'secret 必须脱敏');
});

// ---- 路由行为 ----

await test('token 错误 401；正确触发 200 且 source=webhook（走过 lint 校验链）', async () => {
  const denied = await fire({ hookId, token: 'wrong', body: { input: 'x' } });
  assert.equal(denied.status, 401);
  const ok = await fire({ hookId, token: hookToken, body: { input: '巡检' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.runId);
  globalThis.__hookRunId = ok.body.runId;
  let detail;
  for (let i = 0; i < 30; i += 1) {
    const res = await call('GET', `/wf1/api/runs/detail?id=${ok.body.runId}`);
    detail = res.body;
    if (detail.status && detail.status !== 'running') break;
    await sleep(20);
  }
  assert.equal(detail.source, 'webhook');
});

await test('PATCH：配置 signingSecret/callbackUrl 落盘可重载；GET 脱敏不回传 secret', async () => {
  const patched = await call('PATCH', '/wf1/api/hooks', { id: hookId, signingSecret: 'topsecret-16-chars-min', callbackUrl: 'http://127.0.0.1:19999/done' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.hasSigningSecret, true);
  const disk = readTriggers().hooks.find((h) => h.id === hookId);
  assert.equal(disk.signingSecret, 'topsecret-16-chars-min');
  assert.equal(disk.callbackUrl, 'http://127.0.0.1:19999/done');
  const list = await call('GET', '/wf1/api/hooks');
  const row = list.body.hooks.find((h) => h.id === hookId);
  assert.equal(row.signingSecret, undefined, 'GET 不得回传 secret');
  assert.equal(row.hasSigningSecret, true);
  const short = await call('PATCH', '/wf1/api/hooks', { id: hookId, signingSecret: 'too-short' });
  assert.equal(short.status, 400);
  const badUrl = await call('PATCH', '/wf1/api/hooks', { id: hookId, callbackUrl: 'javascript:alert(1)' });
  assert.equal(badUrl.status, 400);
  const missing = await call('PATCH', '/wf1/api/hooks', { id: 'hk_none', signingSecret: 'x'.repeat(20) });
  assert.equal(missing.status, 404);
});

await test('HMAC：签名缺失/错误 401；正确签名 200；GET 空体也可签名', async () => {
  const body = { input: 'signed' };
  const raw = Buffer.from(JSON.stringify(body));
  const noSig = await fire({ hookId, token: hookToken, body });
  assert.equal(noSig.status, 401);
  assert.match(noSig.body.error, /验签失败/);
  const badSig = await fire({ hookId, token: hookToken, body, headers: hmacHeaders('wrong-secret-16chars!', raw) });
  assert.equal(badSig.status, 401);
  const ok = await fire({ hookId, token: hookToken, body, headers: hmacHeaders('topsecret-16-chars-min', raw) });
  assert.equal(ok.status, 200);
  const getOk = await fire({ method: 'GET', hookId, token: hookToken, headers: hmacHeaders('topsecret-16-chars-min', Buffer.alloc(0)) });
  assert.equal(getOk.status, 200);
});

await test('幂等：同 key 复用首次 runId 不起新 run；异 key 正常起跑', async () => {
  const first = await fire({
    hookId, token: hookToken, body: { input: 'job1' },
    headers: { 'idempotency-key': 'op-42', ...hmacHeaders('topsecret-16-chars-min', Buffer.from(JSON.stringify({ input: 'job1' }))) },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.idempotent, undefined);
  const firstRunId = first.body.runId;
  const replayBody = Buffer.from(JSON.stringify({ input: 'job1' }));
  const replay = await fire({
    hookId, token: hookToken, body: { input: 'job1' },
    headers: { 'idempotency-key': 'op-42', ...hmacHeaders('topsecret-16-chars-min', replayBody) },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.runId, firstRunId, '同 key 复用首次 runId');
  assert.equal(replay.body.idempotent, true);
  const disk = readTriggers().hooks.find((h) => h.id === hookId);
  assert.equal(disk.lastIdempotency.key, 'op-42');
  assert.equal(disk.lastIdempotency.runId, firstRunId);
  const otherBody = Buffer.from(JSON.stringify({ input: 'job2' }));
  const other = await fire({
    hookId, token: hookToken, body: { input: 'job2' },
    headers: { 'idempotency-key': 'op-43', ...hmacHeaders('topsecret-16-chars-min', otherBody) },
  });
  assert.equal(other.status, 200);
  assert.notEqual(other.body.runId, firstRunId);
});

await test('完成回调：终态 POST callbackUrl；失败只记元数据不影响运行', async () => {
  // 前序测试起的 run 可能仍有迟到回调：先排空（等所有活跃 run 到终态）
  for (let i = 0; i < 50; i += 1) {
    const res = await call('GET', '/wf1/api/runs');
    if (!(res.body.runs || []).some((r) => r.status === 'running')) break;
    await sleep(20);
  }
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  try {
    const body = JSON.stringify({ input: 'cb' });
    const fired = await fire({
      hookId, token: hookToken, body: { input: 'cb' },
      headers: { ...hmacHeaders('topsecret-16-chars-min', Buffer.from(body)) },
    });
    assert.equal(fired.status, 200);
    for (let i = 0; i < 50 && !calls.some((c) => c.body.runId === fired.body.runId); i += 1) await sleep(20);
    const mine = calls.find((c) => c.body.runId === fired.body.runId);
    assert.ok(mine, '本次触发的回调已发送');
    assert.equal(mine.url, 'http://127.0.0.1:19999/done');
    assert.equal(mine.body.event, 'workflow_run.finished');
    assert.equal(mine.body.hookId, hookId);
    assert.ok(['success', 'error', 'canceled'].includes(mine.body.status), '回调带终态');
  } finally {
    globalThis.fetch = originalFetch;
  }
  // 回调目标不可达：触发仍 200，运行状态不受影响
  const failBody = JSON.stringify({ input: 'cb-fail' });
  const unreachable = await fire({
    hookId, token: hookToken, body: { input: 'cb-fail' },
    headers: { ...hmacHeaders('topsecret-16-chars-min', Buffer.from(failBody)) },
  });
  assert.equal(unreachable.status, 200);
});

await test('统一校验：坏图工作流的 hook 触发返回 422', async () => {
  const badGraph = { nodes: [{ id: 'n1', type: 'http', position: { x: 0, y: 0 }, data: { label: '坏节点', url: '' } }], edges: [] };
  const wfBad = await call('POST', '/wf1/api/workflows', { id: 'wf_hook_bad', name: '坏图工作流', graph: badGraph });
  assert.equal(wfBad.status, 200);
  const badHook = await call('POST', '/wf1/api/hooks', { workflowId: 'wf_hook_bad' });
  assert.equal(badHook.status, 200);
  const res = await fire({ hookId: badHook.body.id, token: badHook.body.token, body: { input: 'x' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
  await call('DELETE', `/wf1/api/hooks?id=${badHook.body.id}`);
});

await test('存量 hook 零变化：清掉 secret/callback 后无新字段请求全链路 200', async () => {
  await call('PATCH', '/wf1/api/hooks', { id: hookId, signingSecret: '', callbackUrl: '' });
  const disk = readTriggers().hooks.find((h) => h.id === hookId);
  assert.equal(disk.signingSecret, undefined);
  assert.equal(disk.callbackUrl, undefined);
  const fired = await fire({ hookId, token: hookToken, body: { input: 'legacy' } });
  assert.equal(fired.status, 200);
  assert.ok(fired.body.runId);
});

await test('DELETE hook 后触发 404', async () => {
  const tmp = await call('POST', '/wf1/api/hooks', { workflowId: 'wf_hook' });
  await call('DELETE', `/wf1/api/hooks?id=${tmp.body.id}`);
  const res = await fire({ hookId: tmp.body.id, token: tmp.body.token, body: {} });
  assert.equal(res.status, 404);
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
