// dsh-ccpg-orchestrator：Workflow One 编排插件（Cordis plugin）v2。
// 在 dsh 进程内提供：
//   - 图（DAG）执行引擎 lib/engine.js：并发上限、节点超时、运行取消、条件分支、lint
//   - agent 节点 = 真实 dsh agent：节点级 provider/model/tools/maxRounds 真正生效
//     · model: agentOptions.model/provider
//     · tools: agentCtx.tools.restrict({allow})（与已注册工具求交集）
//     · maxRounds: 轮询 session events 的 turn 计数，超限 agent.cancel
//     · 取消: 运行 cancel → agent.cancel({kind:'user'}) + handle.dispose()
//     · 流式进度: agent-progress 事件（turn 序号 / assistant 文本预览）
//   - 运行历史持久化 data/runs/<runId>.json + 刷新恢复（SSE 快照）
//   - webhook 触发（/wf1/api/hooks/* prefix 路由）+ 定时触发（wf1:schedule.* 定时键）
//   - 节点工作区 data/workspaces/<节点名>/；产物下载 /wf1/api/artifact
//
// HTTP 全部挂 ctx.webServer（/wf1 前缀，避开 dsh 自己的 /api）。

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, cpSync, unlinkSync, renameSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { renderTemplate, validateTemplate } from './template.js';
import { describeNodeOutput, normalizeExecutionResult, RUN_SCHEMA_VERSION } from './output-contract.js';
import { resolveInside, safeFileId, safeFilename } from './safe-path.js';
import { runScript } from './script-runner.js';
import {
  artifactId as runArtifactId,
  createRunExport,
  createRunResults,
  isPreviewableMediaType,
  mediaTypeFor,
  normalizeRunDocument,
  resolveRunArtifact,
  snapshotRunArtifacts,
  streamArtifactResponse,
} from './run-results.js';
import { graphFingerprint, runMatchesGraphScope, selectScopedRun, summarizeNodeStates, summarizeOutputs, summarizeStructuredOutputs } from './run-scope.js';
import { buildVariableSchema } from './variable-schema.js';
import {
  createStructuredEnvelope,
  createStructuredFailureEnvelope,
  getAgentOutputConfig,
  readableStructuredOutput,
  structuredOutputInstruction,
  validateStructuredOutputWithRepair,
} from './agent-schema.js';
import { FeishuClient } from './feishu.js';
import { listFeishuCreds, addFeishuCred, removeFeishuCred, setDefaultFeishuCred, getFeishuCredOrEnv } from './credentials.js';
import { Orchestrator, lintGraph, getKind } from './engine.js';
import { createWorkflowExportManifest, importWorkflowDocument, normalizeWorkflowDocument } from './workflow-document.js';
import { saveArtifactsToWorkspace } from './artifact-save.js';
import { createStoragePaths } from './storage-paths.js';
import {
  canvasAssistantPersona, checkPatchResult, summarizeGraphForAI, validateGraphOps,
} from './assistant.js';
import {
  assertNonSensitiveVariableDefinitions, assertSafeContextObject, GlobalVariableStore, VariableStoreError,
  variableDefinitionsToValues,
} from './variable-store.js';
import cronParser from 'cron-parser';
// cron-parser@4：默认导出是命名空间对象（CJS interop），parseExpression 是其方法
const parseCronExpression = cronParser.parseExpression?.bind(cronParser)
  ?? cronParser.default?.parseExpression?.bind(cronParser.default);

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_DATA_DIR = join(__dirname, '..', 'data');
const RUNS_KEEP = 100; // 运行历史保留条数（按开始时间新→旧）
let runIdSeq = 0;
let ctxRef = null;

// 原子写入：临时文件 + rename，进程中途挂掉不会留截断 JSON
const atomicWrite = (file, data) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
};
const atomicJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2));

export const name = 'dsh-ccpg-orchestrator';
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'tools', 'webServer', 'agentPresets', 'sessionPersistence', 'llm', 'skills'];

export const Config = z.object({
  staticDir: z.string().default(''),
});

const workspaceContext = new AsyncLocalStorage();

