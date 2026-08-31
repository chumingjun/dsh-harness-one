import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowSqliteStore } from '../lib/sqlite-store.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const run = (runId, startedAt, status = 'success', workflowId = null) => ({
  runId,
  workflowId,
  status,
  startedAt,
  finishedAt: startedAt,
  nodeStates: {},
  outputs: {},
  structuredOutputs: {},
});

const openStore = (root) => {
  mkdirSync(join(root, 'workflows'), { recursive: true });
  mkdirSync(join(root, 'runs'), { recursive: true });
  return new WorkflowSqliteStore({
    databaseFile: join(root, 'workflow-one.sqlite'),
    workflowsDir: join(root, 'workflows'),
    runsDir: join(root, 'runs'),
  });
};

console.log('sqlite feedback tables tests:');

test('add/list/delete comments roundtrip, scoped by run', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-fb-'));
  try {
    const store = openStore(root);
    const c1 = store.addArtifactComment({ runId: 'run_a', nodeId: 'n1', artifactId: 'report.md', body: '语气太随意' });
    const c2 = store.addArtifactComment({ runId: 'run_a', nodeId: 'n1', artifactId: 'report.md', body: '补充数据来源' });
    store.addArtifactComment({ runId: 'run_b', nodeId: 'n1', artifactId: 'report.md', body: '别的 run' });
    assert.equal(c1.id > 0 && c2.id > c1.id, true);
    assert.deepEqual(store.listArtifactComments('run_a').map((c) => c.body), ['语气太随意', '补充数据来源']);
    assert.equal(store.listArtifactComments('run_a')[0].node_id, 'n1');
    assert.equal(store.deleteArtifactComment(c1.id), true);
    assert.equal(store.listArtifactComments('run_a').length, 1);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('revisions version chain keeps insert order and revisionRunIds dedups', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-fb-'));
  try {
    const store = openStore(root);
    const id1 = store.addArtifactRevision({ targetRunId: 'run_a', nodeId: 'n1', artifactId: 'report.md', revisionRunId: 'run_rev1', name: 'report.md', summary: '改了语气', fileName: 'report.md', content: '# v1' });
    store.addArtifactRevision({ targetRunId: 'run_a', nodeId: 'n1', artifactId: 'report.md', revisionRunId: 'run_rev2', name: 'report.md', summary: '补了来源', fileName: 'report.md', content: '# v2' });
    const revisions = store.listArtifactRevisions('run_a');
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].id, id1);
    assert.deepEqual(revisions.map((r) => r.revision_run_id), ['run_rev1', 'run_rev2']);
    assert.deepEqual(store.revisionRunIds(), ['run_rev1', 'run_rev2']);
    assert.equal(store.listArtifactRevisions('run_b').length, 0);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pruneRuns keeps revision runs out of the stale window', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-fb-'));
  try {
    const store = openStore(root);
    // 3 条真实 run + 1 条改写 run（最老）；keep=3 时按时间窗口最老的该删，但它是修订引用，须保留
    store.putRun(run('run_keep1', '2026-08-01T00:00:01.000Z'));
    store.putRun(run('run_keep2', '2026-08-01T00:00:02.000Z'));
    store.putRun(run('run_keep3', '2026-08-01T00:00:03.000Z'));
    store.putRun({ ...run('run_rev_old', '2026-08-01T00:00:00.000Z'), source: 'revision' });
    store.addArtifactRevision({ targetRunId: 'run_keep1', nodeId: 'n1', artifactId: 'a.md', revisionRunId: 'run_rev_old', name: 'a.md', summary: null, fileName: 'a.md', content: 'x' });
    const pruned = store.pruneRuns(3, { keepRevisionRuns: store.revisionRunIds() });
    assert.deepEqual(pruned.map((r) => r.runId), []);
    assert.equal(store.getRun('run_rev_old') != null, true);
    // 反例：不在保护清单里的最老 run 正常淘汰
    store.putRun(run('run_oldest', '2026-07-31T00:00:00.000Z'));
    const pruned2 = store.pruneRuns(3, { keepRevisionRuns: store.revisionRunIds() });
    assert.deepEqual(pruned2.map((r) => r.runId), ['run_oldest']);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deleteRunData cascades comments and revisions for the run', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-fb-'));
  try {
    const store = openStore(root);
    store.addArtifactComment({ runId: 'run_a', nodeId: 'n1', artifactId: 'a.md', body: 'x' });
    store.addArtifactRevision({ targetRunId: 'run_a', nodeId: 'n1', artifactId: 'a.md', revisionRunId: 'run_rev1', name: 'a.md', summary: null, fileName: 'a.md', content: 'y' });
    store.addArtifactComment({ runId: 'run_b', nodeId: 'n1', artifactId: 'a.md', body: 'keep' });
    store.deleteRunData('run_a');
    assert.equal(store.listArtifactComments('run_a').length, 0);
    assert.equal(store.listArtifactRevisions('run_a').length, 0);
    assert.equal(store.listArtifactComments('run_b').length, 1);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v1 库升级到 v2 只补 DDL，不重导旧 JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-fb-'));
  try {
    // 先用 v1 版本语义建库：直接以当前 store 建库后，把 user_version 压回 1 并塞一份陈旧 JSON
    const store = openStore(root);
    store.putRun(run('run_x', '2026-08-02T00:00:00.000Z', 'success'));
    store.addArtifactComment({ runId: 'run_x', nodeId: 'n1', artifactId: 'a.md', body: '新评论' });
    store.close();
    // 压回版本号 + 放一份会覆盖 run_x 的陈旧 JSON
    const db = new DatabaseSync(join(root, 'workflow-one.sqlite'));
    db.exec('PRAGMA user_version = 1;');
    db.close();
    writeFileSync(join(root, 'runs', 'run_x.json'), JSON.stringify(run('run_x', '2020-01-01T00:00:00.000Z', 'canceled')));
    // 重开：1→2 只补 DDL；若错误重导 JSON，run_x 会被陈旧快照覆盖成 canceled
    const reopened = openStore(root);
    assert.equal(reopened.getRun('run_x').status, 'success');
    assert.equal(reopened.listArtifactComments('run_x').length, 1);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(passed > 0 ? `\n${passed} tests passed` : '');
