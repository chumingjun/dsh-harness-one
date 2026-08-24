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
      running: "运行中", success: "成功", error: "失败",
      canceled: "已取消", skipped: "已跳过", waiting: "等待审批",
    };
    function runDotState(run, fallback) {
      var s = run ? run.status : fallback;
      if (s === "success") return "success";
      if (s === "error" || s === "canceled") return "error";
      if (s === "waiting") return "waiting";
      if (s === "running" || !run) return "running";
      return "pending";
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

    // 语义化流程摘要：真实主路径 + 全图序号，比缩小整张画布更适合消息卡片。
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
        var status = states[item.id] && states[item.id].status;
        var color = colorOf(status);
        var maxLabel = BOX_W >= 90 ? 7 : BOX_W >= 70 ? 4 : 3;
        var label = item.label.length > maxLabel ? item.label.slice(0, maxLabel) + "…" : item.label;
        elements.push(react.createElement("rect", {
          key: "box-" + item.id, x: x, y: y, width: BOX_W, height: BOX_H, rx: 6,
          fill: "var(--dsw-alias-bg-base)", stroke: color, "stroke-width": status ? 1.6 : 1,
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
            return item ? item.number + " " + item.label : "省略 " + (model.pathLength - 4) + " 步";
          }).join("，"),
        },
        elements,
      );
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
    // runId 从工具结果解析；运行中 2s 轮询 runs/detail，终态即停（历史卡片是当时快照）。
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
      var sessionId = currentDshSessionId(null);
      var [run, setRun] = react.useState(null);
      var [missing, setMissing] = react.useState(false);

      react.useEffect(function () {
        if (!runId) return undefined;
        var stopped = false;
        var terminal = false;
        var fetchRun = function () {
          if (stopped || terminal) return;
          var url = "/wf1/api/runs/detail?id=" + encodeURIComponent(runId);
          if (sessionId) url += "&sessionId=" + encodeURIComponent(sessionId);
          fetch(url)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
              if (stopped || !d) { if (!d) setMissing(true); return; }
              setMissing(false);
              setRun(d);
              if (d.status && d.status !== "running") terminal = true;
            })
            .catch(function () { /* 单次失败继续轮询 */ });
        };
        fetchRun();
        var timer = window.setInterval(fetchRun, 2000);
        return function () { stopped = true; window.clearInterval(timer); };
      }, [runId, sessionId]);

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
          meta: "运行 " + runId.slice(0, 8) + "… 记录不在当前工作区",
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
          meta: "运行 " + runId.slice(0, 8) + "…",
          thumbnail: null,
        });
      }

      var dot = runDotState(run);
      var nodeTotal = 0, nodeDone = 0, currentLabel = "", errText = "";
      if (run && run.nodeStates) {
        var labels = {};
        (run.graph && run.graph.nodes ? run.graph.nodes : []).forEach(function (n) {
          labels[n.id] = (n.data && n.data.label) || n.id;
        });
        Object.keys(run.nodeStates).forEach(function (id) {
          var st = run.nodeStates[id].status;
          nodeTotal += 1;
          if (["success", "error", "canceled", "skipped"].indexOf(st) >= 0) nodeDone += 1;
          if (st === "running") currentLabel = labels[id] || id;
          if (!errText && (run.nodeStates[id].error || run.nodeStates[id].toleratedError)) {
            errText = String(run.nodeStates[id].error || run.nodeStates[id].toleratedError);
          }
        });
      }
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
    exports.inject = ["slots"];
    exports.__test = {
      currentDshSessionId: currentDshSessionId,
      openWorkflowSidebar: openWorkflowSidebar,
      removeLegacyChatTabs: removeLegacyChatTabs,
      setBetterSidebarService: setBetterSidebarService,
      sidebarAllTabs: sidebarAllTabs,
      subscribeSidebarService: subscribeSidebarService,
      toolText: toolText,
      runIdFromText: runIdFromText,
      runIdFromArgs: runIdFromArgs,
      runDotState: runDotState,
      flowPreviewModel: flowPreviewModel,
      graphThumbnail: graphThumbnail,
      WorkflowRunCard: WorkflowRunCard,
      GraphPatchCard: GraphPatchCard,
    };

    return exports;
  },
});
