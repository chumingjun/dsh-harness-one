// 编排器 v0.3：并发调度器。
// - 节点"就绪即发"（全部上游成功即并行执行，不再全局拓扑串行）
// - 失败沿下游传播为 skipped，其他分支不受影响
// - 事件通过 EventEmitter 广播（run-start / node-status / run-end / run-error）

import { EventEmitter } from 'node:events';
import { agentToolSet } from './tools.js';
import { extractFeishuLinks } from './feishu.js';
import { renderTemplate } from './template.js';
import { runPlanExecute } from './plan-mode.js';
import { listSkills, skillIndexPrompt } from './skills.js';
import { workspaceFor, wsList } from './workspace.js';
import { detectDsh, runDshTask } from './agent-runtime.js';
import { resolveScriptInputs } from '../dsh-plugins/dsh-ccpg-orchestrator/lib/typed-expression.js';
import { runScript } from '../dsh-plugins/dsh-ccpg-orchestrator/lib/script-runner.js';
import { validateScriptOutput } from '../dsh-plugins/dsh-ccpg-orchestrator/lib/script-schema.js';

let runSeq = 0;

export class Orchestrator extends EventEmitter {
  constructor({ llm, toolExecutor, feishu }) {
    super();
    this.llm = llm;
    this.toolExecutor = toolExecutor;
    this.feishu = feishu;
    this.history = [];
  }

  async run(graph, { triggerInput = '' } = {}) {
    const runId = `run_${Date.now()}_${++runSeq}`;
    const run = {
      runId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      mode: this.llm.name,
      nodeStates: {},
      outputs: {},
      structuredOutputs: {},
    };
    this.history.unshift(run);
    if (this.history.length > 50) this.history.pop();

    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const incoming = new Map();
    const outgoing = new Map();
    const pendingDeps = new Map();
    for (const n of graph.nodes) {
      incoming.set(n.id, []);
      outgoing.set(n.id, []);
      pendingDeps.set(n.id, 0);
    }
    for (const e of graph.edges) {
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
      outgoing.get(e.source).push(e.target);
      incoming.get(e.target).push(e.source);
      pendingDeps.set(e.target, pendingDeps.get(e.target) + 1);
    }

    // 孤立环检测：Kahn 计数
    const deg = new Map(pendingDeps);
    const q = graph.nodes.filter((n) => deg.get(n.id) === 0).map((n) => n.id);
    let seen = 0;
    while (q.length) {
      const id = q.shift();
      seen++;
      for (const next of outgoing.get(id)) {
        deg.set(next, deg.get(next) - 1);
        if (deg.get(next) === 0) q.push(next);
      }
    }
    if (seen !== graph.nodes.length) {
      run.status = 'error';
      run.error = '图中存在环，无法执行';
      this.emit('run-error', { runId, error: run.error });
      return run;
    }

    this.emit('run-start', { runId, mode: run.mode, nodeIds: graph.nodes.map((n) => n.id) });

    // 附件清单：输入节点配置的附件引用（运行时注入上游）
    const attachmentRefs = graph.nodes
      .filter((n) => n.type === 'input')
      .flatMap((n) => (n.data?.attachments || []).map((a) => ({ filename: a.filename, size: a.size })));

    const done = new Promise((resolve) => { run._resolve = resolve; });
    this._scheduler = { run, nodes, incoming, outgoing, pendingDeps, triggerInput, attachmentRefs, remaining: graph.nodes.length };
    this._pump();
    await done;

    run.status = Object.values(run.nodeStates).some((s) => s.status === 'error') ? 'error' : 'success';
    run.finishedAt = new Date().toISOString();
    this.emit('run-end', { runId, status: run.status });
    return run;
  }

  // 就绪队列泵：把待命依赖为 0 的节点并发发射
  _pump() {
    const s = this._scheduler;
    if (!s) return;
    for (const [nodeId, deg] of s.pendingDeps) {
      if (deg === 0 && s.run.nodeStates[nodeId] === undefined) {
        s.run.nodeStates[nodeId] = { status: 'queued' };
        this.emit('node-status', { runId: s.run.runId, nodeId, status: 'queued' });
        this._executeNode(s.nodes.get(nodeId)).catch(() => {});
      }
    }
  }

