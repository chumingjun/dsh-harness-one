// dsh-ccpg-canvasui 浏览器入口（bundle 工厂格式，window.__ModuleLoader__.load 注册）。
// 职责：向 DSH-better-sidebar（社区侧边栏工作台）注册「工作流」tab，内容为
// 同源 /wf1/ 画布 iframe；对话区保持官方单一视图，不再注册工作流 conversation tab。
// 对话输入框左侧的工作流按钮直接展开该侧栏。接入是软依赖
//（ctx.inject(['betterSidebar'],…)）：未安装 better-sidebar 时按钮保持不可用。
// 画布 ↔ 宿主经 postMessage 桥接：
//   宿主 → 画布：{type:'wf1-session', sessionId}（画布据此绑 AI 助手工具作用域）
//               {type:'wf1-theme', theme:'dark'|'light'}（画布跟随主界面主题）
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

    // ---- 主题桥：官方 UI 的 dark/light → 画布 data-theme ----
    // 官方 UI 把当前主题记在 body[data-ds-dark-theme]（brand 插件同款锚点）；
    // MutationObserver 监听该属性 + body class 变化，变化即向画布 iframe 发
    // wf1-theme。独立标签页打开画布（无宿主）时画布保持自身默认主题。
    function currentHostTheme() {
      var body = document.body;
      if (!body) return "dark";
      if (body.hasAttribute("data-ds-dark-theme")) return "dark";
      // 官方浅色：属性移除。历史版本曾用 class 携带主题名，一并识别。
      var m = /(?:^|\s)(dark|light)(?:\s|$)/.exec(body.className || "");
      return m ? m[1] : "light";
    }
    var themeBridge = { notifyReload: null };
    function notifyThemeReload() {
      if (themeBridge.notifyReload) themeBridge.notifyReload();
    }
    function startThemeBridge(getFrame) {
      var lastTheme = null;
      var send = function () {
        var theme = currentHostTheme();
        if (theme === lastTheme) return;
        lastTheme = theme;
        var frame = getFrame();
        if (!frame) return;
        try {
          frame.contentWindow.postMessage(
            { type: "wf1-theme", theme: theme },
            window.location.origin,
          );
        } catch (e) { /* 画布未就绪 */ }
      };
      send();
      // 画布 reload 后 lastTheme 仍等于旧值 → 重置让 send() 立即重发
      themeBridge.notifyReload = function () { lastTheme = null; send(); };
      var observer = new MutationObserver(send);
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme", "class"],
      });
      return function () {
        themeBridge.notifyReload = null;
        observer.disconnect();
      };
    }

    function currentDshSessionId(fallback) {
      try {
        var raw = window.localStorage.getItem("dsh.sessions.current");
        var current = raw ? JSON.parse(raw) : null;
        return (current && current.sessionId) || fallback;
      } catch (e) {
        return fallback;
      }
    }

    var RUN_EVENT_NAMES = ["snapshot", "run-start", "node-status", "agent-progress", "run-end", "run-error"];
    var runEventHub = { sessionId: null, source: null, listeners: new Set(), timer: null };
    function ensureRunEventHub() {
      var sessionId = currentDshSessionId(null);
      if (runEventHub.source && runEventHub.sessionId === sessionId) return;
      if (runEventHub.source) runEventHub.source.close();
      runEventHub.source = null;
      runEventHub.sessionId = sessionId;
      if (!sessionId || !runEventHub.listeners.size || !window.EventSource) return;
      var source = new window.EventSource("/wf1/api/events?sessionId=" + encodeURIComponent(sessionId));
      RUN_EVENT_NAMES.forEach(function (eventName) {
        source.addEventListener(eventName, function (event) {
          try {
            var payload = JSON.parse(event.data);
            runEventHub.listeners.forEach(function (listener) { listener(eventName, payload); });
          } catch (e) { /* 单条异常事件不影响后续消息 */ }
        });
      });
      runEventHub.source = source;
    }
    function subscribeRunEvents(listener) {
      runEventHub.listeners.add(listener);
      ensureRunEventHub();
      if (!runEventHub.timer) runEventHub.timer = window.setInterval(ensureRunEventHub, 1000);
      return function () {
        runEventHub.listeners.delete(listener);
        if (runEventHub.listeners.size) return;
        if (runEventHub.source) runEventHub.source.close();
        if (runEventHub.timer) window.clearInterval(runEventHub.timer);
        runEventHub.source = null;
        runEventHub.sessionId = null;
        runEventHub.timer = null;
      };
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
        // ---- 消息流工作流卡片（tool.call.toolview）----
        ".wf1-card{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;gap:6px;cursor:pointer;transition:border-color 100ms ease;background:var(--dsw-alias-bg-base);text-align:left;width:100%;}",
        ".wf1-card:hover{border-color:var(--dsw-alias-border-l2);}",
        ".wf1-card:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3);}",
        ".wf1-card-head{display:flex;align-items:center;gap:8px;min-width:0;}",
        ".wf1-card-icon{width:16px;height:16px;color:var(--dsw-alias-label-secondary);flex:none;}",
        ".wf1-card-title{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px;flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        ".wf1-card-state{display:inline-flex;align-items:center;gap:5px;margin-left:auto;flex:none;font-size:13px;color:var(--dsw-alias-label-caption);}",
        ".wf1-card-dot{width:7px;height:7px;border-radius:999px;flex:none;}",
        ".wf1-card-dot[data-s=running]{background:var(--dsw-alias-state-business-primary);animation:wf1-card-pulse 1.6s ease-in-out infinite;}",
        ".wf1-card-dot[data-s=success]{background:var(--dsw-alias-state-success-primary);}",
        ".wf1-card-dot[data-s=error]{background:var(--dsw-alias-state-error-primary);}",
        ".wf1-card-dot[data-s=waiting]{background:var(--dsw-alias-state-warn-primary);}",
        ".wf1-card-dot[data-s=pending]{background:var(--dsw-alias-border-l2);}",
        "@keyframes wf1-card-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
        ".wf1-card-map{height:108px;border-radius:8px;display:block;width:100%;background:color-mix(in srgb,var(--dsw-alias-border-l1) 18%,transparent);}",
        ".wf1-card-node[data-s=running]{animation:wf1-card-pulse 1.6s ease-in-out infinite;}",
        ".wf1-card-foot{display:flex;align-items:center;gap:8px;min-width:0;}",
        ".wf1-card-meta{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
        ".wf1-card-meta[data-error]{color:var(--dsw-alias-state-error-primary);}",
        ".wf1-card-open{flex:none;display:inline-flex;align-items:center;gap:3px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;opacity:0;transition:opacity 100ms ease;}",
        ".wf1-card:hover .wf1-card-open,.wf1-card:focus-visible .wf1-card-open{opacity:1;}",
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

    // ---- 消息流工作流卡片（tool.call.toolview）----
    // 数据源全部现成：canvas_run_workflow 的工具结果带 runId → 轮询 /wf1/api/runs/detail；
    // canvas_graph_patch 的 args/结果自带 ops 与 lint。卡片自绘 SVG 缩略图，画布本体零改动。

    function workflowIcon(size) {
      return react.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size || 16,
          height: size || 16,
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
      );
    }

    // 工具 block 的统一文本抽取：running block 无 content，settled block.content 是
    // [{type:'text',text}] 数组（官方 tool-result 投影）。
    function toolText(block) {
      if (!block || !("kind" in block) || !Array.isArray(block.content)) return null;
      return block.content
        .filter(function (c) { return c && c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("");
    }

    // canvas_run_workflow 结果 JSON 里的 runId（execute 返回 {started:true,runId} 字符串）；
    // canvas_run_status 的结果没有 runId，从 args 里取（组件用 props.toolName 区分）。
    function runIdFromText(text) {
      if (!text) return null;
      try {
        var v = JSON.parse(text);
        return v && typeof v === "object" && typeof v.runId === "string" ? v.runId : null;
      } catch (e) {
        return null;
      }
    }
    function runIdFromArgs(argsRaw) {
      if (!argsRaw) return null;
      try {
        var v = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
        return v && typeof v === "object" && typeof v.runId === "string" ? v.runId : null;
      } catch (e) {
        return null;
      }
    }

    var RUN_STATUS_CN = {
      running: "运行中", success: "已完成", error: "失败",
      canceled: "已取消", interrupted: "异常中断", skipped: "已跳过", waiting: "等待审批",
      queued: "等待中", pending: "未开始",
    };
    function runDotState(run, fallback) {
      var s = run ? run.status : fallback;
      if (s === "success") return "success";
      if (s === "error" || s === "canceled" || s === "interrupted") return "error";
      if (s === "waiting") return "waiting";
      if (s === "running" || !run) return "running";
      return "pending";
    }

    function mergeRunEvent(run, eventName, payload) {
      if (!payload || (run?.runId && payload.runId && payload.runId !== run.runId)) return run;
      if (eventName === "snapshot" || eventName === "run-start") {
        return { ...(run || {}), ...payload, status: payload.status || "running" };
      }
      if (!run) return run;
      if ((eventName === "node-status" || eventName === "agent-progress") && payload.nodeId) {
        var previous = run.nodeStates && run.nodeStates[payload.nodeId] || {};
        var state = eventName === "agent-progress"
          ? { ...previous, ...(payload.turns != null ? { turns: payload.turns } : {}) }
          : { ...previous, ...payload };
        return { ...run, nodeStates: { ...(run.nodeStates || {}), [payload.nodeId]: state } };
      }
      if (eventName === "run-end") return { ...run, status: payload.status || run.status, durationMs: payload.durationMs ?? run.durationMs };
      if (eventName === "run-error") return { ...run, status: "error", error: payload.error || run.error };
      return run;
    }

    function shouldFollowRun(run, candidate) {
      if (!run || !candidate?.runId || candidate.runId === run.runId) return false;
      if (["interrupted", "error", "canceled"].indexOf(run.status) < 0) return false;
      if (run.workflowId || candidate.workflowId) return Boolean(run.workflowId && run.workflowId === candidate.workflowId);
      return Boolean(run.canvasId && run.canvasId === candidate.canvasId);
    }

    var NODE_TYPE_CN = {
      input: "输入", agent: "智能体", condition: "条件", http: "HTTP",
      script: "脚本", output: "输出",
    };

    // 取 DAG 最长路径作为卡片主流程；运行态排除明确跳过的节点。
    function flowPreviewModel(graph, nodeStates) {
      var nodes = (graph && Array.isArray(graph.nodes) ? graph.nodes : []).filter(function (n) {
        return (n.type || (n.data && n.data.nodeType)) !== "note";
      });
      if (!nodes.length) return null;
      var previewNodes = nodes.filter(function (n) {
        return !nodeStates || !nodeStates[n.id] || nodeStates[n.id].status !== "skipped";
      });
      if (!previewNodes.length) previewNodes = nodes;
      var byId = {}, incoming = {}, outgoing = {};
      previewNodes.forEach(function (n) { byId[n.id] = n; incoming[n.id] = 0; outgoing[n.id] = []; });
      (graph.edges || []).forEach(function (edge) {
        if (!byId[edge.source] || !byId[edge.target]) return;
        outgoing[edge.source].push(edge.target);
        incoming[edge.target] += 1;
      });
      var position = function (id) {
        var p = byId[id].position || byId[id].data && byId[id].data.position || {};
        return [Number(p.x) || 0, Number(p.y) || 0];
      };
      var sortIds = function (ids) {
        return ids.sort(function (a, b) {
          var ap = position(a), bp = position(b);
          return ap[0] - bp[0] || ap[1] - bp[1] || a.localeCompare(b);
        });
      };
      var queue = sortIds(previewNodes.filter(function (n) { return incoming[n.id] === 0; }).map(function (n) { return n.id; }));
      var order = [], paths = {};
      queue.forEach(function (id) { paths[id] = [id]; });
      while (queue.length) {
        var id = queue.shift();
        order.push(id);
        outgoing[id].forEach(function (next) {
          var candidate = (paths[id] || [id]).concat(next);
          if (!paths[next] || candidate.length > paths[next].length) paths[next] = candidate;
          incoming[next] -= 1;
          if (incoming[next] === 0) { queue.push(next); sortIds(queue); }
        });
      }
      if (order.length !== previewNodes.length) order = sortIds(previewNodes.map(function (n) { return n.id; }));
      var numberById = {};
      var path = order.reduce(function (best, id) {
        var candidate = paths[id] || [id];
        return candidate.length > best.length ? candidate : best;
      }, []);
      if (!path.length) path = order;
      path.forEach(function (id, index) { numberById[id] = index + 1; });
      var visible = path.length > 5 ? path.slice(0, 2).concat(null, path.slice(-2)) : path;
      return {
        items: visible.map(function (id) {
          if (id === null) return null;
          var node = byId[id];
          return {
            id: id,
            number: numberById[id],
            label: String(node.data && node.data.label || id),
            type: node.type || node.data && node.data.nodeType || "",
          };
        }),
        pathLength: path.length,
        otherNodeCount: Math.max(0, nodes.length - path.length),
      };
    }

    // 语义化流程摘要：真实主路径 + 连续序号，比缩小整张画布更适合消息卡片。
    function graphThumbnail(graph, run) {
      var model = flowPreviewModel(graph, run && run.nodeStates);
      if (!model) return null;
      var states = (run && run.nodeStates) || {};
      var colorOf = function (st) {
        if (st === "running") return "var(--dsw-alias-state-business-primary)";
        if (st === "success") return "var(--dsw-alias-state-success-primary)";
        if (st === "error" || st === "canceled") return "var(--dsw-alias-state-error-primary)";
        if (st === "waiting") return "var(--dsw-alias-state-warn-primary)";
        return "var(--dsw-alias-border-l2)";
      };
      var W = 360, H = 108, BOX_H = 44;
      var BOX_W = model.items.length <= 3 ? 96 : model.items.length === 4 ? 74 : 60;
      var GAP = model.items.length > 1 ? (W - 24 - model.items.length * BOX_W) / (model.items.length - 1) : 0;
      var contentW = model.items.length * BOX_W + (model.items.length - 1) * GAP;
      var startX = (W - contentW) / 2, y = 17;
      var elements = [];
      model.items.forEach(function (item, index) {
        var x = startX + index * (BOX_W + GAP);
        if (index > 0) {
          var prevX = x - GAP;
          elements.push(react.createElement("line", {
            key: "line-" + index, x1: prevX, y1: y + BOX_H / 2, x2: x - 4, y2: y + BOX_H / 2,
            stroke: "var(--dsw-alias-border-l2)", "stroke-width": 1.4,
            "stroke-dasharray": item === null || model.items[index - 1] === null ? "3 3" : undefined,
          }));
          elements.push(react.createElement("path", {
            key: "arrow-" + index,
            d: "M" + (x - 8) + " " + (y + BOX_H / 2 - 3) + " L" + (x - 4) + " " + (y + BOX_H / 2) + " L" + (x - 8) + " " + (y + BOX_H / 2 + 3),
            fill: "none", stroke: "var(--dsw-alias-border-l2)", "stroke-width": 1.4,
          }));
        }
        if (item === null) {
          elements.push(react.createElement("text", {
            key: "ellipsis", x: x + BOX_W / 2, y: y + BOX_H / 2 + 3,
            "text-anchor": "middle", fill: "var(--dsw-alias-label-caption)", "font-size": 13,
          }, "•••"));
          return;
        }
        var status = states[item.id] && states[item.id].status || "pending";
        var color = colorOf(status);
        var maxLabel = BOX_W >= 90 ? 7 : BOX_W >= 70 ? 4 : 3;
        var label = item.label.length > maxLabel ? item.label.slice(0, maxLabel) + "…" : item.label;
        elements.push(react.createElement("rect", {
          key: "box-" + item.id, x: x, y: y, width: BOX_W, height: BOX_H, rx: 6,
          className: "wf1-card-node", "data-s": status,
          fill: "var(--dsw-alias-bg-base)", stroke: color, "stroke-width": status === "pending" ? 1 : 1.6,
        }));
        elements.push(react.createElement("circle", {
          key: "number-bg-" + item.id, cx: x + 13, cy: y + 14, r: 8, fill: color,
        }));
        elements.push(react.createElement("text", {
          key: "number-" + item.id, x: x + 13, y: y + 17,
          "text-anchor": "middle", fill: "var(--dsw-alias-bg-base)", "font-size": 8.5, "font-weight": 600,
        }, String(item.number).padStart(2, "0")));
        elements.push(react.createElement("text", {
          key: "label-" + item.id, x: x + 25, y: y + 17,
          fill: "var(--dsw-alias-label-primary)", "font-size": 10.5, "font-weight": 600,
        }, label));
        elements.push(react.createElement("text", {
          key: "type-" + item.id, x: x + 13, y: y + 34,
          fill: "var(--dsw-alias-label-caption)", "font-size": 9,
        }, NODE_TYPE_CN[item.type] || item.type || "节点"));
      });
      var summary = "主流程 " + model.pathLength + " 步" + (model.otherNodeCount ? " · 另有 " + model.otherNodeCount + " 个节点" : "");
      elements.push(react.createElement("text", {
        key: "summary", x: 12, y: 94, fill: "var(--dsw-alias-label-tertiary)", "font-size": 10,
      }, summary));
      return react.createElement(
        "svg", {
          className: "wf1-card-map", viewBox: "0 0 " + W + " " + H, role: "img",
          "aria-label": summary + "：" + model.items.map(function (item) {
            var status = item && states[item.id] && states[item.id].status || "pending";
            return item ? item.number + " " + item.label + " " + RUN_STATUS_CN[status] : "省略 " + (model.pathLength - 4) + " 步";
          }).join("，"),
        },
        elements,
      );
    }

    function runCardProgress(run) {
      var graphNodes = (run && run.graph && Array.isArray(run.graph.nodes) ? run.graph.nodes : []).filter(function (n) {
        return (n.type || (n.data && n.data.nodeType)) !== "note";
      });
      var states = run && run.nodeStates || {};
      var nodeIds = graphNodes.length ? graphNodes.map(function (n) { return n.id; }) : Object.keys(states);
      var labels = {};
      graphNodes.forEach(function (n) { labels[n.id] = n.data && n.data.label || n.id; });
      var result = { total: nodeIds.length, done: 0, currentLabel: "", error: "" };
      nodeIds.forEach(function (id) {
        var state = states[id] || {};
        if (["success", "error", "canceled", "skipped"].indexOf(state.status) >= 0) result.done += 1;
        if (state.status === "running") result.currentLabel = labels[id] || id;
        if (!result.error && (state.error || state.toleratedError)) result.error = String(state.error || state.toleratedError);
      });
      return result;
    }

    function openCanvasFallback() {
      if (openWorkflowSidebar()) return;
      window.open(CANVAS_URL, "_blank");
    }

    // 卡片骨架：头（图标+标题+状态章）+ 缩略图 + 底（meta+打开按钮）。整卡可点。
    function workflowCardShell(props) {
      return react.createElement(
        "button",
        {
          type: "button",
          className: "wf1-card",
          onClick: function () { try { openCanvasFallback(); } catch (e) { /* 宿主状态异常不炸消息流 */ } },
        },
        react.createElement(
          "div", { className: "wf1-card-head" },
          react.createElement("span", { className: "wf1-card-icon" }, workflowIcon(16)),
          react.createElement("span", { className: "wf1-card-title" }, props.title),
          react.createElement(
            "span", { className: "wf1-card-state" },
            react.createElement("span", { className: "wf1-card-dot", "data-s": props.dotState }),
            props.stateText,
          ),
        ),
        props.thumbnail || null,
        react.createElement(
          "div", { className: "wf1-card-foot" },
          react.createElement(
            "span", { className: "wf1-card-meta", "data-error": props.metaError || undefined },
            props.meta,
          ),
          react.createElement("span", { className: "wf1-card-open" }, "打开画布 ↗"),
        ),
      );
    }

    // 运行卡：canvas_run_workflow / canvas_run_status 共用。
    // SSE 实时更新，2s 详情轮询只作断线兜底；失败续跑后自动切到同工作流的新 run。
    function WorkflowRunCard(props) {
      var block = props.block || {};
      var text = toolText(block);
      // runId 双源：canvas_run_workflow 从结果 JSON 解析；canvas_run_status 结果没有
      // runId，从调用 args 取（running/settled 两个阶段都带）。
      var argsRaw = (block.call && block.call.argsRaw) || block.argsRaw;
      var runId = react.useMemo(
        function () { return runIdFromText(text) || runIdFromArgs(argsRaw); },
        [text, argsRaw],
      );
      var [trackedRunId, setTrackedRunId] = react.useState(runId);
      var [run, setRun] = react.useState(null);
      var [missing, setMissing] = react.useState(false);

      react.useEffect(function () {
        setTrackedRunId(runId);
      }, [runId]);

      react.useEffect(function () {
        if (!trackedRunId) return undefined;
        var stopped = false;
        var latestRun = null;
        var timer = null;
        var scopedUrl = function (path) {
          var sessionId = currentDshSessionId(null);
          if (!sessionId) return path;
          return path + (path.indexOf("?") >= 0 ? "&" : "?") + "sessionId=" + encodeURIComponent(sessionId);
        };
        var followCurrentRun = function (current) {
          if (!current || ["interrupted", "error", "canceled"].indexOf(current.status) < 0) return;
          fetch(scopedUrl("/wf1/api/runs"))
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
              if (stopped || !data) return;
              var replacement = (data.runs || []).find(function (candidate) {
                return candidate.live && shouldFollowRun(current, candidate);
              });
              if (replacement) setTrackedRunId(replacement.runId);
            })
            .catch(function () { /* 后续 SSE run-start 仍可接管 */ });
        };
        var fetchRun = function () {
          if (stopped) return;
          fetch(scopedUrl("/wf1/api/runs/detail?id=" + encodeURIComponent(trackedRunId)))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
              if (stopped || !d) { if (!d) setMissing(true); return; }
              setMissing(false);
              latestRun = d;
              setRun(d);
              if (d.status && d.status !== "running") {
                if (timer) window.clearInterval(timer);
                timer = null;
                followCurrentRun(d);
              }
            })
            .catch(function () { /* 单次失败继续轮询 */ });
        };
        var unsubscribe = subscribeRunEvents(function (eventName, payload) {
          if (payload?.runId === trackedRunId) {
            latestRun = mergeRunEvent(latestRun, eventName, payload);
            if (latestRun) setRun(latestRun);
            if (["run-end", "run-error"].indexOf(eventName) >= 0) {
              if (timer) window.clearInterval(timer);
              timer = null;
              followCurrentRun(latestRun);
            }
            return;
          }
          if ((eventName === "snapshot" || eventName === "run-start") && shouldFollowRun(latestRun, payload)) {
            setTrackedRunId(payload.runId);
          }
        });
        setRun(null);
        setMissing(false);
        fetchRun();
        timer = window.setInterval(fetchRun, 2000);
        return function () {
          stopped = true;
          if (timer) window.clearInterval(timer);
          unsubscribe();
        };
      }, [trackedRunId]);

      if (!runId) {
        // 起跑失败（画布未开/lint 拒绝）或会话未绑定：文本降级 + 保留跳转
        return workflowCardShell({
          title: "工作流运行",
          dotState: text && block.isError ? "error" : "pending",
          stateText: block.isError ? "未启动" : "就绪",
          meta: (text || "").slice(0, 60) || "画布尚未打开或未绑定会话",
          metaError: Boolean(block.isError),
          thumbnail: null,
        });
      }
      if (missing && !run) {
        return workflowCardShell({
          title: "工作流运行",
          dotState: "pending",
          stateText: "已归档",
          meta: "运行 " + trackedRunId.slice(0, 8) + "… 记录不在当前工作区",
          thumbnail: null,
        });
      }
      if (!run) {
        // runId 已解析、首次详情未返回的窗口（真实环境 <2s）：渲染加载态，
        // 不读 run.status（此前这里直接空指针）
        return workflowCardShell({
          title: "工作流运行",
          dotState: "running",
          stateText: "加载中",
          meta: "运行 " + trackedRunId.slice(0, 8) + "…",
          thumbnail: null,
        });
      }

      var dot = runDotState(run);
      var progress = runCardProgress(run);
      var nodeTotal = progress.total, nodeDone = progress.done;
      var currentLabel = progress.currentLabel, errText = progress.error;
      var secs = run && run.durationMs ? Math.round(run.durationMs / 1000) + "s" : "";
      var meta;
      if (dot === "running") {
        meta = (currentLabel ? "「" + currentLabel + "」执行中" : "执行中") + (secs ? " · " + secs : "");
      } else if (dot === "error") {
        meta = errText || run.status && (RUN_STATUS_CN[run.status] || run.status) || "运行失败";
      } else if (dot === "success") {
        meta = "完成" + (secs ? " · " + secs : "");
      } else {
        meta = RUN_STATUS_CN[run.status] || run.status || "";
      }
      return workflowCardShell({
        title: "工作流 · " + (run && run.workflowName ? run.workflowName : "草稿图"),
        dotState: dot,
        stateText: nodeTotal ? nodeDone + "/" + nodeTotal : (RUN_STATUS_CN[run.status] || run.status || "运行中"),
        meta: meta,
        metaError: dot === "error",
        thumbnail: graphThumbnail(run && run.graph, run),
      });
    }

    // 建图卡：canvas_graph_patch 的每次调用渲染一批操作 + 应用后的图快照。
    // args.ops 来自调用参数（running 时就有），结果文本（已应用 N 个操作 / 整批拒绝）settle 后补状态。
    var OP_CN = {
      addNode: "加节点", updateNode: "改节点", renameNode: "重命名", deleteNode: "删节点",
      connect: "连线", deleteEdge: "删线", updateEdge: "改线",
    };
    function GraphPatchCard(props) {
      var block = props.block || {};
      var settled = "kind" in block;
      var text = settled ? toolText(block) : null;
      // args：running block 是 {name,argsRaw}（宿主 call 形状），settled 后带 call.argsRaw
      var argsRaw = (block.call && block.call.argsRaw) || block.argsRaw;
      var ops = [];
      try {
        var parsed = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
        ops = (parsed && Array.isArray(parsed.ops)) ? parsed.ops : [];
      } catch (e) { /* 非法参数不炸卡片 */ }
      var opCount = {};
      ops.forEach(function (op) {
        var key = OP_CN[op.op] || op.op;
        opCount[key] = (opCount[key] || 0) + 1;
      });
      var opSummary = Object.keys(opCount)
        .map(function (k) { return opCount[k] + " " + k; })
        .join("、") || "无操作";

      var ok = settled ? !block.isError : true;
      var lintOk = ok && text ? text.indexOf("lint: 通过") >= 0 : false;
      var dotState = !settled ? "running" : ok ? (lintOk ? "success" : "pending") : "error";
      var stateText = !settled ? "应用中" : ok ? (lintOk ? "已应用" : "已应用·有告警") : "被拒绝";
      var meta;
      if (!settled) meta = opSummary;
      else if (!ok) meta = (text || "整批被拒绝").split("\n")[0].slice(0, 60);
      else meta = opSummary + (lintOk ? "" : " · lint 有告警");

      return workflowCardShell({
        title: "建图 · " + opSummary.slice(0, 40),
        dotState: dotState,
        stateText: stateText,
        meta: meta,
        metaError: settled && !ok,
        thumbnail: null,
      });
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
        var stopThemeBridge = startThemeBridge(function () { return frameRef.current; });
        return function () {
          stopThemeBridge();
          // 移回 detached 状态，React 不碰它，切 tab 再回来内容原样
          if (host.parentNode) host.parentNode.removeChild(host);
        };
      }, []);

      // 画布 reload（wf1-ready）后主题桥的 lastTheme 防重标记仍指旧实例，
      // 重置它让下一次 wf1-ready 时立即重发当前主题（与 sessionId 同款处理）。
      react.useEffect(function () {
        function resetThemeOnReady(ev) {
          if (ev.source !== frameRef.current?.contentWindow) return;
          if (ev.data && ev.data.type === "wf1-ready") notifyThemeReload();
        }
        window.addEventListener("message", resetThemeOnReady);
        return function () {
          window.removeEventListener("message", resetThemeOnReady);
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

    // ================= 设置面板「Workflow One」section：版本中心 + 一键升级 =================
    // 后端 /wf1/api/system/*（orchestrator）。数据安全边界（#60）：升级只动安装目录与
    // profile 依赖，工作区 .workflow-one/（SQLite/state）、定时 triggers、飞书凭据均不在触达面。
    var SYSTEM_INFO_API = "/wf1/api/system/info";
    var SYSTEM_CHECK_API = "/wf1/api/system/check-update";
    var SYSTEM_UPGRADE_API = "/wf1/api/system/upgrade";
    // agent 节点默认值（渠道/模型/思考级别）：与 llm-config 目录配套使用
    var AGENT_DEFAULTS_API = "/wf1/api/agent-defaults";
    var LLM_CONFIG_API = "/wf1/api/llm-config";

    function systemGet(api) {
      return fetch(api, { headers: { accept: "application/json" } }).then(function (r) {
        return r.json();
      });
    }
    function systemPost(api, body) {
      return fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json();
      });
    }

    function sourceMeta(pkg) {
      if (!pkg) return { label: "未安装", bg: "rgba(148,163,184,.18)" };
      if (pkg.kind === "registry") return { label: "npm", bg: "rgba(56,189,248,.16)" };
      if (pkg.kind === "link")
        return pkg.gitRoot
          ? { label: "源码", bg: "rgba(52,211,153,.16)" }
          : { label: "离线包", bg: "rgba(251,191,36,.16)" };
      return { label: "未知", bg: "rgba(148,163,184,.18)" };
    }

    var s2 = react.useState;

    function VersionRow(name, version, meta) {
      return react.createElement(
        "div",
        { key: name, style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", lineHeight: "22px" } },
        react.createElement("code", { style: { color: "var(--dsw-alias-label-primary)" } }, name),
        react.createElement("span", { style: { color: "var(--dsw-alias-text-secondary)" } }, version || "—"),
        react.createElement(
          "span",
          {
            style: {
              fontSize: "11px", padding: "0 6px", borderRadius: "6px",
              background: meta.bg, color: "var(--dsw-alias-label-primary)",
            },
          },
          meta.label,
        ),
      );
    }

    function ProfileBlock(profile) {
      var agg = profile.packages.find(function (p) { return p.name === "dsh-harness-one"; })
        || profile.packages.find(function (p) { return p.name === "dsh-ccpg-one"; }) || null;
      return react.createElement(
        "div",
        {
          key: profile.name,
          style: {
            border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))",
            borderRadius: "10px", padding: "10px 12px", display: "flex",
            flexDirection: "column", gap: "4px",
          },
        },
        react.createElement(
          "div",
          { style: { fontSize: "13px", fontWeight: 600 } },
          "profile: ",
          profile.name,
          agg ? react.createElement(
            "span",
            { style: { marginLeft: "8px", fontWeight: 400, color: "var(--dsw-alias-text-secondary)", fontSize: "12px" } },
            AGG_SPEC_TEXT(agg),
          ) : null,
        ),
        profile.packages.map(function (p) {
          // link 目标缺版本时用占位符（整条 link: 路径太长不可读）
          var shown = p.version || (p.kind === "registry" ? p.spec : "—");
          return VersionRow(p.name, shown, sourceMeta(p));
        }),
      );
    }

    function AGG_SPEC_TEXT(entry) {
      if (entry.kind === "registry") return "聚合安装（npm " + (entry.spec || "") + "）";
      if (entry.gitRoot) return "聚合安装（源码 link）";
      return "聚合安装（离线包）";
    }

    // ================= Agent 节点默认值（渠道 / 模型 / 思考级别） =================
    // 语义：节点自身没配置时的兜底，再往下才是 dsh 全局选择（与 runAgentNode 同一解析链）。

    function modelOptionsFor(llmConfig, providerId) {
      var providers = (llmConfig && llmConfig.providers) || [];
      for (var i = 0; i < providers.length; i++) {
        if (providers[i].id === providerId) return providers[i].models || [];
      }
      return [];
    }

    function effortOptionsFor(llmConfig, providerId, modelId) {
      var models = modelOptionsFor(llmConfig, providerId);
      for (var i = 0; i < models.length; i++) {
        if (models[i].id === modelId) return (models[i].reasoning && models[i].reasoning.efforts) || [];
      }
      return [];
    }

    function providerNameOf(llmConfig, providerId) {
      var providers = (llmConfig && llmConfig.providers) || [];
      for (var i = 0; i < providers.length; i++) {
        if (providers[i].id === providerId) return providers[i].name || providers[i].id;
      }
      return providerId || "";
    }

    var selectStyle = {
      width: "100%", padding: "6px 8px", borderRadius: "8px", fontSize: "13px",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))",
      background: "var(--dsw-alias-bg-primary, transparent)", color: "var(--dsw-alias-label-primary)",
    };

    function defaultsField(label, control) {
      return react.createElement(
        "div",
        { key: label, style: { display: "flex", alignItems: "center", gap: "10px" } },
        react.createElement(
          "div",
          { style: { width: "72px", flexShrink: 0, fontSize: "13px", color: "var(--dsw-alias-text-secondary)" } },
          label,
        ),
        react.createElement("div", { style: { flex: 1 } }, control),
      );
    }

    function AgentDefaultsCard() {
      var a = s2(null), llmConfig = a[0], setLlmConfig = a[1];
      var b = s2(null), saved = b[0], setSaved = b[1]; // GET/PUT 回包 {defaults, effective, dsh}
      var c = s2({ provider: "", model: "", reasoningEffort: "", nodeTimeoutSec: 0, modelTimeoutSec: 0, systemPrompt: "" }), draft = c[0], setDraft = c[1];
      var e = s2(false), saving = e[0], setSaving = e[1];
      var f = s2(null), message = f[0], setMessage = f[1]; // {kind:'ok'|'err', text}

      react.useEffect(function () {
        var dead = false;
        systemGet(LLM_CONFIG_API).then(function (d2) { if (!dead) setLlmConfig(d2); }).catch(function () {
          if (!dead) setLlmConfig({ providers: [] });
        });
        systemGet(AGENT_DEFAULTS_API).then(function (d2) {
          if (dead || !d2 || !d2.ok) return;
          setSaved(d2);
          setDraft(Object.assign({ provider: "", model: "", reasoningEffort: "", nodeTimeoutSec: 0, modelTimeoutSec: 0, systemPrompt: "" }, d2.defaults));
        }).catch(function () {});
        return function () { dead = true; };
      }, []);

      var providers = (llmConfig && llmConfig.providers) || [];
      var dirty = !!saved && (
        draft.provider !== saved.defaults.provider
        || draft.model !== saved.defaults.model
        || draft.reasoningEffort !== saved.defaults.reasoningEffort
        || Number(draft.nodeTimeoutSec || 0) !== Number(saved.defaults.nodeTimeoutSec || 0)
        || Number(draft.modelTimeoutSec || 0) !== Number(saved.defaults.modelTimeoutSec || 0)
        || String(draft.systemPrompt || "") !== String(saved.defaults.systemPrompt || "")
      );

      var patchDraft = function (patch) {
        setMessage(null);
        setDraft(function (prev) { return Object.assign({}, prev, patch); });
      };

      var save = function () {
        setSaving(true);
        setMessage(null);
        // 超时输入框是文本：空串归 0（不设置），非法值在提交前拦下
        var payload = Object.assign({}, draft, {
          nodeTimeoutSec: Math.max(0, Math.floor(Number(draft.nodeTimeoutSec) || 0)),
          modelTimeoutSec: Math.max(0, Math.floor(Number(draft.modelTimeoutSec) || 0)),
          systemPrompt: String(draft.systemPrompt || ""),
        });
        if (draft.nodeTimeoutSec !== "" && (!Number.isFinite(Number(draft.nodeTimeoutSec)) || Number(draft.nodeTimeoutSec) < 0)
          || draft.modelTimeoutSec !== "" && (!Number.isFinite(Number(draft.modelTimeoutSec)) || Number(draft.modelTimeoutSec) < 0)) {
          setSaving(false);
          setMessage({ kind: "err", text: "超时必须是不小于 0 的整数（秒），0 表示用内置默认" });
          return;
        }
        fetch(AGENT_DEFAULTS_API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json(); })
          .then(function (r2) {
            if (r2 && r2.ok) {
              setSaved(r2);
              setDraft(Object.assign({ provider: "", model: "", reasoningEffort: "", nodeTimeoutSec: 0, modelTimeoutSec: 0, systemPrompt: "" }, r2.defaults));
              setMessage({ kind: "ok", text: "已保存，新发起的运行立即生效" });
            } else {
              setMessage({ kind: "err", text: (r2 && r2.error) || "保存失败" });
            }
          })
          .catch(function () { setMessage({ kind: "err", text: "连接不上本地服务，请确认 dsh 正在运行" }); })
          .finally(function () { setSaving(false); });
      };

      // —— 选项装配 ——
      var dshProvider = saved && saved.dsh && saved.dsh.provider;
      var providerOptions = [{ value: "", label: "跟随 dsh 默认" + (dshProvider ? "（" + providerNameOf(llmConfig, dshProvider) + "）" : "") }]
        .concat(providers.map(function (p) { return { value: p.id, label: p.name || p.id }; }));

      var models = modelOptionsFor(llmConfig, draft.provider);
      var modelOptions = [{ value: "", label: draft.provider ? "渠道首选模型" : "跟随渠道" }]
        .concat(models.map(function (m) { return { value: m.id, label: (m.name || m.id) + (m.vision ? " 👁" : "") }; }));
      // 已保存的模型从目录下线时保留原值展示，避免静默改写用户配置
      if (draft.model && !models.some(function (m) { return m.id === draft.model; })) {
        modelOptions.push({ value: draft.model, label: draft.model + "（目录中不可用）" });
      }

      var efforts = effortOptionsFor(llmConfig, draft.provider, draft.model);
      var effortOptions = [{ value: "", label: "跟随模型默认" }]
        .concat(efforts.map(function (e2) { return { value: e2.id, label: e2.name || e2.id }; }));
      if (draft.reasoningEffort && !efforts.some(function (e2) { return e2.id === draft.reasoningEffort; })) {
        effortOptions.push({ value: draft.reasoningEffort, label: draft.reasoningEffort + "（模型不支持）" });
      }

      var effective = saved && saved.effective;
      var effectiveText = !effective || !effective.provider
        ? null
        : "当前生效：" + providerNameOf(llmConfig, effective.provider)
          + " / " + (effective.model || "渠道首选模型")
          + (effective.reasoningEffort ? " / 思考级别 " + effective.reasoningEffort : "");

      var mkTimeoutInput = function (key, placeholder) {
        return react.createElement("input", {
          type: "number", min: 0, max: 86400, step: 1,
          style: selectStyle,
          value: draft[key] === 0 || draft[key] === "" ? "" : draft[key],
          placeholder: placeholder,
          disabled: saving,
          onChange: function (ev) { patchDraft({ [key]: ev.target.value === "" ? 0 : Number(ev.target.value) }); },
        });
      };

      var mkSelect = function (value, options, disabled, onChange) {
        return react.createElement(
          "select",
          {
            style: selectStyle,
            value: value,
            disabled: disabled,
            onChange: function (ev) { onChange(ev.target.value); },
          },
          options.map(function (o) {
            return react.createElement("option", { key: o.value || "__default", value: o.value }, o.label);
          }),
        );
      };

      return react.createElement(
        "div",
        {
          style: {
            border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))",
            borderRadius: "10px", padding: "12px 14px", display: "flex",
            flexDirection: "column", gap: "10px",
          },
        },
        react.createElement("div", { style: { fontSize: "13px", fontWeight: 600 } }, "Agent 节点默认值"),
        react.createElement(
          "div",
          { style: { fontSize: "12px", color: "var(--dsw-alias-text-secondary)", lineHeight: "18px" } },
          "节点没有单独配置渠道/模型/思考级别/超时时，按这里的默认值运行；模型层都没有时跟随 dsh 全局选择，超时 0 = 内置默认（节点 500s / 单次 300s）。",
        ),
        !llmConfig
          ? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-text-secondary)" } }, "正在读取渠道目录…")
          : !providers.length
            ? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-text-secondary)" } }, "还没有可用的模型渠道，请先在 dsh 设置里完成配置。")
            : [
                defaultsField("渠道", mkSelect(draft.provider, providerOptions, saving, function (v) {
                  patchDraft({ provider: v, model: "", reasoningEffort: "" });
                })),
                defaultsField("模型", mkSelect(draft.model, modelOptions, saving || !draft.provider, function (v) {
                  patchDraft({ model: v, reasoningEffort: "" });
                })),
                defaultsField("思考级别", mkSelect(
                  draft.reasoningEffort,
                  effortOptions,
                  saving || !draft.model || !efforts.length,
                  function (v) { patchDraft({ reasoningEffort: v }); },
                )),
                defaultsField("节点超时(秒)", mkTimeoutInput("nodeTimeoutSec", "默认 500")),
                defaultsField("单次超时(秒)", mkTimeoutInput("modelTimeoutSec", "默认 300")),
                // 通用提示词：跨节点行为约束，注入所有 agent 节点系统提示词的末尾。
                // 独立成块放在字段行之后（多行文本不适合 72px 标签行的紧凑布局）
                react.createElement(
                  "div",
                  { key: "systemPrompt", style: { display: "flex", flexDirection: "column", gap: "4px" } },
                  react.createElement(
                    "div",
                    { style: { fontSize: "13px", color: "var(--dsw-alias-text-secondary)" } },
                    "通用提示词",
                    react.createElement(
                      "span",
                      { style: { marginLeft: "6px", fontSize: "11px", opacity: 0.75 } },
                      "注入所有 agent 节点提示词末尾的行为约束；留空不注入",
                    ),
                  ),
                  react.createElement("textarea", {
                    value: draft.systemPrompt || "",
                    disabled: saving,
                    placeholder: "例：\n- 输出统一使用中文\n- 交付物直接给结论，不要寒暄\n- 物业术语遵循公司规范手册",
                    style: {
                      width: "100%", minHeight: "72px", padding: "6px 8px", borderRadius: "8px",
                      fontSize: "13px", lineHeight: "20px", resize: "vertical", boxSizing: "border-box",
                      fontFamily: "inherit",
                      border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))",
                      background: "var(--dsw-alias-bg-primary, transparent)",
                      color: "var(--dsw-alias-label-primary)",
                    },
                    onChange: function (ev) { patchDraft({ systemPrompt: ev.target.value }); },
                  }),
                ),
              ],
        react.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px", minHeight: "22px" } },
          providers.length
            ? react.createElement(
                "button",
                {
                  style: {
                    cursor: dirty && !saving ? "pointer" : "default",
                    borderRadius: "8px", padding: "5px 14px", fontSize: "13px",
                    border: "1px solid transparent",
                    background: "var(--dsw-alias-accent-bg, #4F46E5)", color: "#fff",
                    opacity: dirty && !saving ? 1 : 0.45,
                  },
                  disabled: !dirty || saving,
                  onClick: save,
                },
                saving ? "保存中…" : "保存",
              )
            : null,
          message
            ? react.createElement(
                "span",
                { style: { fontSize: "12px", color: message.kind === "ok" ? "rgba(52,211,153,1)" : "rgba(248,113,113,1)" } },
                (message.kind === "ok" ? "✓ " : "✗ ") + message.text,
              )
            : effectiveText
              ? react.createElement("span", { style: { fontSize: "12px", color: "var(--dsw-alias-text-secondary)" } }, effectiveText)
              : null,
        ),
      );
    }

    function WorkflowOneSection() {
      var a = s2(null), info = a[0], setInfo = a[1];
      var b = s2(null), check = b[0], setCheck = b[1];
      var c = s2(false), loading = c[0], setLoading = c[1];
      // null | {phase:'running'} | {phase:'done', log} | {phase:'failed', message}
      var d = s2(null), upgradeState = d[0], setUpgradeState = d[1];
      var e = s2(false), confirming = e[0], setConfirming = e[1];

      var load = react.useCallback(function () {
        setLoading(true);
        systemGet(SYSTEM_INFO_API)
          .then(function (d2) { if (d2 && d2.ok) setInfo(d2); })
          .catch(function () {})
          .finally(function () { setLoading(false); });
      }, []);
      react.useEffect(function () { load(); }, [load]);

      var doCheck = function () {
        setCheck({ pending: true });
        systemPost(SYSTEM_CHECK_API).then(setCheck).catch(function () {
          setCheck({ ok: false, error: "网络失败" });
        });
      };

      var doUpgrade = function () {
        if (!confirming) {
          setConfirming(true);
          // 6 秒不点确认自动回落，防手滑长亮
          setTimeout(function () { setConfirming(false); }, 6000);
          return;
        }
        setConfirming(false);
        setUpgradeState({ phase: "running" });
        systemPost(SYSTEM_UPGRADE_API, { confirm: true })
          .then(function (r) {
            if (r.ok) {
              var resultLog = r.log || [];
              var hasFailure = resultLog.some(function (line) { return /^\s*✗/.test(String(line)); });
              if (hasFailure) {
                setUpgradeState({ phase: "failed", message: resultLog.filter(function (line) { return /^\s*✗/.test(String(line)); }).join("；") || "升级失败" });
                return;
              }
              setUpgradeState({ phase: "done", log: resultLog });
              load();
              setCheck(null);
            } else {
              setUpgradeState({ phase: "failed", message: r.error || "升级失败" });
            }
          })
          .catch(function () {
            setUpgradeState({ phase: "failed", message: "连接不上本地服务，请确认 dsh 正在运行" });
          });
      };

      // ---- 用户视图状态机：普通用户只关心三件事：现在啥版本 / 有没有新的 / 怎么升 ----
      var currentV = (info && info.selfVersion) || null;
      var running = !!upgradeState && upgradeState.phase === "running";
      var pendingCheck = !!check && check.pending === true;
      var available = !!(check && check.ok && check.updateAvailable && check.latest);
      var upToDate = !!(check && check.ok && check.latest && !check.updateAvailable);
      var checkFailed = !!check && check.ok === false;

      var status = running
        ? { text: "正在升级…", bg: "rgba(56,189,248,.18)" }
        : available
          ? { text: "发现新版本 v" + check.latest, bg: "rgba(79,70,229,.22)" }
          : upToDate
            ? { text: "已是最新", bg: "rgba(52,211,153,.18)" }
            : pendingCheck
              ? { text: "检查中…", bg: "rgba(148,163,184,.2)" }
              : checkFailed
                ? { text: "暂时连不上更新服务", bg: "rgba(148,163,184,.2)" }
                : { text: "", bg: "transparent" };

      var btnBase = {
        cursor: "pointer", borderRadius: "8px", padding: "6px 14px", fontSize: "13px",
        border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))",
        background: "transparent", color: "var(--dsw-alias-label-primary)",
      };
      var primaryBtn = Object.assign({}, btnBase, {
        background: "var(--dsw-alias-accent-bg, #4F46E5)", color: "#fff",
        borderColor: "transparent",
      });
      var profiles = (info && info.profiles) || [];

      return react.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "14px", maxWidth: "560px" } },

        // —— Agent 节点默认值：渠道 / 模型 / 思考级别 ——
        react.createElement(AgentDefaultsCard),

        // —— 第一眼：当前版本大字 + 状态一句话 ——
        react.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px" } },
          react.createElement(
            "span",
            { style: { fontSize: "26px", fontWeight: 700, lineHeight: "32px" } },
            currentV ? "v" + currentV : "…",
          ),
          status.text
            ? react.createElement(
                "span",
                {
                  style: {
                    fontSize: "12px", padding: "3px 10px", borderRadius: "999px",
                    background: status.bg, color: "var(--dsw-alias-label-primary)",
                  },
                },
                status.text,
              )
            : null,
        ),
        react.createElement(
          "div",
          { style: { fontSize: "12px", color: "var(--dsw-alias-text-secondary)" } },
          running
            ? "正在自动完成升级，窗口可以离开，回来再看结果就行。"
            : available
              ? "点下面的按钮即可升级，剩余的事全自动。"
              : currentV
                ? upToDate
                  ? "有新版本发布时会在这里提示，不用常来点。"
                  : "看看有没有新版本？点一下就知道。"
                : "",
        ),

        // —— 唯一的主按钮 ——
        react.createElement(
          "div",
          { style: { display: "flex", gap: "8px" } },
          running
            ? react.createElement("button", { style: btnBase, disabled: true }, "升级中…")
            : available
              ? react.createElement(
                  "button",
                  { style: primaryBtn, onClick: doUpgrade },
                  confirming ? "再点一次确认开始升级" : "一键升级",
                )
              : react.createElement(
                  "button",
                  { style: btnBase, onClick: doCheck, disabled: pendingCheck },
                  pendingCheck ? "检查中…" : "检查更新",
                ),
        ),

        // —— 结果横幅 ——
        !!upgradeState && upgradeState.phase === "done"
          ? react.createElement(
              "div",
              {
                style: {
                  padding: "10px 12px", borderRadius: "10px", fontSize: "13px", lineHeight: "20px",
                  background: "rgba(52,211,153,.14)",
                  border: "1px solid rgba(52,211,153,.35)",
                },
              },
              "✓ 升级完成！请彻底退出并重新启动 dsh（HMR 会缓存旧模块），新版即刻生效。",
              (upgradeState.log || []).length
                ? react.createElement(
                    "details",
                    { style: { marginTop: "6px" } },
                    react.createElement(
                      "summary",
                      { style: { cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-text-secondary)" } },
                      "查看升级过程",
                    ),
                    react.createElement(
                      "pre",
                      {
                        style: {
                          margin: "6px 0 0", padding: "8px 10px", borderRadius: "8px", fontSize: "12px",
                          lineHeight: "18px", maxHeight: "200px", overflow: "auto",
                          background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))",
                          whiteSpace: "pre-wrap",
                        },
                      },
                      upgradeState.log.join("\n"),
                    ),
                  )
                : null,
            )
          : null,
        !!upgradeState && upgradeState.phase === "failed"
          ? react.createElement(
              "div",
              {
                style: {
                  padding: "10px 12px", borderRadius: "10px", fontSize: "13px",
                  background: "rgba(248,113,113,.12)",
                  border: "1px solid rgba(248,113,113,.35)",
                },
              },
              "✗ 升级没成功：" + upgradeState.message + "。可以再试一次；反复失败请把这段话截图给管理员。",
            )
          : null,

        // —— 没装的情况（正常用户极少看到）——
        !profiles.length
          ? react.createElement(
              "div",
              { style: { fontSize: "13px", color: "var(--dsw-alias-text-secondary)" } },
              loading ? "正在读取安装信息…" : "本机没有发现已安装的 Workflow One。",
            )
          : null,

        // —— 技术细节折叠区（给排障的人看，普通用户不用展开）——
        profiles.length
          ? react.createElement(
              "details",
              null,
              react.createElement(
                "summary",
                { style: { cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-text-secondary)" } },
                "安装详情（有多个 profile 或排查问题时才需要看）",
              ),
              react.createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" } },
                profiles.map(ProfileBlock),
                react.createElement(
                  "div",
                  { style: { fontSize: "12px", color: "var(--dsw-alias-text-secondary)" } },
                  "「离线包」标记表示该目录来自 release 解包且没有 git 元数据，一键升级对它只给覆盖指引；npm 与源码来源可全自动。",
                ),
              ),
            )
          : null,

        // —— 数据安全脚注（普通用户最关心的安心话）——
        react.createElement(
          "div",
          {
            style: {
              fontSize: "12px", color: "var(--dsw-alias-text-secondary)",
              borderTop: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.2))",
              paddingTop: "8px",
            },
          },
          "你的工作流、运行记录、定时任务和飞书登录都不会被升级改动，无需备份迁移。偏好转命令行的话：npm 安装的用户重跑一次 npx dsh-harness-one 效果等同。",
        ),
      );
    }

    // ---- 设置导航图标注入 ----
    // 官方 ui-settings-general 的 navIcon 是编译期写死的 id→图标映射，第三方 section
    // 统一回退齿轮且无扩展口（SlotMap 只有 id/order/label）。这里用最小 DOM 补丁：
    // 监听文档变化，定位文本精确等于本插件 section 名的导航按钮，前置一枚与官方
    // *_Outline16 同规格（16px / 描边 currentColor）的自绘 SVG。找不到目标行静默不动。
    var NAV_ICON_MARK = "data-ccpg-nav-icon";
    function startSettingsNavIcon(labelText, svgMarkup) {
      // 非 DOM 宿主（单测加载 bundle）直接跳过
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
      // 官方行内的回退齿轮不删除（React 自己的节点）——纯 CSS 隐藏，避免 reconcile 冲突
      if (!document.getElementById("ccpg-nav-icon-style")) {
        var styleEl = document.createElement("style");
        styleEl.id = "ccpg-nav-icon-style";
        styleEl.textContent =
          'button[' + NAV_ICON_MARK + '="seen"] > svg:first-of-type { display:none !important; }';
        document.head.appendChild(styleEl);
      }
      var scheduled = false;
      var scan = function () {
        scheduled = false;
        if (!document.body) return;
        var buttons = document.getElementsByTagName("button");
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          if (btn.getAttribute(NAV_ICON_MARK)) continue;
          if ((btn.textContent || "").trim() !== labelText) continue;
          btn.setAttribute(NAV_ICON_MARK, "seen");
          if (btn.querySelector("[" + NAV_ICON_MARK + "='icon']")) continue;
          var holder = document.createElement("span");
          holder.setAttribute(NAV_ICON_MARK, "icon");
          holder.style.cssText = "flex:none;display:inline-flex;width:16px;height:16px;";
          holder.innerHTML = svgMarkup;
          btn.insertBefore(holder, btn.firstChild);
        }
      };
      var schedule = function () {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(scan);
      };
      if (document.body) schedule();
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    }

    // ---- /workflow-one 触发源（#63）----
    // 官方聊天输入 `/workflow-one` 弹出实时工作流库，Pick 后草稿认领为
    // `/workflow-one <id>`，Enter 提交执行。动作二段式在候选 description 里引导：
    // 直接 Enter=打开（绑定画布时）或运行；追加 ` run`=强制运行、` open`=强制打开。
    // 契约面（@deepseek-ai/dsh-client-ui-input-trigger，仅类型概念、零值导入）：
    // 候选 = { name, description, icon, section, value }；onPick 返回
    // { claim:{ token, hint, submit(args, actx, images) } }，success/error outcome
    // 由官方 input 机结算（成功清草稿、错误保留 + notice）。
    // 自包含：只 fetch 本插件自有路由，类型契约不产生运行时依赖；老运行时无
    // inputTriggers 服务时软跳过，不影响其余功能。
    var WF_TRIGGER_NAME = "workflow-one";
    var wfLexiconListeners = new Set();
    var wfLexiconNames = null; // 热快照：null=未 warm；数组=当前工作流名集

    function wfScopedApi(path, sessionId) {
      var url = "/wf1/api" + path;
      if (sessionId) url += (url.indexOf("?") >= 0 ? "&" : "?") + "sessionId=" + encodeURIComponent(sessionId);
      return url;
    }

    function wfTriggerAction(sessionId, workflowId, action) {
      return fetch(wfScopedApi("/trigger", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: workflowId, action: action }),
      })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            return { ok: r.ok && data.ok !== false, data: data };
          });
        })
        .catch(function () { return { ok: false, data: {} }; });
    }

    function wfTriggerOutcomeText(result, action) {
      if (result.ok) {
        var done = result.data.action || action; // auto 回退后以服务端实际动作为准
        return done === "open"
          ? "画布已打开：" + (result.data.name || result.data.workflowId || "")
          : "已发起运行：" + (result.data.name || result.data.runId || "");
      }
      return result.data.error || (action === "open" ? "打开失败" : "运行发起失败");
    }

    function registerWorkflowTriggerSource(ctx) {
      var inputTriggers = ctx.get("inputTriggers");
      if (!inputTriggers || !inputTriggers.registerSource) return;

      var fetchWorkflows = function (sessionId) {
        return fetch(wfScopedApi("/workflows", sessionId))
          .then(function (r) { return r.ok ? r.json() : { workflows: [] }; })
          .then(function (data) { return data.workflows || []; })
          .catch(function () { return []; });
      };

      var source = {
        trigger: "/",
        name: WF_TRIGGER_NAME,
        order: 3, // skill=2 之后，避免挤占官方目录首位
        warm: function (session) {
          fetchWorkflows(session.sessionId).then(function (workflows) {
            wfLexiconNames = workflows.map(function (wf) { return wf.name; });
            wfLexiconListeners.forEach(function (listener) {
              try { listener(); } catch (e) { /* 单个监听器失败不影响其他 */ }
            });
          });
        },
        lexicon: function () {
          return wfLexiconNames;
        },
        subscribeLexicon: function (_session, listener) {
          wfLexiconListeners.add(listener);
          return function () { wfLexiconListeners.delete(listener); };
        },
        candidates: function (session, req) {
          return fetchWorkflows(session.sessionId).then(function (workflows) {
            if (req.signal && req.signal.aborted) return [];
            var query = (req.query || "").toLowerCase();
            // 选源阶段：query 仍是源名前缀时把工作流全部列出（live picker），
            // 越过源名后按余下文本过滤；带 run/open 前缀时定动作、余下按名过滤。
            var selectingSource = WF_TRIGGER_NAME.indexOf(query) === 0;
            var tail = "";
            if (!selectingSource) {
              tail = query.indexOf(WF_TRIGGER_NAME + " ") === 0
                ? query.slice(WF_TRIGGER_NAME.length + 1).trim()
                : query.trim();
            }
            var forced = tail === "run" || tail === "open" ? tail : null;
            if (tail === "run " || tail === "open ") forced = null;
            var nameQuery = tail;
            if (forced) nameQuery = "";
            else if (nameQuery.indexOf("run ") === 0) nameQuery = nameQuery.slice(4).trim();
            else if (nameQuery.indexOf("open ") === 0) nameQuery = nameQuery.slice(5).trim();
            return workflows
              .filter(function (wf) {
                return selectingSource || !nameQuery || wf.name.toLowerCase().indexOf(nameQuery) >= 0;
              })
              .map(function (wf) {
                return {
                  name: wf.name,
                  description: forced === "run"
                    ? "运行该工作流（Workflow One）"
                    : forced === "open"
                      ? "在绑定画布打开（Workflow One）"
                      : "Enter 打开/运行 · 追加 run 或 open 定动作（Workflow One）",
                  icon: "⇥",
                  section: "Workflow One",
                  value: wf.id,
                };
              });
          });
        },
        onPick: function (pick) {
          // 二段式：Pick 工作流 → 草稿认领 '/workflow-one '，Enter 提交执行。
          // 优先 pick 的 candidate.value（工作流 id）；用户越过 token 另输入时以 args 覆盖。
          var workflowId = pick.candidate && pick.candidate.value;
          var claim = {
            token: "/" + WF_TRIGGER_NAME + " ",
            hint: "Enter 执行 · 追加 run/open 定动作",
            submit: function (args) {
              var sessionId = (pick.session && pick.session.sessionId) || currentDshSessionId(null);
              var text = String(args || "").trim();
              var id = workflowId && !text ? workflowId : text;
              var action = "auto";
              var m = /^(run|open)\s+/.exec(text);
              if (m) {
                action = m[1];
                id = text.slice(m[0].length).trim() || workflowId;
              } else if (text === "run" || text === "open") {
                action = text;
                id = workflowId;
              }
              if (!id) {
                return Promise.resolve({ kind: "error", text: "缺少工作流 id 或名称" });
              }
              var exec = action === "auto"
                ? wfTriggerAction(sessionId, id, "run").then(function (runResult) {
                    if (runResult.ok) return runResult;
                    if (runResult.data.code !== "canvas-not-bound") return runResult;
                    return wfTriggerAction(sessionId, id, "open");
                  })
                : wfTriggerAction(sessionId, id, action);
              return exec.then(function (result) {
                return { kind: result.ok ? "success" : "error", text: wfTriggerOutcomeText(result, action) };
              });
            },
          };
          return { claim: claim };
        },
      };

      ctx.effect(function () {
        return inputTriggers.registerSource(source);
      }, "canvasui: /workflow-one trigger source");
    }

    // 「Workflow One」导航图标：三节点流水线（与侧栏「工作流」tab 图标同族）
    var WF_NAV_ICON_SVG =
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="3.25" cy="4" r="1.35"/><circle cx="12.75" cy="3.25" r="1.35"/><circle cx="12.75" cy="12.75" r="1.35"/>' +
      '<path d="M4.6 4h2.15A2.25 2.25 0 0 1 9 6.25v4.25A2.25 2.25 0 0 0 11.25 12.75h.15M9 7V5.5a2.25 2.25 0 0 1 2.25-2.25h.15"/>' +
      "</svg>";

    function apply(ctx) {
      ensureStyle();

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "workflow-one",
            order: 30,
            label: function () {
              return "Workflow One";
            },
          },
          WorkflowOneSection,
        );
      });
      startSettingsNavIcon("Workflow One", WF_NAV_ICON_SVG);

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

      // ---- /workflow-one 第一方触发源（#63）----
      // inputTriggers 服务不存在（老运行时/关闭）时静默跳过，不影响其余功能。
      try {
        registerWorkflowTriggerSource(ctx);
      } catch (e) {
        /* 老运行时无 inputTriggers：跳过触发源 */
      }

      // 消息流工具卡：按工具名接管官方 UI 的 tool.call.toolview keyed slot
      //（官方 ask_user_question / cordis_run 同款机制）。未注册的 canvas_* 工具
      // 走官方 GenericToolCard 文本行，行为不变。
      var toolviews = [
        ["canvas_graph_patch", GraphPatchCard],
        ["canvas_run_workflow", WorkflowRunCard],
        ["canvas_run_status", WorkflowRunCard],
      ];
      toolviews.forEach(function (pair) {
        ctx.slots.inject("tool.call.toolview", function () {
          return ctx.slots.register(
            { name: "tool.call.toolview", key: pair[0] },
            pair[1],
          );
        });
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
    exports.inject = ["slots", "inputTriggers"];
    exports.__test = {
      currentDshSessionId: currentDshSessionId,
      openWorkflowSidebar: openWorkflowSidebar,
      removeLegacyChatTabs: removeLegacyChatTabs,
      setBetterSidebarService: setBetterSidebarService,
      sidebarAllTabs: sidebarAllTabs,
      subscribeSidebarService: subscribeSidebarService,
      currentHostTheme: currentHostTheme,
      startThemeBridge: startThemeBridge,
      toolText: toolText,
      runIdFromText: runIdFromText,
      runIdFromArgs: runIdFromArgs,
      runDotState: runDotState,
      mergeRunEvent: mergeRunEvent,
      shouldFollowRun: shouldFollowRun,
      runCardProgress: runCardProgress,
      flowPreviewModel: flowPreviewModel,
      graphThumbnail: graphThumbnail,
      WorkflowRunCard: WorkflowRunCard,
      GraphPatchCard: GraphPatchCard,
      modelOptionsFor: modelOptionsFor,
      effortOptionsFor: effortOptionsFor,
      providerNameOf: providerNameOf,
    };

    return exports;
  },
});
