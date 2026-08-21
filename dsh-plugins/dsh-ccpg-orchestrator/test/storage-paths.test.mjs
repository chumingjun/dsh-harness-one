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

test('uses an explicit dshHome and exposes the new and legacy layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccpg-storage-'));
  try {
    const dshHome = join(root, 'custom-dsh');
    const legacyRoot = join(root, 'legacy-data');
    const paths = createStoragePaths({ dshHome, legacyRoot });
    const pluginRoot = join(dshHome, 'plugin-data', 'dsh-ccpg-orchestrator');
    assert.equal(paths.dshHome, dshHome);
    assert.equal(paths.root, pluginRoot);
    assert.equal(paths.newRoot, pluginRoot);
    assert.equal(paths.pluginRoot, pluginRoot);
    assert.equal(paths.legacyRoot, legacyRoot);
    assert.equal(paths.state, join(pluginRoot, 'state'));
    assert.equal(paths.workflows, join(pluginRoot, 'workflows'));
    assert.equal(paths.attachments, join(pluginRoot, 'attachments'));
    assert.equal(paths.runs, join(pluginRoot, 'runs'));
    assert.equal(paths.runtime, join(pluginRoot, 'runtime'));
    assert.equal(paths.workspaceRoot, paths.runtime);
    assert.equal(paths.artifactRoot, paths.runtime);
    assert.equal(paths.legacy.workflows, join(legacyRoot, 'workflows'));
    assert.equal(paths.legacy.runArtifacts, join(legacyRoot, 'run-artifacts'));
    assert.equal(existsSync(dshHome), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses DSH_HOME when no explicit override is supplied', () => {
  const previous = process.env.DSH_HOME;
  const root = mkdtempSync(join(tmpdir(), 'ccpg-storage-env-'));
  try {
    process.env.DSH_HOME = join(root, 'from-env');
    const paths = resolveStoragePaths({ legacyRoot: join(root, 'legacy') });
    assert.equal(paths.dshHome, process.env.DSH_HOME);
    assert.equal(paths.root, join(process.env.DSH_HOME, 'plugin-data', 'dsh-ccpg-orchestrator'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('stable hashes and run-scoped runtime paths do not expose identifiers', () => {
  const paths = createStoragePaths({ dshHome: '/tmp/dsh-home', legacyRoot: '/tmp/legacy' });
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
  assert.equal(paths.workspaceFor, paths.workspaceForNode);
  assert.equal(paths.artifactRunDir(scope), join(runRoot, 'artifacts'));
  assert.equal(paths.runArtifactDir, paths.artifactRunDir);
  assert.notEqual(
    paths.workspaceForNode({ ...scope, nodeId: 'node/一' }),
    paths.workspaceForNode({ workflowId: scope.workflowId, runId: 'run/二', nodeId: 'node/一' }),
  );
});

console.log(`\n${passed} tests passed`);
