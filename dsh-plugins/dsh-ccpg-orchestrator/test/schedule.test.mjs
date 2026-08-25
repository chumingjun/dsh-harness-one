// lib/schedule.js 单测：cron 计算、重叠判定、调度器策略（短真实等待驱动）。
import { strict as assert } from 'node:assert';
import {
  computeNextDelay, createScheduler, hasLiveRunForWorkflow, isValidCron,
  normalizeScheduleMeta, persistableScheduleMeta, upcomingFireTimes,
} from '../lib/schedule.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['✓', name]); }
  catch (error) { results.push(['✗', name, error]); }
};

await test('isValidCron：合法 / 非法表达式；空值必须拒绝（否则空串=每分钟风暴）', () => {
  assert.equal(isValidCron('0 9 * * *'), true);
  assert.equal(isValidCron('*/5 * * * *'), true);
  // cron-parser 宽松模式接受缺段（按 *），但别名错误、超界值、空值必须判非法
  assert.equal(isValidCron('not-a-cron'), false);
  assert.equal(isValidCron('99 * * * *'), false);
  assert.equal(isValidCron(null), false);
  assert.equal(isValidCron(''), false);
  assert.equal(isValidCron('   '), false);
});

await test('computeNextDelay：本地时区整点前 1 秒 → 约 1000ms；结果 ≥1ms', () => {
  // cron 按本地时区解释（调度语义正确）：取下一整点的本地时间，从其前 1 秒起算
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  const base = next.getTime() - 1000;
  const delay = computeNextDelay('0 * * * *', base);
  assert.ok(Math.abs(delay - 1000) < 50, `expect ~1000ms got ${delay}`);
  assert.ok(computeNextDelay('* * * * *', base) >= 1);
  assert.throws(() => computeNextDelay('bad-alias', base));
});

await test('upcomingFireTimes：返回递增 ISO 时间、条数正确（本地时区语义）', () => {
  const base = new Date();
  base.setHours(8, 0, 0, 0);
  const times = upcomingFireTimes('0 9 * * *', 3, base.getTime());
  assert.equal(times.length, 3);
  const expected = [0, 1, 2].map((d) => {
    const day = new Date(base);
    day.setDate(day.getDate() + d);
    day.setHours(9, 0, 0, 0);
    return day.toISOString();
  });
  assert.deepEqual(times, expected);
});

await test('hasLiveRunForWorkflow：按 workflowId+workspaceRoot 匹配，其他工作区/工作流不算', () => {
  const runs = new Map([
    ['r1', { run: { workflowId: 'wf_a', workspaceRoot: '/ws1' } }],
    ['r2', { run: { workflowId: 'wf_b', workspaceRoot: '/ws1' } }],
    ['r3', { run: { workflowId: 'wf_a', workspaceRoot: '/ws2' } }],
  ]);
  assert.equal(hasLiveRunForWorkflow(runs, '/ws1', 'wf_a'), true);
  assert.equal(hasLiveRunForWorkflow(runs, '/ws1', 'wf_b'), true);
  assert.equal(hasLiveRunForWorkflow(runs, '/ws1', 'wf_missing'), false);
  assert.equal(hasLiveRunForWorkflow(runs, '/ws2', 'wf_b'), false);
  assert.equal(hasLiveRunForWorkflow(runs, '/ws1', null), false);
  assert.equal(hasLiveRunForWorkflow(new Map(), '/ws1', 'wf_a'), false);
});

await test('normalizeScheduleMeta：旧 triggers.json 字段补默认 skip/enabled；非法 overlap 回落 skip', () => {
  const legacy = normalizeScheduleMeta({ key: 'sch_x', workflowId: 'wf', workflowName: '旧', cron: '0 9 * * *', input: 'hi', createdAt: '2026-01-01T00:00:00Z' });
  assert.equal(legacy.overlap, 'skip');
  assert.equal(legacy.enabled, true);
  assert.deepEqual(legacy.runInputs, {});
  assert.equal(legacy.fireCount, 0);
  assert.equal(legacy.skippedCount, 0);

  const full = normalizeScheduleMeta({ key: 'sch_y', workflowId: 'wf', cron: '0 9 * * *', overlap: 'parallel', enabled: false, runInputs: { a: 1 }, fireCount: 3, skippedCount: 2 });
  assert.equal(full.overlap, 'parallel');
  assert.equal(full.enabled, false);
  assert.deepEqual(full.runInputs, { a: 1 });
  assert.equal(full.fireCount, 3);
  assert.equal(full.skippedCount, 2);

  assert.equal(normalizeScheduleMeta({ overlap: 'whatever' }).overlap, 'skip');
});

