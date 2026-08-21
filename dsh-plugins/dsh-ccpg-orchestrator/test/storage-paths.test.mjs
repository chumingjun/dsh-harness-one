import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStoragePaths,
  hashedKey,
  resolveStoragePaths,
  stableHashedKey,
} from '../lib/storage-paths.js';

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

console.log('storage paths tests:');

test('uses the workspace hidden directory and exposes read-only legacy layouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccpg-storage-'));
  try {
    const workspaceRoot = join(root, 'workspace');
    const dshHome = join(root, 'custom-dsh');
    const legacyRoot = join(root, 'legacy-data');
    const paths = createStoragePaths({ workspaceRoot, dshHome, legacyRoot });
    const pluginRoot = join(workspaceRoot, '.workflow-one');
    assert.equal(paths.workspaceRoot, workspaceRoot);
    assert.equal(paths.root, pluginRoot);
    assert.equal(paths.state, join(pluginRoot, 'state'));
    assert.equal(paths.workflows, join(pluginRoot, 'workflows'));
    assert.equal(paths.attachments, join(pluginRoot, 'attachments'));
    assert.equal(paths.runs, join(pluginRoot, 'runs'));
    assert.equal(paths.runtime, join(pluginRoot, 'runtime'));
    assert.equal(paths.pluginDataLegacy.root, join(dshHome, 'plugin-data', 'dsh-ccpg-orchestrator'));
    assert.equal(paths.packageLegacy.root, legacyRoot);
    assert.equal(existsSync(workspaceRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires an absolute workspace root', () => {
  assert.throws(() => resolveStoragePaths({ workspaceRoot: 'relative' }), /绝对路径/);
  assert.throws(() => resolveStoragePaths(), /workspaceRoot/);
});

test('different workspaces never share roots', () => {
  const a = createStoragePaths({ workspaceRoot: '/tmp/wf1-a', dshHome: '/tmp/dsh', legacyRoot: '/tmp/legacy' });
  const b = createStoragePaths({ workspaceRoot: '/tmp/wf1-b', dshHome: '/tmp/dsh', legacyRoot: '/tmp/legacy' });
  assert.notEqual(a.root, b.root);
  assert.equal(a.root, '/tmp/wf1-a/.workflow-one');
  assert.equal(b.root, '/tmp/wf1-b/.workflow-one');
});

test('stable hashes and run-scoped runtime paths do not expose identifiers', () => {
  const paths = createStoragePaths({ workspaceRoot: '/tmp/workspace', dshHome: '/tmp/dsh-home', legacyRoot: '/tmp/legacy' });
  assert.equal(hashedKey('workflow/一'), stableHashedKey('workflow/一'));
  assert.match(hashedKey('workflow/一'), /^[a-f0-9]{24}$/);
  assert.notEqual(hashedKey('workflow/一'), hashedKey('workflow/二'));
  const scope = { workflowId: 'workflow/一', runId: 'run/一' };
  const runRoot = join(paths.runtime, hashedKey(scope.workflowId), hashedKey(scope.runId));
  assert.equal(paths.runRoot(scope), runRoot);
  assert.equal(
    paths.workspaceForNode({ ...scope, nodeId: 'node/一' }),
    join(runRoot, 'nodes', hashedKey('node/一'), 'workspace'),
  );
  assert.equal(paths.artifactRunDir(scope), join(runRoot, 'artifacts'));
});

console.log(`\n${passed} tests passed`);
