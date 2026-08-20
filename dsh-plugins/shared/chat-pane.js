// ccpg 共享：dsh 会话只读聊天记录面板（插件 client bundle 源片段，非插件包）。
//
// 用途：在任何 dsh 官方 Web UI 插件里显示某 session 的实时聊天流（用户消息 /
// AI 回复 / 工具调用行）。数据源是 dsh 内建 session.history RPC，轮询 2s、吸底跟随。
//
// 为什么是"源码片段"而不是共享插件：dsh 浏览器端 module-loader 的同步 require 只认
// 平台种子（react 等）、shell 自有模块、已注册工厂——跨插件值导入是构建纯度门禁止项
// （"forbidden cross-plugin value import"），且懒注册导致加载顺序不可依赖。因此各插件
// bundle 必须自包含：本文件经 build-canvasui.sh 的 @include 标记在构建期内联进
// 消费者的 client.js 工厂（工厂内语句块，非独立 bundle），见 dsh-plugins/shared/。
//
// 消费方式（消费者 client 源里，路径相对消费者 src/client.js）：
//   // @include ../../shared/chat-pane.js
//   ...
//   var ChatPane = createChatPane(react, { title: "对话记录", hint: "..." });
// opts：title/hint/emptyText、pollMs（默认 2000）、maxMessages（默认 60）、
//       cssPrefix（默认 ccpg-chat，样式 id ccpg-chat-style）、
//       formatTool(name, args)（工具行摘要，默认通用 JSON 截断）。

function ccpgChatPaneEnsureStyle(cssPrefix) {
	var styleId = cssPrefix + "-style";
	if (document.getElementById(styleId)) return;
	var el = document.createElement("style");
	el.id = styleId;
	el.textContent = [
		"." + cssPrefix + "-head{flex:none;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));display:flex;align-items:center;gap:8px;}",
		"." + cssPrefix + "-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;}",
		"." + cssPrefix + "-list{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;}",
		"." + cssPrefix + "-msg{max-width:100%;padding:8px 10px;border-radius:10px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;}",
		"." + cssPrefix + "-msg-user{align-self:flex-end;background:var(--dsw-alias-state-business-primary,#8B5CF6);color:#fff;border-bottom-right-radius:4px;}",
		"." + cssPrefix + "-msg-ai{align-self:flex-start;background:var(--dsw-alias-bg-raised,#26221D);color:var(--dsw-alias-label-primary,#e8e4dc);border-bottom-left-radius:4px;}",
		"." + cssPrefix + "-msg-tool{align-self:flex-start;background:transparent;border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14));color:var(--dsw-alias-label-tertiary,#8b8578);font-size:12px;font-family:ui-monospace,monospace;padding:5px 9px;}",
		"." + cssPrefix + "-msg-tool b{color:var(--dsw-alias-state-business-primary,#8B5CF6);font-weight:600;}",
		"." + cssPrefix + "-hint{flex:none;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8578);text-align:center;}",
	].join("\n");
	document.head.appendChild(el);
}

// dsh 通用 RPC 信封：POST /api/<method>，body {type:'client-request', rpcId, method, payload}
function ccpgChatPaneApiCall(method, payload) {
	ccpgChatPaneApiCall.seq = (ccpgChatPaneApiCall.seq || 0) + 1;
	return fetch("/api/" + method, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "client-request", rpcId: "ccpgc" + ccpgChatPaneApiCall.seq, method: method, payload: payload }),
	}).then(function (r) { return r.json(); }).then(function (d) {
		var res = d && d.result;
		if (res && res.ok) return res.value;
		throw new Error((res && res.error && res.error.message) || method + " failed");
	});
}

function ccpgChatTextOf(content) {
	return (content || []).filter(function (b) { return b && b.type === "text"; })
		.map(function (b) { return b.text; }).join("");
}