await test('persistableScheduleMeta：落盘含全部统计与配置字段', () => {
  const disk = persistableScheduleMeta(normalizeScheduleMeta({
    key: 'sch_z', workflowId: 'wf', workflowName: 'n', cron: '0 9 * * *', input: 'x',
    runInputs: { k: 'v' }, overlap: 'parallel', enabled: false, createdAt: 't',
    nextAt: '2026-01-16T09:00:00.000Z', fireCount: 5, skippedCount: 1,
  }));
  assert.deepEqual(disk, {
    key: 'sch_z', workflowId: 'wf', workflowName: 'n', cron: '0 9 * * *', input: 'x',
    runInputs: { k: 'v' }, overlap: 'parallel', enabled: false, createdAt: 't',
    nextAt: '2026-01-16T09:00:00.000Z', fireCount: 5, skippedCount: 1,
  });
});

await test('createScheduler：每秒 cron 到点触发 fire 并回调 onFire', async () => {
  let fired = 0;
  let onFire = 0;
  const metas = [];
  const scheduler = createScheduler({
    meta: { key: 'sch_t1', workflowId: 'wf', cron: '* * * * * *', overlap: 'skip' },
    fire: () => { fired += 1; },
    onFire: () => { onFire += 1; },
    isBusy: () => false,
    onMeta: (m) => metas.push(m),
  });
  try {
    await sleep(2300);
    assert.ok(fired >= 2, `expect >=2 fires got ${fired}`);
    assert.equal(onFire, fired, 'onFire 每次真跑都应回调');
    const last = metas[metas.length - 1];
    assert.ok(last.nextAt, 'nextAt 应已上报');
    assert.equal(last.fireCount, undefined, 'onMeta 不回传计数（计数属主是调用方）');
  } finally {
    scheduler.stop();
  }
});

await test('createScheduler：skip 策略下上一轮 live → onSkip 回调且不调 fire', async () => {
  let fired = 0;
  let skipped = 0;
  const scheduler = createScheduler({
    meta: { key: 'sch_t2', workflowId: 'wf', cron: '* * * * * *', overlap: 'skip' },
    fire: () => { fired += 1; },
    onSkip: () => { skipped += 1; },
    isBusy: () => true,
  });
  try {
    await sleep(2300);
    assert.equal(fired, 0, 'skip + busy 不应真跑');
    assert.ok(skipped >= 2, `expect onSkip>=2 got ${skipped}`);
  } finally {
    scheduler.stop();
  }
});

await test('createScheduler：parallel 策略无视 isBusy 直接触发', async () => {
  let fired = 0;
  const scheduler = createScheduler({
    meta: { key: 'sch_t3', workflowId: 'wf', cron: '* * * * * *', overlap: 'parallel' },
    fire: () => { fired += 1; },
    isBusy: () => true,
  });
  try {
    await sleep(1300);
    assert.ok(fired >= 1, `parallel 应触发 got ${fired}`);
  } finally {
    scheduler.stop();
  }
});

await test('createScheduler：fireNow 立即触发且走 onFire、不受 isBusy 影响；stop 后拒绝', () => {
  let fired = 0;
  let onFire = 0;
  const scheduler = createScheduler({
    meta: { key: 'sch_t4', workflowId: 'wf', cron: '0 9 * * *', overlap: 'skip' },
    fire: () => { fired += 1; },
    onFire: () => { onFire += 1; },
    isBusy: () => true,
  });
  assert.equal(scheduler.fireNow(), true);
  assert.equal(fired, 1);
  assert.equal(onFire, 1, 'fireNow 也应经 onFire 记账');
  scheduler.stop();
  assert.equal(scheduler.fireNow(), false);
  assert.equal(fired, 1);
});

await test('createScheduler：无效 cron 起动即停（不触发 fire），nextAt 置空上报', () => {
  let fired = 0;
  const metas = [];
  const scheduler = createScheduler({
    meta: { key: 'sch_t5', workflowId: 'wf', cron: 'bad-cron', overlap: 'skip' },
    fire: () => { fired += 1; },
    onMeta: (m) => metas.push(m),
  });
  assert.equal(fired, 0);
  const last = metas[metas.length - 1];
  assert.equal(last?.nextAt, null);
  scheduler.stop();
});

await test('createScheduler：fire 失败也照常链下一轮（不卡死调度）', async () => {
  let fired = 0;
  const scheduler = createScheduler({
    meta: { key: 'sch_t6', workflowId: 'wf', cron: '* * * * * *', overlap: 'skip' },
    fire: () => { fired += 1; throw new Error('boom'); },
    logger: { warn() {} },
  });
  try {
    await sleep(2300);
    assert.ok(fired >= 2, `异常后链式调度应继续 got ${fired}`);
  } finally {
    scheduler.stop();
  }
});

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
