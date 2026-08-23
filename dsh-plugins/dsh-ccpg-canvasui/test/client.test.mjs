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
assert.deepEqual(injectedSlots, ["conversation.input.left"]);
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

console.log("canvasui client tests: passed");
