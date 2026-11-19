// 用户级 pi 开关存储 + 高权限授权纯逻辑 + 权限单点解析（设计 §16/§17/§18）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettingsStore, normalizeRuntimeSettings } from '../lib/runtime-settings.js';
import { elevatedSetOf, grantMatches, elevatedListOf } from '../lib/runtime-grants.js';
import { resolveRuntimePermission, isElevatedPermission, DEFAULT_RUNTIME_PERMISSION } from '../lib/runtime-cli.js';

const tmp = mkdtempSync(join(tmpdir(), 'wf1-rt-settings-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// ---- 权限单点解析 ----
test('resolveRuntimePermission：缺省/空串回默认；pi 恒 full 且忽略携带值', () => {
  assert.equal(resolveRuntimePermission('codex', undefined), 'sandbox');
  assert.equal(resolveRuntimePermission('codex', ''), 'sandbox');
  assert.equal(resolveRuntimePermission('claude', null), 'restricted');
  assert.equal(resolveRuntimePermission('pi', 'whatever'), 'full');
  assert.equal(resolveRuntimePermission('pi', undefined), 'full');
  assert.equal(DEFAULT_RUNTIME_PERMISSION.pi, 'full');
});

test('resolveRuntimePermission：合法值原样；非法类型/未知值 fail-closed', () => {
  assert.equal(resolveRuntimePermission('codex', 'full'), 'full');
  assert.equal(resolveRuntimePermission('claude', 'bash'), 'bash');
  assert.equal(resolveRuntimePermission('claude', 'full'), 'full');
  for (const bad of ['bogus', 'FULL', 1, true, {}, []]) {
    assert.throws(() => resolveRuntimePermission('codex', bad), (e) => e.code === 'RUNTIME_BAD_PERMISSION');
  }
  assert.throws(() => resolveRuntimePermission('claude', 'sandbox'), (e) => e.code === 'RUNTIME_BAD_PERMISSION');
  assert.throws(() => resolveRuntimePermission('nope', 'full'), (e) => e.code === 'RUNTIME_BAD_PERMISSION');
});

test('isElevatedPermission：codex full / claude bash|full；默认与 pi 不在此列', () => {
  assert.equal(isElevatedPermission('codex', 'full'), true);
  assert.equal(isElevatedPermission('codex', 'sandbox'), false);
  assert.equal(isElevatedPermission('claude', 'bash'), true);
  assert.equal(isElevatedPermission('claude', 'full'), true);
  assert.equal(isElevatedPermission('claude', 'restricted'), false);
  assert.equal(isElevatedPermission('pi', 'full'), false); // pi 走实例级门禁
});

// ---- elevated 集合与 grant 匹配 ----
const graph = (...nodes) => ({ nodes });
const agent = (id, runtime, permission, label) => ({ id, type: 'agent', data: { runtime, runtimePermission: permission, label } });

test('elevatedSetOf：只收高权限 agent；dsh/默认/pi 不入集合', () => {
  const g = graph(
    agent('a', 'codex', 'full', '全权codex'),
    agent('b', 'claude', 'bash', '放行Bash'),
    agent('c', 'claude', undefined, '默认claude'),
    agent('d', 'codex', undefined, '默认codex'),
    agent('e', 'pi', undefined, 'pi'),
    { id: 'f', type: 'script', data: {} },
  );
  const set = elevatedSetOf(g);
  assert.deepEqual(Object.keys(set).sort(), ['a', 'b']);
  assert.deepEqual(set.a, { runtime: 'codex', permission: 'full' });
  assert.deepEqual(set.b, { runtime: 'claude', permission: 'bash' });
  assert.deepEqual(elevatedSetOf({ nodes: [] }), {});
  assert.deepEqual(elevatedSetOf(null), {});
});

test('grantMatches：逐节点精确匹配，顺序无关；增删/升级/换底座即失配', () => {
  const g = graph(agent('a', 'codex', 'full'), agent('b', 'claude', 'bash'));
  const elevated = elevatedSetOf(g);
  const grant = { elevated, grantedAt: 'x' };
  assert.equal(grantMatches(grant, elevated), true);
  // 顺序无关
  const reordered = { b: elevated.b, a: elevated.a };
  assert.equal(grantMatches({ elevated: reordered }, elevated), true);
  // 升级 bash→full 失配
  const escalated = elevatedSetOf(graph(agent('a', 'codex', 'full'), agent('b', 'claude', 'full')));
  assert.equal(grantMatches(grant, escalated), false);
  // 新增高权限节点失配
  const added = elevatedSetOf(graph(agent('a', 'codex', 'full'), agent('b', 'claude', 'bash'), agent('c', 'claude', 'full')));
  assert.equal(grantMatches(grant, added), false);
  // 删除节点失配
  const removed = elevatedSetOf(graph(agent('a', 'codex', 'full')));
  assert.equal(grantMatches(grant, removed), false);
  // 换底座失配
  const switched = elevatedSetOf(graph(agent('a', 'claude', 'full'), agent('b', 'claude', 'bash')));
  assert.equal(grantMatches(grant, switched), false);
  assert.equal(grantMatches(null, elevated), false);
  assert.equal(grantMatches({}, elevated), false);
  // 非 elevated 编辑不影响匹配
  const withExtra = graph(agent('a', 'codex', 'full'), agent('b', 'claude', 'bash'), agent('z', 'claude', undefined));
  assert.equal(grantMatches(grant, elevatedSetOf(withExtra)), true);
});

test('elevatedListOf：带 label 的授权清单', () => {
  const g = graph(agent('a', 'codex', 'full', '全权节点'));
  const list = elevatedListOf(g, elevatedSetOf(g));
  assert.deepEqual(list, [{ nodeId: 'a', label: '全权节点', runtime: 'codex', permission: 'full' }]);
});

// ---- 用户级开关存储 ----
test('normalizeRuntimeSettings：只收恰含布尔 enablePiRuntime 的普通对象', () => {
  assert.deepEqual(normalizeRuntimeSettings({ enablePiRuntime: true }), { enablePiRuntime: true });
  assert.deepEqual(normalizeRuntimeSettings({ enablePiRuntime: false }), { enablePiRuntime: false });
  for (const bad of [null, [], 'x', {}, { enablePiRuntime: 'true' }, { enablePiRuntime: 1 }, { enablePiRuntime: true, extra: 1 }, { other: true }]) {
    assert.throws(() => normalizeRuntimeSettings(bad), TypeError);
  }
});

test('RuntimeSettingsStore：原子写 0600；缺文件/损坏回退禁用（绝不默认放行）', () => {
  const file = join(tmp, 'runtime-settings.json');
  const store = new RuntimeSettingsStore(file);
  assert.deepEqual(store.read(), { enablePiRuntime: false });
  store.write({ enablePiRuntime: true });
  assert.deepEqual(store.read(), { enablePiRuntime: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
  writeFileSync(file, '{corrupt');
  assert.deepEqual(store.read(), { enablePiRuntime: false });
  rmSync(file);
  assert.deepEqual(store.read(), { enablePiRuntime: false });
});