  async _executeNode(node) {
    const s = this._scheduler;
    const { run } = s;
    const toolCtx = { attachments: s.attachmentRefs };
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    this.emit('node-status', { runId: run.runId, nodeId: node.id, status: 'running' });
    try {
      let output;
      let modelUsed = null;
      let extra = null;
      if (node.type === 'input') {
        output = await this._runInputNode(node, s);
      } else if (node.type === 'agent') {
        ({ output, model: modelUsed, ...extra } = await this._runAgentNode(node, run, s, toolCtx));
      } else if (node.type === 'script') {
        const result = await this._runScriptNode(node, run, s);
        output = result.output;
        extra = result;
      } else if (node.type === 'output') {
        const tpl = this._templateCtx(node, run, s);
        const rendered = renderTemplate(node.data?.inputTemplate || '', tpl);
        output = rendered.text || `【输出汇总】\n${this._upstreamText(node, run, s) || '(无上游输入)'}`;
      } else {
        output = `(未知节点类型: ${node.type})`;
      }
      run.outputs[node.id] = output;
      if (extra?.data !== undefined) run.structuredOutputs[node.id] = { version: 1, type: 'json', mediaType: 'application/json', value: extra.data, ...(extra.schema ? { schema: extra.schema } : {}) };
      const state = {
        status: 'success', chars: output.length,
        durationMs: Date.now() - t0, startedAt,
        ...(modelUsed ? { model: modelUsed } : {}),
        ...(extra?.provenance || extra?.trace ? { ...extra.provenance, ...(extra.trace ? { planTrace: extra.trace } : {}) } : {}),
        ...(extra?.artifacts?.length ? { artifacts: extra.artifacts } : {}),
        ...(extra?.runtime ? { runtime: extra.runtime } : {}),
        ...(extra?.input !== undefined ? { input: extra.input } : {}),
      };
      run.nodeStates[node.id] = state;
      // 输出随事件回传前端（预览截断），供节点面板即时展示
      this.emit('node-status', {
        runId: run.runId, nodeId: node.id, status: 'success', chars: output.length,
        ...(modelUsed ? { model: modelUsed } : {}),
        outputPreview: String(output).slice(0, 4000),
        ...(extra?.trace ? { trace: extra.trace } : {}),
        ...(extra?.artifacts?.length ? { artifacts: extra.artifacts } : {}),
        ...(extra?.runtime ? { runtime: extra.runtime } : {}),
      });
      this._onNodeDone(node.id, false);
    } catch (err) {
      const msg = String(err.message || err);
      run.nodeStates[node.id] = { status: 'error', error: msg, durationMs: Date.now() - t0, startedAt };
      this.emit('node-status', { runId: run.runId, nodeId: node.id, status: 'error', error: msg });
      this._onNodeDone(node.id, true);
    }
  }

  _onNodeDone(nodeId, failed) {
    const s = this._scheduler;
    for (const next of s.outgoing.get(nodeId)) {
      const deg = s.pendingDeps.get(next) - 1;
      s.pendingDeps.set(next, deg);
      // 失败传播：某上游失败后，若该节点其余上游也都已失败/跳过（不可能再有成功输入），才跳过；
      // 仍有上游在跑或已成功的节点照常执行（缺失的输入按空处理）。
      if (failed && deg === 0) {
        const upstreamIds = s.incoming.get(next) || [];
        const allBad = upstreamIds.every((id) => {
          const st = s.run.nodeStates[id]?.status;
          return st === 'error' || st === 'skipped';
        });
        if (allBad && (s.run.nodeStates[next] === undefined || s.run.nodeStates[next].status === 'queued')) {
          s.run.nodeStates[next] = { status: 'skipped' };
          this.emit('node-status', { runId: s.run.runId, nodeId: next, status: 'skipped' });
          this._onNodeDone(next, true); // 递归传播
          continue;
        }
      }
    }
    s.remaining -= 1;
    this._pump();
    if (s.remaining === 0) {
      this._scheduler = null;
      runDone(s.run);
    }
  }

  // ---- 节点执行 ----

