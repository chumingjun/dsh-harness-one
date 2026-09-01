// 图执行引擎 v2：从 index.js 拆出的可独立测试核心。
import { RUN_SCHEMA_VERSION, mergeExecutionResults, normalizeExecutionResult } from './output-contract.js';
import { parseTemplate } from './template-parser.js';
import { validateTemplate } from './template.js';
import { getAgentOutputConfig } from './agent-schema.js';
import { lintScriptInputs, resolveScriptInputs } from './typed-expression.js';
import { getScriptOutputSchema, validateScriptOutput } from './script-schema.js';
import { normalizeScriptTimeout, SCRIPT_LIMITS } from './script-runner.js';
import { validateNotificationNodeData } from './notifications.js';
// 相对 v1 的升级：
//   - 多运行实例并存（Map 而非单 this.s）
//   - 并发上限（就绪节点排队，槽位释放依次启动）
//   - 每节点超时（默认 300s，节点可配 timeoutSec）与整运行取消（未开始节点标 canceled + agent.abort 传播）
//   - 条件分支节点（condition）：模板渲染后命中 include/exclude 关键词决定走 true/false 出边（边 branch 字段）
//   - 图静态校验 lintGraph（环之外：未填提示词、模板引用不存在的节点、孤立输出、同名节点）
//   - 失败传播规则不变：全部直接上游 error/skipped/canceled 才跳过下游
//
// 计数约定：每个节点的完成只在其自身 _onNodeDone 尾部扣一次 s.remaining；
// 跳过/取消的节点在标记处扣，且不再递归重复扣。

export const NODE_TIMEOUT_MS = 5 * 60 * 1000;
const CONDITION_VERDICT_RE = /^条件判定：(true|false)/;

let runSeq = 0;

// ---------------- 节点类型注册表（扩展点） ----------------
// 一种节点 = 一个 NodeKind 对象：
//   kind.type            唯一 id（graph.nodes[].type）
//   kind.execute(ctx)    必填。返回 string 或 {output, ...extra}；抛错走失败传播
//                        ctx = {node, s, engine, signal, emit, render(tpl, node)}
//   kind.edgeTaken       可选。(s, node, edge) => boolean，控制分支边是否放行
//   kind.lint            可选。(node, lintCtx) => issues[]（{level:'error'|'warn', message}）
//   kind.wantsSink       可选。true = 成功后调用 engine.outputSink（输出写回等后处理）
// 新增节点类型：export const myKind = {...}; registerKind(myKind) —— 引擎/
// 超时/取消/失败传播/历史持久化全部自动获得。
export const nodeKinds = new Map();

export function registerKind(kind) {
  if (!kind?.type || typeof kind.execute !== 'function') {
    throw new Error(`registerKind: 需要 { type, execute }`);
  }
  nodeKinds.set(kind.type, kind);
  return kind;
}

export function getKind(type) {
  return nodeKinds.get(type) || null;
}

export function listKinds() {
  return [...nodeKinds.values()];
}

// lint 共用上下文（lintGraph 构造）
function lintContextFor(graph, nodes, labels, labelCount, incomingIds, options) {
  return {
    graph, nodes, labels, labelCount, incomingIds,
    ...options,
    renderRef: (tpl) => tpl, // lint 阶段不渲染，仅提供字段
  };
}

export class Orchestrator {
  constructor(ctx, { onEvent, renderTemplate } = {}) {
    this.ctx = ctx;
    this.runs = new Map(); // runId → { run, s, cancel }
    this.onEvent = onEvent || (() => {});
    this.renderTemplate = renderTemplate;
    this.nodeRunner = null; // index.js 注入：async (node, run, s, {signal, emit}) => ({output, ...extra})
    this.scriptRunner = null; // index.js 注入：async ({node,input,signal}) => ({value,artifacts,...})
    this.outputSink = null; // index.js 注入：async (node, output, {signal}) => ({output, ...extra}) 输出节点后处理（飞书写回等）
  }

  emit(event, payload) {
    try { this.onEvent(event, payload); } catch { /* 订阅方异常不阻塞引擎 */ }
  }

