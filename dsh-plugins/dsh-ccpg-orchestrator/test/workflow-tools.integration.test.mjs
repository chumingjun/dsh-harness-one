// workflow_* 助手工具集成测试（假 webServer + 假 tools.register 直调工具，与 schedule-api 同模式）。
// 覆盖：list/get/run/runs/status/cancel/patch/create/delete 守卫与画布同步、workflow_open 广播、
// canvas_run_workflow 复用 startWorkflowRun（补齐工作流变量与 workflowName）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
    emit(event) { listeners.get(event)?.(); return true; },
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
const dshHome = mkdtempSync(join(tmpdir(), 'wf1-wft-home-'));
const workspacesRoot = mkdtempSync(join(tmpdir(), 'wf1-wft-ws-'));
const workspace = join(workspacesRoot, 'ws');
mkdirSync(workspace, { recursive: true });
process.env.DSH_HOME = dshHome;
const packageLegacyDir = join(dshHome, 'package-legacy');
mkdirSync(join(packageLegacyDir, 'state'), { recursive: true });
process.env.WF1_LEGACY_DATA_DIR = packageLegacyDir;
writeFileSync(join(packageLegacyDir, 'state', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));

const disposers = [];
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['✓', name]); }
  catch (error) { results.push(['✗', name, error]); }
};

const registeredTools = new Map();
const broadcasts = []; // broadcast() 经 onOrchestratorEvent 不经过 webServer；抓 SSE 需要真实连接，这里改抓 cv 状态即可

const ctx = {
  webServer: { register(route) { this.routes.push(route); }, routes: [] },
  tools: { register(def) { registeredTools.set(def.name, def); }, schemas() { return []; } },
  get(name) {
    if (name === 'sessions') return { get: (id) => (String(id) === 'session-1' ? { header: { cwd: workspace } } : undefined), flush: async () => {} };
    if (name === 'workspaceRegistry') return { list: () => [{ path: workspace }] };
    return null;
  },
  skills: { async list() { return []; } },
  llm: { listProviders() { return []; }, async listModels() { return []; } },
  agentPresets: { async mount() {} },
  logger: { info() {}, warn() {}, error() {} },
  effect(setup) { const dispose = setup(); if (dispose) disposers.push(dispose); },
};
apply(ctx, {});
const route = (path) => ctx.webServer.routes.find((entry) => entry.kind === 'exact' && entry.path === path)?.handler;
const call = async (method, url, body) => {
  const res = responseCapture();
  await route(url.split('?')[0])(request(method, withSession(url, 'session-1'), body), res);
  return { status: res.status, body: res.json() };
};

// 直调助手工具：exec 模拟 dsh agent 上下文（session-1 绑定画布 cv_test）
const execOf = (canvasId) => ({ agent: { session: { id: 'session-1' } }, canvasId });
const runTool = async (name, args, canvasId) => {
  const def = registeredTools.get(name);
  assert.ok(def, `工具 ${name} 应已注册`);
  const out = await def.execute(args || {}, execOf(canvasId));
  assert.equal(typeof out, 'string', `${name} 输出必须是文本`);
  return out;
};
const maybeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

// 绑定画布：复用 /assistant/bind 路由建立 session-1 ↔ cv_test
const bound = await call('POST', '/wf1/api/assistant/bind', { sessionId: 'session-1', canvasId: 'cv_test', version: 0, graph: null });
assert.equal(bound.status, 200, `bind 应成功，实际 ${bound.status} ${JSON.stringify(bound.body)}`);

const wfGraph = {
  nodes: [{ id: 'n_in', type: 'input', position: { x: 0, y: 0 }, data: { label: '输入', text: 'ok' } }],
  edges: [],
};
const created = await call('POST', '/wf1/api/workflows', { id: 'wf_t1', name: '工具测试工作流', graph: wfGraph });
assert.equal(created.status, 200);
const created2 = await call('POST', '/wf1/api/workflows', { id: 'wf_t2', name: '另一个工作流', graph: wfGraph });
assert.equal(created2.status, 200);

