import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  createRunExport,
  createRunResults,
  isPreviewableMediaType,
  mediaTypeFor,
  normalizeRunDocument,
  parseByteRange,
  resolveRunArtifact,
  RUN_DOCUMENT_VERSION,
  snapshotRunArtifacts,
  streamArtifactResponse,
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
    input: { status: 'success' },
    agent: { status: 'success', artifacts: ['report.md'] },
    output: { status: 'success', writeback: { ok: true, url: 'https://example.test/doc' } },
  },
  outputs: { input: 'ticket-1', agent: 'agent result', output: 'final result' },
  structuredOutputs: {
    input: { version: 1, type: 'text', value: { text: 'ticket-1' } },
    agent: { version: 1, type: 'text', value: 'agent result' },
    output: { version: 1, type: 'json', value: { ok: true } },
  },
  nodeOrder: ['input', 'agent', 'output'],
  graph: {
    nodes: [
      { id: 'input', type: 'input', data: { label: '输入' } },
      { id: 'agent', type: 'agent', data: { label: '分析器' } },
      { id: 'note', type: 'note', data: { label: '画布注释' } },
      { id: 'output', type: 'output', data: { label: '最终成果' } },
    ],
    edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
  },
});

console.log('run results tests:');

await test('v1/v2 run documents normalize to v3, remove acceptance metadata, and do not mutate source', () => {
  const legacy = { ...baseRun(), review: { status: 'accepted' }, acceptance: { decision: 'approved' } };
  const before = structuredClone(legacy);
  const normalized = normalizeRunDocument(legacy);
  assert.deepEqual(legacy, before);
  assert.equal(normalized.schemaVersion, RUN_DOCUMENT_VERSION);
  assert.equal(normalized.finishedAt, '2026-08-20T00:00:01.500Z');
  assert.deepEqual(normalized.artifactIndex, []);
  assert.equal(normalized.review, undefined);
  assert.equal(normalized.acceptance, undefined);
  assert.throws(() => normalizeRunDocument({ ...legacy, schemaVersion: 4 }), /不支持/);
});

await test('run results use output nodes as final results and include every runtime node', () => {
  const run = normalizeRunDocument({
    ...baseRun(),
    artifactIndex: [
      { id: 'a1', nodeId: 'agent', nodeLabel: '分析器', name: 'report.md', relativePath: 'report.md', previewable: true },
      { id: 'a2', nodeId: 'output', nodeLabel: '最终成果', name: 'final.pdf', relativePath: 'final.pdf', previewable: true },
    ],
  });
  const result = createRunResults(run);
  assert.deepEqual(Object.keys(result), [
    'runId', 'status', 'workflowName', 'startedAt', 'finishedAt', 'durationMs',
    'finalStatus', 'usageTotal', 'outputResults', 'processResults', 'nodeTimeline', 'primaryResult',
    'results', 'artifacts', 'finalArtifacts', 'processArtifacts', 'links', 'inputs', 'issues',
  ]);
  assert.equal(result.finalStatus, 'available');
  assert.deepEqual(result.outputResults.map((row) => row.nodeId), ['output']);
  assert.deepEqual(result.processResults.map((row) => row.nodeId), ['input', 'agent']);
  assert.deepEqual(result.nodeTimeline.map((row) => row.nodeId), ['input', 'agent', 'output']);
  assert.equal(result.results.some((row) => row.nodeId === 'note'), false);
  assert.equal(result.primaryResult.nodeId, 'output');
  assert.equal(result.primaryResult.output, 'final result');
  assert.deepEqual(result.finalArtifacts.map((item) => item.id), ['a2']);
  assert.deepEqual(result.processArtifacts.map((item) => item.id), ['a1']);
  assert.equal(Object.hasOwn(result.artifacts[0], 'snapshot'), false);
  assert.equal(Object.hasOwn(result.artifacts[0], 'relativePath'), false);
  assert.equal(result.links[0].url, 'https://example.test/doc');
});