  async run(graph, {
    triggerInput = '', runId, workflowName, workflowId, canvasId, source, workspaceRoot, revises,
    globalVariables = {}, workflowVariables = {}, runInputs = {},
    resume = null,
  } = {}) {
    const id = runId || `run_${Date.now().toString(36)}_${++runSeq}`;
    const safeRunInputs = structuredClone(runInputs || {});
    const run = {
      runId: id, startedAt: new Date().toISOString(), status: 'running',
      triggerInput, runInputs: safeRunInputs, workflowName: workflowName || null, workflowId: workflowId || null,
      canvasId: canvasId || null, source: source || null, workspaceRoot: workspaceRoot || null,
      revises: revises || null,
      schemaVersion: RUN_SCHEMA_VERSION,
      nodeStates: {}, outputs: {}, structuredOutputs: {}, nodeOrder: [],
      canceled: false,
      ...(resume ? { resumedFrom: resume.runId || null } : {}),
    };
    const s = {
      run, graph,
      nodes: new Map(graph.nodes.map((n) => [n.id, n])),
      incoming: new Map(), outgoing: new Map(), pendingDeps: new Map(),
      edgeMap: new Map(), // "src>target" → edge（取 branch 标注）
      triggerInput, globalVariables, workflowVariables, runInputs: safeRunInputs,
      remaining: graph.nodes.length,
      activeCount: 0, concurrency: 4,
      finished: false, startedAtMs: Date.now(),
      nodeAbort: new Map(),
    };
    for (const n of graph.nodes) {
      s.incoming.set(n.id, []);
      s.outgoing.set(n.id, []);
      s.pendingDeps.set(n.id, 0);
    }
    for (const e of graph.edges || []) {
      if (!s.nodes.has(e.source) || !s.nodes.has(e.target)) continue;
      s.outgoing.get(e.source).push(e.target);
      s.incoming.get(e.target).push(e.source);
      s.pendingDeps.set(e.target, s.pendingDeps.get(e.target) + 1);
      s.edgeMap.set(`${e.source}>${e.target}`, e);
    }
    this.runs.set(id, { run, s });

    // 重试计数挂在运行态：每次 run 用全新图深拷贝，跨次运行不残留
    for (const n of graph.nodes) n.__retryLeft = undefined;

    // Kahn 环检测
    const deg = new Map(s.pendingDeps);
    const q = graph.nodes.filter((n) => deg.get(n.id) === 0).map((n) => n.id);
    let seen = 0;
    while (q.length) {
      const cur = q.shift();
      seen++;
      for (const next of s.outgoing.get(cur)) {
        deg.set(next, deg.get(next) - 1);
        if (deg.get(next) === 0) q.push(next);
      }
    }
    if (seen !== graph.nodes.length) {
      run.status = 'error';
      run.error = '图中存在环，无法执行';
      s.finished = true;
      this.emit('run-error', {
        runId: id, error: run.error,
        workflowId: run.workflowId, canvasId: run.canvasId, source: run.source,
      });
      this.runs.delete(id);
      return run;
    }

    // ---- 断点续跑：把上次运行中 success 节点的输出/结构化输出搬进本次运行 ----
    // 图一致才可续跑（入口 startRun 已做 fingerprint 校验；这里只搬运）。
    // 对每个 success 节点：写 outputs/nodeStates、释放直接下游依赖计数，
    // 并按原判定回放分支跳过（与 _onNodeDone 同语义）。
    if (resume?.nodeStates) {
      const prior = resume;
      for (const n of graph.nodes) {
        const st = prior.nodeStates[n.id];
        if (!st || st.status !== 'success') continue;
        const restored = { ...st, resumed: true };
        // startedAt/durationMs 保留原值：续跑报告的耗时语义是“这些节点没再花时间”
        run.outputs[n.id] = prior.outputs?.[n.id] ?? '';
        if (prior.structuredOutputs?.[n.id] !== undefined) {
          run.structuredOutputs[n.id] = prior.structuredOutputs[n.id];
        }
        run.nodeStates[n.id] = restored;
        run.nodeOrder.push(n.id);
        this.emit('node-status', { runId: id, nodeId: n.id, status: 'success', resumed: true, ...(st.chars != null ? { chars: st.chars } : {}) });
        for (const next of s.outgoing.get(n.id) || []) {
          if (this._edgeTaken(s, n.id, next)) {
            s.pendingDeps.set(next, s.pendingDeps.get(next) - 1);
          } else if (s.run.nodeStates[next] === undefined) {
            s.remaining -= 1;
            s.run.nodeStates[next] = { status: 'skipped', error: '条件分支未命中' };
            this.emit('node-status', { runId: id, nodeId: next, status: 'skipped', error: '条件分支未命中' });
            this._propagateSkip(s, next);
          }
        }
        s.remaining -= 1;
      }
    }

    this.emit('run-start', {
      runId: id, nodeIds: graph.nodes.map((n) => n.id),
      workflowId: run.workflowId, workflowName: run.workflowName,
      canvasId: run.canvasId, source: run.source,
    });
    s._done = new Promise((resolve) => { s.resolve = resolve; });
    this._pump(s);
    await s._done;
    run.durationMs = Date.now() - s.startedAtMs;
    run.status = run.canceled ? 'canceled'
      : Object.values(run.nodeStates).some((st) => st.status === 'error') ? 'error' : 'success';
    this.emit('run-end', {
      runId: id, status: run.status, durationMs: run.durationMs,
      workflowId: run.workflowId, canvasId: run.canvasId, source: run.source,
    });
    return run;
  }

  cancel(runId, reason = '用户取消') {
    const entry = this.runs.get(runId);
    if (!entry || entry.s.finished) return false;
    this._cancelRun(entry, reason);
    return true;
  }

