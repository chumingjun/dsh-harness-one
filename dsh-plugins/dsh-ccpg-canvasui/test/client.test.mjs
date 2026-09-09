import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const bundle = readFileSync(
  new URL("../src/client.js", import.meta.url),
  "utf8",
);
let client;
const storage = new Map();
const context = {
  window: {
    localStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
    },
    addEventListener() {},
    __ModuleLoader__: {
      load({ factory }) {
        client = factory((name) => {
          if (name === "react")
            return {
              createElement() {},
              useRef() {},
              useState(v) { return [v, function () {}]; },
              useEffect() {},
            };
          throw new Error(`unexpected require: ${name}`);
        });
      },
    },
  },
  document: {
    head: { appendChild() {} },
    createElement() {
      return {};
    },
    getElementById() {
      return null;
    },
  },
  console,
  setInterval,
  clearInterval,
  setTimeout,
};
vm.runInNewContext(bundle, context, {
  filename: "dsh-ccpg-canvasui/src/client.js",
});

assert.deepEqual([...client.inject], ["slots", "inputTriggers"]);
assert.equal(bundle.includes('name: "conversation.view"'), false);
assert.equal(
  bundle.includes('title: function () { return "对话记录"; }'),
  false,
);
assert.equal(bundle.includes("id: WORKFLOW_TAB_TYPE"), true);
assert.equal(
  bundle.includes(
    'if (ev.data && ev.data.type === "wf1-ready") lastSent = null;',
  ),
  true,
);

const injectedSlots = [];
const registeredTabs = [];
const sidebarService = {
  getSnapshot() {
    return {};
  },
  openTab() {},
  registerTab(tab) {
    registeredTabs.push(tab);
    return function () {};
  },
  subscribeState() {
    return function () {};
  },
};
// inputTriggers 软依赖：老运行时 ctx.get 抛错/返回 null 都不炸 apply。
const registeredSources = [];
const inputTriggersService = {
  registerSource(src) {
    registeredSources.push(src);
    return function () {};
  },
};
client.apply({
  slots: {
    inject(name, register) {
      injectedSlots.push(name);
      return register();
    },
    register() {
      return function () {};
    },
  },
  get(name) {
    if (name === "inputTriggers") return inputTriggersService;
    throw new Error(`unexpected service: ${name}`);
  },
  effect(fn) {
    fn();
  },
  inject(dependencies, callback) {
    assert.deepEqual([...dependencies], ["betterSidebar"]);
    callback({
      betterSidebar: sidebarService,
      effect(effect) {
        effect();
      },
    });
  },
});
assert.deepEqual(injectedSlots, [
  "settings.section",
  "conversation.input.left",
  "conversation.input.dock", // #106 绑定胶囊
  "conversation.input.dock", // #105 确认条
  "conversation.input.dock", // #101 示例条
  "tool.call.toolview",
  "tool.call.toolview",
  "tool.call.toolview",
  "tool.call.toolview",
  "tool.call.toolview",
]);
assert.deepEqual(
  registeredTabs.map((tab) => tab.id),
  ["ccpg:workflow"],
);
assert.deepEqual(registeredSources.map((s) => s.name), ["workflow-one"]);

const opened = [];
client.__test.setBetterSidebarService({
  openTab(tab) {
    opened.push(tab);
  },
});
assert.equal(client.__test.openWorkflowSidebar(), true);
assert.deepEqual(
  opened.map((tab) => ({ ...tab })),
  [{ type: "ccpg:workflow", title: "工作流", path: "ccpg-workflow" }],
);
client.__test.setBetterSidebarService(null);
assert.equal(client.__test.openWorkflowSidebar(), false);

const sidebarStates = [];
const unsubscribeSidebar = client.__test.subscribeSidebarService((ready) => {
  sidebarStates.push(ready);
});
client.__test.setBetterSidebarService({ openTab() {} });
client.__test.setBetterSidebarService(null);
unsubscribeSidebar();
client.__test.setBetterSidebarService({ openTab() {} });
assert.deepEqual(sidebarStates, [false, true, false]);
client.__test.setBetterSidebarService(null);

const tabs = client.__test.sidebarAllTabs({
  splits: {
    kind: "split",
    children: [
      { kind: "leaf", tabs: [{ id: "workflow", type: "ccpg:workflow" }] },
      { kind: "leaf", tabs: [{ id: "files", type: "editor" }] },
    ],
  },
  bottomSplits: { kind: "leaf", tabs: [{ id: "terminal", type: "terminal" }] },
});
assert.deepEqual(
  [...tabs].map((tab) => tab.id),
  ["workflow", "files", "terminal"],
);

const closedTabs = [];
client.__test.removeLegacyChatTabs({
  getSnapshot() {
    return {
      state: {
        splits: {
          kind: "leaf",
          tabs: [
            { id: "legacy-chat", type: "ccpg:chat" },
            { id: "workflow", type: "ccpg:workflow" },
          ],
        },
      },
    };
  },
  closeTab(id) {
    closedTabs.push(id);
  },
});
assert.deepEqual(closedTabs, ["legacy-chat"]);

assert.equal(
  client.__test.currentDshSessionId("blank-session"),
  "blank-session",
);
storage.set(
  "dsh.sessions.current",
  JSON.stringify({ sessionId: "formal-session" }),
);
assert.equal(
  client.__test.currentDshSessionId("blank-session"),
  "formal-session",
);
storage.set("dsh.sessions.current", "{invalid");
assert.equal(
  client.__test.currentDshSessionId("blank-session"),
  "blank-session",
);

