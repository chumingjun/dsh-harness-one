import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProject, prepareChapter } from '../lib/core.js';
import { recordIssue, recoverIssues, validationReport } from '../lib/validation.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scheme-validation-'));
  const rules = join(root, 'rules'); const cwd = join(root, 'project');
  await mkdir(join(rules, 'skills/one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills/one/SKILL.md'), 'one');
  await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'test', version: '1', resources: [], chapters: [
    { id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', inputs: [], outputs: [{ id: '1', kind: 'body' }], dependencies: [] },
  ] }));
  return createProject({ sessionCwd: cwd, projectId: 'test', rulesDir: rules });
}

test('persistent issues deduplicate retries, retain recovery and never change a preparation', async () => {
  const store = await fixture(); await prepareChapter(store, { chapterId: 'one' });
  const before = await readFile(join(store.root, '.ccpg-scheme/state.json'), 'utf8');
  const event = { source: 'runtime', operation: 'model-request', chapterId: 'one', code: 'CONTEXT_LIMIT', position: 'session:1:2', build: 'test-build' };
  await Promise.all([recordIssue(store, event), recordIssue(store, event)]);
  await recoverIssues(store, { source: 'runtime', operation: 'model-request', position: 'session:1:2' });
  const report = await validationReport(store);
  assert.equal(report.issues.length, 1); assert.equal(report.issues[0].count, 2);
  assert.equal(report.issues[0].status, 'recovered'); assert.equal(report.issues[0].recoveries, 1);
  assert.match(await readFile(join(store.root, report.path), 'utf8'), /已恢复/);
  assert.equal(await readFile(join(store.root, '.ccpg-scheme/state.json'), 'utf8'), before);
  const restarted = await validationReport(store);
  assert.deepEqual(restarted.issues, report.issues);
  await recordIssue(store, event);
  assert.equal((await validationReport(store)).issues[0].status, 'open');
});

test('shareable report redacts explicit feedback and never copies arbitrary native messages', async () => {
  const store = await fixture();
  await recordIssue(store, { source: 'plugin', operation: 'tool:chapter_submit', code: 'Error', message: 'password=hunter2 material正文 SECRET', build: 'test' });
  await recordIssue(store, { source: 'user', chapterId: 'one', summary: '表格错误 token=abc https://private.example/a /Users/name/private.md person@example.com', expected: '按模板', actual: '字段缺失', build: 'test' });
  await recordIssue(store, { source: 'model', chapterId: 'one', summary: '可能是规则问题', build: 'test' });
  const report = await validationReport(store); const text = await readFile(join(store.root, report.path), 'utf8');
  assert.equal(report.issues.length, 3);
  assert.match(text, /用户反馈/); assert.match(text, /模型候选/);
  assert.doesNotMatch(text, /hunter2|SECRET|material正文|abc|private\.example|\/Users\/name|person@example/);
  assert.match(text, /未生成：1/);
  assert.match(text, /实际模型用量：未采集/);
});

test('cancellation is excluded, healthy report is explicit, symlinks cannot escape', async () => {
  const store = await fixture();
  await recordIssue(store, { source: 'runtime', code: 'CANCELLED' });
  assert.equal((await validationReport(store)).issues.length, 0);
  assert.match(await readFile(join(store.root, 'reports/方案生成问题报告.md'), 'utf8'), /尚未记录问题/);
  const outside = await mkdtemp(join(tmpdir(), 'scheme-outside-'));
  const unsafe = await fixture(); await symlink(outside, join(unsafe.root, 'reports'));
  await assert.rejects(validationReport(unsafe), /symlink/);
});

test('unrelated successes do not rewrite reports or close another build, structural gaps stay visible', async () => {
  const store = await fixture();
  await recordIssue(store, { source: 'plugin', operation: 'tool:chapter_submit', build: 'old' });
  const path = join(store.root, 'reports/方案生成问题报告.md');
  const before = await stat(path);
  await recoverIssues(store, { source: 'plugin', operation: 'tool:chapter_submit', build: 'new' });
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  const report = await validationReport(store);
  assert.equal(report.issues[0].status, 'open');
  assert.deepEqual(report.checks.unGenerated, ['one']);
});

test('reporting does not acquire a busy business state lock', async () => {
  const store = await fixture();
  await store.withLock(async () => {
    const report = await validationReport(store);
    assert.equal(report.open, 0);
    assert.deepEqual(report.checks.unGenerated, ['one']);
  });
});

test('structural report identifies missing inputs, decisions, attachments and invalid evidence without reading materials', async () => {
  const store = await fixture();
  const manifestPath = join(store.root, '.ccpg-scheme/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.chapters[0].inputs = [{ id: 'required', required: true }, { id: 'unknown', required: 'unknown' }, { id: 'bound', required: false }];
  manifest.chapters[0].outputs.push({ id: 'appendix', kind: 'attachment' });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const statePath = join(store.root, '.ccpg-scheme/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.chapters.one.artifactId = 'art-one';
  state.chapters.one.bindings = { bound: 'pending' };
  state.materials.pending = { parseStatus: 'needs-review', contentPath: '/must/not/read' };
  state.artifacts['art-one'] = { path: 'outputs/test' };
  await mkdir(join(store.root, 'outputs/test'), { recursive: true });
  await writeFile(join(store.root, 'outputs/test/body.md'), 'Body');
  await writeFile(join(store.root, 'outputs/test/attachments.json'), '[]');
  await writeFile(join(store.root, 'outputs/test/evidence.json'), '[{"source":"unregistered"}]');
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, 'utf8');
  const { checks } = await validationReport(store);
  assert.deepEqual(checks.requiredInputs, ['one/required']);
  assert.deepEqual(checks.unresolvedDecisions, ['one/unknown']);
  assert.deepEqual(checks.unavailableBindings, ['one/bound']);
  assert.deepEqual(checks.missingOutputs, ['one/appendix']);
  assert.deepEqual(checks.invalidEvidence, ['one']);
  assert.deepEqual(checks.unGenerated, []);
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('invalid caller metadata cannot enter shareable reports as internal identifiers', async () => {
  const store = await fixture();
  await recordIssue(store, { source: 'plugin', operation: 'tool:submit?token=secret', build: '/Users/private/key' });
  const text = await readFile(join(store.root, 'reports/方案生成问题报告.md'), 'utf8');
  assert.doesNotMatch(text, /secret|\/Users\/private/);
});
