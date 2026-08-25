import assert from 'node:assert/strict';
import { CRON_PRESETS, describeCron, presetOfCron } from './schedule-center.js';

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

console.log('schedule center tests:');

test('常见 preset 人类可读描述', () => {
  assert.equal(describeCron('0 9 * * *'), '每天 09:00');
  assert.equal(describeCron('30 8 * * *'), '每天 08:30');
  assert.equal(describeCron('0 * * * *'), '每小时第 0 分');
  assert.equal(describeCron('15 * * * *'), '每小时第 15 分');
  assert.equal(describeCron('*/10 * * * *'), '每 10 分钟');
  assert.equal(describeCron('0 9 * * 1'), '周一 09:00');
  assert.equal(describeCron('0 9 * * 1-5'), '工作日 09:00');
  assert.equal(describeCron('0 9 1 * *'), '每月 1 日 09:00');
});

test('别名周几与 7=周日', () => {
  assert.equal(describeCron('0 9 * * mon'), '周一 09:00');
  assert.equal(describeCron('0 9 * * sun'), '周日 09:00');
  assert.equal(describeCron('0 9 * * 0'), '周日 09:00');
  assert.equal(describeCron('0 9 * * 7'), '周日 09:00');
});

test('多天组合：周一、周三', () => {
  assert.equal(describeCron('0 9 * * 1,3'), '周一、周三 09:00');
});

test('解析不了返回 null（面板回退显示原文）', () => {
  assert.equal(describeCron('bad'), null);
  assert.equal(describeCron(''), null);
  assert.equal(describeCron(null), null);
  assert.equal(describeCron('99 * * * *'), null);
  assert.equal(describeCron('0 9 * * * *'), null);
  assert.equal(describeCron('5-3 * * * *'), null);
});

test('presetOfCron：命中返回预设，未命中 null', () => {
  assert.equal(presetOfCron('0 9 * * *')?.key, 'daily-9');
  assert.equal(presetOfCron('  0 9 * * *  ')?.key, 'daily-9');
  assert.equal(presetOfCron('13 13 * * *'), null);
  assert.equal(CRON_PRESETS.length, 4);
});

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
