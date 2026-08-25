import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const workflow = (id, updatedAt, nodes = []) => ({
  id,
  name: id,
  updatedAt,
  graph: { nodes, edges: [] },
});
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

console.log('sqlite store tests:');

test('migrates valid JSON, reports bad files, and becomes the only write source', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-sqlite-'));
  try {
    const workflowsDir = join(root, 'workflows');
    const runsDir = join(root, 'runs');
    const tombstones = join(root, 'state', 'tombstones', 'workflows');
    const errorFile = join(root, 'state', 'sqlite-migration-errors.json');
    const databaseFile = join(root, 'workflow-one.sqlite');
    chmodSync(root, 0o755);
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(tombstones, { recursive: true });
    writeFileSync(join(workflowsDir, 'wf_old.json'), JSON.stringify(workflow('wf_old', '2026-08-01T00:00:00.000Z', [
      { id: 'a', type: 'agent', data: {} },
      { id: 'o', type: 'output', data: {} },
    ])));
    writeFileSync(join(workflowsDir, 'wf_deleted.json'), JSON.stringify(workflow('wf_deleted', '2026-08-01T00:00:00.000Z')));
    writeFileSync(join(tombstones, 'wf_deleted'), 'deleted');
    writeFileSync(join(workflowsDir, 'wf_array.json'), '[]');
    writeFileSync(join(workflowsDir, 'wf_bad.json'), '{');
    writeFileSync(join(runsDir, 'run_old.json'), JSON.stringify(run('run_old', '2026-08-01T00:00:00.000Z', 'success', 'wf_old')));

    const warnings = [];
    const store = new WorkflowSqliteStore({
      databaseFile,
      workflowsDir,
      runsDir,
      workflowTombstoneDir: tombstones,
      migrationErrorFile: errorFile,
      logger: { warn(message) { warnings.push(message); } },
    });
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(databaseFile).mode & 0o777, 0o600);
    assert.deepEqual(store.listWorkflows(), [{
      id: 'wf_old', name: 'wf_old', updatedAt: '2026-08-01T00:00:00.000Z', nodeCount: 2, agentCount: 1,
    }]);
    assert.equal(store.getRun('run_old').workflowId, 'wf_old');
    const migrationErrors = JSON.parse(readFileSync(errorFile, 'utf8')).errors;
    assert.equal(migrationErrors.every((error) => error.kind === 'workflow'), true);
    assert.equal(migrationErrors.some((error) => error.error.includes('必须是对象')), true);
    assert.equal(warnings.some((message) => message.includes('wf_bad.json')), true);

    store.putWorkflow(workflow('wf_new', '2026-08-02T00:00:00.000Z'));
    store.putRun(run('run_new', '2026-08-02T00:00:00.000Z', 'success', 'wf_new'));
    assert.equal(existsSync(join(workflowsDir, 'wf_new.json')), false);
    assert.equal(existsSync(join(runsDir, 'run_new.json')), false);
    assert.deepEqual(store.listRuns(2).map((row) => row.runId), ['run_new', 'run_old']);
    assert.equal(store.deleteWorkflow('wf_new'), true);
    assert.equal(store.getWorkflow('wf_new'), null);
    assert.equal(store.getRun('run_new').workflowId, 'wf_new', '删除工作流不得级联删除历史运行');
    store.close();
    store.close();
    const settings = new DatabaseSync(databaseFile);
    assert.equal(settings.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(settings.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2);
    settings.close();

    writeFileSync(join(workflowsDir, 'wf_late.json'), JSON.stringify(workflow('wf_late', '2026-08-03T00:00:00.000Z')));
    const reopened = new WorkflowSqliteStore({ databaseFile, workflowsDir, runsDir, workflowTombstoneDir: tombstones, migrationErrorFile: errorFile });
    assert.equal(reopened.getWorkflow('wf_late'), null, '完成迁移后不得继续读取 JSON 备份');
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prunes runs by startedAt and keeps the newest rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-sqlite-prune-'));
  try {
    const store = new WorkflowSqliteStore({
      databaseFile: join(root, 'workflow-one.sqlite'),
      workflowsDir: join(root, 'workflows'),
      runsDir: join(root, 'runs'),
    });
    store.putRun(run('run_1', '2026-08-01T00:00:00.000Z'));
    store.putRun(run('run_3', '2026-08-03T00:00:00.000Z'));
    store.putRun(run('run_2', '2026-08-02T00:00:00.000Z'));
    assert.deepEqual(store.pruneRuns(2), [{ runId: 'run_1', workflowId: null }]);
    assert.deepEqual(store.listRuns(10).map((row) => row.runId), ['run_3', 'run_2']);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rolls back schema migration when the database is incompatible', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-sqlite-rollback-'));
  try {
    const databaseFile = join(root, 'workflow-one.sqlite');
    const workflowsDir = join(root, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'wf_seed.json'), JSON.stringify(workflow('wf_seed', '2026-08-01T00:00:00.000Z')));
    const broken = new DatabaseSync(databaseFile);
    broken.exec('CREATE TABLE workflows (id TEXT PRIMARY KEY) STRICT');
    broken.close();

    assert.throws(() => new WorkflowSqliteStore({ databaseFile, workflowsDir, runsDir: join(root, 'runs') }));
    const check = new DatabaseSync(databaseFile);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(check.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='runs'").get().count, 0);
    check.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} tests passed`);
