import assert from 'node:assert/strict';
import { guardToolCalls } from '../lib/index.js';

async function collect(chunks) {
  return Array.fromAsync(guardToolCalls((async function* () { yield* chunks; })()));
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
