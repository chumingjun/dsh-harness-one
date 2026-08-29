import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../lib/index.js';
import { graphFingerprint } from '../lib/run-scope.js';
import { hashedKey } from '../lib/storage-paths.js';

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

function request(method, url, body, splitAt) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  queueMicrotask(() => {
    if (body !== undefined) {
      const raw = Buffer.from(JSON.stringify(body));
      if (Number.isInteger(splitAt)) {
        req.emit('data', raw.subarray(0, splitAt));
        req.emit('data', raw.subarray(splitAt));
      } else {
        req.emit('data', raw);
      }
    }
    req.emit('end');
  });
  return req;
}

const withSession = (url, sessionId) => `${url}${url.includes('?') ? '&' : '?'}sessionId=${sessionId}`;
const databaseFile = (workspace) => join(workspace, '.workflow-one', 'workflow-one.sqlite');
const readStoredDocument = (workspace, table, key, id) => {
  if (!existsSync(databaseFile(workspace))) return null;
  const db = new DatabaseSync(databaseFile(workspace), { readOnly: true });
  try {
    const row = db.prepare(`SELECT document_json FROM ${table} WHERE ${key} = ?`).get(id);
    return row ? JSON.parse(row.document_json) : null;
  } finally {
    db.close();
  }
};
const readStoredRun = (workspace, runId) => readStoredDocument(workspace, 'runs', 'run_id', runId);
const readStoredWorkflow = (workspace, workflowId) => readStoredDocument(workspace, 'workflows', 'id', workflowId);
const seedStoredRun = (workspace, value, updatedAt = new Date().toISOString()) => {
  const db = new DatabaseSync(databaseFile(workspace));
  try {
    db.prepare(`
      INSERT INTO runs (run_id, workflow_id, status, started_at, finished_at, updated_at, document_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        workflow_id=excluded.workflow_id, status=excluded.status,
        started_at=excluded.started_at, finished_at=excluded.finished_at,
        updated_at=excluded.updated_at, document_json=excluded.document_json
    `).run(value.runId, value.workflowId || null, value.status, value.startedAt || null, value.finishedAt || null, updatedAt, JSON.stringify(value));
  } finally {
    db.close();
  }
};
const dshHome = mkdtempSync(join(tmpdir(), 'wf1-plugin-home-'));
const workspacesRoot = mkdtempSync(join(tmpdir(), 'wf1-workspaces-'));
const workspaceA = join(workspacesRoot, 'workspace-a');
const workspaceB = join(workspacesRoot, 'workspace-b');
mkdirSync(workspaceA, { recursive: true });
mkdirSync(workspaceB, { recursive: true });
const original = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;
// 隔离包级 legacy 目录：开发机插件 data/ 里可能有真实历史运行，混入会按时间排序挤掉测试 seed（run_it_*）
const packageLegacyDir = join(dshHome, 'package-legacy');
mkdirSync(join(packageLegacyDir, 'state'), { recursive: true });
process.env.WF1_LEGACY_DATA_DIR = packageLegacyDir;
writeFileSync(join(packageLegacyDir, "state", "graph.json"), JSON.stringify({ nodes: [], edges: [] }));

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
  writeFileSync(join(legacyDataDir, 'runs', 'run_it_interrupted.json'), JSON.stringify({
    runId: 'run_it_interrupted', startedAt: '2026-08-02T00:00:00.000Z', status: 'running',
    triggerInput: '', outputs: { input: 'done' }, structuredOutputs: {}, schemaVersion: 3,
    graph: {
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'done' } },
        { id: 'output', type: 'output', position: { x: 200, y: 0 }, data: { label: '输出' } },
      ],
      edges: [{ source: 'input', target: 'output' }],
    },
    nodeStates: { input: { status: 'success' } },
    nodeOrder: ['input'],
  }));
  writeFileSync(join(legacyDataDir, 'runs', 'run_it_finished_checkpoint.json'), JSON.stringify({
    runId: 'run_it_finished_checkpoint', startedAt: '2026-08-03T00:00:00.000Z', status: 'running',
    triggerInput: '', outputs: { input: 'done' }, structuredOutputs: {}, schemaVersion: 3,
    graph: { nodes: [{ id: 'input', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'done' } }], edges: [] },
    nodeStates: { input: { status: 'success' } }, nodeOrder: ['input'],
  }));
  writeFileSync(join(legacyDataDir, 'state', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));
};
seedLegacy();
const disposers = [];

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
    effect(setup) { const dispose = setup(); if (dispose) disposers.push(dispose); },
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

  const runsA = responseCapture();
  await route('/wf1/api/runs')(request('GET', withSession('/wf1/api/runs', 'session-a')), runsA);
  const interruptedRun = runsA.json().runs.find((run) => run.runId === 'run_it_interrupted');
  assert.equal(interruptedRun.status, 'interrupted');
  assert.equal(interruptedRun.resumable, true);
  assert.equal(runsA.json().runs.find((run) => run.runId === 'run_it_finished_checkpoint').status, 'success');

  const workflowsB = responseCapture();
  await route('/wf1/api/workflows')(request('GET', withSession('/wf1/api/workflows', 'session-b')), workflowsB);
  assert.equal(workflowsB.status, 200);
  assert.equal(workflowsB.json().workflows.some((row) => row.id === 'wf_it_legacy'), false);

  const createA = responseCapture();
  await route('/wf1/api/workflows')(request('POST', withSession('/wf1/api/workflows', 'session-a'), {
    id: 'wf_only_a', name: '仅 A', graph: { nodes: [], edges: [] },
  }), createA);
  assert.equal(createA.status, 200);
  assert.equal(readStoredWorkflow(workspaceA, 'wf_only_a')?.name, '仅 A');
  assert.equal(readStoredWorkflow(workspaceB, 'wf_only_a'), null);
  assert.equal(existsSync(join(workspaceA, '.workflow-one', 'workflows', 'wf_only_a.json')), false, '新工作流不得双写 JSON');

  const utf8Workflow = {
    id: 'wf_utf8', name: '中文分块',
    graph: { nodes: [{ id: 'utf8_input', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: '审核对象' } }], edges: [] },
  };
  const utf8Raw = Buffer.from(JSON.stringify(utf8Workflow));
  const utf8Split = utf8Raw.indexOf(Buffer.from('审核对象')) + 1;
  const utf8Create = responseCapture();
  await route('/wf1/api/workflows')(request('POST', withSession('/wf1/api/workflows', 'session-b'), utf8Workflow, utf8Split), utf8Create);
  assert.equal(utf8Create.status, 200);
  const utf8Saved = readStoredWorkflow(workspaceB, 'wf_utf8');
  assert.equal(utf8Saved.graph.nodes[0].data.text, '审核对象');

  const deleteUtf8 = responseCapture();
  await route('/wf1/api/workflows/detail')(request('DELETE', withSession('/wf1/api/workflows/detail?id=wf_utf8', 'session-b')), deleteUtf8);
  assert.equal(deleteUtf8.status, 200);
  assert.equal(readStoredWorkflow(workspaceB, 'wf_utf8'), null);
  assert.equal(existsSync(join(workspaceB, '.workflow-one', 'state', 'tombstones', 'workflows', 'wf_utf8')), true);

  // ---- /wf1/api/trigger（#63 /workflow-one 触发源执行端）----
  // run：无画布绑定也可发起；工作区按 sessionId 解析（跨工作区隔离）。
  const seedTriggerWf = responseCapture();
  await route('/wf1/api/workflows')(request('POST', withSession('/wf1/api/workflows', 'session-a'), {
    id: 'wf_trigger', name: '触发源工作流',
    graph: { nodes: [{ id: 'trig_in', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'x' } }], edges: [] },
  }), seedTriggerWf);
  assert.equal(seedTriggerWf.status, 200);
  const triggerRunRes = responseCapture();
  await route('/wf1/api/trigger')(request('POST', withSession('/wf1/api/trigger', 'session-a'), {
    workflowId: 'wf_trigger', action: 'run',
  }), triggerRunRes);
  assert.equal(triggerRunRes.status, 200);
  assert.equal(triggerRunRes.json().ok, true);
  const triggerRunId = triggerRunRes.json().runId;
  let triggerRun;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    triggerRun = readStoredRun(workspaceA, triggerRunId);
    if (triggerRun && triggerRun.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(triggerRun?.status, 'success', 'trigger run 落在 session-a 工作区且成功');
  assert.equal(triggerRun.source, 'trigger');
  assert.equal(readStoredRun(workspaceB, triggerRunId), null, 'trigger run 不串工作区');

  // run：不存在的工作流 → 404
  const triggerMissing = responseCapture();
  await route('/wf1/api/trigger')(request('POST', withSession('/wf1/api/trigger', 'session-a'), {
    workflowId: 'wf_nope', action: 'run',
  }), triggerMissing);
  assert.equal(triggerMissing.status, 404);

  // open：未绑定画布 → 409 + code
  const triggerOpenUnbound = responseCapture();
  await route('/wf1/api/trigger')(request('POST', withSession('/wf1/api/trigger', 'session-a'), {
    workflowId: 'wf_trigger', action: 'open',
  }), triggerOpenUnbound);
  assert.equal(triggerOpenUnbound.status, 409);
  assert.equal(triggerOpenUnbound.json().code, 'canvas-not-bound');

  // open：绑定画布后成功，且画布切到目标工作流
  const bindCapture = responseCapture();
  await route('/wf1/api/assistant/bind')(request('POST', withSession('/wf1/api/assistant/bind', 'session-a'), {
    sessionId: 'session-a', canvasId: 'canvas-trigger',
  }), bindCapture);
  assert.equal(bindCapture.status, 200);
  const triggerOpen = responseCapture();
  await route('/wf1/api/trigger')(request('POST', withSession('/wf1/api/trigger', 'session-a'), {
    workflowId: 'wf_trigger', action: 'open',
  }), triggerOpen);
  assert.equal(triggerOpen.status, 200);
  assert.equal(triggerOpen.json().canvasId, 'canvas-trigger');
  assert.equal(triggerOpen.json().workflowId, 'wf_trigger');

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
  // startRun 即写入 running 快照（成果面板运行中可读），这里等运行完结状态（success/error/canceled）
  for (let attempt = 0; attempt < 30; attempt += 1) {
    storedRun = readStoredRun(workspaceB, newRunId);
    if (storedRun && storedRun.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(storedRun?.status, 'success');
  assert.equal(storedRun?.workspaceRoot, undefined);
  assert.equal(readStoredRun(workspaceA, newRunId), null);
  assert.equal(existsSync(join(workspaceB, '.workflow-one', 'runs', `${newRunId}.json`)), false, '新运行不得双写 JSON');
  assert.equal(existsSync(join(dshHome, 'plugin-data', 'dsh-ccpg-orchestrator', 'runs', `${newRunId}.json`)), false);

  const originalFetch = globalThis.fetch;
  let finishLiveFetch;
  let liveRunId;
  try {
    globalThis.fetch = () => new Promise((resolve) => {
      finishLiveFetch = () => resolve(new Response('ok', { status: 200 }));
    });
    const liveRunRes = responseCapture();
    await route('/wf1/api/run')(request('POST', withSession('/wf1/api/run', 'session-b'), {
      graph: {
        nodes: [
          { id: 'live_input', type: 'input', position: { x: 0, y: 0 }, data: { label: '实时输入', text: 'hello' } },
          { id: 'live_http', type: 'http', position: { x: 200, y: 0 }, data: { label: '实时请求', url: 'https://example.test', allowPrivate: true } },
          { id: 'live_output', type: 'output', position: { x: 400, y: 0 }, data: { label: '实时输出' } },
        ],
        edges: [
          { source: 'live_input', target: 'live_http' },
          { source: 'live_http', target: 'live_output' },
        ],
      },
      triggerInput: '',
    }), liveRunRes);
    assert.equal(liveRunRes.status, 200);
    liveRunId = liveRunRes.json().runId;

    let liveDetail;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detailRes = responseCapture();
      await route('/wf1/api/runs/detail')(request('GET', withSession(`/wf1/api/runs/detail?id=${liveRunId}`, 'session-b')), detailRes);
      liveDetail = detailRes.json();
      if (liveDetail.nodeStates?.live_http?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(liveDetail.status, 'running');
    assert.equal(liveDetail.graph.nodes.length, 3);
    assert.equal(liveDetail.nodeStates.live_input.status, 'success');
    assert.equal(liveDetail.nodeStates.live_http.status, 'running');
    assert.equal(liveDetail.nodeStates.live_output, undefined);
    assert.equal(liveDetail.workspaceRoot, undefined);

    const liveCheckpoint = readStoredRun(workspaceB, liveRunId);
    assert.equal(liveCheckpoint.status, 'running');
    assert.equal(liveCheckpoint.nodeStates.live_input.status, 'success');
    assert.equal(liveCheckpoint.outputs.live_input, 'hello');
    assert.equal(liveCheckpoint.workspaceRoot, undefined);

    const crossWorkspaceDetail = responseCapture();
    await route('/wf1/api/runs/detail')(request('GET', withSession(`/wf1/api/runs/detail?id=${liveRunId}`, 'session-a')), crossWorkspaceDetail);
    assert.equal(crossWorkspaceDetail.status, 404);
  } finally {
    finishLiveFetch?.();
    globalThis.fetch = originalFetch;
  }

  let finishedLiveRun;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    finishedLiveRun = readStoredRun(workspaceB, liveRunId);
    if (finishedLiveRun.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finishedLiveRun.status, 'success');

  seedStoredRun(workspaceB, {
    runId: 'run_late_orphan', schemaVersion: 3, status: 'running',
    startedAt: '2026-08-24T00:00:00.000Z', triggerInput: '', runInputs: {},
    graph: {
      nodes: [
        { id: 'orphan_done', type: 'input', position: { x: 0, y: 0 }, data: { label: '已完成' } },
        { id: 'orphan_pending', type: 'output', position: { x: 200, y: 0 }, data: { label: '未完成' } },
      ],
      edges: [{ source: 'orphan_done', target: 'orphan_pending' }],
    },
    nodeStates: { orphan_done: { status: 'success' } }, outputs: { orphan_done: 'done' },
    structuredOutputs: {}, nodeOrder: ['orphan_done'],
  });
  const orphanDetail = responseCapture();
  await route('/wf1/api/runs/detail')(request('GET', withSession('/wf1/api/runs/detail?id=run_late_orphan', 'session-b')), orphanDetail);
  assert.equal(orphanDetail.status, 200);
  assert.equal(orphanDetail.json().status, 'interrupted', '启动后产生的孤立 running 详情也应及时收敛');
  const orphanList = responseCapture();
  await route('/wf1/api/runs')(request('GET', withSession('/wf1/api/runs', 'session-b')), orphanList);
  assert.equal(orphanList.json().runs.find((run) => run.runId === 'run_late_orphan')?.status, 'interrupted');

  const resumeGraph = {
    nodes: [
      { id: 'resume_input', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'hello' } },
      { id: 'resume_output', type: 'output', position: { x: 200, y: 0 }, data: { label: '输出' } },
    ],
    edges: [{ source: 'resume_input', target: 'resume_output' }],
  };
  seedStoredRun(workspaceB, {
    runId: 'run_resume_seed', schemaVersion: 3, status: 'error',
    startedAt: '2026-08-24T00:00:00.000Z', finishedAt: '2026-08-24T00:00:01.000Z', durationMs: 1000,
    triggerInput: '', runInputs: {}, graph: resumeGraph, graphFingerprint: 'legacy-fingerprint',
    nodeStates: { resume_input: { status: 'success' }, resume_output: { status: 'error', error: '模拟失败' } },
    outputs: { resume_input: 'hello' }, structuredOutputs: {}, nodeOrder: ['resume_input', 'resume_output'],
  });

  // 改的是未完成节点（resume_output）→ 不再拦截，success 节点照常复用
  const changedGraph = structuredClone(resumeGraph);
  changedGraph.nodes[1].data.inputTemplate = 'changed';
  const changedResume = responseCapture();
  await route('/wf1/api/runs/resume')(request('POST', withSession('/wf1/api/runs/resume', 'session-b'), {
    runId: 'run_resume_seed', graph: changedGraph,
  }), changedResume);
  assert.equal(changedResume.status, 200);
  assert.equal(changedResume.json().resumedNodes, 1);
  // 响应明细：可复用/重跑节点 label 数组（RunHistory 弹窗直接展示）
  assert.deepEqual(changedResume.json().reusableNodes, ['输入']);
  assert.deepEqual(changedResume.json().rerunNodes, []);
  assert.equal(changedResume.json().rerunCount, 0);

  // 改到 success 节点自身（resume_input）→ 无可复用节点，400 nothing-reusable
  const brokenGraph = structuredClone(resumeGraph);
  brokenGraph.nodes[0].data.text = 'changed';
  const brokenResume = responseCapture();
  await route('/wf1/api/runs/resume')(request('POST', withSession('/wf1/api/runs/resume', 'session-b'), {
    runId: 'run_resume_seed', graph: brokenGraph,
  }), brokenResume);
  assert.equal(brokenResume.status, 400);
  assert.equal(brokenResume.json().code, 'nothing-reusable');

  // preview 模式：只返回复用/重跑明细，不启动运行
  const previewResume = responseCapture();
  await route('/wf1/api/runs/resume')(request('POST', withSession('/wf1/api/runs/resume', 'session-b'), {
    runId: 'run_resume_seed', graph: brokenGraph, preview: true,
  }), previewResume);
  assert.equal(previewResume.status, 200);
  assert.deepEqual(previewResume.json(), { reusableNodes: [], rerunNodes: ['输入'] });

  const matchingResume = responseCapture();
  await route('/wf1/api/runs/resume')(request('POST', withSession('/wf1/api/runs/resume', 'session-b'), {
    runId: 'run_resume_seed', graph: resumeGraph, graphFingerprint: 'stale-client-fingerprint',
  }), matchingResume);
  assert.equal(matchingResume.status, 200);
  assert.equal(matchingResume.json().resumedFrom, 'run_resume_seed');

  // 命名工作流场景：已保存版本改了 success 节点（resume_input）→ 无可复用节点拒绝
  const namedCreate = responseCapture();
  await route('/wf1/api/workflows')(request('POST', withSession('/wf1/api/workflows', 'session-b'), {
    id: 'wf_resume_named', name: '命名续跑', graph: brokenGraph,
  }), namedCreate);
  assert.equal(namedCreate.status, 200);
  seedStoredRun(workspaceB, {
    runId: 'run_resume_named_seed', schemaVersion: 3, status: 'interrupted', workflowId: 'wf_resume_named',
    startedAt: '2026-08-24T00:00:00.000Z', finishedAt: '2026-08-24T00:00:01.000Z', durationMs: 1000,
    triggerInput: '', runInputs: {}, graph: resumeGraph, graphFingerprint: graphFingerprint(resumeGraph),
    nodeStates: { resume_input: { status: 'success' }, resume_output: { status: 'running' } },
    outputs: { resume_input: 'hello' }, structuredOutputs: {}, nodeOrder: ['resume_input', 'resume_output'],
  });
  // 续跑物化前置：祖先运行的可复用节点在工作区留了文件，新 run 目录初始为空
  const resumeSeedWorkspace = join(
    workspaceB, '.workflow-one', 'runtime',
    hashedKey('wf_resume_named'), hashedKey('run_resume_named_seed'),
    'nodes', hashedKey('resume_input'), 'workspace',
  );
  mkdirSync(resumeSeedWorkspace, { recursive: true });
  writeFileSync(join(resumeSeedWorkspace, '底稿.md'), '# 祖先产物\n');
  // 同步进 seed 的 nodeStates.artifacts（真实运行里 success 节点都会带清单）
  {
    const seedDoc = readStoredRun(workspaceB, 'run_resume_named_seed');
    seedDoc.nodeStates.resume_input.artifacts = ['底稿.md'];
    seedStoredRun(workspaceB, seedDoc);
  }
  const namedMismatch = responseCapture();
  await route('/wf1/api/runs/resume')(request('POST', withSession('/wf1/api/runs/resume', 'session-b'), {
    runId: 'run_resume_named_seed', graph: resumeGraph,
  }), namedMismatch);
  assert.equal(namedMismatch.status, 400);
  assert.equal(namedMismatch.json().code, 'nothing-reusable');

  const namedRestore = responseCapture();
  await route('/wf1/api/workflows')(request('POST', withSession('/wf1/api/workflows', 'session-b'), {
    id: 'wf_resume_named', name: '命名续跑', graph: resumeGraph,
  }), namedRestore);
  assert.equal(namedRestore.status, 200);
  const namedResume = responseCapture();
  await route('/wf1/api/runs/resume')(request('POST', withSession('/wf1/api/runs/resume', 'session-b'), {
    runId: 'run_resume_named_seed',
  }), namedResume);
  assert.equal(namedResume.status, 200);
  assert.equal(namedResume.json().resumedFrom, 'run_resume_named_seed');

  // 续跑物化：可复用节点的祖先工作区文件必须拷进新 run 目录，
  // 且 /artifact 兜底沿 resumedFrom 链也能命中（祖先目录被清后仍可读）
  const resumedRunId = namedResume.json().runId;
  let resumedRunDoc;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    resumedRunDoc = readStoredRun(workspaceB, resumedRunId);
    if (resumedRunDoc && resumedRunDoc.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(resumedRunDoc?.status, 'success', `续跑运行未完成：${resumedRunDoc?.status}`);
  const resumedWorkspaceFile = join(
    workspaceB, '.workflow-one', 'runtime',
    hashedKey('wf_resume_named'), hashedKey(resumedRunId),
    'nodes', hashedKey('resume_input'), 'workspace', '底稿.md',
  );
  assert.equal(readFileSync(resumedWorkspaceFile, 'utf8'), '# 祖先产物\n');
  const resumedArtifact = responseCapture();
  await route('/wf1/api/artifact')(request('GET', withSession(
    `/wf1/api/artifact?run=${resumedRunId}&node=resume_input&file=${encodeURIComponent('底稿.md')}&preview=1`, 'session-b',
  )), resumedArtifact);
  assert.equal(resumedArtifact.status, 200);
  assert.match(resumedArtifact.headers['Content-Type'] || '', /text\/markdown/);

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
    artifactRunDoc = readStoredRun(workspaceB, artifactRunId);
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
  for (const dispose of disposers.reverse()) await dispose();
  if (original === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = original;
  rmSync(dshHome, { recursive: true, force: true });
  rmSync(workspacesRoot, { recursive: true, force: true });
}
