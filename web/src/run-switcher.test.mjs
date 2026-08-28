import assert from 'node:assert/strict';
import { capsuleTime, SOURCE_LABEL, switcherCapsules } from './run-switcher.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('run switcher tests:');

test('live 优先、其余按开始时间倒序', () => {
  const { shown } = switcherCapsules([
    { runId: 'old-a', status: 'success', startedAt: '2026-08-24T01:00:00Z' },
    { runId: 'live-1', status: 'running', live: true, startedAt: '2026-08-25T01:00:00Z' },
    { runId: 'new-done', status: 'error', startedAt: '2026-08-25T03:00:00Z' },
  ]);
  assert.deepEqual(shown.map((r) => r.runId), ['live-1', 'new-done', 'old-a']);
});

test('多个 live 按时间倒序聚在前面', () => {
  const { shown } = switcherCapsules([
    { runId: 'live-2', live: true, startedAt: '2026-08-25T05:00:00Z' },
    { runId: 'done', status: 'success', startedAt: '2026-08-25T06:00:00Z' },
    { runId: 'live-1', live: true, startedAt: '2026-08-25T04:00:00Z' },
  ]);
  assert.deepEqual(shown.map((r) => r.runId), ['live-2', 'live-1', 'done']);
});

test('live 胶囊状态强制 running 并带进度；非 live 无进度', () => {
  const { shown } = switcherCapsules([
    { runId: 'live-1', live: true, status: 'success', progress: { done: 2, total: 5 }, startedAt: '2026-08-25T01:00:00Z' },
    { runId: 'done-1', status: 'error', progress: { done: 5, total: 5 }, startedAt: '2026-08-24T01:00:00Z' },
  ]);
  assert.equal(shown[0].status, 'running');
  assert.equal(shown[0].progress, '2/5');
  assert.equal(shown[1].progress, null);
  assert.equal(shown[1].status, 'error');
});

test('超出的运行计入 overflow', () => {
  const runs = Array.from({ length: 9 }, (_, i) => ({ runId: `r${i}`, status: 'success', startedAt: `2026-08-2${i}T01:00:00Z` }));
  const { shown, overflow } = switcherCapsules(runs, { max: 6 });
  assert.equal(shown.length, 6);
  assert.equal(overflow, 3);
  const empty = switcherCapsules([]);
  assert.deepEqual(empty.shown, []);
  assert.equal(empty.overflow, 0);
});

test('来源默认 manual，resumedFrom 透传', () => {
  const { shown } = switcherCapsules([
    { runId: 'a', startedAt: '2026-08-25T01:00:00Z', resumedFrom: 'prev' },
    { runId: 'b', startedAt: '2026-08-25T02:00:00Z', source: 'schedule' },
  ]);
  assert.equal(shown[1].source, 'manual');
  assert.equal(shown[1].resumedFrom, true);
  assert.equal(shown[0].source, 'schedule');
});

test('catch-up 来源有标签（停机补跑可见），非枚举来源仍透传', () => {
  assert.equal(SOURCE_LABEL['catch-up'], '补跑');
  const { shown } = switcherCapsules([
    { runId: 'c1', startedAt: '2026-08-25T01:00:00Z', source: 'catch-up' },
  ]);
  assert.equal(shown[0].source, 'catch-up');
});

test('capsuleTime：今天只显时分，跨天带月/日，非法输入空串', () => {
  const now = new Date();
  const sameDay = new Date(now.getTime() - 60_000);
  const hm = `${String(sameDay.getHours()).padStart(2, '0')}:${String(sameDay.getMinutes()).padStart(2, '0')}`;
  assert.equal(capsuleTime(sameDay.toISOString()), hm);
  const otherDay = new Date('2020-01-02T03:04:00');
  assert.equal(capsuleTime(otherDay.toISOString()), '1/2 03:04');
  assert.equal(capsuleTime('not-a-date'), '');
  assert.equal(capsuleTime(null), '');
});

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