  _cancelRun(entry, reason) {
    const { run, s } = entry;
    if (s.finished) return;
    run.canceled = true;
    run.cancelReason = reason;
    // 尚无终态的节点全部标 canceled（运行中的由其 finally 收尾，这里只处理未启动/排队中的）
    for (const nodeId of s.nodes.keys()) {
      const st = run.nodeStates[nodeId]?.status;
      if (st !== undefined && st !== 'queued') continue;
      run.nodeStates[nodeId] = { status: 'canceled', error: reason };
      this.emit('node-status', { runId: run.runId, nodeId, status: 'canceled', error: reason });
      s.remaining -= 1;
    }
    for (const ac of s.nodeAbort.values()) {
      try { ac.abort(); } catch { /* 已中止 */ }
    }
    this._maybeFinish(s);
  }

  currentRunIds() { return [...this.runs.keys()]; }

  _maybeFinish(s) {
    if (s.finished) return;
    if (s.remaining <= 0) {
      s.finished = true;
      this.runs.delete(s.run.runId);
      s.resolve?.();
    }
  }

  _pump(s) {
    if (s.finished || s.run.canceled) return;
    for (const [nodeId, deg] of s.pendingDeps) {
      if (s.activeCount >= s.concurrency) break;
      if (deg === 0 && s.run.nodeStates[nodeId] === undefined) {
        s.run.nodeStates[nodeId] = { status: 'queued' };
        s.activeCount += 1;
        s.run.nodeOrder.push(nodeId);
        this.emit('node-status', { runId: s.run.runId, nodeId, status: 'queued' });
        this._executeNode(s, nodeId).catch(() => {});
      }
    }
  }

