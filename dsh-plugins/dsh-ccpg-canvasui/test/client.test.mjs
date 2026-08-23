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

// runId 解析：canvas_run_workflow 结果 JSON
assert.equal(client.__test.runIdFromText('{"started":true,"runId":"run_123"}'), "run_123");
assert.equal(client.__test.runIdFromText("画布尚未打开或未上报图。"), null);
assert.equal(client.__test.runIdFromText(null), null);
assert.equal(client.__test.runIdFromText('{"ok":true}'), null);

// 运行状态 → 卡片状态点
assert.equal(client.__test.runDotState({ status: "success" }), "success");
assert.equal(client.__test.runDotState({ status: "running" }), "running");
assert.equal(client.__test.runDotState({ status: "error" }), "error");
assert.equal(client.__test.runDotState({ status: "waiting" }), "waiting");
assert.equal(client.__test.runDotState({ status: "canceled" }), "error");
assert.equal(client.__test.runDotState(null, "running"), "running");
assert.equal(client.__test.runDotState(null), "running"); // 无数据按运行中

// GraphPatchCard：running（无 content）→ 应用中；settled 成功带 lint 通过 → 已应用；
// settled isError → 被拒绝。args 解析从 call.argsRaw（JSON 字符串）。
function patchCardOf(block) {
  const calls = [];
  const reactShim = {
    createElement(tag, props, ...children) {
      calls.push({ tag, props, children });
      return { tag, props, children };
    },
    useRef() { return { current: null }; },
    useState(v) { return [v, () => {}]; },
    useEffect() {},
    useMemo(fn) { return fn(); },
  };
  const saved = globalThis.__wf1ReactShim;
  // 直接在 vm context 里再 require 一次 react shim 太重；组件只依赖参数化 react——
  // 借 exports.__test 拿组件后以 shim 调用不可行（闭包引用模块级 react），
  // 所以这里改为：走 vm 重跑 bundle，react require 返回 shim。
  return { calls, reactShim, saved };
}
// 简化：GraphPatchCard/WorkflowRunCard 的渲染链在 vm 内闭包引用 react——
// 用第二批 vm context 以 react shim 加载，专门渲染卡片组件断言 props。
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

console.log("canvasui client tests: passed");
