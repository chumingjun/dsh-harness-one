import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../lib/index.js';
import { createProject } from '../lib/core.js';

test('native error observers preserve retry decisions, correlate terminal failure and recover only on committed model response', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scheme-observer-'));
  const cwd = join(base, 'project'); const empty = join(base, 'empty'); await mkdir(cwd); await mkdir(empty);
  await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: new URL('../rules/', import.meta.url).pathname });
  const before = await readFile(join(cwd, '.ccpg-scheme/state.json'), 'utf8');
  const ctx = new Context(); const tools = [];
  for (const [key, value] of Object.entries({
    tools: { register(tool) { tools.push(tool); }, guard() {} }, webServer: { register() {} }, approval: {},
    commands: { register() {} }, connection: { rpc: { intercept() {} } },
    sessions: { get(sid) { return { header: { cwd: sid === 'unrelated' ? empty : cwd } }; } },
  })) { ctx.provide(key); ctx.set(key, value); }
  apply(ctx);
  const agent = { ctx, session: { id: 'native', header: { cwd } } };
  const args = { agent, turn: 2, step: 3, failure: { code: 'preflight_compress_failed', message: 'context exceeds window password=hidden' }, signal: new AbortController().signal };
  let nextCalls = 0; const decision = { action: 'fail' };
  const action = await ctx.waterfall('agent/request-error', args, () => { nextCalls++; return decision; });
  assert.equal(nextCalls, 1); assert.equal(action, decision);
  ctx.emit('agent/error', { ...args, error: new Error('context exceeds window') });
  await ctx.parallel('agent/status', { agent, status: 'idle' });
  const reportTool = tools.find((tool) => tool.name === 'scheme_validation_report');
  assert.ok(reportTool);
  const report = async () => JSON.parse(await reportTool.execute({ projectId: 'p' }, { sessionId: 'native' }));
  let data = await report();
  assert.equal(data.issues.length, 1); assert.equal(data.issues[0].count, 1);
  assert.equal(data.issues[0].status, 'open');
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a', turn: 2, step: 3 } });
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'a', outcome: { kind: 'committed', eventType: 'assistant/attempt' } } });
  assert.equal((await report()).issues[0].status, 'open');
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'b', turn: 2, step: 3 } });
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'b', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  assert.equal((await report()).issues[0].status, 'recovered');
  const replacement = { ctx, session: agent.session };
  await ctx.waterfall('agent/request-error', { ...args, agent: replacement }, () => decision);
  ctx.emit('agent/error', { ...args, agent: replacement, error: new Error('context exceeds window') });
  assert.equal((await report()).issues[0].count, 2);
  assert.equal((await report()).issues[0].status, 'open');
  await ctx.waterfall('agent/request-error', { ...args, agent: { ctx, session: { id: 'unrelated', header: { cwd: empty } } } }, () => decision);
  assert.equal((await report()).issues.length, 1);
  assert.equal(await readFile(join(cwd, '.ccpg-scheme/state.json'), 'utf8'), before);
  await ctx.parallel('dispose');
});

test('recording failure is visible without changing native retry or original operation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'scheme-observer-failure-'));
  await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: new URL('../rules/', import.meta.url).pathname });
  const outside = await mkdtemp(join(tmpdir(), 'scheme-report-outside-'));
  await symlink(outside, join(cwd, 'reports'));
  const ctx = new Context(); const tools = [];
  for (const [key, value] of Object.entries({
    tools: { register(tool) { tools.push(tool); }, guard() {} }, webServer: { register() {} }, approval: {},
    commands: { register() {} }, connection: { rpc: { intercept() {} } },
    sessions: { get() { return { header: { cwd } }; } },
  })) { ctx.provide(key); ctx.set(key, value); }
  apply(ctx);
  const agent = { ctx, session: { id: 'native', header: { cwd } } };
  const decision = { action: 'retry' };
  assert.equal(await ctx.waterfall('agent/request-error', { agent, turn: 1, step: 1, failure: { code: '502' } }, () => decision), decision);
  const result = JSON.parse(await tools.find((tool) => tool.name === 'project_status').execute({ projectId: 'p' }, { agent }));
  assert.match(result.validation.warning, /问题记录未保存/);
  assert.equal(await readFile(join(outside, '方案生成问题报告.md'), 'utf8').catch(() => null), null);
  await ctx.parallel('dispose');
});
