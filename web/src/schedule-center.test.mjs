import assert from 'node:assert/strict';
import { CRON_PRESETS, describeCron, formatNextInZone, hostTimezone, presetOfCron, supportedTimezones, timezoneOffsetLabel } from './schedule-center.js';

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

test('hostTimezone：返回非空 IANA 名', () => {
  assert.ok(hostTimezone());
  assert.equal(typeof hostTimezone(), 'string');
});

test('supportedTimezones：返回列表且含常见区', () => {
  const zones = supportedTimezones();
  assert.ok(Array.isArray(zones) && zones.length > 0);
  // 部分运行时 supportedValuesOf 不含字面量 'UTC'，选择器需自行补——这里只验证常见 IANA 区在列
  assert.ok(zones.includes('Asia/Shanghai'));
});

test('timezoneOffsetLabel：上海 UTC+08:00、UTC 字面量；非法名空串', () => {
  // 用固定时刻避免依赖「当前」：DST 期个别区会漂移，但这几个区全年固定
  const at = new Date('2026-01-15T00:00:00Z');
  assert.equal(timezoneOffsetLabel('Asia/Shanghai', at), 'UTC+08:00');
  assert.equal(timezoneOffsetLabel('UTC', at), 'UTC');
  assert.equal(timezoneOffsetLabel('Not/AZone', at), '');
  assert.equal(timezoneOffsetLabel('', at), '');
});

test('formatNextInZone：同一 ISO 按不同时区格式化为不同墙钟；空值占位 —', () => {
  const iso = '2026-01-01T09:00:00Z';
  assert.equal(formatNextInZone(iso, 'UTC'), '01/01 09:00');
  assert.equal(formatNextInZone(iso, 'Asia/Shanghai'), '01/01 17:00');
  // tz 为空按浏览器本地时区（旧行为）：不抛错且非占位符
  assert.notEqual(formatNextInZone(iso, ''), '—');
  assert.equal(formatNextInZone('', 'UTC'), '—');
  assert.equal(formatNextInZone(null, 'UTC'), '—');
  assert.equal(formatNextInZone('garbage', 'UTC'), '—');
});

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
