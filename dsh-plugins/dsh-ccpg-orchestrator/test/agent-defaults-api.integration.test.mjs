// /wf1/api/agent-defaults 集成测试（假 webServer 直调路由，与 schedule-api 同模式）。
// 端点是 scoped:false（设置面板无会话上下文），存储落在 DSH_HOME 用户级目录。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

function responseCapture() {
  return {
    status: 0,
    chunks: [],
    writableEnded: false,
    writeHead(status) { this.status = status; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
    on() { return this; },
    once() { return this; },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8') || '{}'); },
  };
}

function request(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

const dshHome = mkdtempSync(join(tmpdir(), 'wf1-ad-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wf1-ad-ws-'));
const originalEnv = { DSH_HOME: process.env.DSH_HOME, WF1_LEGACY_DATA_DIR: process.env.WF1_LEGACY_DATA_DIR };
process.env.DSH_HOME = dshHome;
const packageLegacyDir = join(dshHome, 'package-legacy');
mkdirSync(join(packageLegacyDir, 'state'), { recursive: true });
process.env.WF1_LEGACY_DATA_DIR = packageLegacyDir;
writeFileSync(join(packageLegacyDir, 'state', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));

const ctx = {
  webServer: { register(route) { this.routes.push(route); }, routes: [] },
  tools: { register() {}, schemas() { return []; } },
  get(name) {
    if (name === 'sessions') return { get: () => ({ header: { cwd: workspace } }), flush: async () => {} };
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' }) };
    }
    return null;
  },
  skills: { async list() { return []; } },
  llm: {
    listProviders() { return [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'glm', name: '智谱' }]; },
    async listModels(provider) {
      return provider === 'deepseek' ? [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] : [{ id: 'glm-5' }];
    },
    async resolveModelInfo(_provider, model) {
      return model === 'deepseek-reasoner'
        ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' }, inputModalities: ['text'] }
        : { inputModalities: ['text'] };
    },
  },
  agentPresets: { async mount() {} },
  logger: { info() {}, warn() {}, error() {} },
  effect() {},
};
apply(ctx, {});
const route = ctx.webServer.routes.find((entry) => entry.kind === 'exact' && entry.path === '/wf1/api/agent-defaults')?.handler;
assert.ok(route, 'agent-defaults 路由已注册');

const call = async (method, body) => {
  const res = responseCapture();
  await route(request(method, '/wf1/api/agent-defaults', body), res);
  return { status: res.status, body: res.json() };
};

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['✓', name]); }
  catch (error) { results.push(['✗', name, error]); }
};

await test('GET 初始为空默认值，effective 跟随 dsh 全局选择', async () => {
  const { status, body } = await call('GET');
  assert.equal(status, 200);
  assert.deepEqual(body.defaults, { provider: '', model: '', reasoningEffort: '' });
  assert.deepEqual(body.effective, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' });
  assert.deepEqual(body.dsh, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' });
});

await test('PUT 未知渠道 400 且不落盘', async () => {
  const { status, body } = await call('PUT', { provider: 'nope' });
  assert.equal(status, 400);
  assert.match(body.error, /渠道不存在/);
  assert.equal(existsSync(join(dshHome, 'plugin-data', 'dsh-ccpg-orchestrator', 'state', 'agent-defaults.json')), false);
});

await test('PUT 合法三件套 200，effective 生效且 GET 可读回', async () => {
  const put = await call('PUT', { provider: 'glm', model: 'glm-5', reasoningEffort: '' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.effective, { provider: 'glm', model: 'glm-5', reasoningEffort: null });
  const get = await call('GET');
  assert.deepEqual(get.body.defaults, { provider: 'glm', model: 'glm-5', reasoningEffort: '' });
});

await test('PUT 思考级别校验：支持的放行、不支持的 400', async () => {
  const bad = await call('PUT', { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /不支持思考级别/);
  const good = await call('PUT', { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body.effective, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' });
});

await test('PUT 缺依赖字段 400；清空回退 dsh 全局', async () => {
  const bad = await call('PUT', { model: 'glm-5' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /先选默认渠道/);
  const cleared = await call('PUT', {});
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.effective, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' });
});

await test('POST 方法 405', async () => {
  const { status } = await call('POST', {});
  assert.equal(status, 405);
});

await test('PUT 畸形 JSON 请求体 400（scoped:false 路由也要有请求体错误兜底）', async () => {
  const { status, body } = await call('PUT', 'not-json{{{');
  assert.equal(status, 400);
  assert.match(body.error, /JSON/);
});

if (originalEnv.DSH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalEnv.DSH_HOME;
if (originalEnv.WF1_LEGACY_DATA_DIR === undefined) delete process.env.WF1_LEGACY_DATA_DIR;
else process.env.WF1_LEGACY_DATA_DIR = originalEnv.WF1_LEGACY_DATA_DIR;

let failed = 0;
for (const [mark, name, error] of results) {
  console.log(`${mark} ${name}`);
  if (error) { failed += 1; console.error(error); }
}
if (failed) process.exit(1);
console.log(`${results.length} tests passed`);
