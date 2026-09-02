// dsh-ccpg-orchestrator：Workflow One 编排插件（Cordis plugin）v2。
// 在 dsh 进程内提供：
//   - 图（DAG）执行引擎 lib/engine.js：并发上限、节点超时、运行取消、条件分支、lint
//   - agent 节点 = 真实 dsh agent：节点级 provider/model/tools/maxRounds 真正生效
//     · model: agentOptions.model/provider
//     · tools: agentCtx.tools.restrict({allow})（与已注册工具求交集）
//     · maxRounds: 轮询 session events 的 turn 计数，超限 agent.cancel
//     · 取消: 运行 cancel → agent.cancel({kind:'user'}) + handle.dispose()
//     · 流式进度: agent-progress 事件（turn 序号 / assistant 文本预览）
//   - 工作区 SQLite 运行历史 + 刷新恢复（SSE 快照）
//   - webhook 触发（/wf1/api/hooks/* prefix 路由）+ 定时触发（wf1:schedule.* 定时键）
//   - 节点工作区 data/workspaces/<节点名>/；产物下载 /wf1/api/artifact
//
// HTTP 全部挂 ctx.webServer（/wf1 前缀，避开 dsh 自己的 /api）。

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, cpSync, unlinkSync, renameSync, realpathSync, rmSync, openSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { join, dirname, extname, isAbsolute, relative, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { renderTemplate, validateTemplate } from './template.js';
import { describeNodeOutput, normalizeExecutionResult, RUN_SCHEMA_VERSION } from './output-contract.js';
import { resolveInside, safeFileId, safeFilename } from './safe-path.js';
import { decodeTailWindow } from './doc-tail.js';
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
import { graphFingerprint, resumeDiff, runMatchesGraphScope, selectScopedRun, summarizeNodeStates, summarizeOutputs, summarizeStructuredOutputs } from './run-scope.js';
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
import { createFeishuNotificationChannel } from './notification-feishu.js';
import { collectInstallReport, compareSemver, executePlan, planUpgrade, PACKAGE as UPGRADE_PACKAGE } from './system-upgrade.js';
import { NotificationChannelRegistry, WorkflowNotificationManager } from './notifications.js';
import { listFeishuCreds, addFeishuCred, removeFeishuCred, setDefaultFeishuCred, getFeishuCredOrEnv } from './credentials.js';
import { Orchestrator, lintGraph, getKind } from './engine.js';
import { createWorkflowExportManifest, importWorkflowDocument, normalizeWorkflowDocument } from './workflow-document.js';
import { saveArtifactsToWorkspace } from './artifact-save.js';
import { buildRevisionGraph, extractRevision, revisionAgentNodeId } from './artifact-feedback.js';
import { createStoragePaths } from './storage-paths.js';
import { WorkflowSqliteStore } from './sqlite-store.js';
import {
  canvasAssistantPersona, checkPatchResult, summarizeGraphForAI, validateGraphOps,
} from './assistant.js';
import { ensureWorkflowSkill } from './skill-seed.js';
import {
  assertNonSensitiveVariableDefinitions, assertSafeContextObject, GlobalVariableStore, VariableStoreError,
  variableDefinitionsToValues,
} from './variable-store.js';
import {
  createScheduler, detectScheduleMisfire, hasLiveRunForWorkflow, isValidCron,
  MISFIRE_POLICIES, normalizeScheduleMeta, normalizeTimezoneInput,
  persistableScheduleMeta, upcomingFireTimes,
} from './schedule.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 测试可用 WF1_LEGACY_DATA_DIR 指向隔离目录，避免把开发机真实 data/ 当 legacy 导入。
// 惰性读取：测试在 import 之后才设 env，模块级常量会过早固化成真实路径。
const legacyDataDir = () => (process.env.WF1_LEGACY_DATA_DIR
  ? resolve(process.env.WF1_LEGACY_DATA_DIR)
  : join(__dirname, '..', 'data'));
const RUNS_KEEP = 100; // 运行历史保留条数（按开始时间新→旧）
const REQUEST_BODY_LIMIT = 8_000_000;
const MAX_MANUAL_REVISION_CONTENT = 400 * 1024; // 手工编辑正文上限（字符），防超大写入库表
const TERMINAL_NODE_STATUSES = new Set(['success', 'error', 'canceled', 'skipped']);
let runIdSeq = 0;
let ctxRef = null;

class RequestBodyError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
  ensureWorkflowSkill({ log: (msg) => ctx.logger?.info?.(`[orchestrator] ${msg}`) }); // / 菜单入口：workflow-one 技能种子
  const stores = new Map();
  const publicHooks = new Map();
  const notificationChannels = new NotificationChannelRegistry();
  notificationChannels.register(createFeishuNotificationChannel({ getCredential: getFeishuCredOrEnv }));
  const notifications = new WorkflowNotificationManager({ channels: notificationChannels, logger: ctx.logger });
  const lintWorkflowGraph = (graph) => lintGraph(graph, { notificationChannels });
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
    cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  };
  const initializeStore = (workspaceRoot) => {
    const paths = createStoragePaths({ workspaceRoot, legacyRoot: legacyDataDir() });
    const marker = join(paths.state, 'legacy-import.json');
    const workflowTombstoneDir = join(paths.state, 'tombstones', 'workflows');
    for (const dir of [paths.root, paths.state, paths.workflows, paths.attachments, paths.runs, paths.runtime, workflowTombstoneDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (!legacyClaimedWorkspace && !existsSync(marker)) {
      // 用户级 plugin-data 优先于包内种子；已有工作区文件两者都不得覆盖。
      for (const legacy of [paths.pluginDataLegacy, paths.packageLegacy]) {
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
      workflowTombstoneDir,
      database: new WorkflowSqliteStore({
        databaseFile: paths.database,
        workflowsDir: paths.workflows,
        runsDir: paths.runs,
        workflowTombstoneDir,
        migrationErrorFile: join(paths.state, 'sqlite-migration-errors.json'),
        logger: ctx.logger,
      }),
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
  const globalVariableStore = new Proxy({}, {
    get(_target, key) {
      const store = currentStore().globalVariableStore;
      const value = store[key];
      return typeof value === 'function' ? value.bind(store) : value;
    },
  });
  const currentPaths = () => currentStore().paths;
  const currentDatabase = () => currentStore().database;
  const currentHooks = () => currentStore().hooks;
  const currentSchedulers = () => currentStore().schedulers;
  const currentSchedulerMeta = () => currentStore().schedulerMeta;
  ctx.effect?.(() => () => {
    // 先摘调度定时器（链式 setTimeout 不随插件停机自灭），再关 sqlite
    for (const store of stores.values()) {
      for (const scheduler of store.schedulers.values()) {
        try { scheduler.stop(); } catch { /* 单个失败不阻塞清理 */ }
      }
      store.schedulers.clear();
    }
    for (const store of stores.values()) store.database.close();
    stores.clear();
  }, 'workflow-one sqlite stores');
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
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let failed = false;
    req.on('data', (value) => {
      if (failed) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > REQUEST_BODY_LIMIT) {
        failed = true;
        reject(new RequestBodyError('请求体过大', 413, 'request-body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => {
      if (failed) return;
      failed = true;
      reject(error);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
        resolve(JSON.parse(text || '{}'));
      } catch {
        reject(new RequestBodyError('请求体不是有效的 UTF-8 JSON', 400, 'invalid-request-body'));
      }
    });
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
  const internalRouteError = (res, error) => {
    if (res.writableEnded) return undefined;
    if (error instanceof RequestBodyError) {
      return json(res, Number(error.status) || 500, {
        error: String(error.message || error),
        code: error.code || 'request-failed',
      });
    }
    ctx.logger?.error?.(`Workflow One 请求失败：${error.stack || error.message || error}`);
    return json(res, 500, { error: 'Workflow One 内部错误', code: 'internal-error' });
  };
  const register = (route, { scoped = true } = {}) => {
    const handler = route.handler;
    ctx.webServer.register({
      ...route,
      handler(req, res) {
        if (!scoped) return handler(req, res);
        let store;
        try { store = requestStore(req); }
        catch (error) {
          return json(res, 409, { error: String(error.message || error), code: 'workspace-session-required' });
        }
        try {
          const result = workspaceContext.run(store, () => {
            ensureTriggers();
            return handler(req, res);
          });
          return result && typeof result.catch === 'function'
            ? result.catch((error) => internalRouteError(res, error))
            : result;
        } catch (error) {
          return internalRouteError(res, error);
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

  // 按已保存工作流启动运行（/run API 的 workflowId 分支与 canvas_run_workflow / workflow_run 工具同源）：
  // 组装全局/工作流变量、校验 runInputs，统一走 startRun。
  const startWorkflowRun = (wf, { triggerInput = '', runInputs = {}, canvasId = null, source = 'manual' } = {}) => {
    const lint = lintWorkflowGraph(wf.graph);
    if (!lint.ok) {
      const err = lint.issues.find((i) => i.level === 'error')?.message || '图存在错误';
      return { ok: false, error: `图有错误不能运行：${err}` };
    }
    let globals; try { globals = globalContext(); } catch (error) { return { ok: false, error: String(error.message || error) }; }
    let inputs; try { inputs = assertSafeContextObject(runInputs, 'runInputs'); } catch (error) { return { ok: false, error: String(error.message || error) }; }
    const { runId } = startRun(wf.graph, {
      triggerInput, workflowName: wf.name, workflowId: wf.id,
      canvasId,
      globalVariables: globals.globalVariables,
      workflowVariables: variableDefinitionsToValues(wf.variables),
      runInputs: inputs,
      source,
    });
    return { ok: true, runId };
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
        if (cv.workflowId) {
          const wf = readWf(cv.workflowId);
          if (!wf) return '画布绑定的工作流已不存在（可能已删除），请重新打开或保存。';
          const r = startWorkflowRun(wf, { triggerInput: args.triggerInput ?? '', canvasId: exec.canvasId, source: 'assistant' });
          if (!r.ok) return r.error;
          return JSON.stringify({ started: true, runId: r.runId });
        }
        const lint = lintWorkflowGraph(cv.graph);
        if (!lint.ok) return `图有错误不能运行：\n${lint.issues.filter((x) => x.level === 'error').map((x) => x.message).join('\n')}`;
        const globals = (() => { try { return globalContext(); } catch { return { globalVariables: {} }; } })();
        const { runId } = startRun(cv.graph, {
          triggerInput: args.triggerInput ?? '', workflowName: null, workflowId: null,
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
        const hist = readRun(args.runId);
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
          return await workspaceContext.run(sessionStore(String(sid)), () => def.execute(args, { ...exec, canvasId }));
        } catch (error) {
          return `工作区不可用：${String(error.message || error)}`;
        }
      },
    });
    try { ctx.tools.register(wrapped); } catch (e) { ctx.logger?.warn?.(`assistant tool ${name} 注册失败: ${e.message}`); }
  }

  // ---- workflow_* 工具家族：按工作流 ID/name 操作，不依赖画布绑定 ----
  // 与 canvas_*（锚定当前绑定画布/草稿）分工：workflow_* 管库（查询/运行/终止/改/删/切换），
  // 任意官方聊天会话可用；执行按该会话自己的 cwd 定工作区（sessionStore），解析失败不回退默认工作区。
  // 注意：节点 agent 的工具白名单不含这些名字，不会出现节点递归发起工作流运行。
  // 画布同步：改库后若目标工作流正被某画布打开，同步服务端 cv 并广播 assistant-patch（复用版本跳变兜底）。
  const syncCanvasForWorkflow = (workflowId, nextGraph, patch) => {
    for (const [key, cv] of canvases) {
      if (cv.workflowId !== workflowId || key.split('\0')[0] !== currentStore().workspaceRoot) continue;
      cv.graph = nextGraph;
      cv.version += 1;
      broadcast('assistant-patch', {
        canvasId: key.split('\0')[1], version: cv.version,
        patch: patch || [], graph: nextGraph, workflowId,
      });
    }
  };
  const resolveWorkflowArg = (args) => {
    if (args.workflowId) {
      const wf = readWf(String(args.workflowId));
      return wf ? { wf } : { error: `工作流 "${args.workflowId}" 不存在（可用 workflow_list 查看）` };
    }
    if (args.name) {
      const hit = currentDatabase().listWorkflows().find((w) => w.name === args.name);
      if (!hit) return { error: `未找到名为「${args.name}」的工作流（可用 workflow_list 查看）` };
      return { wf: readWf(hit.id) };
    }
    return { error: '需要 workflowId 或 name 参数' };
  };
  const liveRunSummaries = () => runSummaries(100).filter((r) => r.live);

  const workflowTools = {
    workflow_list: {
      description: '列出当前工作区全部工作流（id/名称/节点数/更新时间/各自运行中数量）。用户问「有哪些工作流」「什么在跑」先用这个。',
      parameters: {},
      async execute() {
        const live = liveRunSummaries();
        const rows = currentDatabase().listWorkflows().map((w) => ({
          id: w.id, name: w.name, nodes: w.nodeCount, agents: w.agentCount,
          updatedAt: w.updatedAt, liveRuns: live.filter((r) => r.workflowId === w.id).length,
        }));
        if (!rows.length) return '工作区还没有已保存的工作流。';
        return JSON.stringify(rows, null, 2);
      },
    },
    workflow_get: {
      description: '读取单个工作流详情。默认返回省 token 的图概要 + 变量定义 + 输入 Schema（AI 据此构造 runInputs）；summary:false 返回完整图 JSON。',
      parameters: {
        workflowId: { type: 'string', description: '工作流 id（与 name 二选一）' },
        name: { type: 'string', description: '工作流名称（与 workflowId 二选一）' },
        summary: { type: 'boolean', description: '默认 true；false 返回完整图' },
      },
      async execute(args) {
        const r = resolveWorkflowArg(args);
        if (r.error) return r.error;
        const { wf } = r;
        const base = {
          id: wf.id, name: wf.name, updatedAt: wf.updatedAt,
          variables: wf.variables, inputSchema: wf.inputSchema,
        };
        if (args.summary === false) return JSON.stringify({ ...base, graph: wf.graph }, null, 2);
        return JSON.stringify({ ...base, graph: summarizeGraphForAI(wf.graph) }, null, 2);
      },
    },
    workflow_run: {
      description: '运行一个已保存的工作流（异步：返回 runId，用 workflow_run_status 或 workflow_runs 轮询）。支持触发输入与结构化运行参数。',
      parameters: {
        workflowId: { type: 'string', description: '工作流 id（与 name 二选一）' },
        name: { type: 'string', description: '工作流名称（与 workflowId 二选一）' },
        triggerInput: { type: 'string', description: '触发输入文本（输入节点模板的 $trigger）' },
        runInputs: { type: 'json', description: '结构化运行参数对象，键需匹配工作流 inputSchema 字段' },
      },
      async execute(args, exec) {
        const r = resolveWorkflowArg(args);
        if (r.error) return r.error;
        const cv = exec.canvasId ? canvasOf(exec.canvasId) : null;
        const canvasId = cv && cv.workflowId === r.wf.id ? exec.canvasId : null;
        const started = startWorkflowRun(r.wf, {
          triggerInput: args.triggerInput ?? '',
          runInputs: args.runInputs || {},
          canvasId,
          source: 'assistant',
        });
        if (!started.ok) return started.error;
        return JSON.stringify({ started: true, runId: started.runId });
      },
    },
    workflow_runs: {
      description: '查询运行列表（默认运行中优先 + 最近 20 条；可按工作流过滤）。回答「现在在跑什么、什么状态」用它。',
      parameters: {
        workflowId: { type: 'string', description: '按工作流过滤（可选）' },
        limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
        onlyLive: { type: 'boolean', description: '只看运行中的' },
      },
      async execute(args) {
        const limit = Math.min(Number(args.limit) || 20, 100);
        let rows = runSummaries(limit);
        if (args.onlyLive) rows = rows.filter((x) => x.live);
        if (args.workflowId) rows = rows.filter((x) => x.workflowId === args.workflowId);
        if (!rows.length) return args.onlyLive ? '当前没有运行中的工作流。' : '暂无运行记录。';
        const order = (a, b) => (Number(b.live) - Number(a.live)) || String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
        return JSON.stringify(rows.sort(order).map((x) => ({
          runId: x.runId, status: x.status, workflowName: x.workflowName, workflowId: x.workflowId,
          source: x.source, startedAt: x.startedAt, durationMs: x.durationMs,
          live: x.live, progress: `${x.progress.done}/${x.progress.total}`,
        })), null, 2);
      },
    },
    workflow_run_status: {
      description: '查询一次运行的详情（节点状态/错误/输出摘要）。运行完成或失败后返回终态。',
      parameters: { runId: { type: 'string', required: true, description: '运行 id（workflow_run / workflow_runs 获得）' } },
      async execute(args) {
        const entry = orch.runs.get(args.runId);
        if (entry?.run?.workspaceRoot === currentStore().workspaceRoot) {
          const run = entry.run;
          return JSON.stringify({
            status: run.status || 'running',
            workflowName: run.workflowName, source: run.source, startedAt: run.startedAt,
            durationMs: run.durationMs ?? null,
            nodeStates: summarizeNodeStates(run.nodeStates),
            outputs: summarizeOutputs(run.outputs, run.structuredOutputs),
          });
        }
        const hist = readRun(args.runId);
        if (!hist) return `运行 "${args.runId}" 不存在`;
        return JSON.stringify({
          status: hist.status,
          workflowName: hist.workflowName, source: hist.source, startedAt: hist.startedAt,
          durationMs: hist.durationMs ?? null,
          nodeStates: summarizeNodeStates(hist.nodeStates),
          outputs: summarizeOutputs(hist.outputs, hist.structuredOutputs),
        });
      },
    },
    workflow_run_cancel: {
      description: '终止/取消运行。传 runId 取消单个；传 workflowId（或 all:true）取消该工作流/全部运行中的 run。已结束的运行不受影响。',
      parameters: {
        runId: { type: 'string', description: '要取消的运行 id（与 workflowId/all 二选一）' },
        workflowId: { type: 'string', description: '取消该工作流全部运行中的 run' },
        all: { type: 'boolean', description: 'true 取消全部运行中的 run' },
      },
      async execute(args) {
        const targets = args.runId
          ? [String(args.runId)]
          : liveRunSummaries()
            .filter((x) => (args.all ? true : x.workflowId === args.workflowId))
            .map((x) => x.runId);
        if (!targets.length) return '没有匹配的运行中 run。';
        const results = [];
        for (const id of targets) {
          const entry = orch.runs.get(id);
          const ok = entry?.run?.workspaceRoot === currentStore().workspaceRoot ? orch.cancel(id, '助手取消') : false;
          results.push({ runId: id, canceled: ok });
        }
        return JSON.stringify({ canceled: results.filter((x) => x.canceled).length, results });
      },
    },
    workflow_patch: {
      description: '修改已保存工作流的图（批量 ops 原子生效，语义与 canvas_graph_patch 完全一致）。若目标工作流正被画布打开，画布实时同步。可选 name 字段改名。',
      parameters: {
        workflowId: { type: 'string', required: true, description: '目标工作流 id' },
        ops: {
          type: 'array', required: true,
          items: {
            type: 'object', additionalProperties: true,
            properties: {
              op: { type: 'string' }, type: { type: 'string' }, label: { type: 'string' },
              data: { type: 'json' }, after: { type: 'string' }, connect: { type: 'boolean' },
              branch: { type: 'string' }, id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
              position: { type: 'json' },
            },
          },
        },
        name: { type: 'string', description: '新名称（可选，不改名不传）' },
      },
      async execute(args) {
        const wf = readWf(String(args.workflowId));
        if (!wf) return `工作流 "${args.workflowId}" 不存在（可用 workflow_list 查看）`;
        const r = validateGraphOps(wf.graph, args.ops);
        if (!r.ok) return `整批拒绝（未做任何修改）：\n${r.errors.join('\n')}\n请修正后重发整批 ops。`;
        const saved = writeWf({
          ...wf,
          ...(args.name ? { name: String(args.name).slice(0, 60) } : {}),
          graph: r.graph,
          updatedAt: new Date().toISOString(),
        });
        syncCanvasForWorkflow(saved.id, r.graph, r.patch);
        const check = checkPatchResult(r.graph);
        return `已应用 ${r.patch.length} 个操作到「${saved.name}」。\nlint: ${check.lintOk ? '通过' : '有告警'}\n${check.issues.slice(0, 20).join('\n')}`;
      },
    },
    workflow_create: {
      description: '新建工作流。name 必填；可选 graph（{nodes,edges} 初始图）或 copyFrom（复制既有工作流 id）。草稿请让用户在画布保存，这里只建已命名工作流。',
      parameters: {
        name: { type: 'string', required: true, description: '工作流名称' },
        graph: { type: 'json', description: '初始图 {nodes, edges}（可选）' },
        copyFrom: { type: 'string', description: '复制来源工作流 id（可选）' },
      },
      async execute(args) {
        const name = String(args.name || '').trim().slice(0, 60);
        if (!name) return 'name 不能为空';
        let graph = { nodes: [], edges: [] };
        if (args.copyFrom) {
          const src = readWf(String(args.copyFrom));
          if (!src) return `复制来源 "${args.copyFrom}" 不存在`;
          graph = src.graph;
        } else if (args.graph && Array.isArray(args.graph.nodes)) {
          graph = args.graph;
        } else if (args.graph) {
          return 'graph 必须是 {nodes, edges} 对象';
        }
        // 与 POST /workflows 同语义：不做 lint（空画布起步合法），运行时会再校验
        const id = `wf_${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
        const saved = writeWf(normalizeWorkflowDocument({ id, name, graph, updatedAt: new Date().toISOString() }));
        return JSON.stringify({ created: true, id: saved.id, name: saved.name, nodes: saved.graph?.nodes?.length || 0 });
      },
    },
    workflow_delete: {
      description: '删除工作流（不可恢复）。必须传 confirm:true 才执行。有运行中 run、定时任务或 webhook 关联时拒绝并列出关联，引导先清理。',
      parameters: {
        workflowId: { type: 'string', required: true, description: '目标工作流 id' },
        confirm: { type: 'boolean', description: '确认真删传 true' },
      },
      async execute(args) {
        const wf = readWf(String(args.workflowId));
        if (!wf) return `工作流 "${args.workflowId}" 不存在`;
        if (args.confirm !== true) return `确认删除「${wf.name}」？此操作不可恢复。确认请带 confirm:true 重新调用。`;
        const live = liveRunSummaries().filter((x) => x.workflowId === wf.id);
        if (live.length) return `有 ${live.length} 个运行中的 run（${live.map((x) => x.runId).join(', ')}），请先等待完成或用 workflow_run_cancel 取消。`;
        const hooks = [...currentHooks().values()].filter((h) => h.workflowId === wf.id);
        if (hooks.length) return `有 ${hooks.length} 个 webhook 关联（${hooks.map((h) => h.id).join(', ')}），请先在画布删除 webhook。`;
        const schedules = [...currentSchedulerMeta().values()].filter((m) => m.workflowId === wf.id);
        if (schedules.length) return `有 ${schedules.length} 个定时任务关联（${schedules.map((m) => m.key).join(', ')}），请先在定时任务中心删除。`;
        // 画布若正打开该工作流：退回草稿态（前端收到事件后回「未保存」空画布）
        for (const [key, cv] of canvases) {
          if (cv.workflowId !== wf.id || key.split('\0')[0] !== currentStore().workspaceRoot) continue;
          cv.workflowId = null;
          cv.graph = { nodes: [], edges: [] };
          cv.version += 1;
          broadcast('assistant-patch', {
            canvasId: key.split('\0')[1], version: cv.version,
            patch: [], graph: cv.graph, workflowId: null,
          });
        }
        deleteWf(wf.id);
        return JSON.stringify({ deleted: true, id: wf.id, name: wf.name });
      },
    },
    workflow_open: {
      description: '把绑定的画布切换到指定工作流（用户屏幕上打开它）。仅在绑定画布的会话里可用；画布有未保存修改时用户会收到确认弹窗。',
      parameters: {
        workflowId: { type: 'string', description: '目标工作流 id（与 name 二选一）' },
        name: { type: 'string', description: '目标工作流名称（与 workflowId 二选一）' },
      },
      async execute(args, exec) {
        const r = resolveWorkflowArg(args);
        if (r.error) return r.error;
        const cv = canvasOf(exec.canvasId);
        cv.workflowId = r.wf.id;
        // 浅拷贝防别名：库里的图对象与画布态解耦，后续任一侧替换互不影响
        cv.graph = { nodes: r.wf.graph.nodes.map((n) => ({ ...n, data: { ...n.data } })), edges: r.wf.graph.edges.map((e) => ({ ...e })) };
        cv.version += 1;
        broadcast('assistant-open-workflow', {
          canvasId: exec.canvasId, workflowId: r.wf.id,
        });
        return `画布已切换到「${r.wf.name}」（若画布有未保存修改，用户确认后生效）。`;
      },
    },
  };

  // workflow_* 注册：与 canvas_* 相同的 defineTool 包装（spec→Schema 编译 + 工作区绑定运行），
  // 但不做画布绑定门槛——按会话自己的 cwd 定工作区；workflow_open 例外，由 execute 内自行处理。
  const registerAssistantTools = (tools, { requireCanvas = true } = {}) => {
    for (const [name, def] of Object.entries(tools)) {
      const needCanvas = requireCanvas && name !== 'workflow_open' ? true : (name === 'workflow_open');
      const wrapped = defineTool({
        name,
        description: def.description,
        parameters: def.parameters,
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute(args, exec) {
          const sid = exec?.agent?.session?.id || exec?.sessionId || exec?.session?.id;
          const canvasId = resolveCanvasId(exec);
          if (needCanvas && (!sid || !canvasId)) {
            return '此工具只在绑定了工作流画布的会话里可用（在画布「工作流」标签页发起对话）。';
          }
          if (!sid) return '当前会话无法定位工作区，请在聊天绑定工作目录后重试。';
          try {
            return await workspaceContext.run(sessionStore(String(sid)), () => def.execute(args, { ...exec, canvasId }));
          } catch (error) {
            return `工作区不可用：${String(error.message || error)}`;
          }
        },
      });
      try { ctx.tools.register(wrapped); } catch (e) { ctx.logger?.warn?.(`assistant tool ${name} 注册失败: ${e.message}`); }
    }
  };
  registerAssistantTools(workflowTools, { requireCanvas: false });


  // ---- 运行历史（按工作区持久化 + 内存缓存）----
  const pendingRunIds = new Set();
  const liveTracesByRun = new Map(); // 运行中节点的实时轨迹：runId → (nodeId → trace)；节点完成后落盘、运行结束释放
  const recoverInterruptedRun = (run, interruptedAt) => {
    const startedAtMs = run.startedAt ? new Date(run.startedAt).getTime() : NaN;
    const states = (run.graph?.nodes || []).map((node) => run.nodeStates?.[node.id]);
    const fullyTerminal = states.length > 0
      && states.every((state) => TERMINAL_NODE_STATUSES.has(state?.status));
    const recoveredStatus = fullyTerminal
      ? states.some((state) => state?.status === 'error') ? 'error'
        : states.some((state) => state?.status === 'canceled') ? 'canceled'
          : 'success'
      : 'interrupted';
    return normalizeRunDocument({
      ...run,
      status: recoveredStatus,
      interruptedAt,
      finishedAt: interruptedAt,
      durationMs: Number.isFinite(startedAtMs) ? Math.max(0, new Date(interruptedAt).getTime() - startedAtMs) : run.durationMs,
      ...(recoveredStatus === 'interrupted' ? { error: run.error || '运行进程异常终止' } : {}),
    });
  };
  // 断点续跑的可复用节点不重新执行，其工作区文件仍留在祖先运行的 runtime 目录；
  // 先物化拷贝到本次运行目录，快照与 /artifact 路由按 runId 定位才能命中。
  // 拷贝失败只记 issue 不阻塞持久化（祖先目录被清理时产物缺失属既成事实）。
  const materializeResumedWorkspaces = (run) => {
    if (!run.resumedFrom || !run.nodeStates) return;
    const scope = { workflowId: run.workflowId || 'draft', runId: run.runId };
    for (const [nodeId, state] of Object.entries(run.nodeStates)) {
      if (state?.status !== 'success' || !Array.isArray(state.artifacts) || !state.artifacts.length) continue;
      const sourceRoot = STORAGE.workspaceForNode({ workflowId: run.workflowId || 'draft', runId: run.resumedFrom, nodeId });
      const targetRoot = STORAGE.workspaceForNode({ ...scope, nodeId });
      for (const relativePath of state.artifacts) {
        if (!relativePath || String(relativePath).endsWith('/')) continue;
        try {
          const source = resolveInside(sourceRoot, relativePath);
          const target = resolveInside(targetRoot, relativePath);
          if (!source || !target) continue;
          if (existsSync(target)) continue;
          if (!existsSync(source) || !statSync(source).isFile()) continue;
          const realSource = realpathSync(source);
          if (resolveInside(realpathSync(sourceRoot), realSource) !== realSource) continue;
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyFileSync(realSource, target, fsConstants.COPYFILE_EXCL);
        } catch (error) {
          ctx.logger?.warn?.(`[wf1] 续跑产物物化失败（${run.runId}/${nodeId}/${relativePath}）：${error.message}`);
        }
      }
    }
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
      materializeResumedWorkspaces(base);
      const snapshot = snapshotRunArtifacts(base, {
        workspaceForNode: ({ nodeId }) => STORAGE.workspaceForNode({ ...scope, nodeId }),
        artifactRunDir: STORAGE.artifactRunDir(scope),
      });
      const document = normalizeRunDocument({
        ...base,
        artifactIndex: snapshot.artifacts,
        issues: [...(Array.isArray(base.issues) ? base.issues : []), ...snapshot.issues],
      });
      currentDatabase().putRun(document);
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
  // 保留策略：SQLite 提交删除后，再清理对应运行产物目录。
  // 改写 run（source='revision'）不受该窗口挤压：仍在版本链里的修订引用其产物正文。
  const pruneRuns = () => {
    try {
      for (const run of currentDatabase().pruneRuns(RUNS_KEEP, { keepRevisionRuns: currentDatabase().revisionRunIds() })) {
        try {
          rmSync(STORAGE.runRoot({ workflowId: run.workflowId || 'draft', runId: run.runId }), { recursive: true, force: true });
        } catch (error) {
          ctx.logger?.warn?.(`运行 ${run.runId} 已过期，但 runtime 清理失败：${error.message}`);
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`运行记录清理失败：${error.message}`);
    }
  };
  let orch;
  const readRun = (runId) => {
    const live = orch?.runs.get(runId);
    if (live?.run.workspaceRoot === currentStore().workspaceRoot) {
      const { workspaceRoot: _workspaceRoot, ...run } = live.run;
      const graph = {
        nodes: live.s.graph.nodes.map((node) => ({ id: node.id, type: node.type, position: node.position, data: node.data })),
        edges: live.s.graph.edges,
      };
      return normalizeRunDocument({ ...run, graph });
    }
    const record = currentDatabase().getRunRecord(runId);
    if (!record) return null;
    let run = record.document;
    if (run.status === 'running' && !pendingRunIds.has(runId)) {
      run = recoverInterruptedRun(run, record.updatedAt || new Date().toISOString());
      writeRun(run);
    }
    return run;
  };
  const writeRun = (run) => {
    const document = normalizeRunDocument(run);
    return currentDatabase().putRun(document);
  };
  const recentRuns = (limit = 50, workflowId) => currentDatabase().listRuns(limit, workflowId)
    // 改写 run（source='revision'）归组到被修产物的版本链下展示，不作为独立运行条目
    .filter((run) => run.source !== 'revision')
    .map((run) => (
      run.status === 'running' && !pendingRunIds.has(run.runId) ? (readRun(run.runId) || run) : run
    ));
  const checkpointRun = (runId) => {
    const live = orch?.runs.get(runId);
    if (!live || live.run.workspaceRoot !== currentStore().workspaceRoot) return;
    const { workspaceRoot: _workspaceRoot, ...run } = live.run;
    const graph = {
      nodes: live.s.graph.nodes.map((node) => ({ id: node.id, type: node.type, position: node.position, data: node.data })),
      edges: live.s.graph.edges,
    };
    writeRun({ ...run, graph, graphFingerprint: graphFingerprint(graph), checkpointedAt: new Date().toISOString() });
  };
  const onOrchestratorEvent = (event, payload) => {
    if (event === 'node-status' && TERMINAL_NODE_STATUSES.has(payload?.status)) {
      notifications.onNodeStatus(payload, orch?.runs.get(payload.runId)?.run);
      liveTracesByRun.get(payload.runId)?.delete(payload.nodeId); // 完成轨迹已随 run 落盘，实时版即时释放
      try { checkpointRun(payload.runId); }
      catch (error) { ctx.logger?.error?.(`dsh-ccpg 运行检查点写入失败（${payload?.runId || 'unknown'}）：${error.message}`); }
    } else if (event === 'run-end') {
      liveTracesByRun.delete(payload?.runId);
    }
    broadcast(event, payload);
  };

  // ---- 工作流库 ----
  const wfTombstone = (id) => join(currentStore().workflowTombstoneDir, safeFileId(id, 'invalid'));
  const readWf = (id) => currentDatabase().getWorkflow(id);
  const writeWf = (wf) => {
    const document = currentDatabase().putWorkflow(wf);
    try { unlinkSync(wfTombstone(document.id)); } catch { /* 未删除过 */ }
    return document;
  };
  const deleteWf = (id) => {
    if (!currentDatabase().deleteWorkflow(id)) return false;
    atomicWrite(wfTombstone(id), new Date().toISOString());
    return true;
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
    const status = error instanceof VariableStoreError ? error.status : Number(error?.status) || 400;
    json(res, status, { ok: false, error: String(error.message || error), code: error.code || 'invalid-request' });
  };

  // ---- 引擎 ----
  orch = new Orchestrator(ctx, { onEvent: onOrchestratorEvent, renderTemplate });
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
    globalVariables = {}, workflowVariables = {}, runInputs = {}, runId: providedRunId, replayOf, resume, revises,
  } = {}) => {
    const store = currentStore();
    const runId = providedRunId || `run_${Date.now().toString(36)}_${++runIdSeq}`;
    notifications.startRun({ runId, graph, workflowName, workflowId });
    pendingRunIds.add(runId);
    // 启动即落盘运行中快照：成果面板在 run-start 后立刻拉 /run-results，
    // 只等最终 persistRun 的话长运行期间 readRun 一直 404（前端退避耗尽即报「运行记录不存在」）。
    try {
      writeRun(normalizeRunDocument({
        runId, status: 'running', startedAt: new Date().toISOString(),
        triggerInput: triggerInput ?? '', workflowName: workflowName || null, workflowId: workflowId || null,
        canvasId: canvasId || null, source: source || null, replayOf: replayOf || null,
        revises: revises || null,
        ...(resume ? { resumedFrom: resume.runId || null } : {}),
        nodeStates: {}, outputs: {}, structuredOutputs: {}, issues: [],
        graph: graph ? { nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })), edges: graph.edges } : undefined,
        graphFingerprint: graph ? graphFingerprint(graph) : null,
      }));
    } catch { /* 快照写失败不阻塞运行；最终 persistRun 仍会落盘 */ }
    const promise = workspaceContext.run(store, () => Promise.resolve().then(() => orch.run(graph, {
      triggerInput, workflowName, workflowId, canvasId, source, runId, revises,
      workspaceRoot: store.workspaceRoot,
      globalVariables, workflowVariables, runInputs,
      resume,
    })).then(async (run) => {
      if (replayOf) run.replayOf = replayOf;
      if (revises) run.revises = revises;
      try { await notifications.complete(runId, run); }
      catch (error) {
        notifications.discard(runId);
        ctx.logger?.warn?.(`[notify] 运行通知收尾失败（${runId}）：${error.message}`);
      }
      persistRun(run, graph, workflowName, workflowId);
      return run;
    })).catch((error) => {
      notifications.discard(runId);
      ctx.logger?.error?.(`dsh-ccpg 运行失败（${runId}）：${error.message}`);
      return null;
    }).finally(() => pendingRunIds.delete(runId));
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
    const inputFiles = Array.isArray(d.inputFiles) ? d.inputFiles.map((file) => safeFilename(file)).filter(Boolean) : [];
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
    // 节点级思考级别：仅当与全局选择同渠道同模型时全局档位才继承；节点显式配置优先。
    // 档位经 installModelSelection 注入 agent/request waterfall（AgentOptions 本身不收 effort）。
    const reasoningEffort = d.reasoningEffort || (provider === sel.provider && model === sel.model ? sel.reasoningEffort : undefined);
    // 模型单请求超时（step 粒度）：一次模型调用（含其工具执行前的新型请求）超过即视为卡死，
    // 与节点总超时（timeoutSec，整个节点生命周期）是两个独立旋钮。step/end 重置计时。
    const MODEL_TIMEOUT_MS = 300 * 1000;
    const modelTimeoutMs = Number(d.modelTimeoutSec) > 0 ? Number(d.modelTimeoutSec) * 1000 : MODEL_TIMEOUT_MS;

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
          // 思考级别：selection 注入后每次模型请求经 waterfall 套用 effort；
          // resolveCallConfig 校验档位，不支持时降级为默认行为（与官方 selectModel 同语义）
          if (reasoningEffort) {
            try {
              const resolved = await ctx.llm.resolveCallConfig({ provider, model, reasoningEffort });
              installModelSelection(agentCtx, {
                current: { provider, model, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) },
                assembled: undefined,
              });
            } catch { /* 档位校验失败：跟随 provider 默认行为 */ }
          }
        },
      });
      const agent = handle.agent;
      await agent.whenIdle();
      const firstSeq = agent.session.seq;

      // 轮数监控：2s 轮询 session events —— 推流式进度；turn 数超限 cancel；turn/end 即退出
      let watchDone;
      const watchReady = new Promise((r) => { watchDone = r; });
      const watchState = { stop: false, timer: null, lastStepStartSeq: 0, stepStartedAt: 0, modelTimeout: null };
      // 实时轨迹：watchTick 逐事件扫描时同步折叠进 liveTracesByRun（详情弹窗运行中即可读）；
      // 水位 lastSeqRef 只处理新到事件；完成后仍走 buildTrace 落盘路径，节点终态即释放。
      let liveTrace = null;
      if (runId) {
        if (!liveTracesByRun.has(runId)) liveTracesByRun.set(runId, new Map());
        const liveTraces = liveTracesByRun.get(runId);
        if (!liveTraces.has(node.id)) {
          liveTraces.set(node.id, { model: `${provider}:${model}`, entries: [{ kind: 'input', text: userPrompt }] });
        }
        liveTrace = liveTraces.get(node.id);
      }
      const metaHint = { input: userPrompt, model: `${provider}:${model}` };
      const lastSeqRef = { value: firstSeq }; // 增量折叠水位：只处理新到事件
      const pendingByCallId = new Map(); // callId → entries 下标（配对跨轮询到达的 tool/call 与 tool/result）
      const scanEvents = () => {
        let turns = 0; let preview = ''; let turnEnded = false;
        let lastStepStartSeq = -1; let stepsSeen = 0;
        try {
          for (const ev of agent.session.events) {
            if (ev.seq < firstSeq) continue;
            if (ev.type === 'turn/start') turns += 1;
            if (ev.type === 'turn/end') turnEnded = true;
            // step/start = 一次模型调用开始；step/end = 该次调用结束（含工具执行）。
            // 记录最后一个 step/start 的时间与序号，供模型请求看门狗判断当前 step 是否卡死。
            if (ev.type === 'step/start') { lastStepStartSeq = ev.seq; stepsSeen += 1; }
            if (ev.type === 'assistant/message') {
              const joined = (ev.data.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
              if (joined) preview = joined;
            }
            if (liveTrace && ev.seq >= lastSeqRef.value) {
              foldTraceEvent(liveTrace, ev, pendingByCallId, metaHint);
              lastSeqRef.value = ev.seq + 1;
            }
          }
        } catch { /* session 已释放 */ }
        return { turns, preview, turnEnded, lastStepStartSeq, stepsSeen };
      };
      // 真·流式生成文稿：扫节点输出目录里最新的文本产物，附其尾部到 agent-progress，
      // 前端流卡直接渲染「正在写的文件」而非 agent 对话文本。只 tail 一个文件，
      // 2KB 尾部 + 轮询期读盘，开销可忽略；无文本产物时为 undefined（前端回退对话文本）
      const DOC_TAIL_BYTES = 2048;
      const scanDocTail = () => {
        try {
          const root = realpathSync(ws);
          let newest = null;
          for (const entry of readdirSync(root, { recursive: true })) {
            if (!/\.(md|markdown|txt|csv)$/i.test(String(entry))) continue;
            const full = resolveInside(root, entry);
            if (!full || !existsSync(full) || !statSync(full).isFile()) continue;
            const mtime = statSync(full).mtimeMs;
            if (!newest || mtime > newest.mtime) newest = { full, mtime };
          }
          if (!newest) return undefined;
          const stat = statSync(newest.full);
          const start = Math.max(0, stat.size - DOC_TAIL_BYTES);
          const fd = openSync(newest.full, 'r');
          try {
            const buf = Buffer.alloc(stat.size - start);
            readSync(fd, buf, 0, buf.length, start);
            // 起点按字节截断可能劈开多字节字符（中文必踩）：跳到字符边界再解码
            const tail = decodeTailWindow(buf, { trimStart: start > 0 });
            return { name: basename(String(newest.full)), size: stat.size, tail, growing: true };
          } finally { closeSync(fd); }
        } catch { return undefined; }
      };
      const watchTick = () => {
        if (watchState.stop) return;
        const { turns, preview, turnEnded, lastStepStartSeq, stepsSeen } = scanEvents();
        // 模型请求看门狗：step/start 后 modelTimeoutMs 内既无 step/end 也无新事件推进，
        // 视为该次模型调用卡死，cancel 本节点（区别于 timeoutSec 的节点总超时）。
        // 以事件序号驱动：step/end 或任何新事件落盘都会刷新 lastActivitySeq。
        if (!turnEnded && stepsSeen > 0) {
          const events = agent.session.events;
          const lastSeq = events.length ? events[events.length - 1].seq : firstSeq;
          if (lastStepStartSeq > 0 && lastSeq === lastStepStartSeq && !watchState.rechecking) {
            const stepAgeMs = Date.now() - (watchState.stepStartedAt || Date.now());
            if (stepAgeMs > modelTimeoutMs) {
              const err = new Error(`模型请求超时（单次超过 ${Math.round(modelTimeoutMs / 1000)}s 无响应）`);
              try { agent.cancel({ kind: 'user' }); } catch { /* noop */ }
              watchState.modelTimeout = err;
              return watchDone();
            }
          }
          if (lastStepStartSeq !== watchState.lastStepStartSeq) {
            watchState.lastStepStartSeq = lastStepStartSeq;
            watchState.stepStartedAt = Date.now();
          }
        }
        emit('agent-progress', {
          runId, nodeId: node.id, turns,
          // 实时输出流（文稿视图消费）：assistant 全文拼接，4KB 截断——多工具轮 agent 生成期
          // 前端可看文稿长大；带宽 = 4KB × 并发 agent ÷ 2s，量级安全
          preview: outputConfig.mode === 'structured' ? '' : preview.slice(0, 4096),
          // 真·流式：正在写的目标文稿尾部（2KB）。有则前端优先渲染它
          docTail: outputConfig.mode === 'structured' ? undefined : scanDocTail(),
          structured: outputConfig.mode === 'structured' || undefined,
          maxRounds: maxRounds || undefined,
        });
        if (maxRounds && turns > maxRounds) {
          try { agent.cancel({ kind: 'user' }); } catch { /* noop */ }
          return watchDone();
        }
        // 首个 turn/end 后延迟复查一次：多工具轮 agent 常在首轮文本后继续调用工具，
        // 立即退出会漏报后续轮次；复查仍无新 turn 才确认结束（单轮 agent 语义不变）
        if (turnEnded && !watchState.rechecking) {
          watchState.rechecking = true;
          watchState.timer = setTimeout(() => {
            if (watchState.stop) return;
            const next = scanEvents();
            if (next.turns > turns) { watchState.rechecking = false; watchTick(); return; }
            watchDone();
          }, 2500);
          return;
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
      // 模型请求看门狗触发：取消导致的「正常收尾」要改写为显式超时错误，
      // 让引擎的重试机制（非取消类失败）能接手
      if (watchState.modelTimeout) {
        reason = { kind: 'error', error: watchState.modelTimeout };
      }
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
    const selected = selectScopedRun({ runId, workflowId: body?.workflowId, graph: body?.graph }, { readRun, runs: recentRuns(50) });
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
    const selected = selectScopedRun({ runId: body?.runId, workflowId: body?.workflowId, graph: body?.graph }, { readRun, runs: recentRuns(50) });
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
    json(res, 200, lintWorkflowGraph(body.graph));
  } });

  // ---- 工作流库 ----
  register({ kind: 'exact', path: '/wf1/api/workflows', async handler(req, res) {
    if (req.method === 'GET') {
      return json(res, 200, { workflows: currentDatabase().listWorkflows() });
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
      deleteWf(id);
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
    const lint = lintWorkflowGraph(graph);
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
    const testTimeoutMs = Number(node.data?.timeoutSec) > 0 ? Number(node.data.timeoutSec) * 1000 : 500 * 1000;
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
  // ---- 运行列表共享整形（/runs API 与 workflow_runs 助手工具同源，不双写）----
  const runProgressOf = (r) => {
    const nodeIds = r.graph?.nodes?.filter((node) => node.type !== 'notify').map((node) => node.id)
      || Object.keys(r.nodeStates || {});
    const states = nodeIds.map((nodeId) => r.nodeStates?.[nodeId]);
    const total = nodeIds.length;
    const done = states.filter((st) => ['success', 'error', 'canceled', 'skipped'].includes(st?.status)).length;
    const succeeded = states.filter((st) => st?.status === 'success').length;
    return { done, total, succeeded };
  };
  const resumableRun = (r, isLive) => !isLive
    && ['error', 'canceled', 'interrupted'].includes(r.status)
    && Boolean(r.graph?.nodes?.length)
    && Object.values(r.nodeStates || {}).some((st) => st?.status === 'success')
    && r.graph.nodes.some((node) => !['success', 'skipped'].includes(r.nodeStates?.[node.id]?.status));
  const runSummaries = (limit = 20) => {
    const live = [...orch.runs.values()].filter((entry) => entry.run.workspaceRoot === currentStore().workspaceRoot).map((entry) => entry.run.runId);
    return recentRuns(limit).map((r) => {
      const { structuredOutputs, graph, ...summary } = r;
      const isLive = live.includes(r.runId);
      return {
        runId: summary.runId,
        status: summary.status,
        workflowId: summary.workflowId ?? null,
        workflowName: summary.workflowName ?? null,
        source: summary.source ?? null,
        startedAt: summary.startedAt ?? null,
        durationMs: summary.durationMs ?? null,
        live: isLive,
        progress: runProgressOf(r),
        resumable: resumableRun(r, isLive),
        outputs: summarizeOutputs(summary.outputs, structuredOutputs),
        nodeStates: summarizeNodeStates(summary.nodeStates),
        structuredOutputSummary: summarizeStructuredOutputs(structuredOutputs),
      };
    });
  };

  register({ kind: 'exact', path: '/wf1/api/runs', handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
    // 可选 workflowId 过滤：历史抽屉按画布打开的工作流隔离（与 workflow_runs 工具同语义）；
    // 缺省维持工作区级全量（草稿画布 / RunSwitcher 等既有调用不受影响）
    const workflowId = url.searchParams.get('workflowId') || undefined;
    const liveIds = new Set([...orch.runs.values()].filter((entry) => entry.run.workspaceRoot === currentStore().workspaceRoot).map((entry) => entry.run.runId));
    json(res, 200, {
      // 保持既有字段面（triggerInput/canvasId 等平铺），整形逻辑与 workflow_runs 工具同源
      runs: recentRuns(limit, workflowId).map((r) => {
        const { structuredOutputs, graph, ...summary } = r;
        const isLive = liveIds.has(r.runId);
        return {
          ...summary,
          outputs: summarizeOutputs(summary.outputs, structuredOutputs),
          nodeStates: summarizeNodeStates(summary.nodeStates),
          structuredOutputSummary: summarizeStructuredOutputs(structuredOutputs),
          live: isLive,
          progress: runProgressOf(r),
          resumable: resumableRun(r, isLive),
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
    const run = readRun(runId);
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
      // 运行中节点的实时轨迹（内存折叠，2s 刷新）；完成节点读落盘快照
      trace: state?.status === 'running' ? (liveTracesByRun.get(runId)?.get(nodeId) ?? null) : state?.trace ?? null,
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
    const lint = lintWorkflowGraph(graph);
    if (!lint.ok) return json(res, 400, { error: lint.issues.find((i) => i.level === 'error').message, lint });
    const { runId } = startRun(graph, {
      triggerInput, workflowName: prev.workflowName || null, workflowId: prev.workflowId || null,
      globalVariables: globals.globalVariables, workflowVariables, runInputs,
      source: 'replay', replayOf: prev.runId,
    });
    json(res, 200, { started: true, runId, replayOf: prev.runId });
  } });

  // 断点续跑：逐节点判定上次 success 输出能否复用（“自身 + 全部上游”子图未变即可复用）。
  // 改卡住的节点、改没跑过的下游、加删无关节点都不再拦截续跑；只有改到成功节点自身或其上游才让该节点重跑。
  register({ kind: 'exact', path: '/wf1/api/runs/resume', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const prev = readRun(body?.runId);
    if (!prev) return json(res, 404, { error: '运行记录不存在' });
    if (orch.runs.has(prev.runId)) return json(res, 409, { error: '该运行仍在进行中', code: 'run-live' });
    if (!prev.graph || !Array.isArray(prev.graph.nodes)) return json(res, 400, { error: '该运行没有图快照，无法续跑' });
    const succeeded = Object.values(prev.nodeStates || {}).filter((st) => st?.status === 'success');
    if (!succeeded.length) return json(res, 400, { error: '该运行没有已完成的节点，无需续跑', code: 'nothing-to-resume' });
    const persistedWorkflow = prev.workflowId ? readWf(prev.workflowId) : null;
    if (prev.workflowId && !persistedWorkflow) return json(res, 404, { error: '工作流不存在，无法续跑' });
    let draftGraph = null;
    if (!prev.workflowId && existsSync(currentStore().graphFile)) {
      try {
        const stored = JSON.parse(readFileSync(currentStore().graphFile, 'utf8'));
        if (!stored.workflowId && Array.isArray(stored.nodes)) draftGraph = stored;
      } catch { /* 草稿损坏时回退请求图或运行快照 */ }
    }
    // 命名工作流以服务端已保存版本为准；草稿优先使用刚保存的服务端图。
    const graph = persistedWorkflow?.graph || draftGraph || body.graph || prev.graph;
    const nodeLabel = (nodeId) => (graph.nodes.find((n) => n.id === nodeId)?.data?.label) || nodeId;
    const { reusable, rerun } = resumeDiff(prev.graph, graph, prev.nodeStates || {});
    const plan = {
      reusableNodes: reusable.map(nodeLabel),
      rerunNodes: rerun.map(nodeLabel),
    };    if (body?.preview) return json(res, 200, plan);
    if (!reusable.length) {
      return json(res, 400, {
        error: '画布改动已覆盖全部已完成节点的上游，无可复用结果，请直接重新运行',
        code: 'nothing-reusable',
        ...plan,
      });
    }
    // 沿用上次的触发输入与运行输入：续跑语义是“同样的输入，只补跑没跑完的节点”。
    // resume 种子裁剪到可复用节点：失效的 success 节点与其余未完成节点一并重新执行。
    const triggerInput = String(prev.triggerInput || '');
    let runInputs; try { runInputs = assertSafeContextObject(prev.runInputs, 'runInputs'); } catch (error) { return routeError(res, error); }
    let globals; try { globals = globalContext(); } catch (error) { return routeError(res, error); }
    const workflowVariables = variableDefinitionsToValues(persistedWorkflow?.variables || []);
    const lint = lintWorkflowGraph(graph);
    if (!lint.ok) return json(res, 400, { error: lint.issues.find((i) => i.level === 'error').message, lint });
    const reusableSet = new Set(reusable);
    const resumeSeed = {
      runId: prev.runId,
      nodeStates: Object.fromEntries(Object.entries(prev.nodeStates || {}).filter(([id]) => reusableSet.has(id))),
      outputs: Object.fromEntries(Object.entries(prev.outputs || {}).filter(([id]) => reusableSet.has(id))),
      structuredOutputs: Object.fromEntries(Object.entries(prev.structuredOutputs || {}).filter(([id]) => reusableSet.has(id))),
    };
    const { runId } = startRun(graph, {
      triggerInput, workflowName: prev.workflowName || null, workflowId: prev.workflowId || null,
      canvasId: body.canvasId || prev.canvasId || null,
      globalVariables: globals.globalVariables, workflowVariables, runInputs,
      source: 'resume', resume: resumeSeed,
    });
    // rerunNodes 为节点 label 数组（明细），数字计数由前端取 length
    json(res, 200, { started: true, runId, resumedFrom: prev.runId, resumedNodes: reusable.length, rerunCount: rerun.length, ...plan });
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
      const lint = lintWorkflowGraph(wf.graph);
      if (!lint.ok) return json(res, 400, { error: `导入的图校验失败：${lint.issues.find((i) => i.level === 'error').message}` });
      wf = writeWf(wf);
      return json(res, 200, { ok: true, id, name: wf.name, warnings: lint.issues.filter((i) => i.level === 'warn').length });
    }
    json(res, 405, { error: 'method' });
  } });

  // 刷新恢复快照：进行中运行的最新状态（供页面加载时补齐 SSE 错过的事件）
  register({ kind: 'exact', path: '/wf1/api/state', handler(_req, res) {
    const runningIds = [...orch.runs.values()].filter((entry) => entry.run.workspaceRoot === currentStore().workspaceRoot).map((entry) => entry.run.runId);
    const latest = recentRuns(1)[0];
    const lastRun = latest ? (() => {
      const { structuredOutputs, graph, ...summary } = latest;
      return { ...summary, outputs: summarizeOutputs(summary.outputs, structuredOutputs), nodeStates: summarizeNodeStates(summary.nodeStates), structuredOutputSummary: summarizeStructuredOutputs(structuredOutputs) };
    })() : null;
    json(res, 200, {
      running: runningIds,
      lastRun,
    });
  } });

  // ---- webhook + 定时触发（落盘 state/triggers.json，重启自动恢复）----
  // hooks: [{ id, token, workflowId, workflowName, createdAt }]
  // schedules meta 字段见 lib/schedule.js normalizeScheduleMeta
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
      for (const s of t.schedules || []) {
        const meta = normalizeScheduleMeta(s);
        if (meta.key) currentSchedulerMeta().set(meta.key, { ...meta, ...s });
      }
      return t;
    } catch { return { hooks: [], schedules: [] }; }
  };

  const persistTriggers = () => {
    try {
      const store = currentStore();
      atomicJson(store.triggersFile, {
        hooks: [...currentHooks().values()].map(({ id, token, workflowId, workflowName, createdAt }) => ({ id, token, workflowId, workflowName, createdAt })),
        schedules: [...currentSchedulerMeta().entries()].map(([key, m]) => persistableScheduleMeta({ ...m, key })),
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

  // ---- 版本中心 / 一键升级（settings「Workflow One」section 后端；无会话作用域）----
  // 探测/planner/执行都在 lib/system-upgrade.js；这里只做 HTTP 形状与并发闸。
  let upgradeRunning = false;
  register({ kind: 'exact', path: '/wf1/api/system/info', handler(_req, res) {
    json(res, 200, { ok: true, selfVersion: selfPluginVersion(), profiles: collectInstallReport() });
  } }, { scoped: false });

  register({ kind: 'exact', path: '/wf1/api/system/check-update', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const current = selfPluginVersion();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      // 发版渠道自 0.5.0 起是单包 dsh-harness-one（老包 latest 永钉 0.4.1，
      // 查老包会让所有 0.5+ 用户永远「已是最新」）；与 system-upgrade 的
      // latestVersion() 同源，保证检查口径 = 实际升级口径。
      const r = await fetch(`https://registry.npmjs.org/${UPGRADE_PACKAGE}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'dsh-harness-one-upgrade-check' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`registry ${r.status}`);
      const doc = await r.json();
      const latest = doc['dist-tags']?.latest || null;
      return json(res, 200, {
        ok: true, current, latest,
        updateAvailable: !!(latest && compareSemver(latest, current) > 0),
      });
    } catch (error) {
      return json(res, 200, { ok: false, current, latest: null, updateAvailable: false, error: String(error.message || error) });
    }
  } }, { scoped: false });

  register({ kind: 'exact', path: '/wf1/api/system/upgrade', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req).catch(() => ({}));
    if (!body?.confirm) return json(res, 400, { error: '升级会更新安装与 profile 依赖，请携带 { confirm: true } 显式确认' });
    if (upgradeRunning) return json(res, 409, { error: '已有一次升级正在进行，请稍候' });
    upgradeRunning = true;
    const startedAt = Date.now();
    try {
      const plan = planUpgrade(collectInstallReport());
      const log = await executePlan(plan);
      return json(res, 200, {
        ok: true, actions: plan.actions.map((a) => a.title),
        warnings: plan.warnings, restartRequired: plan.restartRequired,
        log, durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      ctx.logger?.error?.(`Workflow One 升级失败：${error.stack || error.message || error}`);
      return json(res, 500, { error: '升级执行失败（详见 dsh 日志）' });
    } finally {
      upgradeRunning = false;
    }
  } }, { scoped: false });

  // ---- 定时触发 ----
  // POST /wf1/api/schedule { workflowId, cron, input?, runInputs?, overlap?, timezone? }
  // 调度核心在 lib/schedule.js（computeNextDelay + 链式 setTimeout + overlap 策略）
  const scheduleStoreRoot = () => currentStore().workspaceRoot;
  const scheduleBusy = (workflowId) => hasLiveRunForWorkflow(orch.runs, scheduleStoreRoot(), workflowId);
  // 触发一次定时运行（fire 与手动「立即运行」共用）：读最新图 + 实例变量，返回 runId 或 null
  const fireScheduleRun = (meta, source = 'schedule') => {
    const wf = readWf(meta.workflowId);
    if (!wf) return null;
    let globals;
    try { globals = globalContext(); } catch (error) {
      ctx.logger?.warn?.(`dsh-ccpg 定时运行变量加载失败（${meta.key}）：${error.message}`);
      globals = { globalVariables: {} };
    }
    const { runId } = startRun(wf.graph, {
      triggerInput: meta.input || '', workflowName: wf.name, workflowId: wf.id, source,
      globalVariables: globals.globalVariables,
      workflowVariables: variableDefinitionsToValues(wf.variables),
      runInputs: meta.runInputs && typeof meta.runInputs === 'object' ? meta.runInputs : {},
    });
    return runId;
  };
  // 计数唯一属主是 meta Map：调度器经 onFire/onSkip 回调增量、这里落盘。
  // onMeta 只回传 nextAt（不含计数），手动「立即运行」也走 onFire，统计不会被覆盖回退。
  const bumpScheduleStat = (key, field) => {
    const prev = currentSchedulerMeta().get(key);
    if (!prev) return;
    currentSchedulerMeta().set(key, { ...prev, [field]: (prev[field] || 0) + 1 });
    persistTriggers();
  };
  const startSchedule = (key, meta) => {
    const entry = createScheduler({
      meta: { ...meta, key },
      now: () => Date.now(),
      fire: () => fireScheduleRun(meta),
      isBusy: () => scheduleBusy(meta.workflowId),
      logger: ctx.logger,
      onMeta: (live) => {
        const current = currentSchedulerMeta().get(key) || { ...meta, key };
        // 只取 nextAt，配置与计数以 Map 为准（PATCH 可能已改 cron，手动运行已改计数）
        currentSchedulerMeta().set(key, { ...current, nextAt: live.nextAt ?? null, key });
      },
      onFire: () => bumpScheduleStat(key, 'fireCount'),
      onSkip: () => bumpScheduleStat(key, 'skippedCount'),
    });
    return entry;
  };
  // 手动「立即运行」：不受 overlap/enabled 限制，不干扰调度链；经 onFire 记账
  const runScheduleNow = (key) => {
    const prev = currentSchedulerMeta().get(key);
    if (!prev) return { ok: false, error: '任务不存在' };
    const runId = fireScheduleRun(prev);
    if (!runId) return { ok: false, error: '工作流已删除或启动失败' };
    bumpScheduleStat(key, 'fireCount');
    return { ok: true, runId };
  };
  ensureTriggers = () => {
    const store = currentStore();
    const saved = loadTriggers();
    if (store.triggersRestored) return;
    store.triggersRestored = true;
    let misfireCounted = false;
    for (const raw of saved.schedules || []) {
      const meta = normalizeScheduleMeta(raw);
      if (!meta.key) continue;
      if (!readWf(meta.workflowId)) continue;
      const persisted = { ...meta, ...raw };
      // 停机 misfire（#57）：恢复前对比落盘 nextAt 与当下，过期即记账；
      // catchUp 策略再补跑最近一次（source 标记 catch-up），计一次 fireCount。
      // 补跑走同一 setImmediate，让调度链先挂好（nextAt 先归位）再起 run。
      const misfire = detectScheduleMisfire(persisted);
      if (misfire.count) {
        persisted.misfireCount = (persisted.misfireCount || 0) + misfire.count;
        misfireCounted = true;
        if (misfire.catchUp) {
          setImmediate(() => {
            try {
              const runId = fireScheduleRun(persisted, 'catch-up');
              if (runId) bumpScheduleStat(meta.key, 'fireCount');
              ctx.logger?.info?.(`dsh-ccpg 定时补跑（${meta.key}）：停机错过触发点，已补跑 ${runId || '失败'}`);
            } catch (error) {
              ctx.logger?.warn?.(`dsh-ccpg 定时补跑失败（${meta.key}）：${error?.message || error}`);
            }
          });
        } else {
          ctx.logger?.info?.(`dsh-ccpg 定时 misfire（${meta.key}）：停机错过触发点（策略 ignore，未补跑）`);
        }
      }
      currentSchedulerMeta().set(meta.key, persisted);
      // 停用任务只入 meta 不起定时器：启用时（PATCH）再挂
      if (persisted.enabled === false) continue;
      try {
        currentSchedulers().set(meta.key, startSchedule(meta.key, persisted));
      } catch { /* 单条失败不阻塞 */ }
    }
    // 记账后的 misfireCount 立即落盘（不等下一次 onMeta/persist），
    // 否则调度器上报 nextAt 前进程再挂一次，这次 misfire 就丢了
    if (misfireCounted) persistTriggers();
  };

  // 列表行：实时 join 工作流现名（meta 里的名字是创建时快照，改名后仅作 fallback）。
  // 统计以 meta Map 为准（fireNow 等手动路径直接改 Map），调度器仅补 nextAt。
  const scheduleRows = () => {
    const rows = [];
    for (const [key, meta] of currentSchedulerMeta()) {
      const wf = readWf(meta.workflowId);
      const live = currentSchedulers().get(key)?.getMeta?.() || {};
      rows.push({
        ...meta,
        nextAt: live.nextAt ?? meta.nextAt ?? null,
        key,
        workflowName: wf?.name || meta.workflowName || '(已删除)',
        workflowMissing: !wf,
        enabled: meta.enabled !== false,
      });
    }
    rows.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    return rows;
  };

  register({ kind: 'exact', path: '/wf1/api/schedule', async handler(req, res) {
    if (req.method === 'GET') {
      ensureTriggers();
      return json(res, 200, { schedules: scheduleRows() });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const wf = readWf(body?.workflowId);
      if (!wf) return json(res, 404, { error: '工作流不存在' });
      if (!body?.cron) return json(res, 400, { error: '需要 cron 表达式（5 段）' });
      if (!isValidCron(body.cron)) return json(res, 400, { error: 'cron 表达式无效' });
      let timezone;
      try { timezone = normalizeTimezoneInput(body?.timezone); } catch (error) { return json(res, 400, { error: error.message }); }
      let runInputs = {};
      try { runInputs = assertSafeContextObject(body?.runInputs, 'runInputs'); } catch (error) { return routeError(res, error); }
      if (body?.overlap && !['skip', 'parallel'].includes(body.overlap)) {
        return json(res, 400, { error: 'overlap 仅支持 skip / parallel' });
      }
      if (body?.misfirePolicy && !MISFIRE_POLICIES.includes(body.misfirePolicy)) {
        return json(res, 400, { error: 'misfirePolicy 仅支持 ignore / catchUp' });
      }
      const key = `sch_${randomUUID().slice(0, 8)}`;
      const meta = normalizeScheduleMeta({
        key,
        workflowId: wf.id,
        workflowName: wf.name,
        cron: body.cron,
        input: body.input || '',
        runInputs,
        overlap: body.overlap || 'skip',
        misfirePolicy: body.misfirePolicy || 'ignore',
        timezone,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      currentSchedulerMeta().set(key, meta);
      // 先入 meta 再启动：createScheduler 的 onMeta 会同步补 nextAt/统计
      currentSchedulers().set(key, startSchedule(key, meta));
      persistTriggers();
      return json(res, 200, { ok: true, key, cron: body.cron, overlap: meta.overlap, misfirePolicy: meta.misfirePolicy });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const key = body?.key || '';
      const prev = currentSchedulerMeta().get(key);
      if (!prev) return json(res, 404, { error: '任务不存在' });
      const patch = {};
      if (hasOwn(body, 'cron')) {
        if (!isValidCron(body.cron)) return json(res, 400, { error: 'cron 表达式无效' });
        patch.cron = body.cron;
      }
      if (hasOwn(body, 'input')) patch.input = body.input || '';
      if (hasOwn(body, 'overlap')) {
        if (!['skip', 'parallel'].includes(body.overlap)) return json(res, 400, { error: 'overlap 仅支持 skip / parallel' });
        patch.overlap = body.overlap;
      }
      if (hasOwn(body, 'misfirePolicy')) {
        if (!MISFIRE_POLICIES.includes(body.misfirePolicy)) return json(res, 400, { error: 'misfirePolicy 仅支持 ignore / catchUp' });
        patch.misfirePolicy = body.misfirePolicy;
      }
      if (hasOwn(body, 'timezone')) {
        try { patch.timezone = normalizeTimezoneInput(body.timezone); } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (hasOwn(body, 'runInputs')) {
        try { patch.runInputs = assertSafeContextObject(body?.runInputs, 'runInputs'); } catch (error) { return routeError(res, error); }
      }
      if (hasOwn(body, 'enabled')) patch.enabled = body.enabled !== false;
      const next = { ...prev, ...patch };
      // 配置或启用状态变化 → 重挂调度链（停用则摘掉定时器、nextAt 置空，meta 保留）
      const scheduler = currentSchedulers().get(key);
      if (scheduler) scheduler.stop();
      currentSchedulers().delete(key);
      currentSchedulerMeta().set(key, next);
      if (next.enabled !== false) {
        currentSchedulers().set(key, startSchedule(key, next));
      } else {
        next.nextAt = null;
      }
      persistTriggers();
      return json(res, 200, { ok: true, key });
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

  // cron 预览：创建/编辑表单实时显示接下来几次触发时间（按请求所选时区）
  register({ kind: 'exact', path: '/wf1/api/schedule/preview', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    if (!body?.cron) return json(res, 400, { error: '需要 cron 表达式' });
    let tz;
    try { tz = normalizeTimezoneInput(body?.timezone); } catch (error) { return json(res, 400, { error: error.message }); }
    try {
      return json(res, 200, { ok: true, times: upcomingFireTimes(body.cron, 3, Date.now(), tz) });
    } catch (e) {
      return json(res, 400, { error: `cron 表达式无效：${e.message}` });
    }
  } });

  // 立即运行一次（手动语义，不受 overlap/enabled 限制）
  register({ kind: 'exact', path: '/wf1/api/schedule/run', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const key = body?.key || '';
    if (!currentSchedulerMeta().has(key)) return json(res, 404, { error: '任务不存在' });
    const result = runScheduleNow(key);
    return json(res, result.ok ? 200 : 400, result);
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

  // ---- 产物下载/预览 ----
  // 新格式 ?run=&node=<nodeId>&file=：运行文档 artifactIndex 命中则走快照目录，
  // 未命中（运行中试运行尚未持久化）则直接解析该 run 的节点工作区。
  // 旧格式 ?node=<label>&file= 读 legacy data/workspaces/<label>/，仅兼容旧数据。
  register({ kind: 'exact', path: '/wf1/api/artifact', async handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const runId = url.searchParams.get('run') || '';
    const file = url.searchParams.get('file') || '';
    const nodeParam = url.searchParams.get('node') || '';
    if (!runId && !nodeParam) return json(res, 400, { error: '需要 node 和 file' });
    if (!file) return json(res, 400, { error: '需要 node 和 file' });
    if (runId) {
      // node 参数是 nodeId；artifactId 生成规则与 snapshotRunArtifacts 一致（run-results.js）
      const run = readRun(runId);
      const artifactId = runArtifactId(nodeParam, file);
      const resolved = run && resolveRunArtifact(artifactLocationsForRun(run), run, artifactId);
      if (resolved) {
        const mediaType = resolved.artifact.mediaType || mediaTypeFor(resolved.artifact.name);
        const preview = url.searchParams.get('preview') === '1'
          && resolved.artifact.previewable
          && isPreviewableMediaType(mediaType);
        return streamArtifactResponse(req, res, {
          file: resolved.file, filename: resolved.artifact.name, mediaType, preview,
        });
      }
      // 运行中/试运行：运行文档还没有快照，直接从节点工作区解析；
      // 断点续跑的节点产物物理上在祖先运行目录，沿 resumedFrom 链回退（有限深度防环）
      const ancestorRunIds = [runId];
      let cursor = readRun(runId);
      for (let depth = 0; cursor?.resumedFrom && depth < 10; depth += 1) {
        ancestorRunIds.push(cursor.resumedFrom);
        cursor = readRun(cursor.resumedFrom);
      }
      for (const candidateRunId of ancestorRunIds) {
        const ws = resolveInside(STORAGE.workspaceForNode({
          workflowId: run?.workflowId || 'draft', runId: candidateRunId, nodeId: nodeParam,
        }), file);
        if (!ws || !existsSync(ws) || !statSync(ws).isFile()) continue;
        const realWsParent = realpathSync(dirname(ws));
        const realWs = realpathSync(ws);
        if (resolveInside(realWsParent, realWs) !== realWs) continue;
        const mediaType = mediaTypeFor(file);
        const preview = url.searchParams.get('preview') === '1' && isPreviewableMediaType(mediaType);
        return streamArtifactResponse(req, res, { file: realWs, filename: file, mediaType, preview });
      }
      return json(res, 404, { error: '产物不存在' });
    }
    const nodeLabel = safeFileId(nodeParam, '');
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

  // .univer 产物解析：给 document-preview 的 Univer Viewer 渲染器返回文件系统绝对路径
  //（Viewer 以绝对路径 base64url 为 file key，且要求路径以 .univer 结尾、落在 workspace 内）。
  // 因此不走内容寻址的快照目录（无后缀），统一解析节点工作区里的原始 .univer：
  // 已结束运行沿 artifactIndex 的 relativePath 定位（断点续跑产物在祖先运行目录，沿 resumedFrom 回退），
  // 运行中直接按 file 名在工作区解析。安全约束与 /wf1/api/artifact 同款。
  register({ kind: 'exact', path: '/wf1/api/univer/resolve', async handler(req, res) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    const url = new URL(req.url, 'http://x');
    const runId = url.searchParams.get('run') || '';
    const file = url.searchParams.get('file') || '';
    const nodeParam = url.searchParams.get('node') || '';
    if (!runId && !nodeParam) return json(res, 400, { error: '需要 node 和 file' });
    if (!file) return json(res, 400, { error: '需要 node 和 file' });
    if (extname(file).toLowerCase() !== '.univer') return json(res, 400, { error: '仅支持 .univer 文件' });
    const hit = (absolutePath) => json(res, 200, { file: absolutePath });
    const run = runId ? readRun(runId) : null;
    const ancestors = [];
    if (run) {
      ancestors.push(runId);
      let cursor = run;
      for (let depth = 0; cursor?.resumedFrom && depth < 10; depth += 1) {
        ancestors.push(cursor.resumedFrom);
        cursor = readRun(cursor.resumedFrom);
      }
    }
    // 已结束运行：artifactIndex 记录了 relativePath（相对节点工作区），按它精确解析；
    // 请求的 file 名与索引对不上时回退到按名匹配（同名即认，运行中写入与索引时点差异）。
    const indexed = (run?.artifactIndex || []).filter((a) => a?.relativePath?.toLowerCase().endsWith('.univer'));
    const candidates = [];
    if (indexed.length) {
      const exact = indexed.find((a) => a.nodeId === nodeParam && (a.relativePath === file || a.name === file));
      const byName = indexed.filter((a) => a.name === file);
      for (const a of [exact, ...byName]) {
        if (a && !candidates.some((c) => c.nodeId === a.nodeId && c.relativePath === a.relativePath)) candidates.push(a);
      }
    }
    for (const candidateRunId of ancestors.length ? ancestors : [runId]) {
      const rels = candidates.filter((a) => a.nodeId === nodeParam).map((a) => a.relativePath);
      for (const rel of rels.length ? rels : (runId ? [] : [file])) {
        const ws = resolveInside(STORAGE.workspaceForNode({
          workflowId: run?.workflowId || 'draft', runId: candidateRunId, nodeId: nodeParam,
        }), rel);
        if (!ws || !existsSync(ws) || !statSync(ws).isFile()) continue;
        const realWs = realpathSync(ws);
        if (resolveInside(realpathSync(dirname(realWs)), realWs) !== realWs) continue;
        return hit(realWs);
      }
    }
    return json(res, 404, { error: '产物不存在' });
  } });

  // 文稿墙批量正文：一次请求返回运行内多个产物的文本截断稿，替代逐卡 fetch（37 卡 = 37 请求）。
  // POST { runId, items: [{ node, file }] } → { files: { "<node>\u0000<file>": { content, truncated } } }；
  // 总字节预算 1.5MB，超预算的条目返回 { omitted: true }，前端回退单卡惰性拉取。仅文本类产物。
  register({ kind: 'exact', path: '/wf1/api/artifacts/content', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const runId = String(body?.runId || '');
    const items = Array.isArray(body?.items) ? body.items.slice(0, 200) : [];
    if (!runId || !items.length) return json(res, 400, { error: '需要 runId 和 items' });
    const run = readRun(runId);
    if (!run) return json(res, 404, { error: '运行记录不存在', code: 'run-not-found' });
    // 与 /artifact 兜底同款：沿 resumedFrom 祖先链回退定位节点工作区；
    // 优先读不可变快照，避免历史运行的节点工作区已清理时正文仍不可读。
    const ancestorRuns = [run];
    let cursor = run;
    for (let depth = 0; cursor?.resumedFrom && depth < 10; depth += 1) {
      cursor = readRun(cursor.resumedFrom);
      if (cursor) ancestorRuns.push(cursor);
    }
    const BUDGET = 1.5 * 1024 * 1024;
    const CLIP = 4096;
    const files = {};
    let used = 0;
    const readCandidate = (candidateRun, nodeId, file, requestedArtifactId = '') => {
      const indexed = (candidateRun.artifactIndex || []).filter((artifact) => artifact?.nodeId === nodeId);
      const byId = requestedArtifactId ? indexed.find((artifact) => artifact.id === requestedArtifactId) : null;
      const exact = byId || indexed.find((artifact) => artifact.relativePath === file || artifact.name === file);
      const byName = indexed.filter((artifact) => artifact.name === file);
      const candidates = exact ? [exact, ...byName.filter((artifact) => artifact.id !== exact.id)] : byName;
      for (const artifact of candidates) {
        const resolved = resolveRunArtifact(artifactLocationsForRun(candidateRun), candidateRun, artifact.id);
        if (resolved?.file) return resolved.file;
      }
      const ws = resolveInside(STORAGE.workspaceForNode({
        workflowId: candidateRun.workflowId || run.workflowId || 'draft', runId: candidateRun.runId, nodeId,
      }), file);
      if (!ws || !existsSync(ws) || !statSync(ws).isFile()) return null;
      const realWs = realpathSync(ws);
      if (resolveInside(realpathSync(dirname(realWs)), realWs) !== realWs) return null;
      return realWs;
    };
    for (const item of items) {
      const nodeId = String(item?.node || '');
      const file = String(item?.file || '');
      const artifactId = String(item?.artifactId || '');
      const key = `${nodeId}\u0000${file}`;
      if (!nodeId || !file) continue;
      const ext = extname(file).toLowerCase();
      if (!['.md', '.markdown', '.txt', '.csv'].includes(ext)) {
        files[key] = { missing: true, reason: 'unsupported-type' };
        continue;
      }
      const source = ancestorRuns.map((candidateRun) => readCandidate(candidateRun, nodeId, file, artifactId)).find(Boolean);
      if (!source) {
        files[key] = { missing: true, reason: 'artifact-not-found' };
        continue;
      }
      const size = statSync(source).size;
      if (used + size > BUDGET) {
        files[key] = { omitted: true, reason: 'budget' };
        continue;
      }
      const raw = readFileSync(source, 'utf8');
      used += size;
      files[key] = raw.length > CLIP ? { content: `${raw.slice(0, CLIP)}…`, truncated: true } : { content: raw, truncated: false };
    }
    return json(res, 200, { files });
  } });

  // ---- 产物评论与修订（issue #97 轻通道）----
  // 评论/修订存独立表（run 文档之外的用户数据，run 历史保持不可变）。
  // GET /wf1/api/comments?runId= → { comments, revisions }：一次拉全 run 的评论与版本链，前端按卡归组
  register({ kind: 'exact', path: '/wf1/api/comments', async handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const runId = url.searchParams.get('runId') || '';
    if (!runId) return json(res, 400, { error: '缺少 runId' });
    const db = currentDatabase();
    const comments = req.method === 'GET' ? db.listArtifactComments(runId) : [];
    const revisions = db.listArtifactRevisions(runId);
    return json(res, 200, { comments, revisions });
  } });

  // POST /wf1/api/comments { runId, nodeId, artifactId, body } → { comment }；DELETE ?id=
  register({ kind: 'exact', path: '/wf1/api/comments/add', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const runId = String(body?.runId || '');
    const nodeId = String(body?.nodeId || '');
    const artifactId = String(body?.artifactId || '');
    const text = String(body?.body || '').trim();
    if (!runId || !nodeId || !artifactId) return json(res, 400, { error: '需要 runId、nodeId、artifactId' });
    if (!text) return json(res, 400, { error: '评论内容不能为空' });
    if (!readRun(runId)) return json(res, 404, { error: '运行记录不存在' });
    const comment = currentDatabase().addArtifactComment({ runId, nodeId, artifactId, body: text });
    return json(res, 200, { ok: true, comment });
  } });

  register({ kind: 'exact', path: '/wf1/api/comments/delete', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: '需要有效 id' });
    const removed = currentDatabase().deleteArtifactComment(id);
    return json(res, 200, { ok: removed });
  } });

  // POST /wf1/api/artifacts/revise：按评论改写这一篇（轻通道）。
  // 动态合成单 agent 微图，原稿复制进改写节点输出目录，以 source='revision' 走引擎正常起跑
  // （超时/重试/llm-guard/usage 免费复用）；完成后修订正文入版本链表，不写回原 run。
  register({ kind: 'exact', path: '/wf1/api/artifacts/revise', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const runId = String(body?.runId || '');
    const nodeId = String(body?.nodeId || '');
    const artifactId = String(body?.artifactId || '');
    const instruction = String(body?.instruction || '').trim();
    if (!runId || !nodeId || !artifactId) return json(res, 400, { error: '需要 runId、nodeId、artifactId' });
    const run = readRun(runId);
    if (!run) return json(res, 404, { error: '运行记录不存在' });
    if (run.source === 'revision') return json(res, 400, { error: '改写稿不能再次发起改写' });
    // 产物定位：先按 artifactIndex id，未命中回退按 name（文稿卡前端两形态都可能传）
    let resolved = resolveRunArtifact(artifactLocationsForRun(run), run, artifactId);
    if (!resolved) {
      const byName = (run.artifactIndex || []).find((item) => item.name === artifactId);
      if (byName) resolved = resolveRunArtifact(artifactLocationsForRun(run), run, byName.id);
    }
    if (!resolved) return json(res, 404, { error: '产物不存在或已被清理' });
    const comments = currentDatabase().listArtifactComments(runId)
      .filter((row) => row.node_id === nodeId && row.artifact_id === resolved.artifact.name);
    if (!comments.length && !instruction) return json(res, 400, { error: '没有可用的评论或补充要求' });

    const revisionRunId = `run_${Date.now().toString(36)}_rev${++runIdSeq}`;
    // 原稿复制进改写节点输出目录：prompt 与文档长度解耦，agent 用 read 工具自取
    const revisionWs = STORAGE.workspaceForNode({
      workflowId: run.workflowId || 'draft', runId: revisionRunId, nodeId: revisionAgentNodeId(),
    });
    const fileName = safeFilename(resolved.artifact.name);
    const sourceFileName = `__wf1_original__${fileName}`;
    try {
      mkdirSync(revisionWs, { recursive: true, mode: 0o700 });
      copyFileSync(resolved.file, resolveInside(revisionWs, sourceFileName) || join(revisionWs, sourceFileName));
    } catch (error) {
      return json(res, 500, { error: `原稿复制失败：${error.message}` });
    }
    const graph = buildRevisionGraph({
      comments,
      originalName: resolved.artifact.name,
      fileName,
      sourceFileName,
      instruction,
    });
    const { runId: startedId, promise } = startRun(graph, {
      workflowId: run.workflowId || null,
      workflowName: `${run.workflowName || run.runId} · 按评论修订`,
      source: 'revision',
      runId: revisionRunId,
      revises: { runId, nodeId, artifactId: resolved.artifact.name },
    });
    // 路由即刻返回；修订落库在 run 收尾后异步执行。
    // .then 已脱离路由的 workspaceContext（AsyncLocalStorage），须以路由捕获的 store 重入
    const routeStore = currentStore();
    // 评论/修订统一以产物 name 为键（与前端卡片键一致；artifactId 参数可能是索引 id）
    const artifactKey = resolved.artifact.name;
    promise.then((revisionRun) => {
      if (!revisionRun) return;
      workspaceContext.run(routeStore, () => {
        const persisted = readRun(startedId);
        const record = persisted && extractRevision({
          run: persisted,
          fileName,
          readFile: (artifact) => {
            const found = resolveRunArtifact(artifactLocationsForRun(persisted), persisted, artifact.id);
            if (!found) throw new Error('快照文件缺失');
            return readFileSync(found.file, 'utf8');
          },
        });
        if (!record) return;
        currentDatabase().addArtifactRevision({
          targetRunId: runId, nodeId, artifactId: artifactKey,
          revisionRunId: record.revisionRunId,
          name: record.name, summary: record.summary, fileName: record.fileName, content: record.content,
        });
        broadcast('revision-ready', { runId, nodeId, artifactId: artifactKey, revisionRunId: startedId });
      });
    }).catch((error) => {
      ctx.logger?.error?.(`[wf1] 修订落库失败（${runId}/${artifactKey} → ${startedId}）：${error.message}`);
    });
    return json(res, 200, { ok: true, revisionRunId: startedId });
  } });

  // POST /wf1/api/artifacts/save：手工编辑落版本链（issue #97 补充通道）。
  // 用户在文稿视图直接改文本类产物并保存：不覆盖原稿文件（run 历史不可变），
  // 写成 revision_run_id 为空的修订进版本链（AI 改写版本该字段是改写 run id），
  // 与 AI 改写版本同链展示、可继续迭代。
  register({ kind: 'exact', path: '/wf1/api/artifacts/save', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const runId = String(body?.runId || '');
    const nodeId = String(body?.nodeId || '');
    const artifactId = String(body?.artifactId || '');
    const content = typeof body?.content === 'string' ? body.content : '';
    if (!runId || !nodeId || !artifactId) return json(res, 400, { error: '需要 runId、nodeId、artifactId' });
    if (!content.trim()) return json(res, 400, { error: '内容不能为空' });
    if (content.length > MAX_MANUAL_REVISION_CONTENT) {
      return json(res, 413, { error: `内容超过上限（${MAX_MANUAL_REVISION_CONTENT} 字符）` });
    }
    const run = readRun(runId);
    if (!run) return json(res, 404, { error: '运行记录不存在' });
    // 手工编辑只写版本链、不读原文件：按索引定位即可（快照被清理也能编辑存版本）
    const artifact = (run.artifactIndex || []).find((item) => item.id === artifactId)
      || (run.artifactIndex || []).find((item) => item.name === artifactId);
    if (!artifact) return json(res, 404, { error: '产物不存在或已被清理' });
    // 富文本编辑走 markdown 往返，csv/txt 会破坏原格式（前端同步限定）
    const ext = extname(artifact.name).toLowerCase();
    if (!['.md', '.markdown'].includes(ext)) {
      return json(res, 415, { error: '仅支持 Markdown 文稿的直接编辑' });
    }
    const id = currentDatabase().addArtifactRevision({
      targetRunId: runId, nodeId, artifactId: artifact.name,
      revisionRunId: null, name: artifact.name,
      summary: '手工编辑', fileName: artifact.name, content,
    });
    broadcast('revision-ready', { runId, nodeId, artifactId: artifact.name, revisionId: id, manual: true });
    return json(res, 200, { ok: true, revisionId: id });
  } });

  // ---- /workflow-one 触发源执行端（#63）----
  // 官方聊天输入 `/workflow-one` 选择工作流后的两个动作落点：
  //   action=open：把该会话绑定的画布切到目标工作流（workflow_open 工具同语义）；
  //               未绑定画布返回 409 + code，由前端引导先绑定。
  //   action=run ：直接发起一次运行（workflow_run 工具同语义，startWorkflowRun 共享），
  //               不依赖画布绑定——对话框里随手起跑是触发源的主场景。
  // 工作区按 sessionId 解析（requestStore 同口径），body.sessionId 兼容画布侧调用。
  register({ kind: 'exact', path: '/wf1/api/trigger', async handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const url = new URL(req.url, 'http://wf1.local');
    const sessionId = url.searchParams.get('sessionId') || String(body?.sessionId || '');
    const action = String(body?.action || 'open');
    const wf = readWf(String(body?.workflowId || ''));
    if (!wf) return json(res, 404, { error: '工作流不存在' });
    let store;
    try {
      store = sessionId ? sessionStore(sessionId) : requestStore(req);
    } catch (error) {
      return json(res, 409, { error: `工作区不可用：${String(error.message || error)}` });
    }
    if (action === 'open') {
      // 画布键含工作区根（canvasKey），解析与写图都要落在会话工作区作用域里。
      const opened = workspaceContext.run(store, () => {
        const canvasId = sessionCanvas.get(sessionId);
        if (!canvasId) return { code: 'canvas-not-bound' };
        const cv = canvasOf(canvasId);
        cv.workflowId = wf.id;
        cv.graph = { nodes: wf.graph.nodes.map((n) => ({ ...n, data: { ...n.data } })), edges: wf.graph.edges.map((e) => ({ ...e })) };
        cv.version += 1;
        broadcast('assistant-open-workflow', { canvasId, workflowId: wf.id });
        return { canvasId };
      });
      if (opened.code === 'canvas-not-bound') {
        return json(res, 409, {
          error: '此会话未绑定工作流画布，无法打开（可在画布「工作流」标签页打开后重试，或改用运行）',
          code: 'canvas-not-bound',
        });
      }
      return json(res, 200, { ok: true, action, canvasId: opened.canvasId, workflowId: wf.id, name: wf.name });
    }
    if (action === 'run') {
      const started = workspaceContext.run(store, () => startWorkflowRun(wf, { triggerInput: String(body?.triggerInput ?? ''), runInputs: body?.runInputs && typeof body.runInputs === 'object' ? body.runInputs : {}, source: 'trigger' }));
      if (!started.ok) return json(res, 400, { error: started.error });
      return json(res, 200, { ok: true, action, runId: started.runId, workflowId: wf.id, name: wf.name });
    }
    return json(res, 400, { error: 'action 须为 open 或 run' });
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
        // 逐模型补能力元数据：思考级别档位（reasoning）与视觉输入（vision）。
        // resolveModelInfo 走 adapter 精确解析，失败只降级该模型，不拖垮整个目录。
        const modelsWithMeta = await Promise.all(models.map(async (model) => {
          try {
            const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
            const reasoning = info.reasoning
              ? {
                  efforts: info.reasoning.efforts.map((effort) => ({
                    id: effort.id,
                    name: effort.name,
                    ...(effort.description ? { description: effort.description } : {}),
                  })),
                  ...(info.reasoning.defaultEffort !== undefined ? { defaultEffort: info.reasoning.defaultEffort } : {}),
                }
              : undefined;
            return {
              id: model.id,
              name: model.name || model.id,
              ...(model.description ? { description: model.description } : {}),
              ...(reasoning ? { reasoning } : {}),
              ...(info.inputModalities ? { vision: info.inputModalities.includes('image') } : {}),
            };
          } catch {
            return { id: model.id, name: model.name || model.id, ...(model.description ? { description: model.description } : {}) };
          }
        }));
        return { id: provider.id, name: provider.name, models: modelsWithMeta };
      } catch (error) {
        failures.push({ provider: provider.id, error: error?.message || String(error) });
        return { id: provider.id, name: provider.name, models: [] };
      }
    }));
    json(res, 200, {
      defaultProvider: sel.provider,
      defaultModel: sel.model,
      defaultReasoningEffort: sel.reasoningEffort,
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
        notificationChannels: notificationChannels.list(),
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
      foldTraceEvent({ entries }, ev, pending, meta);
    }
  } catch { /* session 已释放时保留已折叠部分 */ }
  finalizeTrace({ entries }, meta);
  return { model: meta.model, entries };
}

// 折叠单个 session 事件进 entries（buildTrace 全量与实时轨迹增量共用同一套语义）
export function foldTraceEvent(trace, ev, pending, meta = {}) {
  const entries = trace.entries;
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

// 旧会话回放没有 meta.input：第一条非系统注入就是实际用户输入，归位到 input。
export function finalizeTrace(trace, meta = {}) {
  const { entries } = trace;
  if (!entries[0].text) {
    const i = entries.findIndex((e, idx) => idx > 0 && e.kind === 'inject' && !/^Current runtime context|^<system-reminder>/.test(e.text));
    if (i > 0) {
      entries[0].text = entries[i].text;
      entries.splice(i, 1);
    }
  }
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

// ---------------- 版本中心辅助 ----------------

// 部署版本 = 本插件包版本（link/npm 两渠道都随安装走）
function selfPluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || null;
  } catch {
    return null;
  }
}
