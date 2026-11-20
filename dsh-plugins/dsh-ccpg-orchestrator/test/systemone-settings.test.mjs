// systemone 用户级设置离线单测：归一化/存储/合并/两段式测试 + 路由接线（mock fetch）。
// 用法：node test/systemone-settings.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  EMPTY_SYSTEMONE_SETTINGS, SystemOneSettingsError, systemoneUrlIssue,
  normalizeSystemOneSettings, SystemOneSettingsStore, resolveSystemOneSettings,
} from '../lib/systemone-settings.js';
import { probeSystemOne, testSystemOne } from '../lib/systemone.js';
import { apply } from '../lib/index.js';

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

// ---- mock 工具 ----
const jsonRes = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
const realFetch = globalThis.fetch;
const withFetch = async (impl, fn) => {
  globalThis.fetch = impl;
  try { await fn(); } finally { globalThis.fetch = realFetch; }
};
const captureFetch = (responder) => {
  const calls = [];
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    return responder(String(url), body, calls.length);
  };
  impl.calls = calls;
  return impl;
};
const tagsRes = (names) => jsonRes({ models: names.map((name) => ({ name, model: name })) });
const noulRes = (value) => jsonRes({ model: 'm', answers: { judgment: { type: 'noul', noul: value } }, usage: { input_tokens: 10, output_tokens: 0 } });
const ollamaMock = (names, value) => captureFetch((url) => (url.endsWith('/api/tags') ? tagsRes(names) : noulRes(value)));

console.log('systemone-settings tests:');

// ---- 归一化 / URL 校验 ----
await test('normalize：空对象→空设置；trim', () => {
  assert.deepEqual(normalizeSystemOneSettings({}), EMPTY_SYSTEMONE_SETTINGS);
  assert.deepEqual(normalizeSystemOneSettings({ url: '  http://a:11434/v1/systemone  ', model: ' m ' }), { url: 'http://a:11434/v1/systemone', model: 'm' });
});

await test('normalize：未知键/非字符串/超长/非法 URL → SystemOneSettingsError', () => {
  assert.throws(() => normalizeSystemOneSettings({ foo: 1 }), SystemOneSettingsError);
  assert.throws(() => normalizeSystemOneSettings({ url: 123 }), SystemOneSettingsError);
  assert.throws(() => normalizeSystemOneSettings({ url: `http://a/${'x'.repeat(500)}` }), SystemOneSettingsError);
  assert.throws(() => normalizeSystemOneSettings({ model: 'x'.repeat(201) }), SystemOneSettingsError);
  assert.throws(() => normalizeSystemOneSettings({ url: 'ftp://a' }), SystemOneSettingsError);
  assert.throws(() => normalizeSystemOneSettings({ url: 'not a url' }), SystemOneSettingsError);
  assert.throws(() => normalizeSystemOneSettings(null), SystemOneSettingsError);
});

await test('systemoneUrlIssue：空→null；http/https 过；javascript:/file:/乱串 拒', () => {
  assert.equal(systemoneUrlIssue(''), null);
  assert.equal(systemoneUrlIssue('http://localhost:11434/v1/systemone'), null);
  assert.equal(systemoneUrlIssue('https://x.example/v1/systemone'), null);
  assert.ok(systemoneUrlIssue('javascript:alert(1)'));
  assert.ok(systemoneUrlIssue('file:///etc/passwd'));
  assert.ok(systemoneUrlIssue('乱串'));
});

// ---- 存储 ----
await test('store：write/read 往返；损坏/缺失→空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1-s1set-'));
  const file = join(dir, 'settings.json');
  const store = new SystemOneSettingsStore(file);
  assert.deepEqual(store.read(), EMPTY_SYSTEMONE_SETTINGS);
  store.write({ url: 'http://a:11434/v1/systemone', model: 'm2' });
  assert.deepEqual(store.read(), { url: 'http://a:11434/v1/systemone', model: 'm2' });
  writeFileSync(file, '{bad json');
  assert.deepEqual(store.read(), EMPTY_SYSTEMONE_SETTINGS);
});

// ---- 合并链 ----
await test('resolve：逐字段用户>部署；只填 url 时 model 回退部署', () => {
  const config = { systemoneUrl: 'http://deploy:11434/v1/systemone', systemoneModel: 'deploy-model' };
  assert.deepEqual(resolveSystemOneSettings({ url: '', model: '' }, config), { url: config.systemoneUrl, model: config.systemoneModel });
  assert.deepEqual(resolveSystemOneSettings({ url: 'http://user:11434/v1/systemone', model: '' }, config), { url: 'http://user:11434/v1/systemone', model: 'deploy-model' });
  assert.deepEqual(resolveSystemOneSettings({ url: '', model: 'user-model' }, config), { url: config.systemoneUrl, model: 'user-model' });
});