export function apply(ctx, config) {
  ctxRef = ctx; // replayTrace 需要在路由 handler 里拿到 ctx.sessionPersistence
  const stores = new Map();
  const publicHooks = new Map();
  let legacyClaimedWorkspace = null;

  const canonicalWorkspace = (cwd) => {
    if (!cwd || !isAbsolute(cwd)) throw new Error('当前会话没有可用的工作目录');
    const root = realpathSync(resolve(cwd));
    if (!statSync(root).isDirectory()) throw new Error('当前会话工作目录不存在');
    return root;
  };
  try {
    const registry = ctx.workspaceRegistry || ctx.get?.('workspaceRegistry');
    for (const workspace of registry?.list?.() || []) {
      const marker = join(workspace.path, '.workflow-one', 'state', 'legacy-import.json');
      if (existsSync(marker)) {
        legacyClaimedWorkspace = canonicalWorkspace(workspace.path);
        break;
      }
    }
  } catch { /* workspaceRegistry 是可选服务 */ }

  const copyLegacyTree = (source, target) => {
    if (!existsSync(source)) return;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
  };
  const initializeStore = (workspaceRoot) => {
    const paths = createStoragePaths({ workspaceRoot, legacyRoot: LEGACY_DATA_DIR });
    const rootExisted = existsSync(paths.root);
    const marker = join(paths.state, 'legacy-import.json');
    for (const dir of [paths.root, paths.state, paths.workflows, paths.attachments, paths.runs, paths.runtime, join(paths.state, 'tombstones', 'workflows')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (!legacyClaimedWorkspace && !rootExisted) {
      for (const legacy of [paths.packageLegacy, paths.pluginDataLegacy]) {
        copyLegacyTree(legacy.workflows, paths.workflows);
        copyLegacyTree(legacy.attachments, paths.attachments);
        copyLegacyTree(legacy.runs, paths.runs);
        if (legacy === paths.pluginDataLegacy) copyLegacyTree(legacy.runtime, paths.runtime);
        for (const name of ['graph.json', 'triggers.json', 'global-variables.json']) {
          const source = join(legacy.state, name);
          if (existsSync(source)) copyLegacyTree(source, join(paths.state, name));
        }
      }
      legacyClaimedWorkspace = workspaceRoot;
      atomicJson(marker, { version: 1, importedAt: new Date().toISOString() });
    }
    const store = {
      workspaceRoot,
      paths,
      graphFile: join(paths.state, 'graph.json'),
      triggersFile: join(paths.state, 'triggers.json'),
      globalVariablesFile: join(paths.state, 'global-variables.json'),
      workflowTombstoneDir: join(paths.state, 'tombstones', 'workflows'),
      runHistory: [],
      historyHydrated: false,
      globalVariableStore: new GlobalVariableStore(join(paths.state, 'global-variables.json')),
      hooks: new Map(),
      schedulers: new Map(),
      schedulerMeta: new Map(),
      triggersLoaded: false,
      triggersRestored: false,
    };
    stores.set(workspaceRoot, store);
    return store;
  };
  const storeForWorkspace = (cwd) => {
    const workspaceRoot = canonicalWorkspace(cwd);
    return stores.get(workspaceRoot) || initializeStore(workspaceRoot);
  };
  const currentStore = () => {
    const store = workspaceContext.getStore();
    if (!store) throw new Error('工作流请求缺少会话工作目录');
    return store;
  };
  const STORAGE = new Proxy({}, { get(_target, key) { return currentStore().paths[key]; } });
  const runHistory = new Proxy([], {
    get(_target, key) {
      const rows = currentStore().runHistory;
      const value = rows[key];
      return typeof value === 'function' ? value.bind(rows) : value;
    },
    set(_target, key, value) { currentStore().runHistory[key] = value; return true; },
  });
  const globalVariableStore = new Proxy({}, {
    get(_target, key) {
      const store = currentStore().globalVariableStore;
      const value = store[key];
      return typeof value === 'function' ? value.bind(store) : value;
    },
  });
  const currentPaths = () => currentStore().paths;
  const currentRunHistory = () => currentStore().runHistory;
  const currentHooks = () => currentStore().hooks;
  const currentSchedulers = () => currentStore().schedulers;
  const currentSchedulerMeta = () => currentStore().schedulerMeta;
  const registeredWorkspaceRoots = () => {
    try {
      const registry = ctx.workspaceRegistry || ctx.get?.('workspaceRegistry');
      return (registry?.list?.() || [])
        .map((workspace) => canonicalWorkspace(workspace.path))
        .filter((workspaceRoot) => existsSync(join(workspaceRoot, '.workflow-one')));
    } catch { return []; }
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
  const sessionStore = (sessionId) => {
    if (!sessionId) throw new Error('缺少当前会话');
    const session = ctx.get('sessions')?.get?.(SessionId(String(sessionId)));
    return storeForWorkspace(session?.header?.cwd);
  };
  const requestStore = (req) => {
    const url = new URL(req.url, 'http://wf1.local');
    const sessionId = url.searchParams.get('sessionId') || req.headers?.['x-wf1-session'];
    return sessionStore(sessionId);
  };
  let ensureTriggers = () => {};
  const register = (route, { scoped = true } = {}) => {
    const handler = route.handler;
    ctx.webServer.register({
      ...route,
      handler(req, res) {
        if (!scoped) return handler(req, res);
        try {
          return workspaceContext.run(requestStore(req), () => {
            hydrateHistory();
            ensureTriggers();
            return handler(req, res);
          });
        } catch (error) {
          return json(res, 409, { error: String(error.message || error), code: 'workspace-session-required' });
        }
      },
    });
  };

  // ---- SSE ----
  const sseClients = new Map();
  const broadcast = (event, payload) => {
    const store = workspaceContext.getStore();
    if (!store) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [res, subscription] of sseClients) {
      if (subscription.store !== store) continue;
      if (subscription.runId && payload?.runId && subscription.runId !== payload.runId) continue;
      try { res.write(frame); } catch { /* 断开的连接 */ }
    }
  };

  // ---- 画布 AI 助手（官方 UI 工作流侧栏 + 聊天同 session 改图）----
  // canvasId（前端生成、localStorage 持久）→ { graph, version, workflowId, boundSessions:Set }
  // version 只在 AI patch 后递增；前端上报必须基于当前 version，防止延迟的旧图覆盖 AI 新图。
  const canvases = new Map();
  const canvasKey = (id) => `${currentStore().workspaceRoot}\0${id}`;
  const canvasOf = (id) => {
    const key = canvasKey(id);
    if (!canvases.has(key)) canvases.set(key, { graph: null, version: 0, workflowId: null, boundSessions: new Set() });
    return canvases.get(key);
  };
  // 竞态防御：画布 mount 早期会报空图；已有非空图时不回退到空。
  // AI 已产生更高版本后，拒绝旧版本前端的延迟回写。
  const applyCanvasGraph = (cv, graph, baseVersion = 0) => {
    if (!graph || !Array.isArray(graph.nodes)) return { applied: false, reason: 'no-graph' };
    if (Number(baseVersion) < cv.version) return { applied: false, reason: 'stale-version' };
    const incomingEmpty = graph.nodes.length === 0;
    const currentEmpty = !cv.graph || (cv.graph.nodes || []).length === 0;
    if (incomingEmpty && !currentEmpty) return { applied: false, reason: 'empty-regression' };
    cv.graph = graph;
    return { applied: true };
  };

  const canvasTools = {
    canvas_get_graph: {
      description: '获取当前工作流画布的完整图 JSON（节点+边）。',
      parameters: {},
      async execute(_args, exec) {
        const cv = canvasOf(exec.canvasId);
        if (!cv.graph) return '画布尚未打开或未上报图。请让用户打开「工作流」标签页。';
        return JSON.stringify(cv.graph, null, 2);
      },
    },
    canvas_graph_summary: {
      description: '获取画布图概要（节点 id/类型/label/关键配置 + 连线），比完整图省 token。',
      parameters: {},
      async execute(_args, exec) {
        const cv = canvasOf(exec.canvasId);
        if (!cv.graph) return '画布尚未打开或未上报图。';
        return JSON.stringify(summarizeGraphForAI(cv.graph));
      },
    },
    canvas_graph_patch: {
      description: '批量修改画布图（原子生效，出错整批拒绝）。每批 ≤60 个操作。ops 元素字段：op（必填，addNode|updateNode|renameNode|deleteNode|connect|deleteEdge|updateEdge）；addNode: type 节点类型 input/agent/script/condition/http/output/note、label 中文名、data 节点字段对象、after 上游节点id自动连线、connect=false 关闭自动连线、position {x,y}；updateNode/renameNode/deleteNode/deleteEdge/updateEdge: id 目标id（updateNode 另需 data，renameNode 另需 label）；connect: from/to 源目标id，branch 条件分支 true/false。',
      parameters: {
        ops: {
          type: 'array', required: true,
          items: {
            type: 'object', additionalProperties: true,
            properties: {
              op: { type: 'string' },
              type: { type: 'string' },
              label: { type: 'string' },
              data: { type: 'json' },
              after: { type: 'string' },
              connect: { type: 'boolean' },
              branch: { type: 'string' },
              id: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              position: { type: 'json' },
            },
          },
        },
      },
      async execute(args, exec) {
        const cv = canvasOf(exec.canvasId);
        if (!cv.graph) return '画布尚未打开或未上报图。请让用户打开「工作流」标签页后再试。';
        const r = validateGraphOps(cv.graph, args.ops);
        if (!r.ok) return `整批拒绝（未做任何修改）：\n${r.errors.join('\n')}\n请修正后重发整批 ops。`;
        cv.graph = r.graph; // 服务端状态先行；画布应用后回报同一图
        cv.version += 1;
        // AI 工具已确认修改成功时立即持久化；不能依赖前端收到 SSE 后再自动保存。
        // 否则浏览器短暂断线或 dsh 重启会回到旧草稿，看起来像“历史画布”。
        if (cv.workflowId) {
          const wf = readWf(cv.workflowId);
          if (wf) writeWf({ ...wf, graph: r.graph, updatedAt: new Date().toISOString() });
          else atomicJson(currentStore().graphFile, r.graph);
        } else {
          atomicJson(currentStore().graphFile, r.graph);
        }
        const check = checkPatchResult(r.graph);
        // workflowId 一并广播：切换工作流的瞬间若有在飞 patch，画布侧据此丢弃，避免旧图的改动落到新工作流上
        broadcast('assistant-patch', { canvasId: exec.canvasId, version: cv.version, patch: r.patch, graph: r.graph, workflowId: cv.workflowId || null });
        return `已应用 ${r.patch.length} 个操作到画布。\nlint: ${check.lintOk ? '通过' : '有告警'}\n${check.issues.slice(0, 20).join('\n')}`;
      },
    },
    canvas_lint_graph: {
      description: '对当前画布图跑静态检查（环/引用/缺字段），返回 issues 列表。',
      parameters: {},
      async execute(_args, exec) {
        const cv = canvasOf(exec.canvasId);
        if (!cv.graph) return '画布尚未打开或未上报图。';
        const check = checkPatchResult(cv.graph);
        return JSON.stringify({ ok: check.lintOk, issues: check.issues });
      },
    },
    canvas_run_workflow: {
      description: '真实运行当前画布工作流（等价画布 ▶ 运行）。运行是异步的：先返回 runId，用 canvas_run_status 轮询。',
      parameters: {
        triggerInput: { type: 'string', description: '触发输入文本（输入节点模板的 $trigger）' },
      },
      async execute(args, exec) {
        const cv = canvasOf(exec.canvasId);
        if (!cv.graph) return '画布尚未打开或未上报图。';
        const graph = cv.workflowId ? (() => { try { return readWf(cv.workflowId)?.graph || cv.graph; } catch { return cv.graph; } })() : cv.graph;
        const lint = lintGraph(graph);
        if (!lint.ok) return `图有错误不能运行：\n${lint.issues.filter((x) => x.level === 'error').map((x) => x.message).join('\n')}`;
        const globals = (() => { try { return globalContext(); } catch { return { globalVariables: {} }; } })();
        const { runId } = startRun(graph, {
          triggerInput: args.triggerInput ?? '', workflowName: null, workflowId: cv.workflowId,
          canvasId: exec.canvasId,
          globalVariables: globals.globalVariables,
          source: 'assistant',
        });
        return JSON.stringify({ started: true, runId });
      },
    },
    canvas_run_status: {
      description: '查询一次运行的状态（节点状态/错误/输出摘要）。运行完成或失败后返回终态。',
      parameters: { runId: { type: 'string', required: true, description: 'canvas_run_workflow 返回的 runId' } },
      async execute(args) {
        const entry = orch.runs.get(args.runId);
        if (entry?.run?.workspaceRoot === currentStore().workspaceRoot) {
          const run = entry.run;
          return JSON.stringify({
            status: run.status || 'running',
            nodeStates: summarizeNodeStates(run.nodeStates),
            outputs: summarizeOutputs(run.outputs, run.structuredOutputs),
          });
        }
        const hist = runHistory.find((r) => r.runId === args.runId);
        if (!hist) return `运行 "${args.runId}" 不存在`;
        return JSON.stringify({
          status: hist.status,
          nodeStates: summarizeNodeStates(hist.nodeStates),
          outputs: summarizeOutputs(hist.outputs, hist.structuredOutputs),
        });
      },
    },
  };

  // canvas_* 工具注入助手 session：走 dsh per-agent 变体注册（agentCtx.tools.register），
  // 不进全局池（画布会话外的 agent 看不见）。exec.canvasId 由 session 绑定解析。
  // 注入点：orchestrator 不能 hook 官方 session 创建，改为「绑定即装」——
  // /assistant/bind 把 sessionId↔canvasId 记入 canvases；tools 挂全局但 execute 时
  // 校验 exec 所在 session 已绑定画布，未绑定返回提示（对其他 agent 表现为不可用）。
  const sessionCanvas = new Map(); // sessionId → canvasId
  const resolveCanvasId = (exec) => {
    // dsh-tools 的 exec 上下文：exec.agent.session.id 是当前会话（schema 见 dsh-tools execute(args, exec)）
    const sid = exec?.agent?.session?.id || exec?.sessionId || exec?.session?.id;
    return sid ? sessionCanvas.get(String(sid)) : undefined;
  };
  for (const [name, def] of Object.entries(canvasTools)) {
    // defineTool 把作者 spec（required/items 嵌套）编译成模型面 JSON Schema；
    // 直接 register 原始 spec 会把 required 误投影成 schema 级关键字（canvas_graph_patch 首轮丢参的根因）。
    const wrapped = defineTool({
      name,
      description: def.description,
      parameters: def.parameters,
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args, exec) {
        const sid = exec?.agent?.session?.id || exec?.sessionId || exec?.session?.id;
        const canvasId = resolveCanvasId(exec);
        if (!sid || !canvasId) return '此工具只在绑定了工作流画布的会话里可用（在画布「工作流」标签页发起对话）。';
        try {
          return await workspaceContext.run(sessionStore(String(sid)), () => {
            hydrateHistory();
            return def.execute(args, { ...exec, canvasId });
          });
        } catch (error) {
          return `工作区不可用：${String(error.message || error)}`;
        }
      },
    });
    try { ctx.tools.register(wrapped); } catch (e) { ctx.logger?.warn?.(`assistant tool ${name} 注册失败: ${e.message}`); }
  }


  // ---- 运行历史（按工作区持久化 + 内存缓存）----
  const hydrateHistory = () => {
    const store = currentStore();
    if (store.historyHydrated) return;
    store.historyHydrated = true;
    const byId = new Map();
    for (const dir of [store.paths.runs]) {
      try {
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
          try {
            const run = normalizeRunDocument(JSON.parse(readFileSync(join(dir, file), 'utf8')));
            if (!byId.has(run.runId)) byId.set(run.runId, run);
          } catch { /* 单条损坏不阻塞其他历史 */ }
        }
      } catch { /* 目录空 */ }
    }
    const rows = [...byId.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    store.runHistory.push(...rows.slice(0, 50));
  };
  const persistRun = (run, graph, workflowName, workflowId) => {
    try {
      const light = { ...run, _resolved: true };
      delete light._resolve;
      const graphSnapshot = graph ? {
        nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: graph.edges,
      } : undefined;
      delete light.workspaceRoot;
      const base = normalizeRunDocument({
        ...light,
        workflowName: run.workflowName || workflowName || null,
        workflowId: run.workflowId || workflowId || null,
        graphFingerprint: run.graphFingerprint || (graph ? graphFingerprint(graph) : null),
        graph: graphSnapshot,
      });
      const scope = { workflowId: base.workflowId || 'draft', runId: base.runId };
      const snapshot = snapshotRunArtifacts(base, {
        workspaceForNode: ({ nodeId }) => STORAGE.workspaceForNode({ ...scope, nodeId }),
        artifactRunDir: STORAGE.artifactRunDir(scope),
      });
      const document = normalizeRunDocument({
        ...base,
        artifactIndex: snapshot.artifacts,
        issues: [...(Array.isArray(base.issues) ? base.issues : []), ...snapshot.issues],
      });
      atomicJson(join(currentPaths().runs, `${safeFileId(run.runId, 'invalid')}.json`), document);
      const historyRun = { ...document, graph: graphSnapshot };
      const history = currentRunHistory();
      const idx = history.findIndex((r) => r.runId === run.runId);
      if (idx >= 0) history[idx] = historyRun;
      else history.unshift(historyRun);
      pruneRuns();
      broadcast('run-results-ready', {
        runId: document.runId,
        status: document.status,
        resultCount: createRunResults(document).finalArtifacts.length,
        artifactCount: document.artifactIndex.length,
      });
      return document;
    } catch (error) {
      ctx.logger?.error?.(`dsh-ccpg 运行成果持久化失败（${run?.runId || 'unknown'}）：${error.message}`);
      broadcast('run-persist-error', { runId: run?.runId || null, error: String(error.message || error) });
      return null;
    }
  };
  // 保留策略：超过 RUNS_KEEP 的旧运行文件删除（内存列表同步裁剪）
  const pruneRuns = () => {
    try {
      const runsDir = currentPaths().runs;
      const history = currentRunHistory();
      const files = readdirSync(runsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ f, t: statSync(join(runsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(RUNS_KEEP)) {
        try {
          const run = normalizeRunDocument(JSON.parse(readFileSync(join(runsDir, f), 'utf8')));
          rmSync(STORAGE.runRoot({ workflowId: run.workflowId || 'draft', runId: run.runId }), { recursive: true, force: true });
        } catch { /* 单条记录损坏或并发删除 */ }
        try { unlinkSync(join(runsDir, f)); } catch { /* 并发删除 */ }
      }
      if (history.length > RUNS_KEEP) history.length = RUNS_KEEP;
    } catch { /* 目录不可读 */ }
  };
  const readRun = (runId) => {
    const filename = `${safeFileId(runId, 'invalid')}.json`;
    for (const dir of [currentPaths().runs]) {
      try { return normalizeRunDocument(JSON.parse(readFileSync(join(dir, filename), 'utf8'))); } catch { /* 回退下一位置 */ }
    }
    return null;
  };
  const writeRun = (run) => {
    const document = normalizeRunDocument(run);
    atomicJson(join(currentPaths().runs, `${safeFileId(document.runId, 'invalid')}.json`), document);
    const history = currentRunHistory();
    const idx = history.findIndex((row) => row.runId === document.runId);
    if (idx >= 0) history[idx] = document;
    else history.unshift(document);
    return document;
  };

  // ---- 工作流库 ----
  const wfFile = (id, dir = currentPaths().workflows) => join(dir, `${safeFileId(id, 'invalid')}.json`);
  const wfTombstone = (id) => join(currentStore().workflowTombstoneDir, safeFileId(id, 'invalid'));
  const readWf = (id) => {
    if (existsSync(wfTombstone(id))) return null;
    for (const dir of [currentPaths().workflows]) {
      try { return normalizeWorkflowDocument(JSON.parse(readFileSync(wfFile(id, dir), 'utf8'))); } catch { /* 回退下一位置 */ }
    }
    return null;
  };
  const writeWf = (wf) => {
    const document = normalizeWorkflowDocument(wf);
    atomicJson(wfFile(document.id), document);
    try { unlinkSync(wfTombstone(document.id)); } catch { /* 未删除过 */ }
    return document;
  };

  const resolveAttachmentFile = (attachment) => {
    if (attachment?.id) {
      const dir = resolveInside(STORAGE.attachments, safeFileId(attachment.id, 'invalid'));
      const file = dir && resolveInside(dir, safeFilename(attachment.filename));
      if (file && existsSync(file) && statSync(file).isFile()) return file;
    }
    const filename = safeFilename(attachment?.filename || attachment);
    const flatFile = resolveInside(STORAGE.attachments, filename);
    return flatFile && existsSync(flatFile) && statSync(flatFile).isFile() ? flatFile : null;
  };

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const globalContext = () => {
    const document = globalVariableStore.read();
    return {
      document,
      globalVariableDefinitions: document.variables,
      globalVariables: variableDefinitionsToValues(document.variables),
    };
  };
  const inlineWorkflowDefinitions = (body) => {
    if (hasOwn(body, 'workflowVariableDefinitions')) return body.workflowVariableDefinitions;
    if (Array.isArray(body?.workflowVariables)) return body.workflowVariables;
    if (hasOwn(body, 'variables')) return body.variables;
    return undefined;
  };
  const previewWorkflowContext = (body, persistedWorkflow) => {
    const inlineDefinitions = inlineWorkflowDefinitions(body);
    const definitions = inlineDefinitions !== undefined ? inlineDefinitions : (persistedWorkflow?.variables || []);
    assertNonSensitiveVariableDefinitions(definitions, '工作流变量定义');
    const inputSchema = hasOwn(body, 'inputSchema') ? body.inputSchema : (persistedWorkflow?.inputSchema || { fields: [] });
    return {
      workflowVariableDefinitions: definitions,
      workflowVariables: variableDefinitionsToValues(definitions),
      inputSchema,
    };
  };
  const rejectInlineGlobalContext = (body) => {
    if (hasOwn(body, 'globalVariables') || hasOwn(body, 'globalVariableDefinitions')) {
      throw new VariableStoreError('实例变量只能由后端全局变量存储提供', { code: 'global-variable-authority', status: 400 });
    }
  };
  const routeError = (res, error) => {
    const status = error instanceof VariableStoreError ? error.status : 400;
    json(res, status, { ok: false, error: String(error.message || error), code: error.code || 'invalid-request' });
  };

  // ---- 引擎 ----
  const orch = new Orchestrator(ctx, { onEvent: broadcast, renderTemplate });
  orch.nodeRunner = async (node, run, s, ctl) => runAgentNode(ctx, node, run, s, ctl);
  orch.scriptRunner = async ({ node, input, signal, timeoutMs, workflowId, runId }) => {
    const ws = workspaceFor(node, { workflowId: workflowId || 'draft', runId });
    const result = await runScript({
      code: node.data?.code,
      input,
      workspaceDir: ws,
      readWorkspaceDir: currentStore().workspaceRoot,
      signal,
      timeoutMs,
    });
    return { ...result, artifacts: safeWsList(ws) };
  };

  const startRun = (graph, {
    triggerInput, workflowName, workflowId, canvasId, source,
    globalVariables = {}, workflowVariables = {}, runInputs = {}, runId: providedRunId, replayOf, resume,
  } = {}) => {
    const store = currentStore();
    const runId = providedRunId || `run_${Date.now().toString(36)}_${++runIdSeq}`;
    // 启动即落盘运行中快照：成果面板在 run-start 后立刻拉 /run-results，
    // 只等最终 persistRun 的话长运行期间 readRun 一直 404（前端退避耗尽即报「运行记录不存在」）。
    try {
      writeRun(normalizeRunDocument({
        runId, status: 'running', startedAt: new Date().toISOString(),
        triggerInput: triggerInput ?? '', workflowName: workflowName || null, workflowId: workflowId || null,
        canvasId: canvasId || null, source: source || null, replayOf: replayOf || null,
        ...(resume ? { resumedFrom: resume.runId || null } : {}),
        nodeStates: {}, outputs: {}, structuredOutputs: {}, issues: [],
        graph: graph ? { nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })), edges: graph.edges } : undefined,
        graphFingerprint: graph ? graphFingerprint(graph) : null,
      }));
    } catch { /* 快照写失败不阻塞运行；最终 persistRun 仍会落盘 */ }
    const promise = workspaceContext.run(store, () => Promise.resolve().then(() => orch.run(graph, {
      triggerInput, workflowName, workflowId, canvasId, source, runId,
      workspaceRoot: store.workspaceRoot,
      globalVariables, workflowVariables, runInputs,
      resume,
    })).then((run) => {
      if (replayOf) run.replayOf = replayOf;
      persistRun(run, graph, workflowName, workflowId);
      return run;
    })).catch((error) => {
      ctx.logger?.error?.(`dsh-ccpg 运行失败（${runId}）：${error.message}`);
      return null;
    });
    return { runId, promise };
  };

  // ---- agent 节点执行（升级版）----
  async function runAgentNode(ctx, node, run, s, { signal, emit, runId }) {
    const store = currentStore();
    const ws = workspaceFor(node, { workflowId: run.workflowId || 'draft', runId });
    const outputDir = relative(store.workspaceRoot, ws).split(sep).join('/');
    const d = node.data || {};

    // 系统提示词支持显式变量，但不会隐式拼入上游；业务输入统一由 inputTemplate 承载。
    const promptCtx = {
      outputs: new Map((s.incoming.get(node.id) || []).map((id) => [id, s.run.outputs[id] ?? ''])),
      structuredOutputs: new Map((s.incoming.get(node.id) || []).map((id) => [id, s.run.structuredOutputs?.[id]])),
      labels: new Map((s.incoming.get(node.id) || []).map((id) => [id, s.nodes.get(id)?.data?.label || id])),
      incomingIds: s.incoming.get(node.id) || [],
      triggerInput: s.triggerInput,
      nodeStates: s.run.nodeStates,
      globalVariables: s.globalVariables, workflowVariables: s.workflowVariables, runInputs: s.runInputs,
      implicitUpstream: false,
    };
    const renderedPrompt = renderTemplate(d.prompt || '你是一个帮助完成任务的助手。', promptCtx);
    let systemPrompt = `${renderedPrompt.text}

你是一个独立运行的智能体，自主决定步骤完成下面的任务：
- 当前目录是用户工作区根，可直接读取其中已有文件。
- 本节点的专属输出目录是 ${outputDir}；交付物（报告/工单/回复稿等）必须写入该目录，中间产物也应写入该目录，不要修改工作区中的其他文件。
- 会话技能目录里匹配任务的技能，先用 skill 工具加载对应规范再动手，输出遵守规范。
- 完成后在最终回复里给出交付物文件清单（文件名 + 一句话说明），不要复述全文。`;
    const skillIds = Array.isArray(d.skills) ? d.skills.slice() : [];
    // feishu-cli 默认对所有 agent 可用（lark-cli 已装时）：索引带上，agent 自行决定加载
    if (larkCliAvailable() && !skillIds.includes('feishu-cli')) skillIds.push('feishu-cli');
    const idx = await skillIndexPromptSafe(skillIds);
    if (idx) systemPrompt += `\n\n${idx}`;
    const outputConfig = getAgentOutputConfig(d);
    if (outputConfig.mode === 'structured') {
      systemPrompt += `\n\n${structuredOutputInstruction(outputConfig.schema)}`;
    }
    // lark-cli 环境探测：装了才告知，避免误导
    if (skillIds.some((x) => x === 'feishu-cli') && larkCliAvailable()) {
      systemPrompt += `\n\n飞书操作：本机装有 lark-cli（飞书官方 CLI，在 dsh 设置「飞书账号」扫码授权一次即可）。默认身份已固定为 user，执行 lark-cli 命令默认加 --as user；user token 由宿主后台自动续约，无需关心过期。user 身份报错/授权失效时降级 --as bot 并在结果注明"需用户重新扫码"。详见技能 feishu-cli。输出 JSON 信封，成功看 ok==true。`;
    }

    // 用户输入 = 模板渲染 + 附件复制进工作区
    const tctx = {
      outputs: new Map((s.incoming.get(node.id) || []).map((id) => [id, s.run.outputs[id] ?? ''])),
      structuredOutputs: new Map((s.incoming.get(node.id) || []).map((id) => [id, s.run.structuredOutputs?.[id]])),
      labels: new Map((s.incoming.get(node.id) || []).map((id) => [id, s.nodes.get(id)?.data?.label || id])),
      incomingIds: s.incoming.get(node.id) || [],
      triggerInput: s.triggerInput,
      nodeStates: s.run.nodeStates,
      globalVariables: s.globalVariables, workflowVariables: s.workflowVariables, runInputs: s.runInputs,
    };
    const rendered = renderTemplate(d.inputTemplate || '', tctx);
    let userPrompt = rendered.text || '(无上游输入)';
    const attachments = (s.graph?.nodes || []).filter((n) => n.type === 'input').flatMap((n) => n.data?.attachments || []);
    const inputFiles = [];
    if (attachments.length) {
      for (const att of attachments) {
        try {
          const filename = safeFilename(att.filename);
          const src = resolveAttachmentFile(att);
          const dest = resolveInside(ws, filename);
          if (src && dest && existsSync(src)) {
            copyFileSync(src, dest);
            inputFiles.push(filename);
          }
        } catch { /* 单个附件失败不阻塞 */ }
      }
      userPrompt += `\n\n可用附件已放入节点输出目录 ${outputDir}，用 read 工具读取：${attachments.map((a) => `${outputDir}/${a.filename}`).join(', ')}`;
    }

    // 节点级模型：默认取全局选择；channel 仅透传给支持的 provider
    const defaultModel = ctx.get('agentDefaultModel');
    const sel = defaultModel?.currentSelection?.() || {};
    const provider = d.channel || sel.provider;
    let model = d.model;
    if (!model && (!d.channel || provider === sel.provider)) model = sel.model;
    if (!model && provider) {
      const models = await ctx.llm.listModels(provider);
      model = models[0]?.id;
    }
    if (!provider || !model) {
      throw new Error('未找到可用的 dsh 渠道和模型，请先在 dsh 设置中完成配置');
    }

    // 工具过滤：与进程内已注册工具求交集（restrict 不接受未知名）
    const wanted = Array.isArray(d.tools) ? d.tools.filter((t) => t && t !== '*') : [];
    let restrictList = null;
    if (wanted.length) {
      try {
        const registered = (ctx.tools.schemas?.() || []).map((t) => t.name);
        const allow = wanted.filter((t) => registered.includes(t));
        if (allow.length && allow.length < registered.length) restrictList = allow;
      } catch { restrictList = null; }
    }

    const maxRounds = Number(d.maxRounds) > 0 ? Number(d.maxRounds) : 0;
    const personaText = systemPrompt;

    let handle; // agents.create() 直接返回 AgentHandle（.agent + .dispose()）
    let canceledByUser = false;
    const onAbort = () => {
      canceledByUser = true;
      try { handle?.agent?.cancel?.({ kind: 'user' }); } catch { /* 已释放 */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      handle = await ctx.get('agents').create({
        sessionId: SessionId(`wf1-${node.id}-${randomUUID().slice(0, 8)}`),
        meta: { cwd: store.workspaceRoot },
        agentOptions: { provider, model },
        setup: async (agentCtx) => {
          // 加入 standard preset：bash/fs/skill 等模型面工具经 standing scope 覆盖本 agent
          try { await ctx.agentPresets.mount(agentCtx, 'standard'); } catch { /* 宿主无 preset 时仅用全局工具 */ }
          agentCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: personaText });
          if (restrictList) {
            try { agentCtx.tools.restrict({ allow: restrictList }); } catch { /* 交集后仍失败则放开 */ }
          }
        },
      });
      const agent = handle.agent;
      await agent.whenIdle();
      const firstSeq = agent.session.seq;

      // 轮数监控：2s 轮询 session events —— 推流式进度；turn 数超限 cancel；turn/end 即退出
      let watchDone;
      const watchReady = new Promise((r) => { watchDone = r; });
      const watchState = { stop: false, timer: null };
      const scanEvents = () => {
        let turns = 0; let preview = ''; let turnEnded = false;
        try {
          for (const ev of agent.session.events) {
            if (ev.seq < firstSeq) continue;
            if (ev.type === 'turn/start') turns += 1;
            if (ev.type === 'turn/end') turnEnded = true;
            if (ev.type === 'assistant/message') {
              const joined = (ev.data.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
              if (joined) preview = joined;
            }
          }
        } catch { /* session 已释放 */ }
        return { turns, preview, turnEnded };
      };
      const watchTick = () => {
        if (watchState.stop) return;
        const { turns, preview, turnEnded } = scanEvents();
        emit('agent-progress', {
          runId, nodeId: node.id, turns,
          preview: outputConfig.mode === 'structured' ? '' : preview.slice(0, 200),
          structured: outputConfig.mode === 'structured' || undefined,
          maxRounds: maxRounds || undefined,
        });
        if (maxRounds && turns > maxRounds) {
          try { agent.cancel({ kind: 'user' }); } catch { /* noop */ }
          return watchDone();
        }
        if (turnEnded) return watchDone();
        watchState.timer = setTimeout(watchTick, 2000);
      };
      watchState.timer = setTimeout(watchTick, 2000);
      const finishWatch = () => {
        watchState.stop = true;
        if (watchState.timer) clearTimeout(watchState.timer);
        watchDone();
      };

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: userPrompt }],
        source: { kind: 'user' },
      }));
      await Promise.race([agent.whenIdle(), watchReady]);
      finishWatch();
      await agent.whenIdle().catch(() => {});
      try { await ctx.get('sessions').flush(agent.session); } catch { /* flush 失败不影响结果 */ }

      let { text, reason } = summarize(agent.session.events, firstSeq);
      let structuredOutput;
      let structuredMeta;
      if (reason?.kind !== 'error' && outputConfig.mode === 'structured') {
        try {
          const validated = await validateStructuredOutputWithRepair(text, outputConfig.schema, async (repairPrompt) => {
            const repairSeq = agent.session.seq;
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: repairPrompt }],
              source: { kind: 'user' },
            }));
            await agent.whenIdle();
            const repaired = summarize(agent.session.events, repairSeq);
            reason = repaired.reason;
            if (reason?.kind === 'error') throw reason.error || new Error('结构化输出修复请求失败');
            return repaired.text;
          });
          structuredOutput = createStructuredEnvelope(validated.result, { schema: outputConfig.schema });
          structuredMeta = { repaired: validated.repaired, validationErrors: [] };
          text = readableStructuredOutput(validated.result.data);
        } catch (repairError) {
          const failure = createStructuredFailureEnvelope(repairError, { repaired: true });
          structuredMeta = { repaired: true, validationErrors: failure.validationErrors };
          const err = new Error(`结构化输出修复失败：${failure.validationErrors.join('；')}`);
          reason = { kind: 'error', error: err };
        }
      }
      const inputFileSet = new Set(inputFiles);
      const artifacts = safeWsList(ws).filter((file) => !inputFileSet.has(file));
      const usage = sumUsage(agent.session.events, firstSeq);
      const details = {
        model: `${provider}:${model}`,
        runtime: 'dsh-plugin',
        turns: countTurns(agent.session.events, firstSeq),
        artifacts,
        sessionId: String(agent.id || ''),
        // 过程轨迹（详情弹窗数据源）：渲染后的输入 + 轮次/工具调用/助手文本时间线
        trace: buildTrace(agent.session.events, firstSeq, { input: userPrompt, model: `${provider}:${model}` }),
        input: rendered.text || '(无上游输入)',
        ...(structuredMeta ? { structuredMeta } : {}),
        ...(usage ? { usage } : {}),
      };
      if (reason?.kind === 'error') {
        const err = reason.error instanceof Error ? reason.error : new Error(reason.error?.message || 'agent 执行失败');
        err.nodeDetails = details;
        throw err;
      }
      return {
        output: text || '(agent 无输出)',
        ...(structuredOutput ? { structuredOutput } : {}),
        ...details,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try { await handle?.dispose?.(); } catch { /* noop */ }
    }
  }

  // ---------------- HTTP 路由 ----------------

  register({ kind: 'exact', path: '/wf1/api/graph', async handler(req, res) {
    if (req.method === 'GET') {
      const graphFile = currentStore().graphFile;
      if (!existsSync(graphFile)) return json(res, 200, defaultGraph());
      try { return json(res, 200, JSON.parse(readFileSync(graphFile, 'utf8'))); }
      catch { return json(res, 200, defaultGraph()); }
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
        return json(res, 400, { error: 'graph 需要 { nodes, edges }' });
      }
      atomicJson(currentStore().graphFile, body);
      return json(res, 200, { ok: true });    }
    json(res, 405, { error: 'method' });
  } });

  register({ kind: 'exact', path: '/wf1/api/graph/reset', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    atomicJson(currentStore().graphFile, defaultGraph());
    json(res, 200, { ok: true });
  } });

  register({ kind: 'exact', path: '/wf1/api/global-variables', async handler(req, res) {
    try {
      if (req.method === 'GET') return json(res, 200, globalVariableStore.read());
      const body = await readBody(req);
      const url = new URL(req.url, 'http://x');
      const expectedRaw = body?.expectedRevision ?? url.searchParams.get('expectedRevision');
      const expectedRevision = expectedRaw === null || expectedRaw === undefined || expectedRaw === '' ? undefined : Number(expectedRaw);
      if (req.method === 'POST') {
        const variable = body?.variable || Object.fromEntries(Object.entries(body || {}).filter(([key]) => key !== 'expectedRevision'));
        const result = globalVariableStore.add(variable, { expectedRevision });
        return json(res, 200, { ok: true, ...result.document, variable: result.variable });
      }
      const selector = { id: body?.id || url.searchParams.get('id') || undefined, key: body?.key || url.searchParams.get('key') || undefined };
      if (req.method === 'PATCH') {
        const changes = body?.changes || Object.fromEntries(Object.entries(body || {}).filter(([key]) => !['id', 'expectedRevision'].includes(key)));
        const result = globalVariableStore.update(selector, changes, { expectedRevision });
        return json(res, 200, { ok: true, ...result.document, variable: result.variable });
      }
      if (req.method === 'DELETE') {
        const result = globalVariableStore.delete(selector, { expectedRevision });
        return json(res, 200, { ok: true, ...result.document, deleted: result.variable });
      }
      return json(res, 405, { error: 'method' });
    } catch (error) {
      return routeError(res, error);
    }
  } });

  // 模板试渲染：可使用历史运行，也可直接传 outputs/structuredOutputs 做无运行预览。
  register({ kind: 'exact', path: '/wf1/api/template/render', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    try { rejectInlineGlobalContext(body); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    const persistedWorkflow = body?.workflowId ? readWf(body.workflowId) : null;
    let workflowContext; try { workflowContext = previewWorkflowContext(body, persistedWorkflow); } catch (error) { return routeError(res, error); }
    let runInputs; try { runInputs = assertSafeContextObject(body?.runInputs ?? body?.inputs, 'runInputs'); } catch (error) { return routeError(res, error); }
    const url = new URL(req.url, 'http://x');
    const runId = url.searchParams.get('run') || body?.runId;
    const selected = selectScopedRun({ runId, workflowId: body?.workflowId, graph: body?.graph }, { readRun, runs: runHistory });
    const hasInlineValues = body?.outputs || body?.structuredOutputs || body?.triggerInput !== undefined;
    if (selected.error && !hasInlineValues) return json(res, selected.status || 404, { ok: false, error: selected.error });
    const selectedRun = selected.run || {};
    const graph = body?.graph || selectedRun.graph || { nodes: [], edges: [] };
    if (body?.workflowId && selectedRun.workflowId && selectedRun.workflowId !== body.workflowId && !hasInlineValues) return json(res, 409, { ok: false, error: '运行记录不属于指定工作流' });
    const targetNodeId = body?.targetNodeId || body?.nodeId;
    const scopeMatches = !body?.graph || !selected.run || runMatchesGraphScope(selectedRun, body.graph, targetNodeId);
    if (!scopeMatches && !hasInlineValues) return json(res, 409, { ok: false, error: '运行记录与当前上游执行图不匹配' });
    const run = scopeMatches ? selectedRun : {};
    const nodesById = new Map((graph.nodes || []).map((n) => [n.id, n]));
    const outputObject = body?.outputs || run.outputs || {};
    const structuredObject = body?.structuredOutputs || run.structuredOutputs || {};
    const labels = new Map();
    const outputs = new Map();
    const structuredOutputs = new Map();
    const valueIds = new Set([...Object.keys(outputObject), ...Object.keys(structuredObject)]);
    for (const id of valueIds) {
      outputs.set(id, outputObject[id] ?? '');
      structuredOutputs.set(id, structuredObject[id]);
      labels.set(id, nodesById.get(id)?.data?.label || body?.labels?.[id] || id);
    }
    let incomingIds = [...labels.keys()];
    if (targetNodeId) incomingIds = (graph.edges || []).filter((e) => e.target === targetNodeId).map((e) => e.source);
    const r = renderTemplate(String(body?.template ?? ''), {
      outputs, structuredOutputs, labels, incomingIds,
      triggerInput: body?.triggerInput ?? run.triggerInput ?? '',
      nodeStates: body?.nodeStates || run.nodeStates || {},
      globalVariables: globals.globalVariables,
      workflowVariables: workflowContext.workflowVariables,
      runInputs: hasOwn(body, 'runInputs') || hasOwn(body, 'inputs') ? runInputs : (run.runInputs || runInputs),
      implicitUpstream: body?.implicitUpstream !== false,
    });
    json(res, 200, {
      ok: true, schemaVersion: RUN_SCHEMA_VERSION,
      text: r.text, missing: r.missing || [], used: r.used || [], references: r.references || [],
    });
  } });

  register({ kind: 'exact', path: '/wf1/api/template/validate', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    try { rejectInlineGlobalContext(body); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    const persistedWorkflow = body?.workflowId ? readWf(body.workflowId) : null;
    let workflowContext; try { workflowContext = previewWorkflowContext(body, persistedWorkflow); } catch (error) { return routeError(res, error); }
    let runInputs; try { runInputs = assertSafeContextObject(body?.runInputs ?? body?.inputs, 'runInputs'); } catch (error) { return routeError(res, error); }
    const graph = body?.graph || persistedWorkflow?.graph || { nodes: body?.nodes || [], edges: body?.edges || [] };
    const targetNodeId = body?.targetNodeId || body?.nodeId;
    const incomingIds = body?.incomingIds || (graph.edges || []).filter((e) => e.target === targetNodeId).map((e) => e.source);
    json(res, 200, validateTemplate(String(body?.template ?? ''), {
      nodes: graph.nodes || [], incomingIds,
      globalVariableDefinitions: globals.globalVariableDefinitions,
      workflowVariableDefinitions: workflowContext.workflowVariableDefinitions,
      inputSchema: workflowContext.inputSchema,
      globalVariables: globals.globalVariables,
      workflowVariables: workflowContext.workflowVariables,
      runInputs,
    }));
  } });

  register({ kind: 'exact', path: '/wf1/api/variables/describe', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    try { rejectInlineGlobalContext(body); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    const persistedWorkflow = body?.workflowId ? readWf(body.workflowId) : null;
    let workflowContext; try { workflowContext = previewWorkflowContext(body, persistedWorkflow); } catch (error) { return routeError(res, error); }
    let inlineRunInputs; try { inlineRunInputs = assertSafeContextObject(body?.runInputs ?? body?.inputs, 'runInputs'); } catch (error) { return routeError(res, error); }
    const graph = body?.graph || persistedWorkflow?.graph || { nodes: body?.nodes || [], edges: body?.edges || [] };
    const targetNodeId = body?.targetNodeId || body?.nodeId;
    const selected = selectScopedRun({ runId: body?.runId, workflowId: body?.workflowId, graph: body?.graph }, { readRun, runs: runHistory });
    const hasInlineValues = body?.outputs || body?.structuredOutputs || body?.triggerInput !== undefined;
    if (selected.error && !hasInlineValues) return json(res, selected.status || 404, { error: selected.error });
    const selectedRun = selected.run || {};
    if (body?.workflowId && selectedRun.workflowId && selectedRun.workflowId !== body.workflowId && !hasInlineValues) return json(res, 409, { error: '运行记录不属于指定工作流' });
    const scopeMatches = !body?.graph || !selected.run || runMatchesGraphScope(selectedRun, body.graph, targetNodeId);
    if (!scopeMatches && !hasInlineValues) return json(res, 409, { error: '最近运行与当前上游执行图不匹配' });
    const baseRun = scopeMatches ? selectedRun : {};
    const run = {
      ...baseRun,
      outputs: { ...(baseRun.outputs || {}), ...(body?.outputs || {}) },
      structuredOutputs: { ...(baseRun.structuredOutputs || {}), ...(body?.structuredOutputs || {}) },
      nodeStates: { ...(baseRun.nodeStates || {}), ...(body?.nodeStates || {}) },
      triggerInput: body?.triggerInput ?? baseRun.triggerInput,
      runInputs: hasOwn(body, 'runInputs') || hasOwn(body, 'inputs') ? inlineRunInputs : (baseRun.runInputs || inlineRunInputs),
    };
    const schema = buildVariableSchema({
      graph, targetNodeId, run,
      globalVariableDefinitions: globals.globalVariableDefinitions,
      workflowVariableDefinitions: workflowContext.workflowVariableDefinitions,
      inputSchema: workflowContext.inputSchema,
      globalVariables: globals.globalVariables,
      workflowVariables: workflowContext.workflowVariables,
      runInputs: run.runInputs,
    });
    json(res, 200, { schemaVersion: RUN_SCHEMA_VERSION, ...schema });
  } });

  register({ kind: 'exact', path: '/wf1/api/graph/lint', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    if (!body?.graph) return json(res, 400, { error: '缺少 graph' });
    json(res, 200, lintGraph(body.graph));
  } });

  // ---- 工作流库 ----
  register({ kind: 'exact', path: '/wf1/api/workflows', async handler(req, res) {
    if (req.method === 'GET') {
      const ids = new Set();
      for (const dir of [currentPaths().workflows]) {
        try { for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) ids.add(file.replace(/\.json$/, '')); }
        catch { /* 目录空 */ }
      }
      const list = [...ids].map((id) => {
        const wf = readWf(id);
        if (!wf) return null;
        return {
          id: wf.id, name: wf.name, updatedAt: wf.updatedAt,
          nodeCount: wf.graph?.nodes?.length ?? 0,
          agentCount: wf.graph?.nodes?.filter((n) => n.type === 'agent').length ?? 0,
        };
      }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return json(res, 200, { workflows: list });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.name || !body.graph || !Array.isArray(body.graph.nodes)) {
        return json(res, 400, { error: '需要 name 和 graph' });
      }
      const id = body.id || `wf_${Date.now().toString(36)}`;
      const prev = readWf(id);
      const {
        id: _bodyId,
        name: _bodyName,
        updatedAt: _bodyUpdatedAt,
        graph: _bodyGraph,
        ...clientMetadata
      } = body;
      let wf;
      try {
        wf = writeWf({
          ...(prev || {}),
          ...clientMetadata,
          id,
          name: String(body.name).slice(0, 60) || prev?.name || '未命名工作流',
          updatedAt: new Date().toISOString(),
          graph: body.graph,
        });
      } catch (error) {
        return routeError(res, error);
      }
      // 命名工作流保存后镜像到草稿图并写入绑定指针：刷新/重开页面时画布恢复到该工作流。
      atomicJson(currentStore().graphFile, { nodes: wf.graph.nodes, edges: wf.graph.edges, workflowId: wf.id });
      return json(res, 200, {
        ok: true,
        id: wf.id,
        name: wf.name,
        updatedAt: wf.updatedAt,
        graphFingerprint: graphFingerprint(wf.graph),
      });
    }
    if (req.method === 'PUT') {
      // 复制：{ id } → 新副本
      const body = await readBody(req);
      const src = readWf(body?.id);
      if (!src) return json(res, 404, { error: '源工作流不存在' });
      const nid = `wf_${Date.now().toString(36)}`;
      const wf = writeWf({ ...src, id: nid, name: `${src.name} 副本`, updatedAt: new Date().toISOString() });
      return json(res, 200, { ok: true, id: nid, name: wf.name, updatedAt: wf.updatedAt });
    }
    json(res, 405, { error: 'method' });
  } });

  register({ kind: 'exact', path: '/wf1/api/workflows/detail', async handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id') || '';
    if (!id) return json(res, 400, { error: '缺少 id' });
    if (req.method === 'GET') {
      const wf = readWf(id);
      if (!wf) return json(res, 404, { error: '工作流不存在' });
      return json(res, 200, wf);
    }
    if (req.method === 'DELETE') {
      if (!readWf(id)) return json(res, 404, { error: '工作流不存在' });
      try { unlinkSync(wfFile(id)); } catch { /* 可能仅存在旧目录 */ }
      atomicWrite(wfTombstone(id), new Date().toISOString());
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const wf = readWf(id);
      if (!wf) return json(res, 404, { error: '工作流不存在' });
      const saved = writeWf({
        ...wf,
        name: String(body.name || wf.name).slice(0, 60),
        updatedAt: new Date().toISOString(),
      });
      return json(res, 200, { ok: true, id: saved.id, name: saved.name });
    }
    json(res, 405, { error: 'method' });
  } });

  // ---- 运行 ----
  register({ kind: 'exact', path: '/wf1/api/run', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    try { rejectInlineGlobalContext(body); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    let runInputs; try { runInputs = assertSafeContextObject(body?.runInputs, 'runInputs'); } catch (error) { return routeError(res, error); }
    let graph = body.graph;
    let workflowName = body.workflowName || null;
    let workflowId = body.workflowId || null;
    let definitions = inlineWorkflowDefinitions(body) || [];
    if (workflowId) {
      const persisted = readWf(workflowId);
      if (!persisted) return json(res, 404, { error: '工作流不存在' });
      if (hasOwn(body, 'workflowVariableDefinitions') || hasOwn(body, 'workflowVariables') || hasOwn(body, 'variables') || hasOwn(body, 'inputSchema')) {
        return json(res, 400, { error: '命名工作流运行必须使用已保存的变量声明和输入 Schema', code: 'persisted-workflow-authority' });
      }
      const persistedFingerprint = graphFingerprint(persisted.graph);
      if (!body.graphFingerprint || body.graphFingerprint !== persistedFingerprint) {
        return json(res, 409, {
          error: '画布内容尚未保存成功，请保存后重试',
          code: 'workflow-graph-mismatch',
          graphFingerprint: persistedFingerprint,
        });
      }
      graph = persisted.graph;
      workflowName = persisted.name;
      definitions = persisted.variables;
    }
    try { assertNonSensitiveVariableDefinitions(definitions, '工作流变量定义'); } catch (error) { return routeError(res, error); }
    if (!graph || !Array.isArray(graph.nodes)) return json(res, 400, { error: '缺少 graph' });
    const lint = lintGraph(graph);
    if (!lint.ok) return json(res, 400, { error: lint.issues.find((i) => i.level === 'error').message, lint });
    const { runId } = startRun(graph, {
      triggerInput: body.triggerInput ?? '', workflowName, workflowId,
      canvasId: body.canvasId || null,
      globalVariables: globals.globalVariables,
      workflowVariables: variableDefinitionsToValues(definitions),
      runInputs,
      source: 'manual',
    });
    json(res, 200, { started: true, runId });
  } });

  // ---- 输出节点飞书写回（outputSink）：按节点所选凭据（画布配置 > env 兜底）----
  orch.outputSink = async (node, output) => {
    const wb = node.data?.writeback;
    if (!wb || wb.type === 'none') return { output };
    const cred = getFeishuCredOrEnv(node.data?.feishuCredId);
    if (!cred) {
      return { output: `${output}\n\n（飞书写回跳过：未配置飞书应用凭据，可在画布右上「设置」添加）`, writeback: 'skipped' };
    }
    const feishu = new FeishuClient({ appId: cred.appId, appSecret: cred.appSecret });
    try {
      let token = wb.targetToken || '';
      let docUrl = token ? `https://feishu.cn/docx/${token}` : '';
      if (!token) {
        const created = await feishu.createDoc(wb.docTitle || `${node.data?.label || '输出'} ${new Date().toISOString().slice(0, 16)}`);
        token = created.token;
        docUrl = created.url;
      }
      const paras = await feishu.appendDoc(token, output);
      return {
        output: `${output}\n\n（已写入飞书文档：${docUrl}）`,
        writeback: { ok: true, url: docUrl, paragraphs: paras },
      };
    } catch (e) {
      return { output: `${output}\n\n（飞书写回失败：${String(e.message || e)}）`, writeback: { ok: false, error: String(e.message || e) } };
    }
  };

  // ---- 飞书凭据管理（画布配置，多套，掩码返回）----
  register({ kind: 'exact', path: '/wf1/api/feishu-credentials', async handler(req, res) {
    if (req.method === 'GET') {
      return json(res, 200, { credentials: listFeishuCreds(), envFallback: Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const added = addFeishuCred(body || {});
        return json(res, 200, { ok: true, credential: added });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body?.action === 'setDefault') {
        return json(res, 200, { ok: setDefaultFeishuCred(body.id) });
      }
      return json(res, 400, { error: 'PATCH 仅支持 action=setDefault' });
    }
    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const id = url.searchParams.get('id') || '';
      return json(res, 200, { ok: removeFeishuCred(id) });
    }
    json(res, 405, { error: 'method' });
  } });

  register({ kind: 'exact', path: '/wf1/api/run/cancel', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const entry = orch.runs.get(body?.runId);
    const ok = entry?.run?.workspaceRoot === currentStore().workspaceRoot
      ? orch.cancel(body?.runId, '用户取消')
      : false;
    json(res, 200, { ok, runId: body?.runId || null });
  } });

  // 单节点试运行：走引擎注册表（与真实运行同一执行路径）；支持手填假输入。
  register({ kind: 'exact', path: '/wf1/api/node/test', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const node = body?.node;
    if (!node?.id || !node?.type) return json(res, 400, { error: '缺少 node' });
    try { rejectInlineGlobalContext(body); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    const persistedWorkflow = body?.workflowId ? readWf(body.workflowId) : null;
    let workflowContext; try { workflowContext = previewWorkflowContext(body, persistedWorkflow); } catch (error) { return routeError(res, error); }
    let runInputs; try { runInputs = assertSafeContextObject(body?.runInputs ?? body?.inputs, 'runInputs'); } catch (error) { return routeError(res, error); }

    // 手填假输入：{ nodeId: text }（前端弹窗可编辑/禁用各上游）
    const fakeOutputs = new Map(Object.entries(body.upstreamOutputs || {}));
    const labels = new Map(Object.entries(body.upstreamLabels || {}));
    const runId = `test_${Date.now().toString(36)}`;
    const orchLike = {
      run: { outputs: Object.fromEntries(fakeOutputs), structuredOutputs: body.upstreamStructuredOutputs || {}, nodeStates: {}, runInputs, runId, schemaVersion: RUN_SCHEMA_VERSION },
      nodes: new Map([[node.id, node]]),
      incoming: new Map([[node.id, [...fakeOutputs.keys()]]]),
      graph: { nodes: [node], edges: [] },
      triggerInput: body.triggerInput ?? '',
      globalVariables: globals.globalVariables,
      workflowVariables: workflowContext.workflowVariables,
      runInputs,
      emit: broadcast, // runAgentNode 的流式事件直接进 SSE
      nodeRunner: (node, run, s, ctl) => runAgentNode(ctx, node, run, s, ctl), // agent kind 经此调用
      scriptRunner: orch.scriptRunner,
      renderTemplate,
      templateCtx(n) {
        return {
          outputs: fakeOutputs,
          structuredOutputs: new Map(Object.entries(this.run.structuredOutputs || {})),
          labels, incomingIds: [...fakeOutputs.keys()], triggerInput: this.triggerInput,
          nodeStates: this.run.nodeStates,
          globalVariables: this.globalVariables, workflowVariables: this.workflowVariables, runInputs: this.runInputs,
        };
      },
    };

    const testAbort = new AbortController();
    const testTimeoutMs = Number(node.data?.timeoutSec) > 0 ? Number(node.data.timeoutSec) * 1000 : 5 * 60 * 1000;
    let testTimedOut = false;
    const testTimer = setTimeout(() => { testTimedOut = true; testAbort.abort(); }, testTimeoutMs);
    req.once('aborted', () => testAbort.abort());
    broadcast('node-status', { runId, nodeId: node.id, status: 'running', test: true });
    try {
      const kind = getKind(node.type);
      if (kind) {
        // 真实执行（agent 会流式推 agent-progress；输出节点 wantsSink 在试运行中跳过写回）
        const r = await kind.execute({
          node, s: orchLike, engine: orchLike,
          signal: testAbort.signal, emit: broadcast, runId,
          render: (tpl) => renderTemplate(tpl || '', orchLike.templateCtx(node)),
        });
        const normalized = normalizeExecutionResult(r);
        const output = normalized.output;
        broadcast('node-status', {
          runId, nodeId: node.id, status: 'success', test: true,
          ...(normalized.structuredOutput.type === 'json' ? {} : { outputPreview: String(output).slice(0, 4000) }),
          hasStructured: normalized.structuredOutput.type === 'json', outputType: normalized.structuredOutput.type,
        });
        return json(res, 200, {
          ok: true, output, structuredOutput: normalized.structuredOutput,
          ...(typeof r === 'object' && r ? {
            turns: r.turns, model: r.model, artifacts: r.artifacts,
            ...(r.input !== undefined ? { input: r.input } : {}),
            ...(r.workspaceStats !== undefined ? { workspaceStats: r.workspaceStats } : {}),
          } : {}),
        });
      }
      json(res, 400, { error: `不支持试运行的节点类型: ${node.type}` });
    } catch (e) {
      const message = testTimedOut ? `节点超时（${Math.round(testTimeoutMs / 1000)}s）` : String(e.message || e);
      broadcast('node-status', { runId, nodeId: node.id, status: 'error', test: true, error: message });
      if (!res.writableEnded) json(res, 200, { ok: false, error: message });
    } finally {
      clearTimeout(testTimer);
    }
  } });

  // ---- 运行历史 ----
  register({ kind: 'exact', path: '/wf1/api/runs', handler(_req, res) {
    const live = [...orch.runs.values()].filter((entry) => entry.run.workspaceRoot === currentStore().workspaceRoot).map((entry) => entry.run.runId);
    const runProgress = (r) => {
      // 进度 = 终态节点数 / 图节点数。passThrough 注释节点通常不进 nodeStates，用图快照兜底总数。
      const total = (r.graph?.nodes?.length ?? Object.keys(r.nodeStates || {}).length) || Object.keys(r.nodeStates || {}).length;
      const done = Object.values(r.nodeStates || {}).filter((st) => ['success', 'error', 'canceled', 'skipped'].includes(st?.status)).length;
      const succeeded = Object.values(r.nodeStates || {}).filter((st) => st?.status === 'success').length;
      return { done, total, succeeded };
    };
    const resumable = (r, isLive) => !isLive
      && ['error', 'canceled'].includes(r.status)
      && Boolean(r.graph?.nodes?.length)
      && Object.values(r.nodeStates || {}).some((st) => st?.status === 'success')
      && Object.values(r.nodeStates || {}).some((st) => !['success', 'skipped'].includes(st?.status));
    json(res, 200, {
      runs: runHistory.slice(0, 20).map((r) => {
        const { structuredOutputs, graph, ...summary } = r;
        const isLive = live.includes(r.runId);
        return {
          ...summary,
          outputs: summarizeOutputs(summary.outputs, structuredOutputs),
          nodeStates: summarizeNodeStates(summary.nodeStates),
          structuredOutputSummary: summarizeStructuredOutputs(structuredOutputs),
          live: isLive,
          progress: runProgress(r),
          resumable: resumable(r, isLive),
        };
      }),
    });
  } });

  register({ kind: 'exact', path: '/wf1/api/runs/detail', async handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id') || '';
    if (!id) return json(res, 400, { error: '缺少 id' });
    const r = readRun(id);
    if (!r) return json(res, 404, { error: '运行记录不存在' });
    json(res, 200, { ...r, structuredOutputs: r.structuredOutputs || {} });
  } });

  register({ kind: 'exact', path: '/wf1/api/run-results', async handler(req, res) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id') || '';
    if (!id) return json(res, 400, { error: '缺少 id' });
    const run = readRun(id);
    if (!run) return json(res, 404, { error: '运行记录不存在' });
    // 产物 URL 回传给前端后会被直接 fetch，必须继承本次请求的会话标识
    const sessionId = url.searchParams.get('sessionId') || req.headers?.['x-wf1-session'] || '';
    return json(res, 200, createRunResults(run, { sessionId }));
  } });

  const artifactLocationsForRun = (run) => ({
    artifactRunDirs: [
      STORAGE.artifactRunDir({ workflowId: run.workflowId || 'draft', runId: run.runId }),
      ...currentPaths().legacyRoots.map((legacy) => legacy.runArtifacts),
    ],
  });

  register({ kind: 'exact', path: '/wf1/api/run-artifact', async handler(req, res) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    const url = new URL(req.url, 'http://x');
    const runId = url.searchParams.get('run') || '';
    const artifactId = url.searchParams.get('artifact') || '';
    if (!runId || !artifactId) return json(res, 400, { error: '需要 run 和 artifact' });
    const run = readRun(runId);
    const resolved = run && resolveRunArtifact(artifactLocationsForRun(run), run, artifactId);
    if (!resolved) return json(res, 404, { error: '产物不存在' });
    const mediaType = resolved.artifact.mediaType || mediaTypeFor(resolved.artifact.name);
    const preview = url.searchParams.get('preview') === '1'
      && resolved.artifact.previewable
      && isPreviewableMediaType(mediaType);
    return streamArtifactResponse(req, res, {
      file: resolved.file,
      filename: resolved.artifact.name,
      mediaType,
      preview,
    });
  } });

  register({ kind: 'exact', path: '/wf1/api/run-artifacts/save', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const runId = String(body?.runId || '');
    const sessionId = String(body?.sessionId || '');
    const requestedIds = [...new Set(Array.isArray(body?.artifactIds) ? body.artifactIds.map(String) : [])];
    if (!runId || !sessionId || requestedIds.length === 0) return json(res, 400, { error: '需要运行、成果和当前会话' });
    if (!sessionCanvas.has(sessionId)) return json(res, 403, { error: '当前会话未绑定工作流画布' });
    const session = ctx.get('sessions')?.get?.(SessionId(sessionId));
    const cwd = session?.header?.cwd;
    if (!cwd) return json(res, 409, { error: '当前会话没有可用的工作目录' });
    if (storeForWorkspace(cwd) !== currentStore()) return json(res, 403, { error: '当前会话不属于此工作区' });
    const run = readRun(runId);
    if (!run) return json(res, 404, { error: '运行记录不存在' });
    const results = createRunResults(run);
    const allowed = new Map(results.artifacts.map((artifact) => [artifact.id, artifact]));
    const artifacts = requestedIds.map((id) => allowed.get(id)).filter(Boolean);
    if (artifacts.length !== requestedIds.length) return json(res, 400, { error: '包含无效成果' });
    try {
      const saved = saveArtifactsToWorkspace({
        cwd,
        run,
        artifacts,
        resolveArtifact: (artifactId) => resolveRunArtifact(artifactLocationsForRun(run), run, artifactId),
      });
      return json(res, 200, { ok: true, ...saved });
    } catch (error) {
      return json(res, 400, { error: String(error.message || error) });
    }
  } });

  register({ kind: 'exact', path: '/wf1/api/runs/export', async handler(req, res) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id') || '';
    if (!id) return json(res, 400, { error: '缺少 id' });
    const run = readRun(id);
    if (!run) return json(res, 404, { error: '运行记录不存在' });
    const archive = createRunExport(run, artifactLocationsForRun(run));
    const filename = safeFilename(`${run.workflowName || run.runId}-${run.runId}.zip`);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(archive.length),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    return res.end(archive);
  } });

  // 节点详情：输入（渲染后的模板）/ 输出全文 / 状态 / agent 过程轨迹（轮次、工具调用与结果）。
  // 轨迹在运行完成时已随 run 落盘；旧运行或轨迹缺失时现场从 dsh session 存档回放补齐。
  register({ kind: 'exact', path: '/wf1/api/node-detail', async handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const runId = url.searchParams.get('run') || '';
    const nodeId = url.searchParams.get('node') || '';
    if (!runId || !nodeId) return json(res, 400, { error: '缺少 run 和 node' });
    const run = readRun(runId) || runHistory.find((r) => r.runId === runId);
    if (!run) return json(res, 404, { error: '运行记录不存在' });
    const state = run.nodeStates?.[nodeId];
    const label = (run.graph?.nodes || []).find((n) => n.id === nodeId)?.data?.label || nodeId;
    const node = (run.graph?.nodes || []).find((n) => n.id === nodeId);
    const structuredOutput = run.structuredOutputs?.[nodeId] ?? null;
    const structuredValue = structuredOutput?.value && typeof structuredOutput.value === 'object'
      ? structuredOutput.value
      : null;
    const inputDetail = node?.type === 'input' || node?.data?.nodeType === 'input'
      ? {
          configuredText: structuredValue?.text ?? node?.data?.text ?? '',
          triggerInput: structuredValue?.triggerInput ?? run.triggerInput ?? '',
          upstreamText: structuredValue?.upstreamText ?? '',
        }
      : state?.input ?? null;
    const out = {
      runId, nodeId, label,
      nodeType: node?.type || node?.data?.nodeType || null,
      status: state?.status || 'pending',
      state: state || null,
      output: run.outputs?.[nodeId] ?? '',
      structuredOutput,
      schemaVersion: run.schemaVersion || 1,
      variables: run.graph?.nodes ? describeNodeOutput(node) : null,
      input: inputDetail,
      trace: state?.trace ?? null,
      sessionId: state?.sessionId || null,
    };
    if (!out.trace && state?.sessionId) {
      out.trace = await replayTrace(state.sessionId).catch(() => null);
    }
    json(res, 200, out);
  } });

  // 运行重放：用历史运行当时的图快照 + 原触发输入再跑一次（排查失败不改图）
  register({ kind: 'exact', path: '/wf1/api/runs/replay', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const prev = readRun(body?.runId);
    if (!prev) return json(res, 404, { error: '运行记录不存在' });
    const graph = body?.graph || prev.graph;
    if (!graph || !Array.isArray(graph.nodes)) return json(res, 400, { error: '该运行没有图快照，需传 graph' });
    const triggerInput = body?.triggerInput !== undefined ? String(body.triggerInput) : String(prev.triggerInput || '');
    let runInputs; try { runInputs = assertSafeContextObject(body?.runInputs ?? prev.runInputs, 'runInputs'); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    const persistedWorkflow = prev.workflowId ? readWf(prev.workflowId) : null;
    const workflowVariables = variableDefinitionsToValues(persistedWorkflow?.variables || []);
    const lint = lintGraph(graph);
    if (!lint.ok) return json(res, 400, { error: lint.issues.find((i) => i.level === 'error').message, lint });
    const { runId } = startRun(graph, {
      triggerInput, workflowName: prev.workflowName || null, workflowId: prev.workflowId || null,
      globalVariables: globals.globalVariables, workflowVariables, runInputs,
      source: 'replay', replayOf: prev.runId,
    });
    json(res, 200, { started: true, runId, replayOf: prev.runId });
  } });

  // 断点续跑：从上次运行的 success 节点之后继续。图必须与上次一致（fingerprint），
  // 否则产物/模板引用对不上——提示用户重新运行。
  register({ kind: 'exact', path: '/wf1/api/runs/resume', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const prev = readRun(body?.runId);
    if (!prev) return json(res, 404, { error: '运行记录不存在' });
    if (orch.runs.has(prev.runId)) return json(res, 409, { error: '该运行仍在进行中', code: 'run-live' });
    if (!prev.graph || !Array.isArray(prev.graph.nodes)) return json(res, 400, { error: '该运行没有图快照，无法续跑' });
    const succeeded = Object.values(prev.nodeStates || {}).filter((st) => st?.status === 'success');
    if (!succeeded.length) return json(res, 400, { error: '该运行没有已完成的节点，无需续跑', code: 'nothing-to-resume' });
    // 图来源：优先当前画布图（可能是保存后的同名图），须与上次 fingerprint 一致
    let graph = body.graph || prev.graph;
    if (body.graphFingerprint && body.graphFingerprint !== graphFingerprint(body.graph)) {
      return json(res, 400, { error: '画布图与请求指纹不一致', code: 'graph-fingerprint-mismatch' });
    }
    if (graphFingerprint(graph) !== prev.graphFingerprint) {
      return json(res, 409, {
        error: '画布图已修改，与上次运行不一致；请重新运行或还原画布',
        code: 'workflow-graph-mismatch',
      });
    }
    // 沿用上次的触发输入与运行输入：续跑语义是“同样的输入，只补跑没跑完的节点”
    const triggerInput = String(prev.triggerInput || '');
    let runInputs; try { runInputs = assertSafeContextObject(prev.runInputs, 'runInputs'); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    const persistedWorkflow = prev.workflowId ? readWf(prev.workflowId) : null;
    const workflowVariables = variableDefinitionsToValues(persistedWorkflow?.variables || []);
    const lint = lintGraph(graph);
    if (!lint.ok) return json(res, 400, { error: lint.issues.find((i) => i.level === 'error').message, lint });
    const { runId } = startRun(graph, {
      triggerInput, workflowName: prev.workflowName || null, workflowId: prev.workflowId || null,
      canvasId: body.canvasId || prev.canvasId || null,
      globalVariables: globals.globalVariables, workflowVariables, runInputs,
      source: 'resume', resume: prev,
    });
    json(res, 200, { started: true, runId, resumedFrom: prev.runId, resumedNodes: succeeded.length });
  } });

  // 工作流导出 / 导入（画布间分享：{ name, graph } 单文件）
  register({ kind: 'exact', path: '/wf1/api/workflows/transfer', async handler(req, res) {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const id = url.searchParams.get('id') || '';
      const wf = readWf(id);
      if (!wf) return json(res, 404, { error: '工作流不存在' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(wf.name)}.workflow-one.json`,
      });
      res.end(JSON.stringify(createWorkflowExportManifest(wf), null, 2));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const id = `wf_${Date.now().toString(36)}`;
      let wf;
      try {
        wf = importWorkflowDocument(body, { id });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      wf.name = wf.name.slice(0, 60);
      wf.graph = { nodes: wf.graph.nodes, edges: Array.isArray(wf.graph.edges) ? wf.graph.edges : [] };
      const lint = lintGraph(wf.graph);
      if (!lint.ok) return json(res, 400, { error: `导入的图校验失败：${lint.issues.find((i) => i.level === 'error').message}` });
      wf = writeWf(wf);
      return json(res, 200, { ok: true, id, name: wf.name, warnings: lint.issues.filter((i) => i.level === 'warn').length });
    }
    json(res, 405, { error: 'method' });
  } });

  // 刷新恢复快照：进行中运行的最新状态（供页面加载时补齐 SSE 错过的事件）
  register({ kind: 'exact', path: '/wf1/api/state', handler(_req, res) {
    const runningIds = [...orch.runs.values()].filter((entry) => entry.run.workspaceRoot === currentStore().workspaceRoot).map((entry) => entry.run.runId);
    const latest = runHistory[0];
    const lastRun = latest ? (() => {
      const { structuredOutputs, graph, ...summary } = latest;
      return { ...summary, outputs: summarizeOutputs(summary.outputs, structuredOutputs), nodeStates: summarizeNodeStates(summary.nodeStates), structuredOutputSummary: summarizeStructuredOutputs(structuredOutputs) };
    })() : null;
    json(res, 200, {
      running: runningIds,
      lastRun,
    });
  } });

  // ---- webhook + 定时触发（落盘 data/triggers.json，重启自动恢复）----
  // hooks: [{ id, token, workflowId, workflowName, createdAt }]
  // schedules: [{ key, workflowId, workflowName, cron, input, createdAt }]
  const loadTriggers = () => {
    const store = currentStore();
    if (store.triggersLoaded) return { hooks: [...store.hooks.values()], schedules: [...store.schedulerMeta.values()] };
    store.triggersLoaded = true;
    try {
      const t = JSON.parse(readFileSync(store.triggersFile, 'utf8'));
      for (const h of t.hooks || []) {
        store.hooks.set(h.id, h);
        publicHooks.set(h.id, { store, hook: h });
      }
      return t;
    } catch { return { hooks: [], schedules: [] }; }
  };

  const persistTriggers = () => {
    try {
      const store = currentStore();
      atomicJson(store.triggersFile, {
        hooks: [...currentHooks().values()].map(({ id, token, workflowId, workflowName, createdAt }) => ({ id, token, workflowId, workflowName, createdAt })),
        schedules: [...currentSchedulerMeta().entries()].map(([key, m]) => ({
          key, workflowId: m.workflowId, workflowName: m.workflowName, cron: m.cron, input: m.input, createdAt: m.createdAt,
        })),
      });
    } catch { /* 落盘失败不影响运行 */ }
  };

  register({ kind: 'exact', path: '/wf1/api/hooks', async handler(req, res) {
    if (req.method === 'GET') {
      return json(res, 200, { hooks: [...currentHooks().values()].map((h) => ({ ...h, url: `/wf1/api/hooks/${h.id}` })) });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const wf = readWf(body?.workflowId);
      if (!wf) return json(res, 404, { error: '工作流不存在' });
      const id = `hk_${randomUUID().slice(0, 8)}`;
      const token = randomUUID().replace(/-/g, '');
      const hook = { id, token, workflowId: wf.id, workflowName: wf.name, createdAt: new Date().toISOString() };
      currentHooks().set(id, hook);
      publicHooks.set(id, { store: currentStore(), hook });
      persistTriggers();
      return json(res, 200, { ok: true, id, token, url: `/wf1/api/hooks/${id}` });
    }
    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const id = url.searchParams.get('id') || '';
      const deleted = currentHooks().delete(id);
      publicHooks.delete(id);
      json(res, 200, { ok: deleted });
      persistTriggers();
      return;
    }
    json(res, 405, { error: 'method' });
  } });

  register({ kind: 'prefix', path: '/wf1/api/hooks', async handler(req, res) {
    const m = new URL(req.url, 'http://x').pathname.match(/^\/wf1\/api\/hooks\/([A-Za-z0-9_-]+)$/);
    if (!m) return json(res, 404, { error: 'not found' });
    let owner = publicHooks.get(m[1]);
    if (!owner) {
      for (const workspaceRoot of registeredWorkspaceRoots()) {
        const store = storeForWorkspace(workspaceRoot);
        workspaceContext.run(store, ensureTriggers);
      }
      owner = publicHooks.get(m[1]);
    }
    if (!owner) return json(res, 404, { error: 'hook 不存在' });
    return workspaceContext.run(owner.store, async () => {
      const hook = owner.hook;
      const u = new URL(req.url, 'http://x');
      const presented = u.searchParams.get('token')
        || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        || String(req.headers['x-hook-token'] || '');
      if (!presented || presented !== hook.token) {
        return json(res, 401, { error: '缺少或错误的 hook token（?token= 或 Authorization: Bearer 或 X-Hook-Token）' });
      }
      const wf = readWf(hook.workflowId);
      if (!wf) return json(res, 404, { error: 'hook 指向的工作流已删除' });
      let triggerInput = '';
      let runInputs = {};
      try {
        triggerInput = u.searchParams.get('input') || '';
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (!triggerInput) triggerInput = String(body?.input || body?.text || (typeof body === 'string' ? body : ''));
          runInputs = assertSafeContextObject(body?.inputs, 'inputs');
        }
      } catch (error) { return routeError(res, error); }
      let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
      const { runId } = startRun(wf.graph, {
        triggerInput, workflowName: wf.name, workflowId: wf.id,
        globalVariables: globals.globalVariables,
        workflowVariables: variableDefinitionsToValues(wf.variables),
        runInputs,
        source: 'webhook',
      });
      return json(res, 200, { ok: true, triggered: wf.name, runId });
    });
  } }, { scoped: false });

  // ---- 定时触发 ----
  // POST /wf1/api/schedule { workflowId, cron, input? } —— cron-parser 算下次触发，ctx.timer.timeout 链式调度
  const startSchedule = (key, meta) => {
    const state = { stopped: false, timer: null, rawTimer: null, nextAt: null, fireCount: 0 };
    const armNext = () => {
      if (state.stopped) return;
      let nextMs = 1;
      try {
        nextMs = Math.max(1, parseCronExpression(meta.cron, { currentDate: new Date() }).next().getTime() - Date.now());
      } catch (e) {
        state.stopped = true;
        ctx.logger?.warn?.(`dsh-ccpg 定时表达式无效（${key}）：${e.message}`);
        return;
      }
      state.nextAt = new Date(Date.now() + nextMs).toISOString();
      currentSchedulerMeta().set(key, { ...meta, nextAt: state.nextAt, fireCount: state.fireCount });
      const fire = () => {
        if (state.stopped) return;
        state.fireCount += 1;
        const wf = readWf(meta.workflowId);
        if (wf) {
          try {
            const globals = globalContext();
            startRun(wf.graph, {
              triggerInput: meta.input || '', workflowName: wf.name, workflowId: wf.id, source: 'schedule',
              globalVariables: globals.globalVariables,
              workflowVariables: variableDefinitionsToValues(wf.variables),
              runInputs: {},
            });
          } catch (error) { ctx.logger?.warn?.(`dsh-ccpg 定时运行变量加载失败（${key}）：${error.message}`); }
        }
        armNext();
      };
      // setTimeout 上限 2^31-1 ms（约 24.8 天）：远期任务链式分段等待，避免溢出成 1ms 风暴
      const MAX_WAIT = 2 ** 31 - 1;
      if (nextMs > MAX_WAIT) {
        state.rawTimer = setTimeout(armNext, Math.floor(MAX_WAIT / 2));
        return;
      }
      state.rawTimer = setTimeout(fire, nextMs);
    };
    armNext();
    return {
      stop() {
        state.stopped = true;
        if (state.rawTimer) clearTimeout(state.rawTimer);
        try { state.timer?.(); } catch { /* disposer 已失效 */ }
      },
    };
  };
  ensureTriggers = () => {
    const store = currentStore();
    const saved = loadTriggers();
    if (store.triggersRestored) return;
    store.triggersRestored = true;
    for (const meta of saved.schedules || []) {
      if (!readWf(meta.workflowId)) continue;
      try {
        currentSchedulers().set(meta.key, startSchedule(meta.key, meta));
        currentSchedulerMeta().set(meta.key, meta);
      } catch { /* 单条失败不阻塞 */ }
    }
  };

  register({ kind: 'exact', path: '/wf1/api/schedule', async handler(req, res) {
    if (req.method === 'GET') {
      const rows = [];
      for (const [key, meta] of currentSchedulerMeta()) rows.push({ ...meta, key });
      return json(res, 200, { schedules: rows });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const wf = readWf(body?.workflowId);
      if (!wf) return json(res, 404, { error: '工作流不存在' });
      if (!body?.cron) return json(res, 400, { error: '需要 cron 表达式（5 段）' });
      try {
        parseCronExpression(body.cron, { currentDate: new Date() });
      } catch (e) {
        return json(res, 400, { error: `cron 表达式无效：${e.message}` });
      }
      const key = `sch_${randomUUID().slice(0, 8)}`;
      const meta = { workflowId: wf.id, workflowName: wf.name, cron: body.cron, input: body.input || '', createdAt: new Date().toISOString() };
      const entry = startSchedule(key, meta);
      currentSchedulers().set(key, entry);
      currentSchedulerMeta().set(key, meta);
      persistTriggers();
      return json(res, 200, { ok: true, key, cron: body.cron });
    }
    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const key = url.searchParams.get('key') || '';
      const entry = currentSchedulers().get(key);
      if (entry) entry.stop();
      currentSchedulers().delete(key);
      currentSchedulerMeta().delete(key);
      persistTriggers();
      return json(res, 200, { ok: true });
    }
    json(res, 405, { error: 'method' });
  } });

  // ---- 附件 ----
  register({ kind: 'exact', path: '/wf1/api/attachments', async handler(req, res) {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const { filename, contentBase64 } = body || {};
      if (!filename || !contentBase64) return json(res, 400, { error: '需要 filename 和 contentBase64' });
      const safe = safeFilename(filename);
      const buf = Buffer.from(contentBase64, 'base64');
      if (buf.length > 5 * 1024 * 1024) return json(res, 413, { error: '附件超过 5MB' });
      const id = `att_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const dir = resolveInside(currentPaths().attachments, id);
      const file = dir && resolveInside(dir, safe);
      if (!dir || !file) return json(res, 400, { error: '附件名称无效' });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, buf, { mode: 0o600 });
      atomicJson(join(dir, 'meta.json'), { id, filename: safe, size: buf.length, uploadedAt: new Date().toISOString() });
      return json(res, 200, { ok: true, id, filename: safe, size: buf.length });
    }
    if (req.method === 'GET') {
      const files = [];
      try {
        for (const id of readdirSync(currentPaths().attachments)) {
          try {
            const meta = JSON.parse(readFileSync(join(currentPaths().attachments, id, 'meta.json'), 'utf8'));
            files.push(meta);
          } catch { /* 损坏条目跳过 */ }
        }
      } catch { /* 新目录为空 */ }
      return json(res, 200, { attachments: files });
    }
    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const id = url.searchParams.get('id') || '';
      if (id) {
        const target = resolveInside(currentPaths().attachments, safeFileId(id, 'invalid'));
        if (target && existsSync(target)) {
          rmSync(target, { recursive: true, force: true });
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: '附件不存在' });
    }
    json(res, 405, { error: 'method' });
  } });

  // ---- 产物下载/预览：?node=&file=&preview=1 读该节点工作区文件 ----
  register({ kind: 'exact', path: '/wf1/api/artifact', async handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const nodeLabel = safeFileId(url.searchParams.get('node') || '', '');
    const file = url.searchParams.get('file') || '';
    if (!nodeLabel || !file) return json(res, 400, { error: '需要 node 和 file' });
    const dir = resolveInside(STORAGE.legacy.workspaces, nodeLabel);
    const full = dir && resolveInside(dir, file);
    if (!dir || !full || !existsSync(full) || !statSync(full).isFile()) {
      return json(res, 404, { error: '产物不存在' });
    }
    const realDir = realpathSync(dir);
    const realFull = realpathSync(full);
    if (resolveInside(realDir, realFull) !== realFull) return json(res, 404, { error: '产物不存在' });
    const mediaType = mediaTypeFor(file);
    const preview = url.searchParams.get('preview') === '1' && isPreviewableMediaType(mediaType);
    return streamArtifactResponse(req, res, { file: realFull, filename: file, mediaType, preview });
  } });

  // ---- 技能目录：dsh 原生 ctx.skills（skill-filesystem 发现 ~/.dsh/skills 等根）----
  register({ kind: 'exact', path: '/wf1/api/skills', async handler(_req, res) {
    try {
      const all = await ctx.skills.list();
      const skills = all
        .filter((s) => s.invocation?.modelInvocable !== false)
        .map((s) => ({ id: s.name, name: s.name, description: s.description || '', provider: s.provider, source: s.source }));
      json(res, 200, { skills });
    } catch (e) {
      json(res, 200, { skills: [], error: String(e.message) });
    }
  } });

  // ---- LLM 配置：直接读取 dsh 运行时注册的渠道和模型目录 ----
  register({ kind: 'exact', path: '/wf1/api/llm-config', async handler(_req, res) {
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.() || {};
    const failures = [];
    const providers = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
      try {
        const models = await ctx.llm.listModels(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          models: models.map((model) => ({
            id: model.id,
            name: model.name || model.id,
            ...(model.description ? { description: model.description } : {}),
          })),
        };
      } catch (error) {
        failures.push({ provider: provider.id, error: error?.message || String(error) });
        return { id: provider.id, name: provider.name, models: [] };
      }
    }));
    json(res, 200, {
      defaultProvider: sel.provider,
      defaultModel: sel.model,
      providers,
      ...(failures.length ? { failures } : {}),
    });
  } });

  // runtime 徽标数据源：插件形态下 agent 恒走 dsh 底座
  register({ kind: 'exact', path: '/wf1/api/runtime-config', handler(_req, res) {
    json(res, 200, { runtime: { available: true, runtime: 'dsh-plugin', reasons: [] } });
  } });

  register({ kind: 'exact', path: '/wf1/api/tools', handler(_req, res) {
    try {
      const schemas = ctx.tools.schemas ? ctx.tools.schemas() : [];
      json(res, 200, {
        tools: schemas.map((s) => ({ name: s.name, description: s.description })),
        feishuEnabled: Boolean(getFeishuCredOrEnv()),
      });
    } catch (e) {
      json(res, 200, { tools: [], error: String(e.message) });
    }
  } });

  // ---- 画布 AI 助手端点：绑定（聊天 session ↔ 画布）+ 画布状态上报 + persona ----
  // 绑定后该 session 的 agent 调 canvas_* 工具即作用于绑定的画布；
  // persona 经 /assistant/persona 由宿主注入（agents.setup 无官方钩子时退化为：绑定即注入 systemPrompt section）。
  register({ kind: 'exact', path: '/wf1/api/assistant/bind', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const { sessionId, canvasId } = body || {};
    if (!sessionId || !canvasId) return json(res, 400, { error: '需要 sessionId 和 canvasId' });
    sessionCanvas.set(String(sessionId), String(canvasId));
    const cv = canvasOf(String(canvasId));
    cv.boundSessions.add(String(sessionId));
    applyCanvasGraph(cv, body.graph, body.version);
    if (body.workflowId) cv.workflowId = body.workflowId;
    const hostSession = ctx.get('sessions')?.get?.(SessionId(String(sessionId)));
    const canSaveToWorkspace = Boolean(hostSession?.header?.cwd);
    json(res, 200, { ok: true, version: cv.version, graph: cv.graph, persona: canvasAssistantPersona(), canSaveToWorkspace });
  } });

  register({ kind: 'exact', path: '/wf1/api/assistant/unbind', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const sid = String(body?.sessionId || '');
    const cid = sessionCanvas.get(sid);
    if (cid) {
      sessionCanvas.delete(sid);
      canvasOf(cid).boundSessions.delete(sid);
    }
    json(res, 200, { ok: true });
  } });

  // 画布状态：POST 上报前端图，GET 拉服务端权威图。AI patch 的 version 更高时，
  // 旧前端上报会被拒绝，SSE 漏包后前端也能用 GET 补回完整图。
  register({ kind: 'exact', path: '/wf1/api/assistant/canvas-state', async handler(req, res) {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://wf1.local');
      const canvasId = url.searchParams.get('canvasId');
      if (!canvasId) return json(res, 400, { error: '需要 canvasId' });
      const cv = canvasOf(String(canvasId));
      return json(res, 200, { ok: true, version: cv.version, graph: cv.graph, workflowId: cv.workflowId });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    if (!body?.canvasId) return json(res, 400, { error: '需要 canvasId' });
    const cv = canvasOf(String(body.canvasId));
    const result = applyCanvasGraph(cv, body.graph, body.version);
    if (body.workflowId !== undefined) cv.workflowId = body.workflowId || null;
    json(res, 200, { ok: true, applied: result.applied, reason: result.reason, version: cv.version, graph: result.applied ? undefined : cv.graph, nodes: (cv.graph?.nodes || []).length });
  } });

  // SSE 端点（含快照：连接即推送最近一次运行状态）
  for (const workspaceRoot of registeredWorkspaceRoots()) {
    const store = storeForWorkspace(workspaceRoot);
    workspaceContext.run(store, () => {
      hydrateHistory();
      ensureTriggers();
    });
  }

  register({ kind: 'exact', path: '/wf1/api/events', handler(req, res) {
    const requestedRunId = new URL(req.url, 'http://wf1.local').searchParams.get('runId') || null;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');
    // 只恢复进行中运行；完成历史必须由带作用域的历史/详情接口读取，避免跨工作流串台。
    const liveRuns = (requestedRunId
      ? [orch.runs.get(requestedRunId)].filter(Boolean)
      : [...orch.runs.values()])
      .filter((entry) => entry.run.workspaceRoot === currentStore().workspaceRoot);
    for (const live of liveRuns) {
      res.write(`event: snapshot\ndata: ${JSON.stringify({
        runId: live.run.runId,
        workflowId: live.run.workflowId ?? null,
        canvasId: live.run.canvasId ?? null,
        source: live.run.source ?? null,
        schemaVersion: live.run.schemaVersion,
        status: 'running',
        nodeStates: summarizeNodeStates(live.run.nodeStates),
        outputs: summarizeOutputs(live.run.outputs, live.run.structuredOutputs),
        structuredOutputSummary: summarizeStructuredOutputs(live.run.structuredOutputs),
      })}\n\n`);
    }
    sseClients.set(res, { store: currentStore(), runId: requestedRunId });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
  } });
}