  async _executeNode(s, nodeId) {
    const node = s.nodes.get(nodeId);
    const { run } = s;
    if (node.__retryLeft === undefined) node.__retryLeft = this._retryTotal(node);
    const ac = new AbortController();
    s.nodeAbort.set(nodeId, ac);
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    run.nodeStates[nodeId] = { status: 'running', startedAt };
    this.emit('node-status', { runId: run.runId, nodeId, status: 'running', startedAt });
    const timeoutMs = Number(node.data?.timeoutSec) > 0 ? Number(node.data.timeoutSec) * 1000 : NODE_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    try {
      let output = '';
      let extra = {};
      if (run.canceled) throw new Error('运行已取消');
      const kind = getKind(node.type);
      if (kind?.passThrough) {
        // 注释等纯标注节点：不执行，输出 = 上游拼接，立即按成功收尾
        const ctx0 = this.templateCtx(node, s);
        const out = this.renderTemplate('{{$upstream}}', ctx0).text || '';
        const result = normalizeExecutionResult(out);
        run.outputs[node.id] = result.output;
        run.structuredOutputs[node.id] = result.structuredOutput;
        run.nodeStates[node.id] = { status: 'success', chars: out.length, durationMs: 0, startedAt, passThrough: true };
        this.emit('node-status', { runId: run.runId, nodeId: node.id, status: 'success', passThrough: true, chars: out.length });
        return this._onNodeDone(s, node.id, false);
      }
      const execCtx = {
        node, s, engine: this, signal: ac.signal,
        emit: this.emit.bind(this), runId: run.runId,
        workflowId: run.workflowId,
        render: (tpl, options = {}) => this.renderTemplate(tpl || '', { ...this.templateCtx(node, s), ...options }),
      };
      let result;
      if (!kind) {
        const error = new Error(`未知节点类型：${node.type || '(空)'}`);
        error.code = 'UNKNOWN_NODE_TYPE';
        throw error;
      }
      result = normalizeExecutionResult(await kind.execute(execCtx), { meta: { nodeType: node.type } });
      if (timedOut) {
        // 超时但 execute 已产出结果：把轨迹等 extra 带进错误，详情弹窗超时后仍可复盘
        const timeoutError = new Error(`节点超时（${Math.round(timeoutMs / 1000)}s）`);
        if (result?.extra && typeof result.extra === 'object') timeoutError.nodeDetails = result.extra;
        throw timeoutError;
      }
      if (run.canceled) throw new Error('运行已取消');
      // 输出后处理（飞书写回等）：sink 结果增量合并，保留原节点 data/meta/extra。
      if (kind?.wantsSink && this.outputSink) {
        result = mergeExecutionResults(result, await this.outputSink(node, result.output, {
          signal: ac.signal, structuredOutput: result.structuredOutput,
        }));
      }
      output = result.output;
      extra = result.extra;
      run.outputs[node.id] = output;
      run.structuredOutputs[node.id] = result.structuredOutput;
      run.nodeStates[node.id] = { ...extra, status: 'success', chars: output.length, durationMs: Date.now() - t0, startedAt };
      // 详情弹窗数据：extra 携带的输入/轨迹只进运行记录，不进高频事件流
      this.emit('node-status', {
        runId: run.runId, nodeId: node.id, status: 'success', chars: output.length,
        ...(result.structuredOutput.type === 'json' ? {} : { outputPreview: String(output).slice(0, 4000) }),
        hasStructured: result.structuredOutput.type === 'json',
        outputType: result.structuredOutput.type,
        ...(result.structuredOutput.mediaType ? { mediaType: result.structuredOutput.mediaType } : {}),
        ...(extra?.trace ? { hasTrace: true, sessionId: extra.sessionId } : {}),
        ...(extra?.input !== undefined ? { hasInput: true } : {}),
        ...(extra?.turns != null ? { turns: extra.turns } : {}),
        ...(extra?.durationMs != null ? { durationMs: extra.durationMs } : {}),
        ...(extra?.model ? { model: extra.model } : {}),
        ...(extra?.artifacts ? { artifacts: extra.artifacts } : {}),
        ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
      });
      this._onNodeDone(s, node.id, false);
    } catch (err) {
      // 重试：节点声明 retryCount 时，非取消类失败按指数退避重试（重试重新计时超时）
      const canceled0 = run.canceled || String(err?.message || '') === '运行已取消';
      if (!canceled0 && !s.run.canceled && this._retryLeft(node) > 0) {
        node.__retryLeft -= 1;
        const attempt = this._retryTotal(node) - node.__retryLeft;
        const delay = Math.min(8000, 500 * 2 ** (attempt - 1));
        this.emit('node-status', {
          runId: run.runId, nodeId, status: 'running', retrying: true, attempt: attempt + 1,
          error: `${String(err.message || err)}（${delay}ms 后重试）`,
        });
        await new Promise((r) => setTimeout(r, delay));
        clearTimeout(timer);
        s.nodeAbort.delete(nodeId);
        return this._executeNode(s, nodeId);
      }
      const canceled = canceled0
        || (timedOut === false && ac.signal.aborted === true && String(err?.message || '').includes('取消'))
        || String(err?.message || '') === '运行已取消';
      const msg = timedOut ? `节点超时（${Math.round(timeoutMs / 1000)}s）` : String(err.message || err);
      // 失败继续：节点声明 continueOnFail 时以容错输出收尾，下游照常执行
      if (!canceled && err?.code !== 'UNKNOWN_NODE_TYPE' && node.data?.continueOnFail) {
        const out = `(节点失败后继续：${msg})`;
        run.outputs[node.id] = out;
        run.structuredOutputs[node.id] = normalizeExecutionResult(out).structuredOutput;
        run.nodeStates[node.id] = { status: 'success', chars: out.length, durationMs: Date.now() - t0, startedAt, toleratedError: msg };
        this.emit('node-status', { runId: run.runId, nodeId: node.id, status: 'success', toleratedError: msg, chars: out.length, outputPreview: out });
        return this._onNodeDone(s, node.id, false);
      }
      const errDetails = err?.nodeDetails && typeof err.nodeDetails === 'object' ? err.nodeDetails : {};
      run.nodeStates[node.id] = {
        ...errDetails,
        status: canceled ? 'canceled' : 'error', error: canceled ? '运行已取消' : msg,
        durationMs: Date.now() - t0, startedAt,
      };
      this.emit('node-status', {
        runId: run.runId, nodeId: node.id, status: canceled ? 'canceled' : 'error', error: canceled ? '运行已取消' : msg,
        ...(errDetails.trace ? { hasTrace: true, sessionId: errDetails.sessionId } : {}),
        ...(errDetails.turns != null ? { turns: errDetails.turns } : {}),
      });
      this._onNodeDone(s, node.id, !canceled);
    } finally {
      clearTimeout(timer);
      s.nodeAbort.delete(nodeId);
      s.activeCount -= 1;
      this._pump(s);
      this._maybeFinish(s);
    }
  }

  _onNodeDone(s, nodeId, failed) {
    for (const next of s.outgoing.get(nodeId) || []) {
      // 条件分支：源是 condition 且本边分支未命中 → 下游直接跳过（不进入执行）
      if (!failed && !this._edgeTaken(s, nodeId, next)) {
        if (s.run.nodeStates[next] === undefined || s.run.nodeStates[next].status === 'queued') {
          if (s.run.nodeStates[next] === undefined) s.remaining -= 1;
          s.run.nodeStates[next] = { status: 'skipped', error: '条件分支未命中' };
          this.emit('node-status', { runId: s.run.runId, nodeId: next, status: 'skipped', error: '条件分支未命中' });
          this._propagateSkip(s, next); // 只向下传播跳过，不重复扣 remaining
        }
        continue;
      }
      const deg = s.pendingDeps.get(next) - 1;
      s.pendingDeps.set(next, deg);
      if (failed && deg === 0) {
        const upstreamIds = s.incoming.get(next) || [];
        const allBad = upstreamIds.every((id) => {
          const st = s.run.nodeStates[id]?.status;
          return st === 'error' || st === 'skipped' || st === 'canceled';
        });
        if (allBad && (s.run.nodeStates[next] === undefined || s.run.nodeStates[next].status === 'queued')) {
          if (s.run.nodeStates[next] === undefined) s.remaining -= 1;
          s.run.nodeStates[next] = { status: 'skipped' };
          this.emit('node-status', { runId: s.run.runId, nodeId: next, status: 'skipped' });
          this._propagateSkip(s, next);
          continue;
        }
      }
    }
    s.remaining -= 1;
    this._pump(s);
    this._maybeFinish(s);
  }

