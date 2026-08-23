// dsh-ccpg-canvasui 浏览器入口（bundle 工厂格式，window.__ModuleLoader__.load 注册）。
// 职责：向 DSH-better-sidebar（社区侧边栏工作台）注册「工作流」tab，内容为
// 同源 /wf1/ 画布 iframe；对话区保持官方单一视图，不再注册工作流 conversation tab。
// 对话输入框左侧的工作流按钮直接展开该侧栏。接入是软依赖
//（ctx.inject(['betterSidebar'],…)）：未安装 better-sidebar 时按钮保持不可用。
// 画布 ↔ 宿主经 postMessage 桥接：
//   宿主 → 画布：{type:'wf1-session', sessionId}（画布据此绑 AI 助手工具作用域）
//   画布 → 宿主：{type:'wf1-ready'}
//
// ⚠ 本文件是源文件（src/client.js），真正的插件 bundle 是构建产物 lib/client.js；
// 改这里后必须重跑 build-canvasui.sh，直接改 lib/ 会被覆盖。

window.__ModuleLoader__.load({
  id: "dsh-ccpg-canvasui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    var CANVAS_URL = "/wf1/";
    var WORKFLOW_TAB_TYPE = "ccpg:workflow";
    var LEGACY_CHAT_TAB_TYPE = "ccpg:chat";
    var WORKFLOW_TAB_ORDER = 5; // better-sidebar + 菜单升序，内置最小 explorer=10 → 排第一

    function currentDshSessionId(fallback) {
      try {
        var raw = window.localStorage.getItem("dsh.sessions.current");
        var current = raw ? JSON.parse(raw) : null;
        return (current && current.sessionId) || fallback;
      } catch (e) {
        return fallback;
      }
    }

    // conversation.input.left 的 owner props 拿不到 ctx，走模块级引用。
    var betterSidebarRef = { svc: null };
    var sidebarServiceListeners = new Set();
    function setBetterSidebarService(svc) {
      betterSidebarRef.svc = svc;
      sidebarServiceListeners.forEach(function (listener) {
        listener(Boolean(svc));
      });
    }

    function subscribeSidebarService(listener) {
      sidebarServiceListeners.add(listener);
      listener(Boolean(betterSidebarRef.svc));
      return function () {
        sidebarServiceListeners.delete(listener);
      };
    }

    function ensureStyle() {
      if (document.getElementById("wf1-canvasui-style")) return;
      var el = document.createElement("style");
      el.id = "wf1-canvasui-style";
      el.textContent = [
        ".wf1-open-btn{width:28px;height:28px;display:grid;flex:none;place-items:center;padding:0;border:0;border-radius:999px;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color 100ms ease,opacity 100ms ease;}",
        ".wf1-open-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);}",
        ".wf1-open-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3);}",
        ".wf1-open-btn:disabled{opacity:.5;cursor:default;}",
        ".wf1-open-btn svg{width:15px;height:15px;display:block;}",
        // 官方 viewArea 是 flex "1 0 auto"（shrink=0），普通流内 iframe 会把它撑高。
        // root 正常占满 viewArea 并建立定位上下文，iframe absolute 锁在该内容区内。
        ".wf1-view-root{position:relative;display:block;flex:1 1 0;width:100%;height:100%;min-height:0;overflow:hidden;}",
        ".wf1-canvas-fill{position:absolute;inset:0;display:flex;}",
        ".wf1-canvas-fill iframe{width:100%;height:100%;border:0;display:block;flex:1;}",
      ].join("\n");
      document.head.appendChild(el);
    }

    function openWorkflowSidebar() {
      if (!betterSidebarRef.svc) return false;
      betterSidebarRef.svc.openTab({
        type: WORKFLOW_TAB_TYPE,
        title: "工作流",
        path: "ccpg-workflow",
      });
      return true;
    }

    function WorkflowOpenButton(props) {
      var [sidebarReady, setSidebarReady] = react.useState(
        Boolean(betterSidebarRef.svc),
      );
      react.useEffect(function () {
        return subscribeSidebarService(setSidebarReady);
      }, []);
      var disabled =
        !props.input || props.input.phase !== "plain" || !sidebarReady;
      var openWorkflow = function () {
        if (disabled) return;
        try {
          openWorkflowSidebar();
        } catch (e) {
          /* 侧边栏状态异常时保持对话可用 */
        }
      };

      return react.createElement(
        "button",
        {
          type: "button",
          className: "wf1-open-btn",
          disabled: disabled,
          title: "打开工作流画布",
          "aria-label": "打开工作流画布",

          onClick: openWorkflow,
        },
        react.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            "aria-hidden": true,
            fill: "none",
            stroke: "currentColor",
            "stroke-width": 1.45,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          },
          react.createElement("circle", { cx: 3.25, cy: 4, r: 1.35 }),
          react.createElement("circle", { cx: 12.75, cy: 3.25, r: 1.35 }),
          react.createElement("circle", { cx: 12.75, cy: 12.75, r: 1.35 }),
          react.createElement("path", {
            d: "M4.6 4h2.15A2.25 2.25 0 0 1 9 6.25v4.25A2.25 2.25 0 0 0 11.25 12.75h.15M9 7V5.5a2.25 2.25 0 0 1 2.25-2.25h.15",
          }),
        ),
      );
    }

    // ---- 画布半：常驻 iframe（侧栏折叠或切换 tab 时不重载）----
    // iframe 挂在模块级 detached 容器，组件 mount 时移入、卸载时移回，
    // contentWindow 全程存活。

    var persistentHost = null;
    function ensurePersistentHost() {
      if (persistentHost) return persistentHost;
      persistentHost = document.createElement("div");
      persistentHost.style.cssText = "width:100%;height:100%;display:flex;";
      var frame = document.createElement("iframe");
      frame.src = CANVAS_URL;
      frame.title = "工作流画布";
      frame.allow = "clipboard-write";
      frame.style.cssText =
        "width:100%;height:100%;border:0;display:block;flex:1;";
      frame.addEventListener("load", function () {
        canvasReady = true;
      });
      persistentHost.appendChild(frame);
      return persistentHost;
    }
    var canvasReady = false;

    function CanvasPane(props) {
      var sessionId = props.sessionId;
      var mountRef = react.useRef(null);
      var frameRef = react.useRef(null);
      var [ready, setReady] = react.useState(canvasReady);

      // mount/卸载：搬运常驻宿主而不是重建
      react.useEffect(function () {
        var host = ensurePersistentHost();
        if (mountRef.current) mountRef.current.appendChild(host);
        frameRef.current = host.querySelector("iframe");
        setReady(canvasReady);
        return function () {
          // 移回 detached 状态，React 不碰它，切 tab 再回来内容原样
          if (host.parentNode) host.parentNode.removeChild(host);
        };
      }, []);

      // sessionId 或画布 ready 任一就绪即（重）发绑定。blank 会话首条消息后，
      // dsh 会换成正式 sessionId，但侧栏组件不一定重渲染；轮询只补发身份，iframe 不重载。

      react.useEffect(
        function () {
          var lastSent = null;
          // wf1-ready = 画布新实例（首载或画布内刷新按钮 reload）：重置防重标记，
          // 让轮询立即重发 sessionId——否则刷新后的画布拿不到会话，图永远不加载。
          function resetOnReady(ev) {
            if (ev.source !== frameRef.current?.contentWindow) return;
            if (ev.data && ev.data.type === "wf1-ready") lastSent = null;
          }
          window.addEventListener("message", resetOnReady);
          function sendSession() {
            var frame = frameRef.current;
            var current = currentDshSessionId(sessionId);
            if (!frame || !ready || !current || current === lastSent) return;
            try {
              frame.contentWindow.postMessage(
                { type: "wf1-session", sessionId: current },
                window.location.origin,
              );
              lastSent = current;
            } catch (e) {
              /* 画布未就绪 */
            }
          }
          sendSession();
          var timer = window.setInterval(sendSession, 500);
          return function () {
            window.clearInterval(timer);
            window.removeEventListener("message", resetOnReady);
          };
        },
        [sessionId, ready],
      );

      react.useEffect(function () {
        function onMessage(ev) {
          if (ev.source !== frameRef.current?.contentWindow) return;
          var d = ev.data;
          if (!d || typeof d !== "object") return;
          if (d.type === "wf1-ready") {
            canvasReady = true;
            setReady(true);
          }
        }
        window.addEventListener("message", onMessage);
        return function () {
          window.removeEventListener("message", onMessage);
        };
      }, []);

      return react.createElement(
        "div",
        {
          style: {
            position: "relative",
            width: "100%",
            height: "100%",
            minHeight: 0,
          },
        },
        react.createElement("div", {
          ref: mountRef,
          style: { position: "absolute", inset: 0 },
        }),
        ready
          ? null
          : react.createElement(
              "div",
              {
                style: {
                  position: "absolute",
                  top: 8,
                  right: 12,
                  fontSize: 12,
                  color: "#8b8578",
                  pointerEvents: "none",
                },
              },
              "画布加载中…",
            ),
      );
    }

    function SidebarWorkflowTab(props) {
      var scope = props.scope || {};
      return react.createElement(
        "div",
        { className: "wf1-view-root" },
        react.createElement(
          "div",
          { className: "wf1-canvas-fill" },
          react.createElement(CanvasPane, { sessionId: scope.sessionId }),
        ),
      );
    }

    function sidebarAllTabs(state) {
      var out = [];
      function walk(node) {
        if (!node || node.kind !== "leaf") {
          ((node && node.children) || []).forEach(walk);
          return;
        }
        (node.tabs || []).forEach(function (tab) {
          out.push(tab);
        });
      }
      walk(state && state.splits);
      walk(state && state.bottomSplits);
      return out;
    }

    function removeLegacyChatTabs(svc) {
      if (!svc || !svc.getSnapshot) return;
      try {
        var snap = svc.getSnapshot();
        if (!snap || !snap.state) return;
        sidebarAllTabs(snap.state)
          .filter(function (tab) {
            return tab.type === LEGACY_CHAT_TAB_TYPE;
          })
          .forEach(function (tab) {
            svc.closeTab(tab.id);
          });
      } catch (e) {
        /* 状态异常不阻塞 */
      }
    }

    function apply(ctx) {
      ensureStyle();

      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register(
          {
            name: "conversation.input.left",
            id: "ccpg-workflow-open",
            order: 30,
          },
          WorkflowOpenButton,
        );
      });

      // DSH-better-sidebar「工作流」tab：软依赖注入。
      try {
        ctx.inject(["betterSidebar"], function (scope) {
          setBetterSidebarService(scope.betterSidebar);
          scope.effect(function () {
            return function () {
              setBetterSidebarService(null);
            };
          }, "canvasui: sidebar svc ref");
          scope.effect(function () {
            return scope.betterSidebar.registerTab({
              id: WORKFLOW_TAB_TYPE,
              title: function () {
                return "工作流";
              },
              icon: function (size) {
                return react.createElement(
                  "svg",
                  {
                    viewBox: "0 0 16 16",
                    width: size || 14,
                    height: size || 14,
                    "aria-hidden": true,
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": 1.6,
                    "stroke-linecap": "round",
                    "stroke-linejoin": "round",
                  },
                  react.createElement("circle", { cx: 3.25, cy: 4, r: 1.35 }),
                  react.createElement("circle", {
                    cx: 12.75,
                    cy: 3.25,
                    r: 1.35,
                  }),
                  react.createElement("circle", {
                    cx: 12.75,
                    cy: 12.75,
                    r: 1.35,
                  }),
                  react.createElement("path", {
                    d: "M4.6 4h2.15A2.25 2.25 0 0 1 9 6.25v4.25A2.25 2.25 0 0 0 11.25 12.75h.15M9 7V5.5a2.25 2.25 0 0 1 2.25-2.25h.15",
                  }),
                );
              },
              order: WORKFLOW_TAB_ORDER,
              single: true,
              component: SidebarWorkflowTab,
            });
          }, "canvasui: better-sidebar workflow tab");
          // 清理旧版本持久化的「对话记录」tab；hydrate 可能晚一拍，持续随状态校验。
          scope.effect(function () {
            var svc = scope.betterSidebar;
            if (!svc || !svc.subscribeState) return;
            var check = function () {
              removeLegacyChatTabs(svc);
            };
            var off = svc.subscribeState(check);
            check();
            return off;
          }, "canvasui: remove legacy chat tabs");
        });
      } catch (e) {
        /* 老运行时无 ctx.inject：跳过侧边栏注册 */
      }
    }

    exports.apply = apply;
    exports.name = "dsh-ccpg-canvasui/client";
    exports.inject = ["slots"];
    exports.__test = {
      currentDshSessionId: currentDshSessionId,
      openWorkflowSidebar: openWorkflowSidebar,
      removeLegacyChatTabs: removeLegacyChatTabs,
      setBetterSidebarService: setBetterSidebarService,
      sidebarAllTabs: sidebarAllTabs,
      subscribeSidebarService: subscribeSidebarService,
    };

    return exports;
  },
});