// ---- 消息流卡片：纯函数面 ----
// 工具 block 文本抽取（settled content 数组 → 文本；settled 必带 kind）
assert.equal(client.__test.toolText(null), null);
assert.equal(
  client.__test.toolText({ kind: "tool-result", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
  "ab",
);
assert.equal(client.__test.toolText({ kind: "tool-result", content: [{ type: "image", text: "x" }] }), "");
assert.equal(client.__test.toolText({ name: "x" }), null); // running block 无 kind/content

// runId 解析：canvas_run_workflow 结果 JSON；canvas_run_status 从 args 取
assert.equal(client.__test.runIdFromText('{"started":true,"runId":"run_123"}'), "run_123");
assert.equal(client.__test.runIdFromText("画布尚未打开或未上报图。"), null);
assert.equal(client.__test.runIdFromText(null), null);
assert.equal(client.__test.runIdFromText('{"ok":true}'), null);
assert.equal(client.__test.runIdFromArgs('{"runId":"run_456"}'), "run_456");
assert.equal(client.__test.runIdFromArgs({ runId: "run_789" }), "run_789");
assert.equal(client.__test.runIdFromArgs(null), null);

// 运行状态 → 卡片状态点
assert.equal(client.__test.runDotState({ status: "success" }), "success");
assert.equal(client.__test.runDotState({ status: "running" }), "running");
assert.equal(client.__test.runDotState({ status: "error" }), "error");
assert.equal(client.__test.runDotState({ status: "waiting" }), "waiting");
assert.equal(client.__test.runDotState({ status: "canceled" }), "error");
assert.equal(client.__test.runDotState({ status: "interrupted" }), "error");
assert.equal(client.__test.runDotState(null, "running"), "running");
assert.equal(client.__test.runDotState(null), "running"); // 无数据按运行中

const progressGraph = {
  nodes: Array.from({ length: 10 }, (_, index) => ({
    id: `node_${index + 1}`,
    type: "agent",
    position: { x: index * 20, y: 0 },
    data: { label: `节点 ${index + 1}` },
  })),
  edges: Array.from({ length: 9 }, (_, index) => ({ source: `node_${index + 1}`, target: `node_${index + 2}` })),
};
const progressRun = {
  graph: progressGraph,
  nodeStates: {
    node_1: { status: "success" },
    node_2: { status: "success" },
    node_3: { status: "success" },
    node_4: { status: "success" },
    node_9: { status: "running" },
  },
};
assert.deepEqual(
  { ...client.__test.runCardProgress(progressRun) },
  { total: 10, done: 4, currentLabel: "节点 9", error: "" },
);

const liveEventRun = client.__test.mergeRunEvent(progressRun, "node-status", {
  runId: "run_progress", nodeId: "node_9", status: "success", durationMs: 1200,
});
assert.equal(liveEventRun.nodeStates.node_9.status, "success");
assert.equal(client.__test.runCardProgress(liveEventRun).done, 5);
const endedEventRun = client.__test.mergeRunEvent(liveEventRun, "run-end", {
  runId: "run_progress", status: "success", durationMs: 5000,
});
assert.equal(endedEventRun.status, "success");
assert.equal(endedEventRun.durationMs, 5000);
assert.equal(client.__test.shouldFollowRun(
  { runId: "old", status: "interrupted", workflowId: "wf-1" },
  { runId: "new", status: "running", workflowId: "wf-1", live: true },
), true);
assert.equal(client.__test.shouldFollowRun(
  { runId: "old", status: "success", workflowId: "wf-1" },
  { runId: "new", status: "running", workflowId: "wf-1", live: true },
), false);

// 分支图摘要取最长路径，主路径连续编号，未展示节点使用中性计数。
const branchGraph = {
  nodes: [
    { id: "in", type: "input", position: { x: 0, y: 0 }, data: { label: "报修输入" } },
    { id: "route", type: "condition", position: { x: 100, y: 0 }, data: { label: "紧急判断" } },
    { id: "urgent", type: "agent", position: { x: 200, y: 0 }, data: { label: "紧急派单" } },
    { id: "normal", type: "agent", position: { x: 200, y: 100 }, data: { label: "普通派单" } },
    { id: "out", type: "output", position: { x: 300, y: 0 }, data: { label: "工单输出" } },
  ],
  edges: [
    { source: "in", target: "route" },
    { source: "route", target: "urgent" },
    { source: "route", target: "normal" },
    { source: "urgent", target: "out" },
    { source: "normal", target: "out" },
  ],
};
const preview = client.__test.flowPreviewModel(branchGraph);
assert.deepEqual([...preview.items].map((item) => item && item.id), ["in", "route", "urgent", "out"]);
assert.deepEqual([...preview.items].map((item) => item && item.number), [1, 2, 3, 4]);
assert.equal(preview.pathLength, 4);
assert.equal(preview.otherNodeCount, 1);

// 实际运行命中下方分支时，不能继续展示按画布位置选出的上方分支。
const executedPreview = client.__test.flowPreviewModel(branchGraph, {
  in: { status: "success" },
  route: { status: "success" },
  urgent: { status: "skipped" },
  normal: { status: "success" },
  out: { status: "success" },
});
assert.deepEqual([...executedPreview.items].map((item) => item && item.id), ["in", "route", "normal", "out"]);
assert.deepEqual([...executedPreview.items].map((item) => item && item.number), [1, 2, 3, 4]);
assert.equal(executedPreview.otherNodeCount, 1);

const longPreview = client.__test.flowPreviewModel({
  nodes: Array.from({ length: 7 }, (_, index) => ({ id: `n${index + 1}`, type: "agent", data: { label: `步骤${index + 1}` } })),
  edges: Array.from({ length: 6 }, (_, index) => ({ source: `n${index + 1}`, target: `n${index + 2}` })),
});
assert.deepEqual([...longPreview.items].map((item) => item && item.id), ["n1", "n2", null, "n6", "n7"]);

// 容量参数：宽卡（capacity=8）可展示 7 节点全路径；省略数随可见头数变化
const widePreview = client.__test.flowPreviewModel(
  {
    nodes: Array.from({ length: 7 }, (_, index) => ({ id: `n${index + 1}`, type: "agent", data: { label: `步骤${index + 1}` } })),
    edges: Array.from({ length: 6 }, (_, index) => ({ source: `n${index + 1}`, target: `n${index + 2}` })),
  },
  null,
  8,
);
assert.deepEqual([...widePreview.items].map((item) => item && item.id), ["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
const midPreview = client.__test.flowPreviewModel(
  {
    nodes: Array.from({ length: 7 }, (_, index) => ({ id: `n${index + 1}`, type: "agent", data: { label: `步骤${index + 1}` } })),
    edges: Array.from({ length: 6 }, (_, index) => ({ source: `n${index + 1}`, target: `n${index + 2}` })),
  },
  null,
  6,
);
// capacity=6 → 头 3 + 省略 1 + 尾 2，共 6 项
assert.deepEqual([...midPreview.items].map((item) => item && item.id), ["n1", "n2", "n3", null, "n6", "n7"]);
// 容量下限保护：小于 3 按 5 档处理（不比旧版更窄）
assert.deepEqual(
  [...client.__test.flowPreviewModel(longGraphOf(7), null, 1).items].filter(Boolean).length,
  4,
);

function longGraphOf(count) {
  return {
    nodes: Array.from({ length: count }, (_, index) => ({ id: `n${index + 1}`, type: "agent", data: { label: `步骤${index + 1}` } })),
    edges: Array.from({ length: count - 1 }, (_, index) => ({ source: `n${index + 1}`, target: `n${index + 2}` })),
  };
}

// 卡片组件渲染断言：GraphPatchCard/WorkflowRunCard 的渲染链在 vm 内闭包引用 react——
// 用第二批 vm context 以 react shim 加载（createElement 记录调用），专门断言 props：
// running → 应用中；settled 成功带 lint 通过 → 已应用；settled isError → 被拒绝。
let cardClient;
const cardCalls = [];
const cardContext = {
  window: {
    localStorage: { getItem() { return null; } },
    __ModuleLoader__: {
      load({ factory }) {
        cardClient = factory((name) => {
          if (name === "react")
            return {
              createElement(tag, props, ...children) {
                cardCalls.push({ tag, props, children });
                return { tag, props, children };
              },
              useRef() { return { current: null }; },
              useState(v) { return [v, () => {}]; },
              useEffect() {},
              useMemo(fn) { return fn(); },
            };
          throw new Error(`unexpected require: ${name}`);
        });
      },
    },
  },
  document: {
    head: { appendChild() {} },
    createElement() { return {}; },
    getElementById() { return null; },
    // #107 suggestion 点击填入：模拟宿主 composer 输入框
    querySelector() { return composerFake; },
    execCommand(cmd, show, text) { composerLog.push({ cmd, text }); },
  },
  console,
};
const composerFake = { focus() {} };
const composerLog = [];
vm.runInNewContext(bundle, cardContext, {
  filename: "dsh-ccpg-canvasui/src/client.js",
});

cardCalls.length = 0;
cardClient.__test.graphThumbnail(progressGraph, progressRun);
const nodeBoxes = cardCalls.filter((call) => call.tag === "rect" && call.props?.className === "wf1-card-node");
assert.equal(nodeBoxes.some((call) => call.props["data-s"] === "success"), true);
assert.equal(nodeBoxes.some((call) => call.props["data-s"] === "running"), true);
assert.equal(nodeBoxes.some((call) => call.props["data-s"] === "pending"), true);
assert.match(cardCalls.find((call) => call.tag === "svg" && call.props?.className === "wf1-card-map").props["aria-label"], /已完成.*运行中.*未开始/);

// SVG 的可访问名称包含视觉摘要，读屏信息与卡片底部文案一致。
cardCalls.length = 0;
const thumbnail = cardClient.__test.graphThumbnail(branchGraph, {
  nodeStates: {
    in: { status: "success" }, route: { status: "success" },
    urgent: { status: "skipped" }, normal: { status: "success" }, out: { status: "success" },
  },
});
assert.match(thumbnail.props["aria-label"], /^主流程 4 步 · 另有 1 个节点：/);
assert.match(thumbnail.props["aria-label"], /3 普通派单/);

// 宽度自适应：viewBox 跟随传入宽度；7 项链图在宽卡（capacity=8）下不再省略
{
  const chain7 = {
    nodes: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, type: "agent", data: { label: `步骤${i + 1}` } })),
    edges: Array.from({ length: 6 }, (_, i) => ({ source: `c${i}`, target: `c${i + 1}` })),
  };
  cardCalls.length = 0;
  const wide = cardClient.__test.graphThumbnail(chain7, { nodeStates: {} }, { width: 640, capacity: 8 });
  assert.match(wide.props.viewBox, /^0 0 640 108$/);
  assert.doesNotMatch(wide.props["aria-label"], /省略/);
  const boxes = cardCalls.filter((c) => c.tag === "rect" && c.props?.className === "wf1-card-node");
  assert.equal(boxes.length, 7, "宽卡应展示全部 7 节点");
  assert.ok(boxes.every((b) => b.props.width >= 52), "节点框不窄于最小可读宽 52");
  // 窄卡（默认 360/无 capacity）仍走头2+省略+尾2 的省略档
  cardCalls.length = 0;
  const narrow = cardClient.__test.graphThumbnail(chain7, { nodeStates: {} });
  assert.match(narrow.props["aria-label"], /省略 3 步/);
}

// GraphPatchCard：running（argsRaw 携带 ops）
cardCalls.length = 0;
cardClient.__test.GraphPatchCard({
  block: { name: "canvas_graph_patch", argsRaw: JSON.stringify({ ops: [{ op: "addNode" }, { op: "addNode" }, { op: "connect" }] }) },
});
{
  const shell = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card");
  assert.ok(shell, "建图卡应渲染卡片骨架");
  const state = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card-state");
  const dot = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card-dot");
  assert.equal(dot.props["data-s"], "running");
  const meta = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card-meta");
  assert.equal(meta.children && meta.children[0], "2 加节点、1 连线");
}

// GraphPatchCard：settled 成功（lint 通过）
cardCalls.length = 0;
cardClient.__test.GraphPatchCard({
  block: {
    kind: "tool-result",
    isError: false,
    call: { name: "canvas_graph_patch", argsRaw: JSON.stringify({ ops: [{ op: "addNode" }] }) },
    content: [{ type: "text", text: "已应用 1 个操作到画布。\nlint: 通过" }],
  },
});
{
  const dot = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card-dot");
  assert.equal(dot.props["data-s"], "success");
}

// GraphPatchCard：settled 拒绝（isError）
cardCalls.length = 0;
cardClient.__test.GraphPatchCard({
  block: {
    kind: "tool-result",
    isError: true,
    call: { name: "canvas_graph_patch", argsRaw: JSON.stringify({ ops: [{ op: "bogus" }] }) },
    content: [{ type: "text", text: "整批拒绝（未做任何修改）" }],
  },
});
{
  const dot = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card-dot");
  assert.equal(dot.props["data-s"], "error");
}

// WorkflowRunCard：结果不可解析（画布未开）→ 文本降级卡，仍可点
cardCalls.length = 0;
cardClient.__test.WorkflowRunCard({
  block: {
    kind: "tool-result",
    isError: false,
    content: [{ type: "text", text: "画布尚未打开或未上报图。" }],
  },
});
{
  const dot = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card-dot");
  assert.equal(dot.props["data-s"], "pending");
}

// WorkflowRunCard：canvas_run_status 形状（结果无 runId，args 携带）→ 从 args 解析，
// 不再落入降级态（此前整段 JSON 塞进 meta 的 bug 回归）
cardCalls.length = 0;
cardClient.__test.WorkflowRunCard({
  toolName: "canvas_run_status",
  block: {
    kind: "tool-result",
    isError: false,
    call: { name: "canvas_run_status", argsRaw: JSON.stringify({ runId: "run_status_case" }) },
    content: [{ type: "text", text: '{"status":"success","nodeStates":{}}' }],
  },
});
{
  // useEffect 不跑（shim），轮询未启动——但 runId 已解析成功，卡片不应再走
  // 「就绪 + JSON 塞 meta」的降级分支（title 会带 run 详情态而非“就绪”状态章）
  const meta = cardCalls.findLast((c) => c.props && c.props.className === "wf1-card-meta");
  const metaText = meta.children && meta.children[0];
  assert.ok(!String(metaText).startsWith("{"), "run_status 卡不应把结果 JSON 塞进 meta");
}

// ---- 主题桥：宿主 dark/light 检测 + wf1-theme 推送 ----
// 在自定义 vm 上下文里重载 bundle，逐例换 document.body 断言 currentHostTheme
function loadClientInContext(overrides) {
  let scoped;
  const ctx = {
    document: {
      createElement: () => ({}),
      getElementById: () => null,
      head: { appendChild() {} },
      ...overrides.document,
    },
    window: {
      location: { origin: "https://dsh.local" },
      localStorage: { getItem: () => null },
      addEventListener() {},
      __ModuleLoader__: {
        load({ factory }) {
          scoped = factory(() => ({ createElement() {}, useRef() {}, useState() {}, useEffect() {} }));
        },
      },
    },
    console,
    ...overrides.globals,
  };
  vm.runInNewContext(bundle, ctx, { filename: "canvasui-scoped.js" });
  return scoped;
}

for (const [body, expected] of [
  [{ hasAttribute: (k) => k === "data-ds-dark-theme", className: "" }, "dark"],
  [{ hasAttribute: () => false, className: "" }, "light"],
  [{ hasAttribute: () => false, className: "theme-light other" }, "light"],
  [{ hasAttribute: () => false, className: "xyz dark" }, "dark"],
]) {
  const scoped = loadClientInContext({ document: { body } });
  assert.equal(scoped.__test.currentHostTheme(), expected);
}

// startThemeBridge：主题变化 → 向画布 iframe 发 wf1-theme
{
  const observers = [];
  const body = { hasAttribute: () => true, className: "" };
  const scoped = loadClientInContext({
    document: { body },
    globals: {
      MutationObserver: class {
        constructor(cb) { observers.push(cb); }
        observe() {}
        disconnect() {}
      },
    },
  });
  const sent = [];
  const frame = { contentWindow: { postMessage: (msg, origin) => sent.push({ msg, origin }) } };
  const stop = scoped.__test.startThemeBridge(() => frame);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.type, "wf1-theme");
  assert.equal(sent[0].msg.theme, "dark");
  assert.equal(sent[0].origin, "https://dsh.local");
  // 切浅色（属性移除）→ observer 回调 → 重发 light
  body.hasAttribute = () => false;
  observers.forEach((cb) => cb());
  assert.equal(sent.length, 2);
  assert.equal(sent[1].msg.theme, "light");
  stop();
}