  // 跳过传播：next 已被标 skipped，将其下游依赖减一并按需连锁跳过；不重复扣 remaining。
  // 合流保护：pendingDeps 归零时若已有 success 上游，则不应跳过，应正常执行（交还 _pump 调度）。
  _propagateSkip(s, skippedId) {
    for (const next of s.outgoing.get(skippedId) || []) {
      const deg = s.pendingDeps.get(next) - 1;
      s.pendingDeps.set(next, deg);
      if (deg > 0) continue;
      if (s.run.nodeStates[next] === undefined || s.run.nodeStates[next].status === 'queued') {
        // 存在 success 上游 → 合流节点仍应执行（不标记 skipped，交给 _pump 调度）
        const upstreamIds = s.incoming.get(next) || [];
        const hasSuccessUpstream = upstreamIds.some((id) => s.run.nodeStates[id]?.status === 'success');
        if (hasSuccessUpstream) continue;
        if (s.run.nodeStates[next] === undefined) s.remaining -= 1;
        s.run.nodeStates[next] = { status: 'skipped' };
        this.emit('node-status', { runId: s.run.runId, nodeId: next, status: 'skipped' });
        this._propagateSkip(s, next);
      }
    }
  }

  _edgeTaken(s, nodeId, next) {
    const srcNode = s.nodes.get(nodeId);
    const kind = getKind(srcNode?.type);
    if (!kind?.edgeTaken) return true;
    const edge = s.edgeMap.get(`${nodeId}>${next}`) || {};
    return kind.edgeTaken(s, srcNode, edge);
  }

  _retryTotal(node) {
    return Number(node.data?.retryCount) > 0 ? Math.min(5, Math.floor(Number(node.data.retryCount))) : 0;
  }

  _retryLeft(node) {
    return node.__retryLeft ?? this._retryTotal(node);
  }

  // ---- 输入/条件/输出节点语义 ----

  templateCtx(node, s) {
    const outputs = new Map();
    const labels = new Map();
    for (const id of s.incoming.get(node.id) || []) {
      outputs.set(id, s.run.outputs[id] ?? '');
      labels.set(id, s.nodes.get(id)?.data?.label || id);
    }
    const structuredOutputs = new Map();
    for (const id of s.incoming.get(node.id) || []) structuredOutputs.set(id, s.run.structuredOutputs?.[id]);
    return {
      outputs, structuredOutputs, labels, incomingIds: s.incoming.get(node.id) || [],
      triggerInput: s.triggerInput, nodeStates: s.run.nodeStates,
      globalVariables: s.globalVariables, workflowVariables: s.workflowVariables, runInputs: s.runInputs,
    };
  }

  _runInputNode(node, s) {
    const parts = [];
    const ctx = this.templateCtx(node, s);
    const upstream = this.renderTemplate('{{$upstream}}', ctx).text;
    if (upstream) parts.push(`上游输入：\n${upstream}`);
    if (node.data?.text) parts.push(this.renderTemplate(node.data.text, ctx).text);
    if (s.triggerInput) parts.push(`[触发输入] ${s.triggerInput}`);
    return parts.filter(Boolean).join('\n\n') || '(输入节点未配置内容)';
  }