  async _runInputNode(node, s) {
    const triggerInput = s.triggerInput;
    // 文本本身支持 {{上游}}/{{$trigger}} 变量；无变量时保持旧行为（上游全量 + 文本 + 触发输入顺次拼接）
    const tpl = this._templateCtx(node, s.run, s);
    const rendered = renderTemplate(node.data?.text || '', tpl);
    const parts = [];
    if (rendered.text) parts.push(rendered.text);
    if (triggerInput && !/\{\{\s*\$trigger\s*\}\}/.test(node.data?.text || '')) {
      parts.push(`[触发输入] ${triggerInput}`);
    }

    // 附件：直接展开文本附件内容注入
    for (const att of node.data?.attachments || []) {
      try {
        const { readFileSync } = await import('node:fs');
        const { join, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'attachments');
        const content = readFileSync(join(dir, att.filename), 'utf8');
        parts.push(`[附件 ${att.filename}]\n${content.slice(0, 8000)}`);
      } catch {
        parts.push(`[附件 ${att.filename}]（二进制，智能体可通过 read_file 工具按需读取）`);
      }
    }

    // 飞书链接：解析并注入文档内容（未配置凭据时为占位说明）
    const links = extractFeishuLinks(node.data?.text || '').concat(extractFeishuLinks(triggerInput));
    for (const link of links.slice(0, 3)) {
      if (!this.feishu?.enabled) {
        parts.push(`[飞书文档 ${link.url}] 未配置 FEISHU_APP_ID/FEISHU_APP_SECRET，识别到 ${link.type} token=${link.token}；配置后此处将注入文档全文。`);
        continue;
      }
      try {
        const { objType, token } = await this.feishu.resolveToken(link.type, link.token);
        if (objType !== 'docx') {
          parts.push(`[飞书文档 ${link.url}] 暂不支持 ${objType} 类型`);
        } else {
          parts.push(`[飞书文档]\n${await this.feishu.docToMarkdown(token)}`);
        }
      } catch (e) {
        parts.push(`[飞书文档 ${link.url}] 读取失败: ${e.message}`);
      }
    }

    const result = parts.filter(Boolean).join('\n\n');
    return result || '(输入节点未配置内容)';
  }

  async _runScriptNode(node, run, s, signal) {
    const ws = workspaceFor(node);
    const context = this._templateCtx(node, run, s);
    const input = resolveScriptInputs(node.data?.inputs || [], context);
    const result = await runScript({
      code: node.data?.code,
      input,
      workspaceDir: ws,
      timeoutMs: node.data?.scriptTimeoutMs,
      signal,
    });
    const schema = validateScriptOutput(result.value, node.data?.outputSchema);
    const artifacts = wsList(ws).split('\n').filter((line) => line && line !== '(空)').map((line) => line.replace(/ \(\d+B\)$/, '')).slice(0, 30);
    return {
      output: JSON.stringify(result.value, null, 2),
      data: result.value,
      ...(schema ? { schema } : {}),
      artifacts,
      runtime: 'quickjs',
      input,
    };
  }