// /workflow-one 触发源（#63）：注册、候选过滤、submit 动作路由
{
  const fetchCalls = [];
  const workflows = [
    { id: "wf_a", name: "工程手册编制" },
    { id: "wf_b", name: "报修工单整理" },
  ];
  const fetchImpl = (url, init) => {
    fetchCalls.push({ url, init });
    const body = url.includes("/trigger")
      ? { ok: true, action: JSON.parse(init.body).action }
      : { workflows };
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    });
  };
  const sources = [];
  const scoped = loadClientInContext({ globals: { fetch: fetchImpl } });
  const registered = [];
  const service = {
    registerSource(src) {
      registered.push(src);
      return function () {};
    },
  };
  // apply 全流程需要 slots/document 等完整宿主面；scoped client 只驱动
  // registerWorkflowTriggerSource 的等价注册路径：ctx.get + ctx.effect。
  assert.deepEqual(
    [...scoped.inject],
    ["slots", "inputTriggers"],
    "inject 必须声明 inputTriggers，缺声明时 ctx.get 抛错被吞、source 静默不注册",
  );
  scoped.apply({
    slots: {
      inject() {},
      register() {
        return function () {};
      },
    },
    get(name) {
      if (name === "inputTriggers") return service;
      throw new Error(`unexpected service: ${name}`);
    },
    effect(fn) {
      fn();
    },
    inject(dependencies, callback) {
      callback({ betterSidebar: sidebarService, effect(fn) { fn(); } });
      void dependencies;
    },
  });
  assert.equal(registered.length, 1, "inputTriggers 服务在场时 source 注册");
  const source = registered[0];
  assert.equal(source.trigger, "/");
  assert.equal(source.name, "workflow-one");

  // candidates：选源阶段（query=源名前缀）列全部；越过源名后按名过滤；run/open 尾缀
  const session = { sessionId: "sess_test" };
  const list = await source.candidates(session, { query: "workflow-one" });
  assert.equal(list.length, 2, "选源阶段列全部工作流");
  assert.equal(list[0].value, "wf_a");
  const filtered = await source.candidates(session, { query: "工程手册" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].value, "wf_a");
  // 空态引导（#101）：过滤无命中不再返回空，列示例指令候选（默认未绑定→搭建类）
  const none = await source.candidates(session, { query: "不存在的名字" });
  assert.ok(none.length > 0, "空态返回示例候选");
  assert.ok(none.every((c) => String(c.value).startsWith("prompt:")));
  assert.ok(none.some((c) => c.name.includes("工作流")));

  // 示例候选 onPick：claim.token = 示例全文（Enter 即普通消息发送），不走 /trigger
  const promptPick = { candidate: { value: "prompt:帮我搭一个报修单整理工作流" }, session };
  const promptClaim = source.onPick(promptPick).claim;
  assert.equal(promptClaim.token, "帮我搭一个报修单整理工作流");
  const promptOut = await promptClaim.submit("");
  assert.equal(promptOut.kind, "success");

  // onPick→claim.submit：args 为空时用 pick 的工作流 id，默认 auto（run 优先）
  const pick = { candidate: { value: "wf_a" }, session };
  const { claim } = source.onPick(pick);
  assert.equal(claim.token, "/workflow-one ");
  const out1 = await claim.submit("");
  assert.equal(out1.kind, "success");
  const triggerCall = fetchCalls.find((c) => c.url.includes("/trigger"));
  assert.ok(triggerCall, "submit 走 /wf1/api/trigger");
  assert.ok(triggerCall.url.includes("sessionId=sess_test"));
  assert.deepEqual(JSON.parse(triggerCall.init.body), { workflowId: "wf_a", action: "run" });

  // args=「open」：强制 open 动作
  const out2 = await claim.submit("open");
  assert.equal(out2.kind, "success");
  const openCall = fetchCalls.filter((c) => c.url.includes("/trigger")).pop();
  assert.deepEqual(JSON.parse(openCall.init.body), { workflowId: "wf_a", action: "open" });

  // args=「run <name>」：动作前缀 + 覆盖目标
  await claim.submit("run wf_z");
  const runCall = fetchCalls.filter((c) => c.url.includes("/trigger")).pop();
  assert.deepEqual(JSON.parse(runCall.init.body), { workflowId: "wf_z", action: "run" });

  // 服务端报错（409 canvas-not-bound + auto 回退 open 也失败）→ error outcome 带服务端文案
  const errFetch = (url, init) => {
    if (url.includes("/trigger")) {
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: "此会话未绑定工作流画布，无法打开", code: "canvas-not-bound" }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows }) });
  };
  const scoped2 = loadClientInContext({ globals: { fetch: errFetch } });
  scoped2.apply({
    slots: {
      inject() {},
      register() {
        return function () {};
      },
    },
    get(name) {
      if (name === "inputTriggers") return service;
      throw new Error(`unexpected service: ${name}`);
    },
    effect(fn) {
      fn();
    },
    inject(dependencies, callback) {
      callback({ betterSidebar: sidebarService, effect(fn) { fn(); } });
      void dependencies;
    },
  });
  // 第二个 scoped client 往同一 service 注册第二个 source（闭包绑定 errFetch）
  const secondSource = registered[registered.length - 1];
  const { claim: claim2 } = secondSource.onPick(pick);
  const out3 = await claim2.submit("");
  assert.equal(out3.kind, "error");
  assert.match(out3.text, /未绑定工作流画布/);

  // 缺目标 id → 结构化错误，不发请求
  const before = fetchCalls.length;
  const { claim: claimNoTarget } = source.onPick({ candidate: null, session });
  const out4 = await claimNoTarget.submit("");
  assert.equal(out4.kind, "error");
  assert.match(out4.text, /缺少工作流/);
  assert.equal(fetchCalls.length, before, "缺目标不发请求");
}

