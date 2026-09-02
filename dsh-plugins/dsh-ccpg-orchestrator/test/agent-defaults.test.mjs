import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentDefaultsError,
  AgentDefaultsStore,
  EMPTY_AGENT_DEFAULTS,
  normalizeAgentDefaults,
  resolveAgentModelSelection,
  validateAgentDefaults,
} from '../lib/agent-defaults.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- normalizeAgentDefaults ----

test('normalize: 空对象与缺省字段都落成空默认值', () => {
  assert.deepEqual(normalizeAgentDefaults({}), EMPTY_AGENT_DEFAULTS);
  assert.deepEqual(normalizeAgentDefaults({ provider: undefined, model: null }), EMPTY_AGENT_DEFAULTS);
});

test('normalize: 正常字段保留并 trim', () => {
  assert.deepEqual(
    normalizeAgentDefaults({ provider: ' deepseek ', model: 'deepseek-chat', reasoningEffort: 'high' }),
    { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  );
});

test('normalize: 拒绝未知字段 / 非字符串 / 非对象', () => {
  assert.throws(() => normalizeAgentDefaults({ provider: 'a', extra: 1 }), AgentDefaultsError);
  assert.throws(() => normalizeAgentDefaults({ provider: 42 }), AgentDefaultsError);
  assert.throws(() => normalizeAgentDefaults(null), AgentDefaultsError);
  assert.throws(() => normalizeAgentDefaults('x'), AgentDefaultsError);
});

test('normalize: model 依赖 provider、思考级别依赖 model', () => {
  assert.throws(() => normalizeAgentDefaults({ model: 'm' }), /先选默认渠道/);
  assert.throws(() => normalizeAgentDefaults({ provider: 'p', reasoningEffort: 'high' }), /先选默认渠道和模型/);
});

// ---- validateAgentDefaults ----

const fakeLlm = (overrides = {}) => ({
  async listProviders() { return [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'glm', name: '智谱' }]; },
  async listModels(provider) {
    return provider === 'deepseek' ? [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] : [{ id: 'glm-5' }];
  },
  async resolveModelInfo(provider, model) {
    if (model === 'deepseek-reasoner') {
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } };
    }
    return {};
  },
  ...overrides,
});

test('validate: 全空（跟随 dsh）直接放行', async () => {
  await validateAgentDefaults(EMPTY_AGENT_DEFAULTS, fakeLlm());
});

test('validate: 未知渠道 / 未知模型 / 不支持的档位都 400', async () => {
  await assert.rejects(() => validateAgentDefaults({ provider: 'nope', model: '', reasoningEffort: '' }, fakeLlm()), /渠道不存在/);
  await assert.rejects(
    () => validateAgentDefaults({ provider: 'deepseek', model: 'nope', reasoningEffort: '' }, fakeLlm()),
    /不存在模型/,
  );
  await assert.rejects(
    () => validateAgentDefaults({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' }, fakeLlm()),
    /不支持思考级别 max/,
  );
  await assert.rejects(
    () => validateAgentDefaults({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }, fakeLlm()),
    /不支持思考级别设置/,
  );
});

test('validate: 支持的档位放行；元数据解析失败降级放行', async () => {
  await validateAgentDefaults({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }, fakeLlm());
  await validateAgentDefaults(
    { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    fakeLlm({ async resolveModelInfo() { throw new Error('adapter 缺失'); } }),
  );
});

// ---- AgentDefaultsStore ----

test('store: 缺文件 / 损坏文件都回退空默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1-agent-defaults-'));
  const file = join(dir, 'agent-defaults.json');
  const store = new AgentDefaultsStore(file);
  assert.deepEqual(store.read(), EMPTY_AGENT_DEFAULTS);
  writeFileSync(file, '{broken json', 'utf8');
  assert.deepEqual(store.read(), EMPTY_AGENT_DEFAULTS);
  writeFileSync(file, JSON.stringify({ provider: 'p', hacker: true }), 'utf8');
  assert.deepEqual(store.read(), EMPTY_AGENT_DEFAULTS);
});

test('store: 写入后可读回，落盘 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1-agent-defaults-'));
  const file = join(dir, 'sub', 'agent-defaults.json');
  const store = new AgentDefaultsStore(file);
  store.write({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' });
  assert.deepEqual(store.read(), { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' });
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.provider, 'deepseek');
});

// ---- resolveAgentModelSelection（与 runAgentNode 同一解析链）----

const SEL = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' };

test('resolve: 节点显式配置永远优先', () => {
  const r = resolveAgentModelSelection({
    node: { channel: 'glm', model: 'glm-5', reasoningEffort: 'low' },
    defaults: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    dshSelection: SEL,
  });
  assert.deepEqual(r, { provider: 'glm', model: 'glm-5', reasoningEffort: 'low' });
});

test('resolve: 节点未配置时取 Workflow One 默认值（含档位）', () => {
  const r = resolveAgentModelSelection({
    node: {},
    defaults: { provider: 'glm', model: 'glm-5', reasoningEffort: 'high' },
    dshSelection: SEL,
  });
  assert.deepEqual(r, { provider: 'glm', model: 'glm-5', reasoningEffort: 'high' });
});

test('resolve: 无默认值时维持 dsh 全局选择旧行为', () => {
  const r = resolveAgentModelSelection({ node: {}, defaults: EMPTY_AGENT_DEFAULTS, dshSelection: SEL });
  assert.deepEqual(r, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' });
});

test('resolve: 默认渠道下的默认模型为空 → model 留空（由调用方取渠道首选），不错配 dsh 模型', () => {
  const r = resolveAgentModelSelection({
    node: {},
    defaults: { provider: 'glm', model: '', reasoningEffort: '' },
    dshSelection: SEL,
  });
  assert.equal(r.provider, 'glm');
  assert.equal(r.model, undefined); // 不能回退成 deepseek-chat
  assert.equal(r.reasoningEffort, undefined);
});

test('resolve: 节点指定了渠道 → 不继承 Workflow One 默认模型', () => {
  const r = resolveAgentModelSelection({
    node: { channel: 'glm' },
    defaults: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    dshSelection: SEL,
  });
  assert.equal(r.provider, 'glm');
  assert.equal(r.model, undefined);
  assert.equal(r.reasoningEffort, undefined);
});

test('resolve: 默认档位只在同渠道同模型时继承', () => {
  const r = resolveAgentModelSelection({
    node: { channel: 'glm', model: 'glm-5-air' }, // 同渠道不同模型
    defaults: { provider: 'glm', model: 'glm-5', reasoningEffort: 'high' },
    dshSelection: SEL,
  });
  assert.equal(r.reasoningEffort, undefined);
});

test('resolve: 默认档位的下一顺位是 dsh 全局档位', () => {
  const r = resolveAgentModelSelection({
    node: {},
    defaults: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' }, // 与 dsh 同渠道同模型但未设档位
    dshSelection: SEL,
  });
  assert.equal(r.reasoningEffort, 'medium');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
if (failed) process.exit(1);
console.log(`${tests.length} tests passed`);
