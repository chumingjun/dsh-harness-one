import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

function responseCapture() {
  const listeners = new Map();
  return {
    status: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
    on(event, callback) { listeners.set(event, callback); return this; },
    once(event, callback) { const inner = listeners.get(event); listeners.set(event, () => { inner?.(); callback(); }); return this; },
    emit(event) { listeners.get(event)?.(); return this; },
    destroy(error) { if (error) throw error; },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8') || '{}'); },
  };
}

function request(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

const withSession = (url, sessionId) => `${url}${url.includes('?') ? '&' : '?'}sessionId=${sessionId}`;
const dshHome = mkdtempSync(join(tmpdir(), 'wf1-plugin-home-'));
const workspacesRoot = mkdtempSync(join(tmpdir(), 'wf1-workspaces-'));
const workspaceA = join(workspacesRoot, 'workspace-a');
const workspaceB = join(workspacesRoot, 'workspace-b');
mkdirSync(workspaceA, { recursive: true });
mkdirSync(workspaceB, { recursive: true });
const original = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;

const legacyDataDir = join(dshHome, 'plugin-data', 'dsh-ccpg-orchestrator');
const seedLegacy = () => {
  mkdirSync(join(legacyDataDir, 'workflows'), { recursive: true });
  mkdirSync(join(legacyDataDir, 'runs'), { recursive: true });
  mkdirSync(join(legacyDataDir, 'state'), { recursive: true });
  writeFileSync(join(legacyDataDir, 'workflows', 'wf_it_legacy.json'), JSON.stringify({
    id: 'wf_it_legacy', name: 'IT 遗留工作流', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    graph: { nodes: [], edges: [] },
  }));
  writeFileSync(join(legacyDataDir, 'runs', 'run_it_legacy.json'), JSON.stringify({
    runId: 'run_it_legacy', startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:00:01.000Z',
    status: 'success', triggerInput: '', outputs: {}, structuredOutputs: {}, nodeStates: {}, nodeOrder: [], schemaVersion: 3,
  }));
  writeFileSync(join(legacyDataDir, 'state', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));
};
seedLegacy();

try {
  const routes = [];
  const sessionMap = new Map([
    ['session-a', { header: { cwd: workspaceA } }],
    ['session-b', { header: { cwd: workspaceB } }],
  ]);
  const sessions = { get: (id) => sessionMap.get(String(id)), flush: async () => {} };
  const ctx = {
    webServer: { register(route) { routes.push(route); } },
    tools: { register() {}, schemas() { return []; } },
    get(name) {
      if (name === 'sessions') return sessions;
      if (name === 'workspaceRegistry') return { list: () => [{ path: workspaceA }, { path: workspaceB }] };
      return null;
    },
    skills: { async list() { return []; } },
    llm: { listProviders() { return []; }, async listModels() { return []; } },
    agentPresets: { async mount() {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  apply(ctx, {});
  const route = (path) => routes.find((entry) => entry.kind === 'exact' && entry.path === path)?.handler;

  const graphA = responseCapture();
  await route('/wf1/api/graph')(request('GET', withSession('/wf1/api/graph', 'session-a')), graphA);
  assert.equal(graphA.status, 200);
  assert.ok(Array.isArray(graphA.json().nodes));
  assert.equal(existsSync(join(workspaceA, '.workflow-one', 'state', 'legacy-import.json')), true);
  assert.equal(existsSync(join(workspaceB, '.workflow-one')), false);

  const workflowsA = responseCapture();
  await route('/wf1/api/workflows')(request('GET', withSession('/wf1/api/workflows', 'session-a')), workflowsA);
  assert.equal(workflowsA.status, 200);
  assert.ok(workflowsA.json().workflows.some((row) => row.id === 'wf_it_legacy'));

  const workflowsB = responseCapture();
  await route('/wf1/api/workflows')(request('GET', withSession('/wf1/api/workflows', 'session-b')), workflowsB);
  assert.equal(workflowsB.status, 200);
  assert.equal(workflowsB.json().workflows.some((row) => row.id === 'wf_it_legacy'), false);

  const createA = responseCapture();
  await route('/wf1/api/workflows')(request('POST', withSession('/wf1/api/workflows', 'session-a'), {
    id: 'wf_only_a', name: '仅 A', graph: { nodes: [], edges: [] },
  }), createA);
  assert.equal(createA.status, 200);
  assert.equal(existsSync(join(workspaceA, '.workflow-one', 'workflows', 'wf_only_a.json')), true);
  assert.equal(existsSync(join(workspaceB, '.workflow-one', 'workflows', 'wf_only_a.json')), false);

  const runRes = responseCapture();
  await route('/wf1/api/run')(request('POST', withSession('/wf1/api/run', 'session-b'), {
    graph: {
      nodes: [{ id: 'input_one', type: 'input', position: { x: 0, y: 0 }, data: { label: '测试输入', text: 'hello' } }],
      edges: [],
    },
    triggerInput: 'world',
  }), runRes);
  assert.equal(runRes.status, 200);
  const newRunId = runRes.json().runId;
  let storedRun;
  const runsDirB = join(workspaceB, '.workflow-one', 'runs');
  // startRun 即落盘 running 快照（成果面板运行中可读），这里等运行完结状态（success/error/canceled）
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const files = existsSync(runsDirB) ? readdirSync(runsDirB).filter((file) => file.endsWith('.json')) : [];
    storedRun = files.map((file) => JSON.parse(readFileSync(join(runsDirB, file), 'utf8'))).find((run) => run.runId === newRunId);
    if (storedRun && storedRun.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(storedRun?.status, 'success');
  assert.equal(storedRun?.workspaceRoot, undefined);
  assert.equal(existsSync(join(workspaceA, '.workflow-one', 'runs', `${newRunId}.json`)), false);
  assert.equal(existsSync(join(dshHome, 'plugin-data', 'dsh-ccpg-orchestrator', 'runs', `${newRunId}.json`)), false);

  const missingSession = responseCapture();
  await route('/wf1/api/graph')(request('GET', '/wf1/api/graph'), missingSession);
  assert.equal(missingSession.status, 409);

  // 产物预览链路：/run-results 回传的 URL 必须继承 sessionId，
  // 前端原样 fetch 才不会撞 scoped 路由的 409 workspace-session-required。
  const artifactRunRes = responseCapture();
  await route('/wf1/api/run')(request('POST', withSession('/wf1/api/run', 'session-b'), {
    graph: {
      nodes: [
        { id: 'input_src', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'hi' } },
        { id: 'script_doc', type: 'script', position: { x: 0, y: 0 }, data: {
          label: '写文件',
          code: 'function main(input, workspace) { workspace.write("report.md", "# 成果"); return { ok: true }; }',
          outputSchema: null,
        } },
      ],
      edges: [{ source: 'input_src', target: 'script_doc' }],
    },
    triggerInput: '',
  }), artifactRunRes);
  assert.equal(artifactRunRes.status, 200);
  const artifactRunId = artifactRunRes.json().runId;
  let artifactRunDoc;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    artifactRunDoc = readdirSync(runsDirB)
      .map((file) => JSON.parse(readFileSync(join(runsDirB, file), 'utf8')))
      .find((run) => run.runId === artifactRunId);
    if (artifactRunDoc && artifactRunDoc.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(artifactRunDoc?.status, 'success');
  assert.ok(artifactRunDoc.artifactIndex.length >= 1);

  const resultsRes = responseCapture();
  await route('/wf1/api/run-results')(request('GET', withSession(`/wf1/api/run-results?id=${artifactRunId}`, 'session-b')), resultsRes);
  assert.equal(resultsRes.status, 200);
  const artifactRow = resultsRes.json().artifacts.find((row) => row.name === 'report.md');
  assert.ok(artifactRow, 'report.md 应在产物清单中');
  assert.match(artifactRow.downloadUrl, /[?&]sessionId=session-b$/);
  assert.match(artifactRow.previewUrl, /[?&]sessionId=session-b$/);

  // 前端拿响应 URL 直接请求（相对路径挂在服务根上）：命中 scoped 会话应 200 而非 409
  const previewPath = artifactRow.previewUrl.replace(/^https?:\/\/[^/]+/, '');
  const previewRes = responseCapture();
  await new Promise((resolve, reject) => {
    previewRes.on('error', reject);
    const origEnd = previewRes.end.bind(previewRes);
    previewRes.end = (chunk) => { origEnd(chunk); resolve(); };
    route('/wf1/api/run-artifact')(request('GET', previewPath), previewRes);
  });
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers['Content-Type'], 'text/markdown; charset=utf-8');

  console.log('plugin storage integration tests: ALL PASS');
} finally {
  if (original === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = original;
  rmSync(dshHome, { recursive: true, force: true });
  rmSync(workspacesRoot, { recursive: true, force: true });
}
