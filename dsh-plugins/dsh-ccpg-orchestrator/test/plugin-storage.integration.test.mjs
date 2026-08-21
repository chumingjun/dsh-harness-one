import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

function responseCapture() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
    destroy(error) { throw error; },
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

const dshHome = mkdtempSync(join(tmpdir(), 'wf1-plugin-home-'));
const original = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;
try {
  const routes = [];
  const sessions = { get: () => undefined, flush: async () => {} };
  const ctx = {
    webServer: { register(route) { routes.push(route); } },
    tools: { register() {}, schemas() { return []; } },
    get(name) { if (name === 'sessions') return sessions; return null; },
    skills: { async list() { return []; } },
    llm: { listProviders() { return []; }, async listModels() { return []; } },
    agentPresets: { async mount() {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  apply(ctx, {});
  const route = (path) => routes.find((entry) => entry.kind === 'exact' && entry.path === path)?.handler;
  assert.ok(route('/wf1/api/graph'));
  assert.ok(route('/wf1/api/run-results'));

  const graphRes = responseCapture();
  await route('/wf1/api/graph')(request('GET', '/wf1/api/graph'), graphRes);
  assert.equal(graphRes.status, 200);
  assert.ok(Array.isArray(graphRes.json().nodes));

  const workflowsRes = responseCapture();
  await route('/wf1/api/workflows')(request('GET', '/wf1/api/workflows'), workflowsRes);
  assert.equal(workflowsRes.status, 200);
  assert.ok(workflowsRes.json().workflows.length > 0, 'legacy workflows should remain visible');

  const runsRes = responseCapture();
  await route('/wf1/api/runs')(request('GET', '/wf1/api/runs'), runsRes);
  assert.equal(runsRes.status, 200);
  const latest = runsRes.json().runs[0];
  assert.ok(latest?.runId, 'legacy runs should remain visible');

  const resultsRes = responseCapture();
  await route('/wf1/api/run-results')(request('GET', `/wf1/api/run-results?id=${encodeURIComponent(latest.runId)}`), resultsRes);
  assert.equal(resultsRes.status, 200);
  assert.equal(resultsRes.json().runId, latest.runId);

  const root = join(dshHome, 'plugin-data', 'dsh-ccpg-orchestrator');
  assert.equal(existsSync(join(root, 'state')), true);
  assert.equal(existsSync(join(root, 'runs')), true);
  assert.equal(readFileSync(join(root, 'state', 'graph.json'), 'utf8').length > 0, true);

  const runRes = responseCapture();
  await route('/wf1/api/run')(request('POST', '/wf1/api/run', {
    graph: {
      nodes: [{ id: 'input_one', type: 'input', position: { x: 0, y: 0 }, data: { label: '测试输入', text: 'hello' } }],
      edges: [],
    },
    triggerInput: 'world',
  }), runRes);
  assert.equal(runRes.status, 200);
  const newRunId = runRes.json().runId;
  assert.ok(newRunId);
  let storedRun;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const files = readdirSync(join(root, 'runs')).filter((file) => file.endsWith('.json'));
    storedRun = files.map((file) => JSON.parse(readFileSync(join(root, 'runs', file), 'utf8'))).find((run) => run.runId === newRunId);
    if (storedRun) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(storedRun?.status, 'success');
  assert.equal(storedRun?.workflowId, null);
  assert.equal(existsSync(join(root, 'runtime')), true);
  console.log('plugin storage integration tests: ALL PASS');
} finally {
  if (original === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = original;
  rmSync(dshHome, { recursive: true, force: true });
}