// ---- 设置面板「Agent 节点默认值」选项装配 ----
{
  const catalog = {
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [
          { id: "deepseek-chat", name: "Chat" },
          {
            id: "deepseek-reasoner",
            name: "Reasoner",
            vision: true,
            reasoning: { efforts: [{ id: "low" }, { id: "high", name: "高" }] },
          },
        ],
      },
      { id: "glm", name: "智谱", models: [{ id: "glm-5" }] },
    ],
  };
  assert.equal(client.__test.providerNameOf(catalog, "glm"), "智谱");
  assert.equal(client.__test.providerNameOf(catalog, "ghost"), "ghost");
  // __test 函数返回的数组来自 vm realm，先 Array.from 回宿主 realm 再 deepEqual
  assert.deepEqual(
    Array.from(client.__test.modelOptionsFor(catalog, "deepseek"), (m) => m.id),
    ["deepseek-chat", "deepseek-reasoner"],
  );
  assert.deepEqual(Array.from(client.__test.modelOptionsFor(catalog, "ghost")), []);
  assert.deepEqual(
    Array.from(client.__test.effortOptionsFor(catalog, "deepseek", "deepseek-reasoner"), (e) => e.id),
    ["low", "high"],
  );
  assert.deepEqual(Array.from(client.__test.effortOptionsFor(catalog, "deepseek", "deepseek-chat")), []);
  assert.deepEqual(Array.from(client.__test.effortOptionsFor(catalog, "ghost", "x")), []);
  assert.deepEqual(Array.from(client.__test.effortOptionsFor(null, "deepseek", "deepseek-reasoner")), []);
  // 设置面板数据源：默认值接口与模型目录接口都要在 bundle 里
  assert.equal(bundle.includes('"/wf1/api/agent-defaults"'), true);
  assert.equal(bundle.includes('"/wf1/api/llm-config"'), true);
}

