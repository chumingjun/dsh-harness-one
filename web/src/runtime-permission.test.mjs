// 节点级权限模式 UI 接线 + 运行授权流（设计 §17/§18）。
// 零依赖：源码断言 + 组件内联逻辑的纯逻辑等价物（与组件保持同步）。
// 用法：node --test web/src/runtime-permission.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(root, 'NodePanel.jsx'), 'utf8');
const app = readFileSync(join(root, 'App.jsx'), 'utf8');
const modal = readFileSync(join(root, 'TestRunModal.jsx'), 'utf8');

test('NodePanel：切换底座清空 runtimePermission（防跨底座静默沿用/非法值）', () => {
  assert.match(panel, /externalModel: undefined, runtimePermission: undefined/);
});

test('NodePanel：权限下拉按底座给选项，elevated 出警示，claudeAllowBash 已替换', () => {
  assert.ok(panel.includes('权限模式'));
  for (const v of ['sandbox', 'restricted', 'bash', 'full']) {
    assert.ok(panel.includes(`value="${v}"`), `应有选项 ${v}`);
  }
  assert.ok(panel.includes('高权限：以 dsh 用户身份全自动执行'));
  assert.ok(!panel.includes('claudeAllowBash'), 'claudeAllowBash 应被 runtimePermission 取代');
});

test('NodePanel：pi 禁用文案指向设置面板入口', () => {
  assert.ok(panel.includes('本地执行底座开启'));
});

// elevated 判定纯逻辑等价物（与 TestRunModal / runtime-grants.elevatedSetOf 同口径）
function elevatedFor(runtime, perm) {
  return (runtime === 'codex' && perm === 'full')
    || (runtime === 'claude' && (perm === 'bash' || perm === 'full'));
}

test('elevated 判定：codex full / claude bash|full；默认与 pi/dsh 不在此列', () => {
  assert.equal(elevatedFor('codex', 'full'), true);
  assert.equal(elevatedFor('claude', 'bash'), true);
  assert.equal(elevatedFor('claude', 'full'), true);
  assert.equal(elevatedFor('codex', undefined), false);
  assert.equal(elevatedFor('claude', undefined), false);
  assert.equal(elevatedFor('pi', 'full'), false); // pi 走实例级门禁
  assert.equal(elevatedFor('dsh', undefined), false);
});

test('TestRunModal：elevated 试运行须勾选确认，请求体带 confirmPermission', () => {
  assert.ok(modal.includes('confirmPermission'));
  assert.ok(modal.includes('我已知晓风险，确认本次试运行'));
  assert.match(modal, /elevated && !confirmPermission/);
});

test('App：未授权启动走授权弹窗→grant→重试；focus 重取底座列表', () => {
  assert.ok(app.includes('RUNTIME_PERMISSION_UNGRANTED'));
  assert.ok(app.includes("apiUrl('/runtime-grant')"));
  assert.ok(app.includes('授权并运行'));
  assert.ok(app.includes("window.addEventListener('focus', onFocus)"));
});