await test('HTTP workflow list：返回运行概览且列表专用启动按保存工作流执行', async () => {
  const list = await call('GET', '/wf1/api/workflows');
  assert.equal(list.status, 200);
  const row = list.body.workflows.find((item) => item.id === 'wf_t1');
  assert.ok(row && Array.isArray(row.liveRuns) && Object.prototype.hasOwnProperty.call(row, 'lastRun'));
  const missing = await call('POST', '/wf1/api/workflows/run', { workflowId: 'wf_missing' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'workflow-not-found');
  const started = await call('POST', '/wf1/api/workflows/run', { workflowId: 'wf_t1', triggerInput: 'list-start' });
  assert.equal(started.status, 200);
  assert.equal(started.body.started, true);
  assert.match(started.body.runId, /^run_/);
  // 输入节点跑得极快，等一拍后验证终态对账：lastRun 指向本次运行且成功
  await new Promise((resolve) => setTimeout(resolve, 30));
  const finished = await call('GET', '/wf1/api/workflows');
  const finishedRow = finished.body.workflows.find((item) => item.id === 'wf_t1');
  assert.equal(finishedRow.lastRun.runId, started.body.runId);
  assert.equal(finishedRow.lastRun.status, 'success');
});

await test('workflow_list：列出工作流含 id/名称/liveRuns', async () => {
  const out = await runTool('workflow_list', {});
  const rows = maybeJson(out);
  assert.ok(Array.isArray(rows), '应返回 JSON 数组');
  assert.ok(rows.some((r) => r.id === 'wf_t1' && r.name === '工具测试工作流' && r.liveRuns === 0));
});

await test('workflow_get：默认概要模式含变量/inputSchema，summary:false 返回完整图', async () => {
  const byId = await runTool('workflow_get', { workflowId: 'wf_t1' });
  const doc = maybeJson(byId);
  assert.equal(doc.id, 'wf_t1');
  assert.ok(doc.graph && Array.isArray(doc.graph.nodes));
  assert.deepEqual(doc.inputSchema, { fields: [] });
  const byName = await runTool('workflow_get', { name: '另一个工作流' });
  assert.equal(maybeJson(byName).id, 'wf_t2');
  const missing = await runTool('workflow_get', { workflowId: 'wf_no' });
  assert.match(missing, /不存在/);
});

await test('workflow_run：返回 runId；workflow_runs 能看到该运行（source=assistant）', async () => {
  const out = await runTool('workflow_run', { workflowId: 'wf_t1', triggerInput: 'go' });
  const started = maybeJson(out);
  assert.equal(started.started, true);
  assert.match(started.runId, /^run_/);
  const list = maybeJson(await runTool('workflow_runs', {}));
  const hit = list.find((r) => r.runId === started.runId);
  assert.ok(hit, '运行列表应包含新运行');
  assert.equal(hit.source, 'assistant');
  assert.equal(hit.workflowId, 'wf_t1');
  globalThis.__runId = started.runId;
});

await test('workflow_runs：onlyLive 过滤 + workflowId 过滤', async () => {
  const all = maybeJson(await runTool('workflow_runs', { limit: 50 }));
  assert.ok(Array.isArray(all) && all.length >= 1);
  const filtered = maybeJson(await runTool('workflow_runs', { workflowId: 'wf_t2' }));
  assert.ok(filtered === null || filtered.every((r) => r.workflowId === 'wf_t2'), '过滤结果要么为空文本要么全部属于 wf_t2');
  const liveOnly = await runTool('workflow_runs', { onlyLive: true });
  if (maybeJson(liveOnly)) assert.ok(maybeJson(liveOnly).every((r) => r.live === true));
});

await test('workflow_run_status：按 runId 查详情（含 nodeStates/outputs）', async () => {
  const out = await runTool('workflow_run_status', { runId: globalThis.__runId });
  const st = maybeJson(out);
  assert.ok(st, '应返回 JSON');
  assert.ok(['running', 'success', 'error'].includes(st.status));
  assert.ok(st.nodeStates);
  const missing = await runTool('workflow_run_status', { runId: 'run_nope' });
  assert.match(missing, /不存在/);
});

await test('workflow_run_cancel：无匹配 live run 时明确返回', async () => {
  const out = await runTool('workflow_run_cancel', { workflowId: 'wf_t2' });
  assert.match(out, /没有匹配的运行中 run/);
});

await test('workflow_patch：原子改图 + 落盘 + lint 回执；坏 ops 整批拒绝', async () => {
  const ok = await runTool('workflow_patch', { workflowId: 'wf_t1', ops: [
    { op: 'addNode', type: 'note', label: '说明', data: { text: 'AI 加的注释' }, after: 'n_in' },
  ] });
  assert.match(ok, /已应用 \d+ 个操作/);
  const detail = await call('GET', '/wf1/api/workflows/detail?id=wf_t1');
  assert.ok(detail.body.graph.nodes.some((n) => n.data?.label === '说明'), '改图应落盘');
  const bad = await runTool('workflow_patch', { workflowId: 'wf_t1', ops: [{ op: 'addNode', type: 'nope' }] });
  assert.match(bad, /整批拒绝/);
});

await test('workflow_patch：改名走 name 字段', async () => {
  const out = await runTool('workflow_patch', { workflowId: 'wf_t2', name: '改名后的工作流', ops: [
    { op: 'updateNode', id: 'n_in', data: { text: '改' } },
  ] });
  assert.match(out, /已应用 \d+ 个操作/);
  const detail = await call('GET', '/wf1/api/workflows/detail?id=wf_t2');
  assert.equal(detail.body.name, '改名后的工作流');
});

await test('workflow_create：新建（空图/复制来源），重复名允许（与 UI 一致）', async () => {
  const out = await runTool('workflow_create', { name: 'AI 新建' });
  const createdDoc = maybeJson(out);
  assert.equal(createdDoc.created, true);
  assert.match(createdDoc.id, /^wf_/);
  const copy = await runTool('workflow_create', { name: 'AI 副本', copyFrom: 'wf_t1' });
  const copyDoc = maybeJson(copy);
  assert.equal(copyDoc.nodes >= 1, true, '副本应有节点');
  const badGraph = await runTool('workflow_create', { name: '坏图', graph: { nodes: 'x' } });
  assert.match(badGraph, /graph 必须是/);
});

await test('workflow_delete：缺 confirm 拒绝；有关联定时任务/webhook 拒绝并列出；confirm 后真删', async () => {
  const noConfirm = await runTool('workflow_delete', { workflowId: 'wf_t1' });
  assert.match(noConfirm, /确认删除/);
  const sched = await call('POST', '/wf1/api/schedule', { workflowId: 'wf_t1', cron: '0 9 * * *' });
  assert.equal(sched.status, 200);
  const guarded = await runTool('workflow_delete', { workflowId: 'wf_t1', confirm: true });
  assert.match(guarded, /定时任务关联/);
  assert.match(guarded, /sch_/);
  // 清理定时任务后可删
  const del = await call('DELETE', `/wf1/api/schedule?key=${sched.body.key}`);
  assert.equal(del.status, 200);
  const done = maybeJson(await runTool('workflow_delete', { workflowId: 'wf_t1', confirm: true }));
  assert.equal(done.deleted, true);
  const gone = await call('GET', '/wf1/api/workflows/detail?id=wf_t1');
  assert.equal(gone.status, 404);
});

await test('workflow_open：未绑定画布的会话被拒；绑定后切换', async () => {
  // session-2 未绑定画布 → workflow_open 拒绝
  const def = registeredTools.get('workflow_open');
  const refused = await def.execute({ workflowId: 'wf_t2' }, { agent: { session: { id: 'session-2' } } });
  assert.match(refused, /只在绑定了工作流画布的会话里可用/);
  // session-1 绑定 cv_test：open 切换 cv 指向 wf_t2
  const out = await runTool('workflow_open', { workflowId: 'wf_t2' }, 'cv_test');
  assert.match(out, /画布已切换/);
  // 再次 open 到另一目标（by name）也正常
  const again = await runTool('workflow_open', { name: '改名后的工作流' }, 'cv_test');
  assert.match(again, /画布已切换/);
});

await test('canvas_run_workflow 走 startWorkflowRun：命名工作流运行带 workflowName', async () => {
  // open 已把 cv_test 切到 wf_t2：canvas_run_workflow 应走 startWorkflowRun（带 wf 名与变量）
  const out = await runTool('canvas_run_workflow', { triggerInput: 'hi' }, 'cv_test');
  const started = maybeJson(out);
  assert.ok(started && started.started, `应返回 started，实际：${out}`);
  const list = maybeJson(await runTool('workflow_runs', { limit: 10 }));
  const hit = list.find((r) => r.runId === started.runId);
  assert.ok(hit, '运行应出现在列表');
  assert.equal(hit.workflowName, '改名后的工作流');
  assert.equal(hit.source, 'assistant');
});

await test('未绑定画布的会话：canvas_* 拒绝、workflow_* 可用', async () => {
  // exec 不带 canvasId → resolveCanvasId 靠 sessionCanvas；session-1 已绑定，需要另造 session
  const def = registeredTools.get('canvas_get_graph');
  const out = await def.execute({}, { agent: { session: { id: 'session-2' } } });
  assert.match(out, /只在绑定了工作流画布的会话里可用/);
  const wfDef = registeredTools.get('workflow_list');
  const listOut = await wfDef.execute({}, { agent: { session: { id: 'session-1' } } });
  assert.ok(maybeJson(listOut), 'workflow_list 不依赖画布绑定');
});

await test('workflow_run_cancel：all:true 可批量取消（无 live 时不误报）', async () => {
  const out = await runTool('workflow_run_cancel', { all: true });
  const parsed = maybeJson(out);
  assert.ok(parsed === null || typeof parsed.canceled === 'number', '返回取消计数或不匹配提示');
});

for (const d of disposers) { try { await d(); } catch { /* 清理尽力 */ } }
for (const [mark, name, error] of results) {
  if (mark === '✗') console.error(`${mark} ${name}\n${error?.stack || error}`);
}
const failed = results.filter((r) => r[0] === '✗').length;
console.log(results.map(([mark, name]) => `${mark} ${name}`).join('\n'));
console.log(`workflow-tools.integration: ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