// ---- 空态引导（#101）：示例表取舍与 ExampleBar 渲染 ----
{
  assert.equal(client.__test.examplePromptsFor(false), client.__test.examplePromptsFor(false));
  const unbound = client.__test.examplePromptsFor(false);
  const bound = client.__test.examplePromptsFor(true);
  assert.ok(unbound.length >= 3 && unbound.length <= 5, "示例数量 3~5 条");
  assert.ok(unbound.some((p) => p.name.includes("搭")), "未绑定时以搭建类为主");
  assert.ok(bound.some((p) => p.name.includes("当前画布")), "已绑定时以运行/修改类为主");
  assert.notEqual(unbound, bound, "绑定与否返回不同示例集");

  // ExampleBar：仅绑定画布后渲染（owner 决策：未绑定不显示示例条）。
  // 主 vm 的 createElement 是无返回 stub，绑定态走 createElement 分支返回 undefined；
  // 未绑定/草稿非空/claim 阶段早退 null。
  client.__test.setWfBoundState(true);
  assert.equal(client.__test.WorkflowExampleBar({ input: { draft: "", phase: "plain" } }), undefined, "绑定+空草稿应渲染");
  client.__test.setWfBoundState(false);
  assert.equal(client.__test.WorkflowExampleBar({ input: { draft: "", phase: "plain" } }), null, "未绑定不渲染");
  client.__test.setWfBoundState(null);
  assert.equal(client.__test.WorkflowExampleBar({ input: { draft: "", phase: "plain" } }), null, "绑定态未知不渲染");
  client.__test.setWfBoundState(true);
  assert.equal(client.__test.WorkflowExampleBar({ input: { draft: "已有草稿", phase: "plain" } }), null);
  assert.equal(client.__test.WorkflowExampleBar({ input: { draft: "", phase: "claim" } }), null);
  assert.equal(client.__test.WorkflowExampleBar({}), null);
  client.__test.setWfBoundState(null);
}