// ---------------- helpers ----------------

// agent 过程轨迹：把本节点产生的 session 事件折叠成 UI 可直接渲染的时间线。
// entries: {kind:'input'|'assistant'|'tool', ...}；工具调用与结果按 callId 配对成一条。
function buildTrace(events, firstSeq, meta = {}) {
  const entries = [{ kind: 'input', text: String(meta.input || '') }];
  const pending = new Map(); // callId → index in entries
  try {
    for (const ev of events) {
      if (ev.seq < firstSeq) continue;
      if (ev.type === 'user/message') {
        // followup 之外还有 agent.inject 合成消息（技能加载/文件变更等），一并列出
        const text = (ev.data?.message?.content || ev.data?.content || [])
          .filter((b) => b?.type === 'text').map((b) => b.text).join('');
        if (text && text !== meta.input) {
          entries.push({ kind: 'inject', text: text.slice(0, 2000) });
        }
      } else if (ev.type === 'assistant/message') {
        const text = (ev.data?.message?.content || [])
          .filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) entries.push({ kind: 'assistant', text: text.slice(0, 6000), usage: ev.data?.usage });
      } else if (ev.type === 'tool/call') {
        pending.set(ev.data.callId, entries.length);
        entries.push({
          kind: 'tool', name: ev.data.name,
          args: String(ev.data.arguments || '').slice(0, 4000),
          turn: ev.data.turn, step: ev.data.step,
        });
      } else if (ev.type === 'tool/result') {
        // ToolResultMessage.content = [{ type:'tool-result', toolCallId, content, isError }]
        const blocks = ev.data?.message?.content || [];
        for (const b of blocks) {
          const i = pending.get(b?.toolCallId);
          if (i !== undefined && entries[i]?.result === undefined) {
            entries[i].result = {
              ok: b.isError !== true && !ev.data?.error,
              text: (b.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('').slice(0, 4000),
              ...(ev.data?.error ? { error: `${ev.data.error.name}: ${ev.data.error.code}` } : {}),
            };
          }
        }
      } else if (ev.type === 'turn/end') {
        entries.push({ kind: 'turn-end', reason: ev.data?.reason?.kind || String(ev.data?.reason || '') });
      }
    }
  } catch { /* session 已释放时保留已折叠部分 */ }
  // 旧会话回放没有 meta.input：第一条非系统注入就是实际用户输入，归位到 input。
  if (!entries[0].text) {
    const i = entries.findIndex((e, idx) => idx > 0 && e.kind === 'inject' && !/^Current runtime context|^<system-reminder>/.test(e.text));
    if (i > 0) {
      entries[0].text = entries[i].text;
      entries.splice(i, 1);
    }
  }
  return { model: meta.model, entries };
}