  _runConditionNode(node, s) {
    const ctx = this.templateCtx(node, s);
    const src = this.renderTemplate(node.data?.inputTemplate || '{{$upstream}}', ctx).text || '';
    const include = String(node.data?.include || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
    const exclude = String(node.data?.exclude || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
    let branch = 'true';
    if (include.length && !include.some((kw) => src.includes(kw))) branch = 'false';
    if (exclude.length && exclude.some((kw) => src.includes(kw))) branch = 'false';
    const text = `条件判定：${branch}\n依据文本：${src.slice(0, 200)}`;
    return { output: text, data: { branch, source: src, include, exclude } };
  }

  _runOutputNode(node, s) {
    const ctx = this.templateCtx(node, s);
    const rendered = this.renderTemplate(node.data?.inputTemplate || '', ctx);
    return rendered.text || `【输出汇总】\n${this.renderTemplate('{{$upstream}}', ctx).text || '(无上游输入)'}`;
  }
}

// ---------------- 内置节点类型 ----------------
// 全部经由 registerKind 注册，与新类型走完全相同的路径（自证扩展性）。

export const inputKind = registerKind({
  type: 'input',
  async execute({ node, s, engine }) {
    const ctx = engine.templateCtx(node, s);
    const parsedInput = parseTemplate(node.data?.text || '');
    const hasExplicitVariables = parsedInput.references.length > 0;
    let upstream = hasExplicitVariables ? '' : engine.renderTemplate('{{$upstream}}', ctx).text;
    if (/\{\{\s*\$?upstream\s*\}\}/.test(upstream)) upstream = '';
    const configured = node.data?.text ? engine.renderTemplate(node.data.text, { ...ctx, implicitUpstream: false }).text : '';
    const includesTrigger = parsedInput.references.some((ref) => ref.expression.builtin === '$trigger');
    const trigger = !includesTrigger && s.triggerInput ? `[触发输入] ${s.triggerInput}` : '';
    const text = [upstream ? `上游输入：\n${upstream}` : '', configured, trigger].filter(Boolean).join('\n\n') || '(输入节点未配置内容)';
    return {
      output: text,
      data: { text: configured, triggerInput: s.triggerInput || '', upstreamText: upstream },
    };
  },
});

registerKind({
  type: 'condition',
  async execute({ node, engine, s }) {
    let src = engine.renderTemplate(node.data?.inputTemplate || '{{$upstream}}', engine.templateCtx(node, s)).text || '';
    // 防御：渲染器异常残留字面量时按空文本处理
    if (/\{\{\s*\$?upstream\s*\}\}/.test(src)) src = '';
    const include = String(node.data?.include || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
    const exclude = String(node.data?.exclude || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
    let branch = 'true';
    if (include.length && !include.some((kw) => src.includes(kw))) branch = 'false';
    if (exclude.length && exclude.some((kw) => src.includes(kw))) branch = 'false';
    const text = `条件判定：${branch}\n依据文本：${src.slice(0, 200)}`;
    return { output: text, data: { branch, source: src, include, exclude } };
  },
  edgeTaken(s, node, edge) {
    const want = edge.branch || edge.data?.branch || 'true';
    const structuredBranch = s.run.structuredOutputs?.[node.id]?.value?.branch;
    const out = s.run.outputs[node.id] || '';
    const m = out.match(CONDITION_VERDICT_RE);
    return String(structuredBranch || (m ? m[1] : 'true')) === String(want);
  },
});

export const outputKind = registerKind({
  type: 'output',
  wantsSink: true,
  async execute({ node, engine, render, s }) {
    const rendered = render(node.data?.inputTemplate || '');
    return rendered.text || `【输出汇总】\n${engine.renderTemplate('{{$upstream}}', engine.templateCtx(node, s)).text || '(无上游输入)'}`;
  },
});

// 私网地址判定（SSRF 防护）：解析 hostname；IP 字面量判私网段，域名走 DNS 解析后判全部地址
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;
async function assertPublicHost(hostname, allowPrivate) {
  if (allowPrivate) return;
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new Error(`HTTP 节点禁止访问内网地址（${hostname}）；如确需请在节点勾选「允许内网」`);
  }
  if (isIP(h)) {
    if (PRIVATE_IP_RE.test(h)) throw new Error(`HTTP 节点禁止访问内网地址（${h}）；如确需请在节点勾选「允许内网」`);
    return;
  }
  try {
    const addrs = await lookup(h, { all: true });
    for (const { address } of addrs) {
      if (PRIVATE_IP_RE.test(address)) {
        throw new Error(`HTTP 节点禁止访问内网地址（${hostname} → ${address}）；如确需请在节点勾选「允许内网」`);
      }
    }
  } catch (e) {
    if (e?.message?.includes('内网')) throw e;
    throw new Error(`域名解析失败：${hostname}`);
  }
}

// 流式读响应体，最多 maxChars，超出即断开（大响应不撑内存）
async function readBodyCapped(res, maxChars = 65536) {
  const reader = res.body?.getReader?.();
  if (!reader) return { text: await res.text(), truncated: false };
  const dec = new TextDecoder();
  let out = '';
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
    if (out.length > maxChars) {
      truncated = true;
      try { await reader.cancel(); } catch { /* 已断开 */ }
      out = out.slice(0, maxChars);
      break;
    }
  }
  return { text: out, truncated };
}

registerKind({
  type: 'http',
  description: 'HTTP 请求节点',
  async execute({ node, render, signal }) {
    const d = node.data || {};
    const url = render(d.url || '', { implicitUpstream: false }).text.trim();
    if (!/^https?:\/\//.test(url)) throw new Error(`HTTP 节点需要合法 URL（当前：${url.slice(0, 60) || '(空)'}）`);
    const u = new URL(url);
    await assertPublicHost(u.hostname, d.allowPrivate === true);
    const method = String(d.method || 'GET').toUpperCase();
    const headers = {};
    if (d.headers) {
      for (const line of String(d.headers).split(/\n/)) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m) headers[m[1].trim()] = render(m[2], { implicitUpstream: false }).text;
      }
    }
    const body = d.body ? render(d.body, { implicitUpstream: false }).text : undefined;
    if (body && !headers['Content-Type'] && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    // 重定向手动跟随（最多 3 跳）：fetch 默认静默跟随，跨协议/内网跳转不可见
    let cur = u;
    let res;
    for (let hop = 0; ; hop++) {
      const init = {
        method: hop === 0 ? method : 'GET', headers,
        body: hop === 0 && body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
        redirect: 'manual', signal,
      };
      res = await fetch(cur, init); // eslint-disable-line no-await-in-loop
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= 3) throw new Error(`HTTP 重定向超过 3 跳（${cur}）`);
        const nextUrl = new URL(res.headers.get('location'), cur);
        await assertPublicHost(nextUrl.hostname, d.allowPrivate === true);
        cur = nextUrl;
        continue;
      }
      break;
    }
    const { text, truncated } = await readBodyCapped(res, Number(d.maxChars) > 0 ? Number(d.maxChars) : 65536);
    const head = `HTTP ${res.status} ${res.statusText || ''}`.trim();
    const note = truncated ? `\n（响应超过上限，已截断）` : '';
    const outText = `${head}\n${text}${note}`;
    let jsonBody;
    try { jsonBody = JSON.parse(text); } catch { jsonBody = null; }
    const sensitiveHeaders = new Set(['set-cookie', 'cookie', 'authorization', 'proxy-authorization', 'www-authenticate', 'proxy-authenticate']);
    const headersOut = Object.fromEntries([...res.headers.entries()].filter(([name]) => !sensitiveHeaders.has(name.toLowerCase())));
    const data = {
      status: res.status, ok: res.ok, headers: headersOut, body: text,
      json: jsonBody, url: String(cur), method, truncated,
    };
    if (d.failOnError !== false && !(res.status >= 200 && res.status < 300)) {
      const err = new Error(`HTTP ${res.status}（${method} ${cur.host}${cur.pathname}）${text.slice(0, 120)}`);
      err.httpStatus = res.status;
      err.httpOutput = outText; // 供 continueOnFail / 错误输出引用
      throw err;
    }
    return { output: outText, data };
  },
  lint(node) {
    const issues = [];
    const url = String(node.data?.url || '').trim();
    if (!url) issues.push({ level: 'error', message: `HTTP 节点「${node.data?.label || node.id}」未配置 URL` });
    else if (!/^https?:\/\//.test(url.replace(/\{\{.*?\}\}/g, 'x'))) {
      issues.push({ level: 'warn', message: `HTTP 节点「${node.data?.label || node.id}」的 URL 不以 http(s):// 开头` });
    }
    if (node.data?.allowPrivate === true) {
      issues.push({ level: 'warn', message: `HTTP 节点「${node.data?.label || node.id}」允许访问内网地址（SSRF 风险自担）` });
    }
    return issues;
  },
});