// ---- 运行卡停止按钮（#103）：有状态 react shim 驱动 运行中→停止中→已取消 流转 ----
{
  const stopCalls = [];
  const fetchLog = [];
  const intervals = [];
  const runningRun = {
    runId: "run_stop_case", status: "running", workflowName: "停止测试",
    graph: { nodes: [{ id: "n1", type: "agent", data: { label: "步骤1" } }], edges: [] },
    nodeStates: { n1: { status: "running" } },
  };
  const canceledRun = { ...runningRun, status: "canceled", nodeStates: { n1: { status: "canceled" } } };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  // 有状态 hooks：slot 按 hook 序号复用，组件重调即「重渲染」；effect 仅首渲染后跑
  let cursor = 0;
  const slots = [];
  const effects = [];
  const reactShim = {
    createElement(tag, props, ...children) { stopCalls.push({ tag, props, children }); return { tag, props, children }; },
    useRef() { const i = cursor++; if (!slots[i]) slots[i] = { ref: true, value: { current: null } }; return slots[i].value; },
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (v) => { slot.value = typeof v === "function" ? v(slot.value) : v; }];
    },
    useEffect(fn) { effects.push(fn); },
    useMemo(fn) { return fn(); },
  };

  let stopClient;
  let cancelOk = true;
  let detailRun = runningRun;
  const fetchStub = (url, opts) => {
    const u = String(url);
    fetchLog.push({ url: u, opts });
    if (u.includes("/wf1/api/run/cancel")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: cancelOk, runId: "run_stop_case" }) });
    }
    if (u.includes("/wf1/api/runs/detail")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detailRun) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ runs: [] }) });
  };
  const setIntervalStub = (fn) => { intervals.push(fn); return intervals.length; };
  const clearIntervalStub = () => {};
  const stopContext = {
    console,
    // 裸 fetch/interval（vm realm 全局）与 window.* 两种引用路径都要有
    fetch: fetchStub,
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    document: {
      head: { appendChild() {} },
      createElement: () => ({}),
      getElementById: () => null,
      body: {},
    },
    window: {
      localStorage: { getItem: (k) => (k === "dsh.sessions.current" ? JSON.stringify({ sessionId: "sess_stop" }) : null) },
      fetch: fetchStub,
      setInterval: setIntervalStub,
      clearInterval: clearIntervalStub,
    },
  };
  stopContext.window.__ModuleLoader__ = {
    load({ factory }) { stopClient = factory((name) => (name === "react" ? reactShim : (() => { throw new Error("unexpected require: " + name); })())); },
  };
  vm.runInNewContext(bundle, stopContext, { filename: "dsh-ccpg-canvasui/src/client.js" });

  const render = () => {
    cursor = 0;
    stopCalls.length = 0;
    return stopClient.__test.WorkflowRunCard({
      block: {
        kind: "tool-result",
        isError: false,
        content: [{ type: "text", text: JSON.stringify({ started: true, runId: "run_stop_case" }) }],
      },
    });
  };
  const find = (className, tag) => stopCalls.findLast((c) => c.tag === tag && c.props?.className === className);

  render();
  effects.splice(0).forEach((fn) => fn());
  await tick(); // 首次详情拉回 running
  render();
  {
    const action = find("wf1-card-action", "span");
    assert.ok(action, "运行中应渲染停止按钮");
    assert.equal(action.props.role, "button");
    assert.equal(action.children[0], "停止");
    const meta = find("wf1-card-meta", "span");
    assert.match(String(meta.children[0]), /步骤1」执行中/);
  }

  // 先验证取消失败回退：点停止但服务端回 ok:false → 按钮回到「停止」可重试
  cancelOk = false;
  find("wf1-card-action", "span").props.onClick({ stopPropagation() {} });
  await tick();
  render();
  assert.equal(find("wf1-card-action", "span").children[0], "停止", "取消失败应回退到可重试态");

  // 成功路径：stopPropagation + POST cancel（带 sessionId 作用域与 runId）
  cancelOk = true;
  let propagationStopped = false;
  find("wf1-card-action", "span").props.onClick({ stopPropagation() { propagationStopped = true; } });
  assert.equal(propagationStopped, true, "停止点击不得触发整卡打开画布");
  await tick();
  const cancelCall = fetchLog.findLast((f) => f.url.includes("/wf1/api/run/cancel"));
  assert.ok(cancelCall, "应发 POST /wf1/api/run/cancel");
  assert.match(cancelCall.url, /[?&]sessionId=sess_stop/, "cancel 请求须带 sessionId 作用域");
  assert.equal(cancelCall.opts?.method, "POST");
  assert.deepEqual(JSON.parse(cancelCall.opts.body), { runId: "run_stop_case" });

  render();
  {
    assert.equal(find("wf1-card-action", "span").children[0], "停止中…");
    assert.match(String(find("wf1-card-meta", "span").children[0]), /停止中/);
  }

  // 轮询到已取消：停止按钮消失，卡片转取消态；失败终态给下一步 suggestion
  detailRun = canceledRun;
  intervals.forEach((fn) => fn());
  await tick();
  render();
  {
    assert.equal(find("wf1-card-action", "span"), undefined, "终态后不再渲染停止按钮");
    const dot = find("wf1-card-dot", "span");
    assert.equal(dot.props["data-s"], "error");
    assert.equal(String(find("wf1-card-meta", "span").children[0]), "已取消");
    const row = find("wf1-card-suggest", "div");
    assert.ok(row, "失败终态应渲染 suggestion");
    const btns = (Array.isArray(row.children[0]) ? row.children[0] : row.children).filter((c) => c.tag === "span");
    assert.deepEqual(Array.from(btns, (b) => String(b.children[0])), ["再跑一次", "基于这次结果继续改"]);
  }

  // 成功终态：3 个下一步指令（查看文稿/再跑一次/存到工作目录）
  detailRun = { ...runningRun, status: "success", nodeStates: { n1: { status: "success" } } };
  intervals.forEach((fn) => fn());
  await tick();
  render();
  {
    const row = find("wf1-card-suggest", "div");
    const btns = (Array.isArray(row.children[0]) ? row.children[0] : row.children).filter((c) => c.tag === "span");
    assert.deepEqual(Array.from(btns, (b) => String(b.children[0])), ["查看上次运行的文稿", "再跑一次", "把运行结果存到工作目录"]);
  }
}

