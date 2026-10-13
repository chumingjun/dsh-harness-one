import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';

const sdk = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
const { PiAiAdapter } = await import(sdk.resolve('@deepseek-ai/dsh-llm-pi-ai'));
const { Session } = await import(sdk.resolve('@deepseek-ai/dsh-session'));
const { createUserMessage, IMAGE_OFFLOAD_REQUIRED_CODE } = await import(sdk.resolve('@deepseek-ai/dsh-llm'));
const { LocalAttachmentStore } = await import(sdk.resolve('@deepseek-ai/dsh-attachment-local'));
const nativeOffload = await import(sdk.resolve('@deepseek-ai/dsh-compaction-image-offload'));
const sharp = createRequire(sdk.resolve('@deepseek-ai/dsh-attachment-local'))('sharp');

test('native request budgets offload old image occurrences and retain the same session and originals', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ccpg-native-image-budget-'));
  const ctx = new Context(); const projections = [];
  ctx.provide('agents'); ctx.set('agents', {});
  ctx.provide('sessions'); ctx.set('sessions', { registerMessageProjection(value) { projections.push(value); } });
  const mounted = await ctx.plugin(nativeOffload);
  const attachments = new LocalAttachmentStore(ctx, { dshHome: home });
  t.after(() => mounted.dispose());
  const raw = Buffer.alloc(1280 * 720 * 3);
  let seed = 17;
  for (let i = 0; i < raw.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; raw[i] = seed >>> 24; }
  const data = await sharp(raw, { raw: { width: 1280, height: 720, channels: 3 } }).png().toBuffer();
  const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: 'source.png' });
  const original = Buffer.from((await attachments.readImage(ref)).data);
  const session = Session.create('native-images', undefined, undefined, undefined, projections);
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Read the required diagrams.' }, { type: 'image', attachment: ref }, { type: 'image', attachment: ref }] }), { surfaceOp: 'append' });
  const profile = { modelErrors: new Map(), streamIdleTimeoutMs: 1000, requestImagePixelBudget: 4194304, requestImageMaxBytes: 131072, maxRequestImageBytes: 196608 };
  const model = { id: 'vision', provider: 'test', input: ['text', 'image'], reasoning: false, contextWindow: 253686 };
  let upstreamCalls = 0;
  const snapshot = { profiles: new Map([['test', profile]]), models: { getModel() { return model; }, async *streamSimple(_model, context) {
    upstreamCalls++;
    const blocks = context.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    assert.equal(blocks.filter((block) => block.type === 'image').length, 0);
    yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: {} } };
  } } };
  const adapter = new PiAiAdapter({ resolveApiKey() { return undefined; }, resolveAttachments() { return attachments; } });
  const request = () => ({ provider: 'test', model: 'vision', messages: session.deriveMessages() });
  let failure; let caught;
  try { for await (const _chunk of adapter.streamWithSnapshot(request(), snapshot)) {} }
  catch (error) { caught = error; failure = error.failure; }
  assert.equal(failure?.code, IMAGE_OFFLOAD_REQUIRED_CODE, caught?.stack);
  assert.equal(failure.offloadImages, 2);
  assert.equal(upstreamCalls, 0, 'over-budget payload never reaches the provider');
  assert.deepEqual(await ctx.waterfall('agent/request-error', { agent: { session }, failure }, () => undefined), { kind: 'retry' });
  for await (const _chunk of adapter.streamWithSnapshot(request(), snapshot)) {}
  assert.equal(upstreamCalls, 1);
  assert.equal(session.id, 'native-images');
  assert.equal(session.log.filter((event) => event.type === 'image/offload').length, 1);
  assert.deepEqual(Buffer.from((await attachments.readImage(ref)).data), original, 'source attachment remains unchanged and can be read again');
});