// 旧运行记录（无 trace 快照）按 sessionId 从 dsh 会话存档现场回放轨迹
async function replayTrace(sessionId) {
  const persistence = ctxRef?.sessionPersistence;
  if (!persistence || !sessionId) return null;
  const insp = await persistence.load(sessionId);
  return buildTrace(insp.events, 0, { input: '', model: '' });
}

function summarize(events, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/start') { started = true; continue; }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}

function countTurns(events, firstSeq) {
  let n = 0;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/start') n += 1;
  }
  return n;
}

// 汇总 agent 会话内 assistant/message 事件携带的 token 用量（计数互斥：input 为未缓存部分）
function sumUsage(events, firstSeq) {
  let input = 0; let output = 0; let cacheRead = 0; let cacheWrite = 0; let has = false;
  for (const ev of events) {
    if (ev.seq < firstSeq || ev.type !== 'assistant/message') continue;
    const u = ev.data?.usage;
    if (!u) continue;
    has = true;
    input += u.inputTokens || 0;
    output += u.outputTokens || 0;
    cacheRead += u.cacheReadTokens || 0;
    cacheWrite += u.cacheWriteTokens || 0;
  }
  return has ? { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } : null;
}

function workspaceFor(node, { workflowId, runId } = {}) {
  const store = workspaceContext.getStore();
  if (!store) throw new Error('节点执行缺少工作区上下文');
  const dir = store.paths.workspaceForNode({
    workflowId: workflowId || 'draft',
    runId: runId || `test-${Date.now().toString(36)}`,
    nodeId: node.id,
  });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeWsList(dir, { maxFiles = 1000, maxFileBytes = 50 * 1024 * 1024, maxTotalBytes = 500 * 1024 * 1024 } = {}) {
  const out = [];
  let totalBytes = 0;
  const realRoot = realpathSync(dir);
  const walk = (cur) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const real = realpathSync(full);
      if (resolveInside(realRoot, real) !== real) continue;
      const stat = statSync(real);
      if (stat.size > maxFileBytes) throw new Error(`文件“${entry.name}”超过 50MB，未保存为成果`);
      totalBytes += stat.size;
      if (totalBytes > maxTotalBytes) throw new Error('本节点生成文件总量超过 500MB，请减少文件后重试');
      out.push(real.slice(realRoot.length + 1).replace(/\\/g, '/'));
      if (out.length > maxFiles) throw new Error('本节点生成文件超过 1000 个，请整理后重试');
    }
  };
  walk(realRoot);
  return out;
}