// ---- 建图卡错误展开（#104）：默认收起，点击展开完整错误行（含服务端修复建议）----
{
  const expandCalls = [];
  let cursor = 0;
  const slots = [];
  const reactShim = {
    createElement(tag, props, ...children) { expandCalls.push({ tag, props, children }); return { tag, props, children }; },
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (v) => { slot.value = typeof v === "function" ? v(slot.value) : v; }];
    },
  };
  let expandClient;
  const expandContext = {
    console,
    document: {
      head: { appendChild() {} },
      createElement: () => ({}),
      getElementById: () => null,
      body: {},
    },
    window: {
      localStorage: { getItem: () => null },
      __ModuleLoader__: {
        load({ factory }) { expandClient = factory((name) => (name === "react" ? reactShim : (() => { throw new Error("unexpected require: " + name); })())); },
      },
    },
  };
  vm.runInNewContext(bundle, expandContext, { filename: "dsh-ccpg-canvasui/src/client.js" });

  // 5 行错误（含服务端修复建议）：成环 + 引用不存在 + 缺字段等
  const rejectedText = [
    "整批拒绝（未做任何修改）：",
    'ops[1]: connect from 节点 "ghost" 不存在 —— 修复建议：先在同批 addNode 创建该节点，或改用画布摘要里已有的节点 id',
    "ops[2]: 这条边会构成环 —— 修复建议：删掉形成环的那条连线（回边），或改连到环外节点",
    "ops[3]: data 必须是对象 —— 修复建议：updateNode 的 data 传 {字段: 值} 对象",
    "ops[4]: label 不能为空 —— 修复建议：renameNode 需要非空 label",
    "请修正后重发整批 ops。",
  ].join("\n");
  const render = () => {
    cursor = 0;
    expandCalls.length = 0;
    return expandClient.__test.GraphPatchCard({
      block: {
        kind: "tool-result",
        isError: true,
        call: { name: "canvas_graph_patch", argsRaw: JSON.stringify({ ops: [{ op: "connect" }] }) },
        content: [{ type: "text", text: rejectedText }],
      },
    });
  };
  const find = (className, tag) => expandCalls.findLast((c) => c.tag === tag && c.props?.className === className);

  render();
  {
    const toggle = find("wf1-card-toggle", "span");
    assert.ok(toggle, "被拒多行错误应渲染展开入口");
    assert.match(String(toggle.children[0]), /^展开 \d+ 条$/);
    assert.equal(toggle.props["aria-expanded"], false);
    assert.equal(find("wf1-card-detail", "div"), undefined, "默认收起");
    // meta 仍是首行摘要，不撑爆卡片
    assert.match(String(find("wf1-card-meta", "span").children[0]), /^整批拒绝/);

    // 点击展开（stopPropagation 不触发整卡打开）
    let stopped = false;
    toggle.props.onClick({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
  }
  render();
  {
    const detail = find("wf1-card-detail", "div");
    assert.ok(detail, "展开后渲染完整错误列表");
    assert.equal(detail.props["data-error"], true, "被拒态错误行用错误色");
    // createElement shim 单数组参数不展开，先展平再断言
    const lines = Array.isArray(detail.children[0]) ? detail.children[0] : detail.children;
    assert.equal(lines.length, 6, "全部错误行均展示（超 3 条靠滚动）");
    assert.match(String(lines[2].children[0]), /构成环 —— 修复建议：删掉形成环的那条连线/);
    const toggle = find("wf1-card-toggle", "span");
    assert.equal(toggle.children[0], "收起");
    assert.equal(toggle.props["aria-expanded"], true);

    // 再点收起
    toggle.props.onClick({ stopPropagation() {} });
  }
  render();
  assert.equal(find("wf1-card-detail", "div"), undefined, "点击收起后详情隐藏");

  // lint 通过的成功卡：不渲染展开入口
  expandCalls.length = 0;
  expandClient.__test.GraphPatchCard({
    block: {
      kind: "tool-result",
      isError: false,
      call: { name: "canvas_graph_patch", argsRaw: JSON.stringify({ ops: [{ op: "addNode" }] }) },
      content: [{ type: "text", text: "已应用 1 个操作到画布。\nlint: 通过" }],
    },
  });
  assert.equal(find("wf1-card-toggle", "span"), undefined, "lint 通过不渲染展开");
}

// ---- 修改类补丁确认条（#105）：挂起渲染摘要/倒计时/按钮，裁决回传后收起 ----
{
  const confirmCalls = [];
  const decisions = [];
  let cursor = 0;
  const slots = [];
  const effects = [];
  const reactShim = {
    createElement(tag, props, ...children) { confirmCalls.push({ tag, props, children }); return { tag, props, children }; },
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (v) => { slot.value = typeof v === "function" ? v(slot.value) : v; }];
    },
    useEffect(fn) { effects.push(fn); },
  };
  let confirmClient;
  const confirmContext = {
    console,
    document: {
      head: { appendChild() {} },
      createElement: () => ({}),
      getElementById: () => null,
      body: {},
    },
    window: {
      localStorage: { getItem: () => null },
      setInterval: () => 0,
      clearInterval: () => {},
      __ModuleLoader__: {
        load({ factory }) { confirmClient = factory((name) => (name === "react" ? reactShim : (() => { throw new Error("unexpected require: " + name); })())); },
      },
    },
  };
  vm.runInNewContext(bundle, confirmContext, { filename: "dsh-ccpg-canvasui/src/client.js" });
  const render = () => {
    cursor = 0;
    confirmCalls.length = 0;
    return confirmClient.__test.PatchConfirmBar({ onDecide: (msg) => decisions.push(msg) });
  };
  const find = (className, tag) => confirmCalls.findLast((c) => c.tag === tag && c.props?.className && c.props.className.indexOf(className) >= 0);
  // 无状态时：不渲染（首渲染后跑 effect：订阅监听）
  render();
  effects.splice(0).forEach((fn) => fn());
  assert.equal(find("wf1-confirm-bar", "div"), undefined, "无挂起状态不渲染确认条");
  // 挂起：摘要 + 双按钮 + 倒计时（deadline 未来 30s）；监听已在，推送即达
  confirmClient.__test.setPatchConfirmState({
    state: "pending", canvasId: "cv_1", version: 7, summary: "删除 1 个节点（工单输出）、修改 2 个节点",
    deadline: Date.now() + 30000,
  });
  render();
  {
    const bar = find("wf1-confirm-bar", "div");
    assert.ok(bar, "挂起时渲染确认条");
    assert.equal(bar.props.role, "alert");
    assert.match(String(find("wf1-confirm-summary", "span").children[0]), /删除 1 个节点（工单输出）、修改 2 个节点/);
    const btns = confirmCalls.filter((c) => c.tag === "button");
    assert.equal(btns.length, 2);
    assert.equal(btns[0].children[0], "应用");
    assert.equal(btns[1].children[0], "放弃");
    assert.match(String(find("wf1-confirm-countdown", "span").children[0]), /^\d+s 后自动应用$/);
  }
  // 点「应用」：乐观收起 + 回传 approve 与版本/canvasId（vm realm 对象不 deepEqual，逐字段）
  confirmCalls.findLast((c) => c.tag === "button" && c.children[0] === "应用").props.onClick();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].type, "wf1-patch-confirm");
  assert.equal(decisions[0].canvasId, "cv_1");
  assert.equal(decisions[0].version, 7);
  assert.equal(decisions[0].approve, true);
  render();
  assert.equal(find("wf1-confirm-bar", "div"), undefined, "裁决后确认条收起");
  // 再挂起一批，点「放弃」
  confirmClient.__test.setPatchConfirmState({
    state: "pending", canvasId: "cv_1", version: 8, summary: "删除 1 个节点",
    deadline: Date.now() + 30000,
  });
  render();
  confirmCalls.findLast((c) => c.tag === "button" && c.children[0] === "放弃").props.onClick();
  assert.equal(decisions[1].version, 8);
  assert.equal(decisions[1].approve, false);
  // App 推送 applied/applied 之外的终态：同样不渲染
  confirmClient.__test.setPatchConfirmState({ state: "discarded", version: 8 });
  render();
  assert.equal(find("wf1-confirm-bar", "div"), undefined);
}