// session.history → 渲染项数组（用户消息/AI 回复/工具调用，倒序翻页拼回正序）。
// formatTool(name, parsedArgs) 由消费者注入（如画布插件摘要 canvas_graph_patch），
// 返回字符串；抛错/返回空时回退 JSON 截断。
function ccpgChatHistoryToItems(value, formatTool) {
	var items = [];
	var events = (value && value.events) || [];
	for (var i = 0; i < events.length; i += 1) {
		var ev = events[i] && events[i].event ? events[i].event : events[i];
		if (!ev) continue;
		var data = ev.data || {};
		if (ev.type === "user/message") {
			// user 事件文本在 data.content（assistant 事件在 data.message.content）。
			// 只显真实用户输入：source.kind==='user'；系统注入（plugin/skill-catalog 快照）跳过。
			var uc = data.message && data.message.content ? data.message.content : data.content;
			var ut = ccpgChatTextOf(uc);
			var srcKind = (data.source && data.source.kind) || "";
			if (ut && (srcKind === "user" || data.role === "user" && srcKind === "")) {
				if (!(items[items.length - 1] && items[items.length - 1].kind === "user" && items[items.length - 1].text === ut)) {
					items.push({ kind: "user", text: ut });
				}
			}
		} else if (ev.type === "assistant/message") {
			var at = ccpgChatTextOf(data.message && data.message.content);
			if (at) items.push({ kind: "ai", text: at });
		} else if (ev.type === "tool/call") {
			var name = data.name || "tool";
			var argStr = "";
			try {
				var a = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
				if (formatTool) {
					try { argStr = formatTool(name, a) || ""; } catch (e) { argStr = ""; }
				}
				if (!argStr) argStr = JSON.stringify(a || {}).slice(0, 60);
			} catch (e) { argStr = String(data.arguments || "").slice(0, 60); }
			items.push({ kind: "tool", name: name, text: argStr });
		}
	}
	return items;
}

// 工厂：注入 react（工厂 require 到的种子）与 opts，返回 <ChatPane sessionId/> 组件。
function createChatPane(react, opts) {
	var o = opts || {};
	var cssPrefix = o.cssPrefix || "ccpg-chat";
	var pollMs = o.pollMs || 2000;
	var maxMessages = o.maxMessages || 60;
	var title = o.title != null ? o.title : "对话记录";
	var hint = o.hint != null ? o.hint : "";
	var emptyText = o.emptyText != null ? o.emptyText : "暂无消息";
	var formatTool = o.formatTool || null;
	var apiCall = o.apiCall || ccpgChatPaneApiCall;
	var historyToItems = o.historyToItems || ccpgChatHistoryToItems;
	var styleEnsured = false;

	return function ChatPane(props) {
		var sessionId = props.sessionId;
		var listRef = react.useRef(null);
		var stickRef = react.useRef(true);
		var [items, setItems] = react.useState([]);
		var [err, setErr] = react.useState(null);

		if (!styleEnsured) { ccpgChatPaneEnsureStyle(cssPrefix); styleEnsured = true; }

		react.useEffect(function () {
			if (!sessionId) return;
			var stop = false;
			var tick = function () {
				if (stop) return;
				apiCall("session.history", { sessionId: sessionId, maxMessages: maxMessages }).then(function (v) {
					if (stop) return;
					setItems(historyToItems(v, formatTool));
					setErr(null);
				}).catch(function (e) {
					if (!stop) setErr(String(e.message || e));
				}).finally(function () {
					if (!stop) setTimeout(tick, pollMs);
				});
			};
			tick();
			return function () { stop = true; };
		}, [sessionId]);

		// 吸底：用户没上滚就跟随最新
		react.useEffect(function () {
			var el = listRef.current;
			if (el && stickRef.current) el.scrollTop = el.scrollHeight;
		}, [items]);

		var onScroll = function () {
			var el = listRef.current;
			if (!el) return;
			stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		};

		return react.createElement("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
			react.createElement("div", { className: cssPrefix + "-head" },
				react.createElement("span", { className: cssPrefix + "-title" }, title),
				err ? react.createElement("span", { style: { fontSize: 11, color: "#ef4444" } }, "同步失败") : null,
			),
			react.createElement("div", { className: cssPrefix + "-list", ref: listRef, onScroll: onScroll },
				items.length === 0 ? react.createElement("div", { style: { color: "#8b8578", fontSize: 12, textAlign: "center", marginTop: 20 } }, emptyText) : null,
				items.map(function (it, idx) {
					if (it.kind === "tool") {
						return react.createElement("div", { className: cssPrefix + "-msg " + cssPrefix + "-msg-tool", key: idx },
							"⚙ ", react.createElement("b", null, it.name), " ", it.text);
					}
					return react.createElement("div", {
						className: cssPrefix + "-msg " + (it.kind === "user" ? cssPrefix + "-msg-user" : cssPrefix + "-msg-ai"),
						key: idx,
					}, it.text);
				}),
			),
			hint ? react.createElement("div", { className: cssPrefix + "-hint" }, hint) : null,
		);
	};
}
