import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunExport,
  createRunResults,
  normalizeRunDocument,
  resolveRunArtifact,
  RUN_DOCUMENT_VERSION,
  snapshotRunArtifacts,
} from '../lib/run-results.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const baseRun = () => ({
  runId: 'run_test_1',
  schemaVersion: 2,
  status: 'success',
  startedAt: '2026-08-20T00:00:00.000Z',
  durationMs: 1500,
  workflowName: '成果测试',
  triggerInput: 'ticket-1',
  runInputs: { region: 'cn' },
  nodeStates: {
    agent: { status: 'success', artifacts: ['report.md'] },
    output: { status: 'success', writeback: { ok: true, url: 'https://example.test/doc' } },
  },
  outputs: { agent: 'agent result', output: 'final result' },
  structuredOutputs: {
    agent: { version: 1, type: 'text', value: 'agent result' },
    output: { version: 1, type: 'json', value: { ok: true } },
  },
  nodeOrder: ['agent', 'output'],
  graph: {
    nodes: [
      { id: 'agent', type: 'agent', data: { label: '分析器' } },
      { id: 'output', type: 'output', data: { label: '最终成果' } },
    ],
    edges: [{ source: 'agent', target: 'output' }],
  },
});

console.log('run results tests:');

await test('v1/v2 run documents normalize to v3 without mutating source', () => {
  const legacy = baseRun();
  const before = structuredClone(legacy);
  const normalized = normalizeRunDocument(legacy);
  assert.deepEqual(legacy, before);
  assert.equal(normalized.schemaVersion, RUN_DOCUMENT_VERSION);
  assert.equal(normalized.finishedAt, '2026-08-20T00:00:01.500Z');
  assert.deepEqual(normalized.artifactIndex, []);
  assert.deepEqual(normalized.review, { status: 'pending', by: null, comment: '', updatedAt: null });
  assert.throws(() => normalizeRunDocument({ ...legacy, schemaVersion: 4 }), /不支持/);
});

await test('run results expose the complete frontend contract and primary output', () => {
  const run = normalizeRunDocument({
    ...baseRun(),
    artifactIndex: [{ id: 'a1', name: 'report.md', previewable: true }],
    review: { status: 'accepted', by: 'qa', comment: 'ok', updatedAt: '2026-08-20T01:00:00Z' },
  });
  const result = createRunResults(run);
  assert.deepEqual(Object.keys(result), [
    'runId', 'status', 'workflowName', 'startedAt', 'finishedAt', 'durationMs',
    'primaryResult', 'results', 'artifacts', 'links', 'inputs', 'review', 'issues',
  ]);
  assert.equal(result.primaryResult.nodeId, 'output');
  assert.equal(result.primaryResult.output, 'final result');
  assert.equal(result.artifacts[0].downloadUrl, '/wf1/api/run-artifact?run=run_test_1&artifact=a1');
  assert.equal(result.artifacts[0].previewUrl, '/wf1/api/run-artifact?run=run_test_1&artifact=a1&preview=1');
  assert.equal(result.links[0].url, 'https://example.test/doc');
  assert.deepEqual(result.inputs, { triggerInput: 'ticket-1', runInputs: { region: 'cn' } });
});

await test('artifact snapshots are immutable and reject paths outside the workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-results-'));
  try {
    const workspaceRoot = join(root, 'workspaces');
    const artifactRoot = join(root, 'artifacts');
    const workspace = join(workspaceRoot, '分析器');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'report.md'), 'version one');
    writeFileSync(join(root, 'secret.txt'), 'secret');
    const run = baseRun();
    run.nodeStates.agent.artifacts = ['report.md', 'nested/../report.md', '../secret.txt'];
    const snapshot = snapshotRunArtifacts(run, { workspaceRoot, artifactRoot });
    assert.equal(snapshot.artifacts.length, 1);
    assert.equal(snapshot.artifacts[0].relativePath, 'report.md');
    assert.equal(snapshot.issues.length, 1);
    assert.equal(snapshot.issues[0].code, 'artifact-snapshot-failed');
    const persisted = normalizeRunDocument({ ...run, artifactIndex: snapshot.artifacts });
    const resolved = resolveRunArtifact(artifactRoot, persisted, snapshot.artifacts[0].id);
    assert.ok(resolved);
    writeFileSync(join(workspace, 'report.md'), 'version two');
    assert.equal(readFileSync(resolved.file, 'utf8'), 'version one');
    assert.equal(resolveRunArtifact(artifactRoot, persisted, '../secret'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('ZIP export contains result index and immutable artifacts with UTF-8 names', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-export-'));
  try {
    const workspaceRoot = join(root, 'workspaces');
    const artifactRoot = join(root, 'artifacts');
    const workspace = join(workspaceRoot, '分析器');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'report.md'), '# report');
    const run = baseRun();
    const snapshot = snapshotRunArtifacts(run, { workspaceRoot, artifactRoot });
    const persisted = normalizeRunDocument({ ...run, artifactIndex: snapshot.artifacts });
    const zip = createRunExport(persisted, artifactRoot);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
    assert.match(zip.toString('utf8'), /run-results\.json/);
    assert.match(zip.toString('utf8'), /artifacts\/分析器\/report\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} tests passed`);