// ---- suggestion 按钮组（#107）：卡片尾部指令按钮，点击填入输入框不发送 ----
{
  // 纯渲染：cardSuggestRow 生成按钮组，文案保留原文
  cardCalls.length = 0;
  cardClient.__test.cardSuggestRow(["查看上次运行的文稿", "再跑一次"]);
  {
    const row = cardCalls.findLast((c) => c.tag === "div" && c.props?.className === "wf1-card-suggest");
    assert.ok(row, "应渲染 suggestion 行");
    const btns = (Array.isArray(row.children[0]) ? row.children[0] : row.children).filter((c) => c.tag === "span");
    assert.equal(btns.length, 2);
    assert.equal(btns[0].children[0], "查看上次运行的文稿");
    assert.equal(btns[1].children[0], "再跑一次");
  }

  // 点击：selectAll + insertText 填入，不自动发送
  composerLog.length = 0;
  {
    cardCalls.length = 0;
    cardClient.__test.cardSuggestRow(["再跑一次"]);
    const btn = cardCalls.findLast((c) => c.tag === "span" && c.children[0] === "再跑一次");
    let stopped = false;
    btn.props.onClick({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, "点击不触发整卡打开");
    assert.deepEqual(composerLog.map((x) => x.cmd), ["selectAll", "insertText"], "填入应 selectAll+insertText");
    assert.equal(composerLog[1].text, "再跑一次");
  }

  // GraphPatchCard 已应用态：尾部 3 按钮；被拒不渲染
  cardCalls.length = 0;
  cardClient.__test.GraphPatchCard({
    block: {
      kind: "tool-result",
      isError: false,
      call: { name: "canvas_graph_patch", argsRaw: JSON.stringify({ ops: [{ op: "addNode" }] }) },
      content: [{ type: "text", text: "已应用 1 个操作到画布。\nlint: 通过" }],
    },
  });
  {
    const row = cardCalls.findLast((c) => c.tag === "div" && c.props?.className === "wf1-card-suggest");
    assert.ok(row, "已应用态应渲染 suggestion");
    const btns = (Array.isArray(row.children[0]) ? row.children[0] : row.children).filter((c) => c.tag === "span");
    assert.deepEqual(Array.from(btns, (b) => String(b.children[0])), ["撤销刚才那批修改", "运行这个工作流", "保存为工作流"]);
  }
  cardCalls.length = 0;
  cardClient.__test.GraphPatchCard({
    block: {
      kind: "tool-result",
      isError: true,
      call: { name: "canvas_graph_patch", argsRaw: JSON.stringify({ ops: [{ op: "bogus" }] }) },
      content: [{ type: "text", text: "整批拒绝（未做任何修改）" }],
    },
  });
  assert.equal(cardCalls.findLast((c) => c.tag === "div" && c.props?.className === "wf1-card-suggest"), undefined, "被拒不渲染 suggestion");
}

// ---- 绑定状态胶囊（#106）：已绑定/未绑定文案，点击开侧栏，首拉前不渲染 ----
{
  const capCalls = [];
  const fetchLog = [];
  let boundPayload = { ok: true, bound: true, canvasId: "cv_x", workflowName: "海印一期", nodeCount: 41 };
  let cursor = 0;
  const slots = [];
  const effects = [];
  const reactShim = {
    createElement(tag, props, ...children) { capCalls.push({ tag, props, children }); return { tag, props, children }; },
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (v) => { slot.value = typeof v === "function" ? v(slot.value) : v; }];
    },
    useEffect(fn) { effects.push(fn); },
  };
  let capClient;
  const capContext = {
    console,
    fetch: (url) => {
      fetchLog.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(boundPayload) });
    },
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      head: { appendChild() {} },
      createElement: () => ({}),
      getElementById: () => null,
      body: {},
    },
    window: {
      localStorage: { getItem: (k) => (k === "dsh.sessions.current" ? JSON.stringify({ sessionId: "sess_cap" }) : null) },
      fetch: (url) => {
        fetchLog.push(String(url));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(boundPayload) });
      },
      setInterval: () => 0,
      clearInterval: () => {},
      __ModuleLoader__: {
        load({ factory }) { capClient = factory((name) => (name === "react" ? reactShim : (() => { throw new Error("unexpected require: " + name); })())); },
      },
    },
  };
  vm.runInNewContext(bundle, capContext, { filename: "dsh-ccpg-canvasui/src/client.js" });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const render = () => { cursor = 0; capCalls.length = 0; return capClient.__test.WorkflowBindCapsule(); };
  const pill = () => capCalls.findLast((c) => c.tag === "button" && String(c.props?.className).includes("wf1-bind-pill"));

  // 首拉前（info=null）：不渲染
  render();
  assert.equal(pill(), undefined, "首次数据到达前不渲染，避免闪未绑定");

  // 挂 effect（轮询启动）→ 首拉返回已绑定
  effects.splice(0).forEach((fn) => fn());
  await tick();
  render();
  {
    const p = pill();
    assert.ok(p, "已绑定应渲染胶囊");
    assert.equal(p.props["data-bound"], true);
    assert.match(String(p.children[p.children.length - 1].children[0]), /已绑定：海印一期 · 41 节点/);
    assert.equal(capCalls.findLast((c) => c.props?.className === "wf1-bind-dot").props["data-s"], "on");
    // 请求带 sessionId 作用域
    assert.ok(fetchLog.some((u) => u.includes("/wf1/api/assistant/bound") && u.includes("sessionId=sess_cap")), "bound 查询须带 sessionId");
  }

  // 未绑定：不渲染（owner 决策：未绑定不展示胶囊与引导）
  boundPayload = { ok: true, bound: false, canvasId: null, workflowName: null, nodeCount: 0 };
  effects.splice(0).forEach((fn) => fn()); // 重挂 effect 再拉一轮
  await tick();
  render();
  assert.equal(pill(), undefined, "未绑定时胶囊不渲染");
}

console.log("canvasui client tests: passed");
