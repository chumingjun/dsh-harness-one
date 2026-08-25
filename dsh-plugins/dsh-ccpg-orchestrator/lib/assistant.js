// dsh-ccpg-orchestrator 画布助手工具集（AI 对话改图）。
// 官方 Web UI「工作流」tab（dsh-ccpg-canvasui）与官方聊天共用同一 dsh session；
// 本模块为该 session 的 agent 注册 canvas_* 工具：AI 像用 bash 一样调工具改画布，
// 服务端校验（validateGraphOps）→ 广播 assistant-patch SSE → 画布落图（可撤销）→
// 工具结果回 agent 继续推理。
// 纯函数部分（校验/ops 应用）与宿主解耦，可单测；宿主接线在 index.js。

import { lintGraph } from './engine.js';

// ---- 已知节点类型（与前端 registry.jsx、引擎 nodeKinds 对齐）----
const NODE_TYPES = ['input', 'agent', 'script', 'condition', 'http', 'output', 'notify', 'note'];

// 服务端生成的节点 id：与前端 n_<type>_<ts><rand> 风格区分，AI 引用稳定
export function newCanvasNodeId() {
  return `n_a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
export function newCanvasEdgeId() {
  return `e_a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 成环检测：在图上加 from→to 后是否出现环（DFS）
export function wouldCreateCycle(nodes, edges, from, to) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e.target);
  }
  if (!adj.has(from)) adj.set(from, []);
  adj.get(from).push(to);
  const seen = new Set();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) || []) stack.push(nxt);
  }
  return false;
}

