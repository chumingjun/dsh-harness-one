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
  const none = await source.candidates(session, { query: "不存在的名字" });
  assert.equal(none.length, 0);

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

console.log("canvasui client tests: passed");
