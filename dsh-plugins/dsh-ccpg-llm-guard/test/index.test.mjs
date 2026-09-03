import assert from 'node:assert/strict';
import { guardToolCalls } from '../lib/index.js';

async function collect(chunks) {
  // Array.fromAsync 需 node>=22，CI 是 node 20——手写聚合
  const out = [];
  for await (const chunk of guardToolCalls((async function* () { yield* chunks; })())) out.push(chunk);
  return out;
}

const finish = { type: 'finish', reason: { kind: 'tool-calls' } };
const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };

const text = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'finish', reason: { kind: 'stop' } },
];
assert.deepEqual(await collect(text), text);

const validCall = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read_file', argumentsDelta: '{}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' } },
  usage,
  finish,
];
assert.deepEqual(await collect(validCall), validCall);

for (const block of [
  { type: 'tool-call', id: '', name: 'read_file', arguments: '{}' },
  { type: 'tool-call', id: 'call-1', name: '', arguments: '{}' },
  { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '' },
]) {
  const output = await collect([
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block },
    usage,
    finish,
  ]);
  assert.deepEqual(output[0], usage);
  assert.equal(output[1].type, 'finish');
  assert.equal(output[1].reason.kind, 'error');
  assert.equal(output[1].reason.failure.code, 'EMPTY_RESPONSE');
  assert.equal(output.length, 2);
}

console.log('llm guard tests passed');

// —— 多余沙箱升级参数清洗（gpt-5.6-terra 在 danger-full-access 会话里自发带
//    sandbox_permissions/justification 导致 write 被拒的回归）——
const escalationCall = (args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'write', argumentsDelta: args },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-9', name: 'write', arguments: args } },
  finish,
];

{
  const out = await collect(escalationCall('{"file_path":"/tmp/a.md","content":"x","sandbox_permissions":"danger-full-access","justification":"创建交付物。"}'));
  assert.equal(out.length, 4);
  assert.deepEqual(JSON.parse(out[2].block.arguments), { file_path: '/tmp/a.md', content: 'x' });
}

{
  // justification 单独出现（无 sandbox_permissions）同样过不了成对校验，剔除
  const out = await collect(escalationCall('{"file_path":"/tmp/a.md","justification":""}'));
  assert.deepEqual(JSON.parse(out[2].block.arguments), { file_path: '/tmp/a.md' });
}

{
  // 无升级参数的调用原样放行（字符串引用相等，未被重写）
  const args = '{"file_path":"/tmp/a.md","content":"x"}';
  const out = await collect(escalationCall(args));
  assert.equal(out[2].block.arguments, args);
}

{
  // 非法 JSON 与非对象 JSON 原样放行
  for (const args of ['not json', '["sandbox_permissions"]', '"str"', 'null']) {
    const out = await collect(escalationCall(args));
    assert.equal(out[2].block.arguments, args);
  }
}

console.log('escalation strip tests passed');