// ---- 校验并应用一批 ops 到图（纯函数：返回 {ok, graph, patch, errors}）----
// patch 是广播给画布的规范化操作数组（服务端生成 id，前端按 id 落图，保证 AI 后续引用一致）。
// 原子性：任一 op 失败整批拒绝（画布不会停在半改状态）。
export function validateGraphOps(graph, ops) {
  const errors = [];
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { ok: false, errors: ['缺少有效画布图（先让用户打开工作流画布）'] };
  }
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, errors: ['ops 必须是非空数组'] };
  if (ops.length > 60) return { ok: false, errors: [`单批 ops 上限 60，收到 ${ops.length}`] };

  // 工作副本：逐 op 应用到副本，全部成功才对外可见
  const nodes = graph.nodes.map((n) => ({ ...n, data: { ...n.data } }));
  const edges = graph.edges.map((e) => ({ ...e }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const patch = [];

  const fail = (i, msg) => errors.push(`ops[${i}]: ${msg}`);

  ops.forEach((op, i) => {
    if (!isPlainObject(op) || typeof op.op !== 'string') { fail(i, '缺少 op 字段'); return; }
    switch (op.op) {
      case 'addNode': {
        const type = NODE_TYPES.includes(op.type) ? op.type : null;
        if (!type) { fail(i, `未知节点类型 "${op.type}"（可用：${NODE_TYPES.join('/')}）`); return; }
        const label = String(op.label || '').trim() || null;
        if (op.after !== undefined && !byId.has(op.after)) { fail(i, `after 引用的节点 "${op.after}" 不存在`); return; }
        const id = newCanvasNodeId();
        const data = isPlainObject(op.data) ? { ...op.data } : {};
        if (label) data.label = label;
        const after = op.after !== undefined ? byId.get(op.after) : null;
        const position = after
          ? { x: (after.position?.x || 0) + 320, y: (after.position?.y || 0) + (after.data?.__assistantOffset || 0) }
          : (isPlainObject(op.position) && Number.isFinite(op.position.x) && Number.isFinite(op.position.y)
            ? { x: op.position.x, y: op.position.y }
            : { x: 80 + (patch.filter((p) => p.op === 'addNode').length * 60), y: 80 + (patch.filter((p) => p.op === 'addNode').length * 180) });
        const node = { id, type, position, data };
        nodes.push(node);
        byId.set(id, node);
        patch.push({ op: 'addNode', id, type, position, data });
        if (after && op.connect !== false) {
          const branch = type === 'condition' ? undefined : op.branch;
          const edgeId = newCanvasEdgeId();
          edges.push({ id: edgeId, source: after.id, target: id, ...(branch ? { branch } : {}) });
          patch.push({ op: 'connect', id: edgeId, from: after.id, to: id, ...(branch ? { branch } : {}) });
        }
        break;
      }
      case 'updateNode': {
        if (!byId.has(op.id)) { fail(i, `节点 "${op.id}" 不存在`); return; }
        if (!isPlainObject(op.data)) { fail(i, 'data 必须是对象'); return; }
        const node = byId.get(op.id);
        Object.assign(node.data, op.data);
        patch.push({ op: 'updateNode', id: op.id, data: { ...op.data } });
        break;
      }
      case 'renameNode': {
        if (!byId.has(op.id)) { fail(i, `节点 "${op.id}" 不存在`); return; }
        const label = String(op.label || '').trim();
        if (!label) { fail(i, 'label 不能为空'); return; }
        byId.get(op.id).data.label = label;
        patch.push({ op: 'updateNode', id: op.id, data: { label } });
        break;
      }
      case 'deleteNode': {
        if (!byId.has(op.id)) { fail(i, `节点 "${op.id}" 不存在`); return; }
        byId.delete(op.id);
        for (let k = nodes.length - 1; k >= 0; k -= 1) if (nodes[k].id === op.id) nodes.splice(k, 1);
        for (let k = edges.length - 1; k >= 0; k -= 1) {
          if (edges[k].source === op.id || edges[k].target === op.id) edges.splice(k, 1);
        }
        patch.push({ op: 'deleteNode', id: op.id });
        break;
      }
      case 'connect': {
        if (!byId.has(op.from)) { fail(i, `from 节点 "${op.from}" 不存在`); return; }
        if (!byId.has(op.to)) { fail(i, `to 节点 "${op.to}" 不存在`); return; }
        if (op.from === op.to) { fail(i, '不能自连'); return; }
        if (edges.some((e) => e.source === op.from && e.target === op.to)) { fail(i, '边已存在'); return; }
        if (wouldCreateCycle(nodes, edges, op.from, op.to)) { fail(i, '这条边会构成环'); return; }
        const edgeId = newCanvasEdgeId();
        edges.push({ id: edgeId, source: op.from, target: op.to, ...(op.branch ? { branch: String(op.branch) } : {}) });
        patch.push({ op: 'connect', id: edgeId, from: op.from, to: op.to, ...(op.branch ? { branch: String(op.branch) } : {}) });
        break;
      }
      case 'deleteEdge': {
        const k = edges.findIndex((e) => e.id === op.id || (op.from !== undefined && op.to !== undefined && e.source === op.from && e.target === op.to));
        if (k < 0) { fail(i, `边不存在（${op.id || `${op.from}→${op.to}`}）`); return; }
        const [removed] = edges.splice(k, 1);
        patch.push({ op: 'deleteEdge', id: removed.id });
        break;
      }
      case 'updateEdge': {
        const e = edges.find((x) => x.id === op.id);
        if (!e) { fail(i, `边 "${op.id}" 不存在`); return; }
        if (op.branch !== undefined) e.branch = String(op.branch);
        patch.push({ op: 'updateEdge', id: op.id, ...(op.branch !== undefined ? { branch: String(op.branch) } : {}) });
        break;
      }
      default:
        fail(i, `未知操作 "${op.op}"（可用：addNode/updateNode/renameNode/deleteNode/connect/deleteEdge/updateEdge）`);
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, graph: { nodes, edges }, patch };
}

// ---- AI 可见的画布图概要（控制上下文体积；完整图让 AI 调 canvas_get_graph）----
export function summarizeGraphForAI(graph) {
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes)) return { nodes: [], edges: [] };
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.data?.label || n.id,
      ...(n.type === 'agent' ? {
        tools: Array.isArray(n.data?.tools) ? n.data.tools : [],
        model: n.data?.model,
        promptChars: String(n.data?.prompt || '').length,
      } : {}),
      ...(n.type === 'script' ? {
        language: 'javascript',
        inputNames: Array.isArray(n.data?.inputs) ? n.data.inputs.map((entry) => entry?.name).filter(Boolean) : [],
        codeChars: String(n.data?.code || '').length,
        hasOutputSchema: Boolean(n.data?.outputSchema),
      } : {}),
      ...(n.type === 'condition' ? { include: n.data?.include, exclude: n.data?.exclude } : {}),
      ...(n.type === 'http' ? { url: n.data?.url, method: n.data?.method } : {}),
      ...(n.type === 'notify' ? { channel: n.data?.channel, mode: n.data?.mode, targetType: n.data?.channelConfig?.targetType } : {}),
    })),
    edges: (graph.edges || []).map((e) => ({ from: e.source, to: e.target, ...(e.branch ? { branch: e.branch } : {}) })),
  };
}