registerKind({
  type: 'script',
  async execute({ node, s, engine, signal, runId, workflowId }) {
    if (!engine.scriptRunner) throw new Error('script 执行器未注入（宿主初始化异常）');
    const input = resolveScriptInputs(node.data?.inputs || [], engine.templateCtx(node, s));
    const schema = getScriptOutputSchema(node.data?.outputSchema);
    const executed = await engine.scriptRunner({
      node,
      input,
      signal,
      runId,
      workflowId,
      timeoutMs: normalizeScriptTimeout(node.data?.scriptTimeoutMs),
    });
    validateScriptOutput(executed.value, schema);
    return {
      output: JSON.stringify(executed.value, null, 2),
      data: executed.value,
      ...(schema ? { schema } : {}),
      artifacts: executed.artifacts || [],
      runtime: 'quickjs',
      input,
      workspaceStats: executed.workspaceStats || {},
    };
  },
  lint(node, lintCtx = {}) {
    const issues = [];
    const label = node.data?.label || node.id;
    const code = String(node.data?.code || '');
    if (!code.trim()) issues.push({ level: 'error', message: `脚本节点「${label}」未配置代码` });
    else if (Buffer.byteLength(code) > SCRIPT_LIMITS.maxCodeBytes) issues.push({ level: 'error', message: `脚本节点「${label}」源码超过 ${SCRIPT_LIMITS.maxCodeBytes} 字节上限` });
    else if (!/\bfunction\s+main\s*\(/.test(code)) issues.push({ level: 'error', message: `脚本节点「${label}」必须声明 function main(input, workspace)` });
    const timeout = Number(node.data?.scriptTimeoutMs ?? SCRIPT_LIMITS.defaultTimeoutMs);
    if (!Number.isFinite(timeout) || timeout < SCRIPT_LIMITS.minTimeoutMs || timeout > SCRIPT_LIMITS.maxTimeoutMs) {
      issues.push({ level: 'error', message: `脚本节点「${label}」超时必须在 ${SCRIPT_LIMITS.minTimeoutMs}-${SCRIPT_LIMITS.maxTimeoutMs}ms 之间` });
    }
    issues.push(...lintScriptInputs(node.data?.inputs || [], {
      nodes: lintCtx.graph?.nodes || [],
      incomingIds: lintCtx.incomingIds || [],
    }));
    try { getScriptOutputSchema(node.data?.outputSchema); }
    catch (error) { issues.push({ level: 'error', message: `脚本节点「${label}」输出 Schema 无效：${error.message}` }); }
    return issues;
  },
});

// agent：执行体由宿主注入（index.js 的 runAgentNode——进程内 dsh agent 驱动）。
// 注册成 kind 让试运行/统一分发路径可用；lint 检查提示词。
registerKind({
  type: 'agent',
  async execute(ctx) {
    if (!ctx.engine.nodeRunner) throw new Error('agent 执行器未注入（宿主初始化异常）');
    return ctx.engine.nodeRunner(ctx.node, ctx.s.run, ctx.s, {
      signal: ctx.signal, emit: ctx.emit, runId: ctx.runId,
    });
  },
  lint(node) {
    const issues = [];
    if (!String(node.data?.prompt || '').trim()) {
      issues.push({ level: 'warn', message: `智能体「${node.data?.label || node.id}」未填写提示词，将使用默认助手人设` });
    }
    try { getAgentOutputConfig(node.data || {}); }
    catch (error) { issues.push({ level: 'error', message: `智能体「${node.data?.label || node.id}」输出 Schema 无效：${error.message}` }); }
    return issues;
  },
});

// 消息通知是运行级观察器；节点执行本身只负责在线路中透传数据。
registerKind({
  type: 'notify',
  passThrough: true,
  observer: true,
  async execute() { return ''; },
  lint(node, lintCtx) {
    return validateNotificationNodeData(node.data, lintCtx.notificationChannels);
  },
});

// 注释节点：画布上的说明便签，不参与执行。passThrough 让引擎跳过执行并把
// 其上游输出原样转发给下游（图结构语义不变，纯标注用途）。
registerKind({
  type: 'note',
  passThrough: true,
  async execute() { return ''; }, // 不会被调用（passThrough 短路），保底实现
});

// ---- 图静态校验（lint）----
// 返回 { ok, issues: [{level:'error'|'warn', nodeId?, message}] }
export function lintGraph(graph, options = {}) {
  const issues = [];
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return { ok: false, issues: [{ level: 'error', message: '图中没有节点' }] };
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const labels = new Map(graph.nodes.map((n) => [n.id, n.data?.label || n.id]));
  const labelCount = {};
  for (const [, l] of labels) labelCount[l] = (labelCount[l] || 0) + 1;

  // 环检测（Kahn）
  const deg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const adj = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges || []) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    adj.get(e.source).push(e.target);
    deg.set(e.target, deg.get(e.target) + 1);
  }
  const q = graph.nodes.filter((n) => deg.get(n.id) === 0).map((n) => n.id);
  let seen = 0;
  while (q.length) { const id = q.shift(); seen++; for (const nx of adj.get(id)) { deg.set(nx, deg.get(nx) - 1); if (deg.get(nx) === 0) q.push(nx); } }
  if (seen !== graph.nodes.length) issues.push({ level: 'error', message: '图中存在环，无法执行' });

  const incomingIds = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges || []) {
    if (nodes.has(e.source) && nodes.has(e.target)) incomingIds.get(e.target).push(e.source);
  }

  for (const n of graph.nodes) {
    const d = n.data || {};
    const label = d.label || n.id;
    if (n.type === 'note') continue; // 注释节点不参与任何结构检查
    // 类型专属检查：注册表 lint 钩子（http URL、后续新类型）
    const kind = getKind(n.type);
    if (!kind) {
      issues.push({ level: 'error', nodeId: n.id, message: `未知节点类型：${n.type || '(空)'}` });
    } else if (kind.lint) {
      const lintCtx = lintContextFor(graph, nodes, labels, labelCount, incomingIds.get(n.id) || [], options);
      for (const iss of kind.lint(n, lintCtx) || []) issues.push({ nodeId: n.id, ...iss });
    }

    const templateFields = [d.text, d.inputTemplate, d.url, d.headers, d.body];
    for (const field of templateFields) {
      if (!field) continue;
      const checked = validateTemplate(field, {
        nodes: graph.nodes,
        incomingIds: incomingIds.get(n.id) || [],
      });
      for (const issue of checked.issues) {
        if (issue.level === 'info') continue;
        issues.push({
          level: issue.level,
          nodeId: n.id,
          code: issue.code,
          message: `「${label}」模板：${issue.message}`,
        });
      }
    }
    if (n.type === 'output' && (incomingIds.get(n.id) || []).length === 0) {
      issues.push({ level: 'warn', nodeId: n.id, message: `输出节点「${label}」没有上游连线` });
    }
    if (labelCount[label] > 1) {
      issues.push({ level: 'warn', nodeId: n.id, message: `存在多个名为「${label}」的节点，模板引用可能歧义` });
    }
  }
  return { ok: !issues.some((i) => i.level === 'error'), issues };
}
