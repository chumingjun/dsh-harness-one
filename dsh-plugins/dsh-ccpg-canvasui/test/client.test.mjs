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
    __ModuleLoader__: {
      load({ factory }) {
        client = factory((name) => {
          if (name === "react")
            return {
              createElement() {},
              useRef() {},
              useState() {},
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

assert.deepEqual([...client.inject], ["slots"]);
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
client.apply({
  inject(dependencies, callback) {
    assert.deepEqual([...dependencies], ["betterSidebar"]);
    callback({
      betterSidebar: sidebarService,
      effect(effect) {
        effect();
      },
    });
  },
  slots: {
    inject(name, register) {
      injectedSlots.push(name);
      return register();
    },
    register() {
      return function () {};
    },
  },
});
assert.deepEqual(injectedSlots, [
  "conversation.input.left",
  "tool.call.toolview",
  "tool.call.toolview",
  "tool.call.toolview",
]);
assert.deepEqual(
  registeredTabs.map((tab) => tab.id),
  ["ccpg:workflow"],
);

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
assert.equal(client.__test.runDotState(null, "running"), "running");
assert.equal(client.__test.runDotState(null), "running"); // 无数据按运行中

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
  },
  console,
};
vm.runInNewContext(bundle, cardContext, {
  filename: "dsh-ccpg-canvasui/src/client.js",
});

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

console.log("canvasui client tests: passed");