// ---- 校验 + lint 合并报告（graph_patch 执行体用）----
export function checkPatchResult(nextGraph) {
  const lint = lintGraph(nextGraph);
  return {
    lintOk: lint.ok,
    issues: lint.issues.map((x) => `[${x.level}]${x.nodeId ? `(${x.nodeId})` : ''} ${x.message}`),
  };
}

// ---- 助手 persona：图 schema 文档 + 操作规范 ----
export function canvasAssistantPersona() {
  return `你是「物业工作流画布」的 AI 助手，帮助用户创建/修改/测试节点式工作流。用户在聊天里提需求，你调用画布工具落图。

## 画布模型
- 图 = 节点 + 有向边。节点类型 8 种：
  - input 输入：data.text 触发文本模板（支持 {{变量}}）
  - agent 智能体：data.prompt 系统提示词、data.inputTemplate 输入模板（{{上游节点名}} 引用上游输出）、data.tools 工具名数组（如 feishu_doc_read/web_fetch）、data.model/data.channel 可选
  - script 脚本：固定 JavaScript；data.inputs 为命名参数数组，每项用 expression 完整变量或 value JSON 常量；data.code 必须声明同步 function main(input, workspace) 并返回 JSON；workspace 仅可 list/read/write/remove 当前节点工作区；可选 data.outputSchema 和 data.scriptTimeoutMs（100-10000）
  - condition 条件：data.include/data.exclude 逗号分隔关键词，命中走 true 边否则 false 边；条件节点的两条出边必须 branch="true"/"false"
  - http 请求：data.url/method/headers/body
  - output 输出：汇聚展示，可选 data.writeback 飞书写回
  - notify 消息通知：运行级观察器，可独立放置或在线路中透传；data.channel="feishu"、data.mode="terminal"|"each_node"；群聊使用 data.channelConfig.targetType="chat_id" + oc_ 开头的群 ID，私聊使用 targetType="open_id" + ou_ 开头的用户 open_id；data.channelConfig.credentialId 可选
  - note 注释：不执行，data.text 说明文字
- 节点 label 用中文短名（如「分类智能体」）；上下游引用靠 label（{{分类智能体}}）。

## 操作规范
1. 改图一律用 canvas_graph_patch（当前画布/草稿）或 workflow_patch（已保存工作流，按 id）；一批 ops 原子生效，出错整批拒绝会返回错误让你修正；不要试图整图重写。
2. 新节点接入链路：addNode 带 after=<上游节点id> 自动连线；显式连线用 connect。
3. 每次改完调 canvas_lint_graph 自检；有 error 必须修掉再回复用户。
4. 运行：当前画布用 canvas_run_workflow；按工作流 id/name 运行用 workflow_run。两者都异步返回 runId，用 canvas_run_status / workflow_run_status 轮询，或 workflow_runs 查列表。
5. 用户问「有哪些工作流」「现在在跑什么、什么状态」：workflow_list / workflow_runs（onlyLive 只看运行中）。取消/终止运行用 workflow_run_cancel。
6. 管理已保存工作流（新建/改名/复制/删除）用 workflow_create / workflow_patch(name) / workflow_delete；删除必须 confirm:true，有关联运行/定时/webhook 时工具会拒绝并列出关联。
7. 让用户屏幕切到某工作流：workflow_open（需本会话绑定画布）。
8. 修改已有节点用 updateNode 只传变化字段；改名用 renameNode（下游模板引用会自动同步）。
9. 回复用户时简洁说明改了什么（节点名/连线/运行结果），不复述 JSON。`;
}