await test('usage passes through per node and totals across nodes; absent stays undefined (≠ 0)', () => {
  const run = normalizeRunDocument({
    ...baseRun(),
    nodeStates: {
      ...baseRun().nodeStates,
      agent: {
        status: 'success', artifacts: ['report.md'],
        model: 'provider-a:model-x',
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 60 },
      },
      output: { status: 'success', writeback: { ok: true }, usage: { inputTokens: 5, outputTokens: 2 } },
    },
  });
  const result = createRunResults(run);
  const agentRow = result.results.find((row) => row.nodeId === 'agent');
  assert.deepEqual(agentRow.usage, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 60 });
  assert.equal(agentRow.model, 'provider-a:model-x');
  // 运行级合计跨节点求和；input 节点无 usage 不贡献也不影响
  assert.deepEqual(result.usageTotal, { inputTokens: 105, outputTokens: 42, cacheReadTokens: 900, cacheWriteTokens: 60 });
  // 全部节点都无上报 → undefined（前端显示「无记录」，不得是 0 值对象）
  const bare = createRunResults(normalizeRunDocument(baseRun()));
  assert.equal(bare.usageTotal, undefined);
  assert.equal(bare.results.every((row) => row.usage === undefined), true);
});

await test('artifact URLs inherit sessionId so scoped routes can resolve the workspace', () => {
  const run = normalizeRunDocument({
    ...baseRun(),
    artifactIndex: [
      { id: 'a2', nodeId: 'output', nodeLabel: '最终成果', name: 'final.pdf', relativePath: 'final.pdf', previewable: true },
    ],
  });
  const withSession = createRunResults(run, { sessionId: 'sess/单 元' });
  assert.equal(withSession.artifacts[0].downloadUrl,
    '/wf1/api/run-artifact?run=run_test_1&artifact=a2&sessionId=sess%2F%E5%8D%95%20%E5%85%83');
  assert.equal(withSession.artifacts[0].previewUrl,
    '/wf1/api/run-artifact?run=run_test_1&artifact=a2&preview=1&sessionId=sess%2F%E5%8D%95%20%E5%85%83');
  const withoutSession = createRunResults(run);
  assert.equal(withoutSession.artifacts[0].downloadUrl, '/wf1/api/run-artifact?run=run_test_1&artifact=a2');
  assert.equal(withoutSession.artifacts[0].previewUrl, '/wf1/api/run-artifact?run=run_test_1&artifact=a2&preview=1');
});

await test('non-technical generated artifacts become final when output nodes have no files', () => {
  const run = normalizeRunDocument({
    ...baseRun(),
    artifactIndex: [
      { id: 'report', nodeId: 'agent', nodeLabel: '分析器', name: 'report.md', size: 12, relativePath: 'report.md', snapshot: 'run/report' },
      { id: 'empty', nodeId: 'agent', nodeLabel: '分析器', name: 'empty.txt', size: 0, relativePath: 'empty.txt', snapshot: 'run/empty' },
      { id: 'fetch', nodeId: 'agent', nodeLabel: '分析器', name: 'fetch_err2.json', size: 20, relativePath: 'fetch_err2.json', snapshot: 'run/fetch' },
      { id: 'log', nodeId: 'agent', nodeLabel: '分析器', name: 'debug.log', size: 20, relativePath: 'debug.log', snapshot: 'run/log' },
    ],
  });
  const result = createRunResults(run);
  assert.deepEqual(result.finalArtifacts.map((item) => item.id), ['report']);
  assert.deepEqual(result.processArtifacts.map((item) => item.id), ['empty', 'fetch', 'log']);
});

