// 节点详情轮询纯逻辑单测（issue #52）
import assert from 'node:assert/strict';
import { POLL_INTERVAL_MS, nextPollDelayMs, shouldAutoSelectTrace } from './node-detail-polling.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

test('running 节点按 1.5s 轮询', () => {
  assert.equal(nextPollDelayMs('running'), POLL_INTERVAL_MS);
  assert.equal(POLL_INTERVAL_MS, 1500);
});

test('终态节点停止轮询（返回 null）', () => {
  for (const status of ['success', 'error', 'canceled', 'skipped']) {
    assert.equal(nextPollDelayMs(status), null, status);
  }
  assert.equal(nextPollDelayMs(undefined), null);
});

test('首次加载到 trace 且用户未动 tab → 自动进「执行过程」', () => {
  assert.equal(shouldAutoSelectTrace({ trace: { entries: [] } }, true, false), true);
});

test('用户手动切过 tab 后不再自动切换', () => {
  assert.equal(shouldAutoSelectTrace({ trace: { entries: [] } }, true, true), false);
});

test('非首次加载（轮询后续）不触发自动切换', () => {
  assert.equal(shouldAutoSelectTrace({ trace: { entries: [] } }, false, false), false);
});

test('无 trace 不自动切换', () => {
  assert.equal(shouldAutoSelectTrace({ trace: null }, true, false), false);
});

console.log(`node-detail polling tests: ALL PASS (${passed})`);