// ---- probe 扩展 ----
await test('probe：返回 models 列表与 ms', async () => {
  const impl = captureFetch(() => tagsRes(['pplx-decider-flash:latest', 'other:7b']));
  const r = await probeSystemOne({ url: 'http://localhost:11434/v1/systemone', model: 'pplx-decider-flash', fetchImpl: impl });
  assert.equal(r.available, true);
  assert.deepEqual(r.models, ['pplx-decider-flash:latest', 'other:7b']);
  assert.equal(typeof r.ms, 'number');
});

await test('probe：模型不在 → pull 指路且 models 仍返回', async () => {
  const impl = captureFetch(() => tagsRes(['other:7b']));
  const r = await probeSystemOne({ url: 'http://localhost:11434/v1/systemone', model: 'pplx-decider-flash', fetchImpl: impl });
  assert.equal(r.available, false);
  assert.match(r.reason, /ollama pull pplx-decider-flash/);
  assert.deepEqual(r.models, ['other:7b']);
});

// ---- 两段式测试 ----
await test('testSystemOne：全绿→ok 含 probeMs/judgmentMs/value，冒烟题固定', async () => {
  const impl = ollamaMock(['m:latest'], 0.99);
  const r = await testSystemOne({ url: 'http://mock:11434/v1/systemone', model: 'm', fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.equal(typeof r.probeMs, 'number');
  assert.equal(typeof r.judgmentMs, 'number');
  assert.equal(r.value, 0.99);
  assert.deepEqual(r.models, ['m:latest']);
  const judgmentCall = impl.calls.find((c) => c.body);
  assert.equal(judgmentCall.body.state, '天空是蓝色的，草是绿色的。');
  assert.equal(judgmentCall.body.questions.judgment.instructions, '天空是蓝色的');
});

await test('testSystemOne：tags 连不上 → stage probe 含 ollama serve', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  const r = await testSystemOne({ url: 'http://mock:11434/v1/systemone', model: 'm', fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'probe');
  assert.match(r.reason, /ollama serve/);
});

await test('testSystemOne：模型不在 → stage probe 含 pull + models，不发判断', async () => {
  const impl = ollamaMock(['other:7b'], 0.99);
  const r = await testSystemOne({ url: 'http://mock:11434/v1/systemone', model: 'm', fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'probe');
  assert.match(r.reason, /ollama pull m/);
  assert.deepEqual(r.models, ['other:7b']);
  assert.equal(impl.calls.length, 1);
});

await test('testSystemOne：判断回非数值 → stage judgment', async () => {
  const impl = captureFetch((url) => (url.endsWith('/api/tags') ? tagsRes(['m:latest']) : jsonRes({ answers: { judgment: { type: 'noul' } } })));
  const r = await testSystemOne({ url: 'http://mock:11434/v1/systemone', model: 'm', fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'judgment');
});

await test('testSystemOne：判断连接失败 → stage judgment；AbortError → 超时文案', async () => {
  const impl = captureFetch((url) => { if (url.endsWith('/api/tags')) return tagsRes(['m:latest']); throw new TypeError('fetch failed'); });
  const r = await testSystemOne({ url: 'http://mock:11434/v1/systemone', model: 'm', fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'judgment');
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const impl2 = captureFetch((url) => { if (url.endsWith('/api/tags')) return tagsRes(['m:latest']); throw abort; });
  const r2 = await testSystemOne({ url: 'http://mock:11434/v1/systemone', model: 'm', fetchImpl: impl2 });
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, 'judgment');
  assert.match(r2.reason, /超时/);
});

// ---- 路由接线（假 webServer 直调，与 systemone.test.mjs 同范式）----
function responseCapture() {
  return {
    status: 0, chunks: [], writableEnded: false,
    writeHead(status) { this.status = status; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8') || '{}'); },
  };
}
function request(method, url, body) {
  const req = new EventEmitter();
  req.method = method; req.url = url; req.headers = {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}
const home = mkdtempSync(join(tmpdir(), 'wf1-s1set-home-'));
const ws = mkdtempSync(join(tmpdir(), 'wf1-s1set-ws-'));
process.env.DSH_HOME = home;
const legacy = join(home, 'package-legacy');
mkdirSync(join(legacy, 'state'), { recursive: true });
writeFileSync(join(legacy, 'state', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));
process.env.WF1_LEGACY_DATA_DIR = legacy;
const ctx = {
  webServer: { register(route) { this.routes.push(route); }, routes: [] },
  tools: { register() {}, schemas() { return []; } },
  get(name) {
    if (name === 'sessions') return { get: () => ({ header: { cwd: ws } }), flush: async () => {} };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };
    return null;
  },
  skills: { async list() { return []; } },
  llm: { listProviders() { return []; }, async listModels() { return []; }, async resolveModelInfo() { return {}; } },
  agentPresets: { async mount() {} },
  logger: { info() {}, warn() {}, error() {} },
  effect() {},
};
apply(ctx, { systemoneUrl: 'http://mock:11434/v1/systemone', systemoneModel: 'm' });
const routeOf = (path) => ctx.webServer.routes.find((e) => e.kind === 'exact' && e.path === path)?.handler;
const callRoute = async (path, method, body) => {
  const res = responseCapture();
  const url = `${path}?sessionId=session-1`;
  await routeOf(path)(request(method, url, body), res);
  return { status: res.status, body: res.json() };
};

await test('路由：GET settings → defaults 空 + effective=部署', async () => {
  const r = await callRoute('/wf1/api/systemone/settings', 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.defaults, { url: '', model: '' });
  assert.deepEqual(r.body.effective, { url: 'http://mock:11434/v1/systemone', model: 'm' });
  assert.deepEqual(r.body.deployment, { url: 'http://mock:11434/v1/systemone', model: 'm' });
});

await test('路由：PUT → 持久化 + effective 热更新，试运行立即打新地址', async () => {
  const r = await callRoute('/wf1/api/systemone/settings', 'PUT', { url: 'http://other:11434/v1/systemone', model: 'm2' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.defaults, { url: 'http://other:11434/v1/systemone', model: 'm2' });
  assert.deepEqual(r.body.effective, { url: 'http://other:11434/v1/systemone', model: 'm2' });
  const impl = captureFetch(() => noulRes(0.99));
  await withFetch(impl, async () => {
    const t = await callRoute('/wf1/api/node/test', 'POST', {
      node: { id: 'j1', type: 'systemone', data: { mode: 'noul', statement: 's' } },
      upstreamOutputs: {}, upstreamLabels: {}, triggerInput: '',
    });
    assert.equal(t.body.ok, true, t.body.error);
    assert.equal(impl.calls[0].url, 'http://other:11434/v1/systemone');
    assert.equal(impl.calls[0].body.model, 'm2');
  });
});

await test('路由：PUT 空对象 → effective 回退部署', async () => {
  const r = await callRoute('/wf1/api/systemone/settings', 'PUT', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.effective, { url: 'http://mock:11434/v1/systemone', model: 'm' });
});

await test('路由：PUT 非法 url / 未知键 → 400', async () => {
  assert.equal((await callRoute('/wf1/api/systemone/settings', 'PUT', { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await callRoute('/wf1/api/systemone/settings', 'PUT', { foo: 'x' })).status, 400);
});

await test('路由：POST test 草稿空 → 用 effective，mock 全绿→ok', async () => {
  const impl = ollamaMock(['m:latest'], 0.99);
  await withFetch(impl, async () => {
    const r = await callRoute('/wf1/api/systemone/test', 'POST', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(impl.calls[0].url, 'http://mock:11434/api/tags');
  });
});

await test('路由：POST test 草稿 url 非法 → 400 且零 fetch', async () => {
  const impl = captureFetch(() => { throw new Error('should not fetch'); });
  await withFetch(impl, async () => {
    const r = await callRoute('/wf1/api/systemone/test', 'POST', { url: 'javascript:alert(1)' });
    assert.equal(r.status, 400);
    assert.equal(impl.calls.length, 0);
  });
});

await test('路由：POST test 草稿覆盖 effective', async () => {
  const impl = ollamaMock(['m2:latest'], 0.99);
  await withFetch(impl, async () => {
    const r = await callRoute('/wf1/api/systemone/test', 'POST', { url: 'http://draft:11434/v1/systemone', model: 'm2' });
    assert.equal(r.body.ok, true);
    assert.equal(impl.calls[0].url, 'http://draft:11434/api/tags');
    assert.equal(impl.calls[1].body.model, 'm2');
  });
});

await test('路由：PUT 后 GET status 探针 origin 跟随用户设置 + models 透传', async () => {
  await callRoute('/wf1/api/systemone/settings', 'PUT', { url: 'http://status:11434/v1/systemone', model: '' });
  const impl = ollamaMock(['m:latest'], 0.99);
  await withFetch(impl, async () => {
    const r = await callRoute('/wf1/api/systemone/status', 'GET');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.available, true);
    assert.deepEqual(r.body.models, ['m:latest']);
    assert.equal(impl.calls[0].url, 'http://status:11434/api/tags');
  });
  await callRoute('/wf1/api/systemone/settings', 'PUT', {}); // 还原，不影响后续用例
});

await test('路由：方法守卫 settings POST / test GET → 405', async () => {
  assert.equal((await callRoute('/wf1/api/systemone/settings', 'POST', {})).status, 405);
  assert.equal((await callRoute('/wf1/api/systemone/test', 'GET')).status, 405);
});

console.log(`\n${passed} passed${process.exitCode ? '（存在失败）' : ''}`);