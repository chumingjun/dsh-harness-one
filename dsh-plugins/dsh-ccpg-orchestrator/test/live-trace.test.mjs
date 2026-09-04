// 实时轨迹单测（issue #52）：foldTraceEvent 增量折叠与 buildTrace 全量产出同语义；
// 折叠语义回归：input/inject/assistant/tool(call+result 配对)/turn-end。
// sessionEventsOf 兼容层：dsh-session 0.1.2-alpha.5 删除 Session.events getter 后
// 引擎收尾（summarize/countTurns/sumUsage）不再抛「events is not iterable」。
import assert from 'node:assert/strict';

const { foldTraceEvent, finalizeTrace, sessionEventsOf } = await import('../lib/index.js');

let passed = 0;
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
  .catch((error) => { console.error(`  ✗ ${name}\n${error.message}`); process.exitCode = 1; });

const newTrace = () => ({ model: 'test:model', entries: [{ kind: 'input', text: '任务' }] });

await test('tool/call 与 tool/result 按 callId 配对（增量逐事件折叠 = 全量一次折叠）', () => {
  const trace = newTrace();
  const pending = new Map();
  const meta = { input: '任务', model: 'test:model' };
  const events = [
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}', turn: 1, step: 1 } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '查看目录' }] }, usage: { outputTokens: 10 } } },
    { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt' }] }] } } },
    { seq: 4, type: 'turn/end', data: { reason: { kind: 'end_turn' } } },
  ];
  for (const ev of events) foldTraceEvent(trace, ev, pending, meta);
  assert.deepEqual(trace.entries.map((e) => e.kind), ['input', 'tool', 'assistant', 'turn-end']);
  assert.equal(trace.entries[0].text, '任务');
  assert.equal(trace.entries[1].name, 'bash');
  assert.equal(trace.entries[1].result.ok, true);
  assert.equal(trace.entries[1].result.text, 'a.txt');
  assert.equal(trace.entries[2].usage.outputTokens, 10);
  assert.equal(trace.entries[3].reason, 'end_turn');
});

await test('running 中工具调用先出现、结果未到 → result 缺省（前端显示 …）', () => {
  const trace = newTrace();
  const pending = new Map();
  foldTraceEvent(trace, { seq: 1, type: 'tool/call', data: { callId: 'c9', name: 'read', arguments: '{}', turn: 1, step: 1 } }, pending, { input: '任务' });
  assert.equal(trace.entries[1].kind, 'tool');
  assert.equal(trace.entries[1].result, undefined);
  // 下一 tick 结果到达：增量配对回填同一条 entry
  foldTraceEvent(trace, { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'boom' }] }] }, error: { name: 'E', code: 'X' } } }, pending, { input: '任务' });
  assert.equal(trace.entries[1].result.ok, false);
  assert.equal(trace.entries[1].result.error, 'E: X');
});

await test('pending Map 跨 tick 持久：call 在前一 tick、result 在后一 tick 也能配对', () => {
  const trace = newTrace();
  const pending = new Map();
  const meta = { input: '任务' };
  foldTraceEvent(trace, { seq: 1, type: 'tool/call', data: { callId: 'ck', name: 'fs', arguments: 'a', turn: 1, step: 1 } }, pending, meta);
  // 模拟第二个 tick：pending 沿用同一个 Map（引擎侧 pendingByCallId 常驻）
  foldTraceEvent(trace, { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'ck', isError: false, content: [{ type: 'text', text: 'ok' }] }] } } }, pending, meta);
  assert.equal(trace.entries[1].result.text, 'ok');
});

await test('user/message 注入上下文折叠为 inject；与 input 相同文本不重复', () => {
  const trace = newTrace();
  const pending = new Map();
  const meta = { input: '任务' };
  foldTraceEvent(trace, { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '技能规范加载' }] } } }, pending, meta);
  foldTraceEvent(trace, { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '任务' }] } }, pending, meta);
  assert.deepEqual(trace.entries.filter((e) => e.kind === 'inject').map((e) => e.text), ['技能规范加载']);
});

await test('finalizeTrace：空 input 时把首条非系统 inject 归位为 input（回放语义不回归）', () => {
  const trace = { model: '', entries: [{ kind: 'input', text: '' }, { kind: 'inject', text: '真实用户输入' }, { kind: 'inject', text: '<system-reminder>系统</system-reminder>' }] };
  finalizeTrace(trace, { input: '' });
  assert.equal(trace.entries[0].text, '真实用户输入');
  assert.equal(trace.entries.length, 2);
  assert.equal(trace.entries[1].text, '<system-reminder>系统</system-reminder>');
});

await test('失败结果 isError=true → ok=false；成功不带 error 字段', () => {
  const trace = newTrace();
  const pending = new Map();
  const meta = { input: '任务' };
  foldTraceEvent(trace, { seq: 1, type: 'tool/call', data: { callId: 'x', name: 'bash', arguments: 'e', turn: 1, step: 1 } }, pending, meta);
  foldTraceEvent(trace, { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'x', isError: true, content: [{ type: 'text', text: 'exit 1' }] }] } } }, pending, meta);
  assert.equal(trace.entries[1].result.ok, false);
  assert.equal(trace.entries[1].result.error, undefined);
});

await test('sessionEventsOf：新 SDK（snapshotEvents 方法）优先，旧 SDK（.events 数组）回退', () => {
  const events = [{ seq: 0, type: 'turn/start', data: {} }];
  const modern = { snapshotEvents: () => events };
  const legacy = { events };
  assert.equal(sessionEventsOf(modern), events);
  assert.equal(sessionEventsOf(legacy), events);
  // 两者都有时新 API 优先（snapshotEvents 是当前契约）
  const both = { snapshotEvents: () => events, events: ['stale'] };
  assert.equal(sessionEventsOf(both), events);
});

await test('sessionEventsOf：异常形态降级为空数组，不再抛「events is not iterable」', () => {
  assert.deepEqual(sessionEventsOf(null), []);
  assert.deepEqual(sessionEventsOf(undefined), []);
  assert.deepEqual(sessionEventsOf({}), []);
  // snapshotEvents 抛错（session 已释放等）也降级为空数组
  assert.deepEqual(sessionEventsOf({ snapshotEvents: () => { throw new Error('released'); } }), []);
  // 旧 SDK 形态但 .events 非数组
  assert.deepEqual(sessionEventsOf({ events: undefined }), []);
});

console.log(process.exitCode ? 'live-trace tests: FAIL' : `live-trace tests: ALL PASS (${passed})`);