// lark-cli 可能由 larkauth 插件在启动后自动安装完成 —— 缓存带 15s TTL，免重启生效
let _larkCliCache;
let _larkCliCacheAt = 0;
function larkCliAvailable() {
  const now = Date.now();
  if (_larkCliCache !== undefined && now - _larkCliCacheAt < 15000) return _larkCliCache;
  const candidates = [
    join(homedir(), '.local', 'npm-global', 'bin', 'lark-cli'),
    '/usr/local/bin/lark-cli',
    '/opt/homebrew/bin/lark-cli',
  ];
  _larkCliCache = candidates.some((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  _larkCliCacheAt = now;
  return _larkCliCache;
}

async function skillIndexPromptSafe(ids) {
  try {
    const skills = await ctxRef?.skills?.list();
    if (!skills?.length) return null;
    // dsh 原生 skill 工具已注入会话技能目录（skill-catalog），这里只做画布节点勾选的定向提示
    const lines = [];
    for (const s of skills) {
      if (ids.includes(s.name)) {
        lines.push(`- ${s.name}：${s.description || ''}`);
      }
    }
    if (!lines.length) return null;
    return `本节点指定优先使用以下技能（用 skill 工具加载规范后按规范执行）：\n${lines.join('\n')}`;
  } catch { return null; }
}

function defaultGraph() {
  return {
    nodes: [
      {
        id: 'n_input', type: 'input', position: { x: 60, y: 220 },
        data: {
          label: '报修单输入',
          text: '3栋2单元501室 张先生 13800001111：厨房水槽下水缓慢已有三天，偶尔返味，希望尽快上门查看。',
          attachments: [],
        },
      },
      {
        id: 'n_agent1', type: 'agent', position: { x: 380, y: 100 },
        data: {
          label: '工单整理',
          prompt: '你是物业客服助手。把上游的报修信息整理为规范工单，写成 gongdan.md 落盘：提取报修人、联系方式、位置、故障描述、紧急程度（低/中/高）。',
          tools: [],
        },
      },
      {
        id: 'n_output', type: 'output', position: { x: 720, y: 230 },
        data: { label: '工单输出' },
      },
    ],
    edges: [
      { id: 'e1', source: 'n_input', target: 'n_agent1' },
      { id: 'e3', source: 'n_agent1', target: 'n_output' },
    ],
  };
}