await test('legacy workflows without output nodes promote only non-technical artifacts', () => {
  const run = baseRun();
  run.graph.nodes = run.graph.nodes.filter((node) => node.type !== 'output');
  run.graph.edges = run.graph.edges.filter((edge) => edge.source !== 'output' && edge.target !== 'output');
  delete run.nodeStates.output;
  delete run.outputs.output;
  delete run.structuredOutputs.output;
  run.artifactIndex = [
    { id: 'report', nodeId: 'agent', nodeLabel: '分析器', name: 'report.md', size: 12, relativePath: 'report.md', snapshot: 'run/report' },
    { id: 'log', nodeId: 'agent', nodeLabel: '分析器', name: 'debug.log', size: 20, relativePath: 'debug.log', snapshot: 'run/log' },
  ];
  const result = createRunResults(run);
  assert.equal(result.finalStatus, 'legacy-inferred');
  assert.deepEqual(result.finalArtifacts.map((item) => item.id), ['report']);
  assert.deepEqual(result.processArtifacts.map((item) => item.id), ['log']);
});

await test('failed output is not replaced by a successful intermediate result', () => {
  const run = baseRun();
  delete run.outputs.output;
  run.nodeStates.output = { status: 'skipped' };
  const result = createRunResults(run);
  assert.equal(result.finalStatus, 'unavailable');
  assert.equal(result.primaryResult, null);
  assert.equal(result.outputResults[0].status, 'skipped');
  assert.equal(result.processResults.find((row) => row.nodeId === 'agent').output, 'agent result');
});

await test('timeline uses stable graph order and includes skipped branch nodes absent from nodeOrder', () => {
  const run = baseRun();
  run.graph.nodes.splice(2, 0, { id: 'branch', type: 'agent', data: { label: '未命中分支' } });
  run.graph.edges = [
    { source: 'input', target: 'agent' },
    { source: 'input', target: 'branch' },
    { source: 'agent', target: 'output' },
    { source: 'branch', target: 'output' },
  ];
  run.nodeStates.branch = { status: 'skipped' };
  const result = createRunResults(run);
  assert.deepEqual(result.nodeTimeline.map((row) => row.nodeId), ['input', 'agent', 'branch', 'output']);
  assert.equal(result.nodeTimeline.find((row) => row.nodeId === 'branch').text, '本次流程未执行该节点');
});