  async _runAgentNode(node, run, s, toolCtx) {
    // ---- agent harness 系统提示词：身份 + 工作区 + 技能目录 + 自主性约定 ----
    const ws = workspaceFor(node); // 该节点专属工作目录（跨运行保留，产物落盘）
    toolCtx.ws = ws;
    const promptContext = { ...this._templateCtx(node, run, s), implicitUpstream: false };
    const renderedPrompt = renderTemplate(node.data?.prompt || '你是一个帮助完成任务的助手。', promptContext);
    let systemPrompt = `${renderedPrompt.text}

你是一个独立运行的智能体，自主决定步骤完成下面的任务：
- 你有自己的工作目录，ws_write/ws_read/ws_list 可读写其中的文件。最终交付物（报告/工单/回复稿等）必须用 ws_write 落盘成文件；中间产物也建议落盘。
- 有可用的技能目录时，先用 load_skill 加载对应规范再动手，输出遵守规范。
- 完成后在最终回复里给出交付物文件清单（文件名 + 一句话说明），不要把文件全文复述一遍。`;

    // 技能：目录索引进 systemPrompt，正文由模型按需 load_skill（渐进式）
    const skillIds = Array.isArray(node.data?.skills) ? node.data.skills : [];
    if (skillIds.length) {
      const all = listSkills();
      const selected = all.filter((sk) => skillIds.includes(sk.id) || skillIds.includes(sk.name));
      if (selected.length) systemPrompt += `\n\n${skillIndexPrompt(selected)}`;
    }
    // 用户提示词 = 模板渲染（{{上游节点名}} 变量引用；无变量时回退全量上游注入）
    const tpl = this._templateCtx(node, run, s);
    const rendered = renderTemplate(node.data?.inputTemplate || '', tpl);
    let userPrompt = rendered.text || '(无上游输入)';
    const attachmentsNote = s.attachmentRefs.length
      ? `\n\n可用附件清单（可用 read_file 工具读取）：${s.attachmentRefs.map((a) => a.filename).join(', ')}`
      : '';
    userPrompt += attachmentsNote;

    // 节点级 LLM 路由：model / channel 覆盖全局默认
    const llm = this.llm.forNode
      ? this.llm.forNode({ model: node.data?.model, channel: node.data?.channel })
      : this.llm;
    const maxRounds = node.data?.maxRounds ? Number(node.data.maxRounds) : undefined;
    const usedModel = llm.model || llm.name;

    const selected = node.data?.tools || [];
    // agent 完整工具表：勾选的外部工具 + 工作区三件套 + load_skill（基础能力常驻）
    const tools = agentToolSet(selected);
    const executeTool = this.toolExecutor
      ? (name, args) => this.toolExecutor.execute(name, args, toolCtx)
      : null;

    try {
      // ---- 运行时优先级：dsh 底座（真实 agent harness）→ 内置工具循环 ----
      // planMode 仍走内置三阶段（dsh headless 单任务模式无阶段切分）。
      const dsh = detectDsh();
      if (dsh.available && !node.data?.planMode) {
        const task = `${systemPrompt}\n\n----\n任务输入：\n${userPrompt}`;
        try {
          const out = await runDshTask({ node: dsh.node, bin: dsh.bin, cwd: ws, task });
          let artifacts = [];
          try { artifacts = wsList(ws).split('\n').filter((l) => l && l !== '(空)').slice(0, 30); } catch { /* 忽略 */ }
          return { output: out, model: 'dsh:' + (node.data?.model || 'glm-5.3'), runtime: 'dsh', artifacts };
        } catch (e) {
          // dsh 失败不炸节点：回退内置循环继续
          run.nodeStates[node.id] = { status: 'running', note: `dsh 失败回退内置: ${String(e.message).slice(0, 120)}` };
        }
      }
      let out;
      let trace;
      if (node.data?.planMode) {
        // Plan → Exec → 总结 三阶段
        ({ output: out, trace } = await runPlanExecute(llm, { systemPrompt, userPrompt, tools, executeTool, maxRounds }));
      } else {
        out = await llm.chat({ systemPrompt, userPrompt, tools, executeTool, maxRounds });
      }
      const provenance = rendered.missing.length ? { missingVars: rendered.missing } : undefined;
      // 工作区产物清单（agent 落盘的文件），随状态/SSE 回传前端
      let artifacts = [];
      try { artifacts = wsList(ws).split('\n').filter((l) => l && l !== '(空)').slice(0, 30); } catch { /* 工作区异常不阻塞 */ }
      return { output: out, model: usedModel, runtime: 'builtin', provenance, artifacts, ...(trace ? { trace } : {}) };
    } catch (e) {
      e.message = `[${usedModel}] ${e.message}`;
      throw e;
    }
  }

  _templateCtx(node, run, s) {
    const outputs = new Map();
    const labels = new Map();
    for (const id of s.incoming.get(node.id) || []) {
      outputs.set(id, run.outputs[id] ?? '');
      labels.set(id, s.nodes.get(id)?.data?.label || id);
    }
    return { outputs, labels, incomingIds: s.incoming.get(node.id) || [], triggerInput: s.triggerInput };
  }

  _upstreamText(node, run, s) {
    return renderTemplate('{{$upstream}}', this._templateCtx(node, run, s)).text;
  }
}

function runDone(run) { run._resolve?.(); }