await test('preview MIME coverage includes safe text, Office documents, images, and PDF but excludes unknown binaries and SVG', () => {
  assert.equal(mediaTypeFor('data.json'), 'application/json; charset=utf-8');
  assert.equal(mediaTypeFor('photo.webp'), 'image/webp');
  assert.equal(mediaTypeFor('document.pdf'), 'application/pdf');
  assert.equal(mediaTypeFor('report.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mediaTypeFor('legacy.xls'), 'application/vnd.ms-excel');
  assert.equal(mediaTypeFor('table.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(mediaTypeFor('slides.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  for (const filename of ['document.pdf', 'notes.txt', 'report.docx', 'legacy.xls', 'table.xlsx', 'slides.pptx']) {
    assert.equal(isPreviewableMediaType(mediaTypeFor(filename)), true);
  }
  assert.equal(isPreviewableMediaType(mediaTypeFor('archive.zip')), false);
  assert.equal(isPreviewableMediaType(mediaTypeFor('unsafe.svg')), false);
});

await test('byte range parser handles bounded, open, suffix, clamped, and invalid ranges', () => {
  assert.equal(parseByteRange(undefined, 10), null);
  assert.deepEqual(parseByteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-30', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=8-30', 10), { start: 8, end: 9 });
  for (const value of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=', 'items=0-1', 'bytes=0-1,3-4']) {
    assert.deepEqual(parseByteRange(value, 10), { unsatisfiable: true });
  }
  assert.deepEqual(parseByteRange('bytes=0-0', 0), { unsatisfiable: true });
});

function captureResponse() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.writeHead = (status, headers) => {
    response.status = status;
    response.headers = headers;
  };
  response.body = () => Buffer.concat(chunks);
  return response;
}

async function streamFixture(file, range, options = {}) {
  const response = captureResponse();
  const finished = new Promise((resolve, reject) => {
    response.once('finish', resolve);
    response.once('error', reject);
  });
  streamArtifactResponse({ headers: range ? { range } : {} }, response, {
    file,
    filename: options.filename || 'sample.txt',
    mediaType: options.mediaType || 'text/plain; charset=utf-8',
    preview: options.preview || false,
  });
  await finished;
  return response;
}

await test('stream helper sends safe 200/206/416 responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-stream-'));
  try {
    const file = join(root, 'sample.txt');
    writeFileSync(file, '0123456789');

    const full = await streamFixture(file);
    assert.equal(full.status, 200);
    assert.equal(full.headers['Accept-Ranges'], 'bytes');
    assert.equal(full.headers['Content-Length'], '10');
    assert.equal(full.headers['Content-Disposition'], "attachment; filename*=UTF-8''sample.txt");
    assert.equal(full.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(full.body().toString(), '0123456789');

    const partial = await streamFixture(file, 'bytes=2-5', {
      filename: '报告.html',
      mediaType: 'text/html; charset=utf-8',
      preview: true,
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['Content-Range'], 'bytes 2-5/10');
    assert.equal(partial.headers['Content-Length'], '4');
    assert.match(partial.headers['Content-Disposition'], /^inline;/);
    assert.equal(partial.headers['Content-Security-Policy'], "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    assert.equal(partial.body().toString(), '2345');

    const invalid = await streamFixture(file, 'bytes=20-');
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['Content-Range'], 'bytes */10');
    assert.equal(invalid.headers['Content-Length'], '0');
    assert.equal(invalid.headers['Accept-Ranges'], 'bytes');
    assert.equal(invalid.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(invalid.body().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

await test('artifact snapshots accept run-scoped workspace and direct artifact directory callbacks', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-scoped-results-'));
  try {
    const workspace = join(root, 'workflow-key', 'run-key', 'nodes', 'node-key', 'workspace');
    const artifactRunDir = join(root, 'workflow-key', 'run-key', 'artifacts');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'report.md'), 'scoped result');
    const run = { ...baseRun(), workflowId: 'workflow-id' };
    const calls = [];
    const snapshot = snapshotRunArtifacts(run, {
      workspaceForNode: (scope) => {
        calls.push(scope);
        return workspace;
      },
      artifactRunDir,
    });
    assert.deepEqual(calls.find((call) => call.nodeId === 'agent'), {
      workflowId: 'workflow-id', runId: 'run_test_1', nodeId: 'agent', nodeLabel: '分析器',
    });
    assert.equal(snapshot.artifacts[0].snapshot, snapshot.artifacts[0].id);
    const persisted = normalizeRunDocument({ ...run, artifactIndex: snapshot.artifacts });
    assert.equal(resolveRunArtifact([join(root, 'missing'), artifactRunDir], persisted, snapshot.artifacts[0].id)?.file,
      realpathSync(join(artifactRunDir, snapshot.artifacts[0].id)));
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

await test('artifact resolution and ZIP export fall back across multiple roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1-export-roots-'));
  try {
    const oldRoot = join(root, 'old-artifacts');
    const newRoot = join(root, 'new-artifacts');
    const runDir = join(oldRoot, 'run_test_1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'artifact-id'), 'legacy artifact');
    mkdirSync(newRoot, { recursive: true });
    const run = normalizeRunDocument({
      ...baseRun(),
      artifactIndex: [{
        id: 'artifact-id', nodeId: 'agent', nodeLabel: '分析器', name: 'legacy.md',
        relativePath: 'legacy.md', snapshot: 'run_test_1/artifact-id', size: 15,
      }],
    });
    assert.equal(resolveRunArtifact({ artifactRoots: [newRoot, oldRoot] }, run, 'artifact-id')?.file,
      realpathSync(join(runDir, 'artifact-id')));
    const zip = createRunExport(run, [newRoot, oldRoot]);
    assert.match(zip.toString('utf8'), /artifacts\/分析器\/legacy\.md/);
    assert.match(zip.toString('utf8'), /legacy artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} tests passed`);
