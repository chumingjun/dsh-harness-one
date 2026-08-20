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
// props：sessionId 必填；paused=true 时挂起轮询（宿主容器不可见时省流量，
//       恢复可见立即补拉一次再回到节拍）。
// 消息渲染：user/AI 消息按迷你 Markdown 渲染（ccpgMdBlocks，纯 createElement
//       无 HTML 注入）：标题/粗斜体/行内码/围栏代码块/引用/列表/表格/链接/分隔线；
//       工具行保持等宽纯文本。

// ---- 极简 Markdown 行内解析：`code`、**bold**、*italic*、[text](url) ----
function ccpgMdInline(react, text, keyp) {
	var out = [];
	var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
	var last = 0, m, i = 0;
	while ((m = re.exec(text))) {
		if (m.index > last) out.push(text.slice(last, m.index));
		var tok = m[0];
		if (tok.charAt(0) === "`") {
			out.push(react.createElement("code", { key: keyp + "c" + (i++) }, tok.slice(1, -1)));
		} else if (tok.slice(0, 2) === "**") {
			out.push(react.createElement("strong", { key: keyp + "b" + (i++) }, tok.slice(2, -2)));
		} else if (tok.charAt(0) === "*") {
			out.push(react.createElement("em", { key: keyp + "i" + (i++) }, tok.slice(1, -1)));
		} else {
			var lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
			out.push(react.createElement("a", { key: keyp + "a" + (i++), href: lm[2], target: "_blank", rel: "noopener noreferrer" }, lm[1]));
		}
		last = m.index + tok.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

// ---- Markdown 块级解析 → React 元素数组（段落内换行靠容器 pre-wrap 呈现）----
function ccpgMdBlocks(react, text) {
	var lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
	var blocks = [];
	var para = [];
	var k = 0;
	function flush() {
		if (!para.length) return;
		blocks.push(react.createElement.apply(react, ["p", { key: "p" + k++ }].concat(ccpgMdInline(react, para.join("\n"), "p" + k + "_"))));
		para = [];
	}
	var i = 0;
	while (i < lines.length) {
		var line = lines[i];
		if (/^\s*```/.test(line)) {
			flush();
			var buf = [];
			i++;
			while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
			i++;
			blocks.push(react.createElement("pre", { key: "pre" + k++ },
				react.createElement("code", null, buf.join("\n"))));
			continue;
		}
		var h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) {
			flush();
			blocks.push(react.createElement.apply(react, ["h" + h[1].length, { key: "h" + k++ }].concat(ccpgMdInline(react, h[2], "h" + k + "_"))));
			i++;
			continue;
		}
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); blocks.push(react.createElement("hr", { key: "hr" + k++ })); i++; continue; }
		if (/^\s*>/.test(line)) {
			flush();
			var q = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
			blocks.push(react.createElement.apply(react, ["blockquote", { key: "q" + k++ }].concat(ccpgMdInline(react, q.join("\n"), "q" + k + "_"))));
			continue;
		}
		if (/^\s*[-*+]\s+/.test(line)) {
			flush();
			var ui = [];
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ui.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
			blocks.push(react.createElement("ul", { key: "ul" + k++ }, ui.map(function (t, ix) {
				return react.createElement.apply(react, ["li", { key: "li" + ix }].concat(ccpgMdInline(react, t, "li" + ix + "_")));
			})));
			continue;
		}
		if (/^\s*\d+[.)]\s+/.test(line)) {
			flush();
			var oi = [];
			while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { oi.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
			blocks.push(react.createElement("ol", { key: "ol" + k++ }, oi.map(function (t, ix) {
				return react.createElement("li", { key: "li" + ix }, ccpgMdInline(react, t, "oi" + ix + "_"));
			})));
			continue;
		}
		if (/^\s*\|/.test(line) && i + 1 < lines.length
			&& /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
			flush();
			var head = line;
			i += 2;
			var rows = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
			var cells = function (r) {
				return r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) { return c.trim(); });
			};
			var tableEl = react.createElement("table", { key: "tb" + k++ },
				react.createElement("thead", null, react.createElement.apply(react, ["tr", null].concat(cells(head).map(function (c, ix) {
					return react.createElement.apply(react, ["th", { key: ix }].concat(ccpgMdInline(react, c, "th" + ix + "_")));
				})))),
				react.createElement.apply(react, ["tbody", null].concat(rows.map(function (r, ri) {
					return react.createElement.apply(react, ["tr", { key: ri }].concat(cells(r).map(function (c, ix) {
						return react.createElement.apply(react, ["td", { key: ix }].concat(ccpgMdInline(react, c, "td" + ri + "_" + ix + "_")));
					})));
				}))));
			blocks.push(tableEl);
			continue;
		}
		if (line.trim() === "") { flush(); i++; continue; }
		para.push(line);
		i++;
	}
	flush();
	return blocks;
}

function ccpgChatPaneEnsureStyle(cssPrefix) {
	var styleId = cssPrefix + "-style";
	if (document.getElementById(styleId)) return;
	var el = document.createElement("style");
	el.id = styleId;
	el.textContent = [
		"." + cssPrefix + "-head{flex:none;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));display:flex;align-items:center;gap:8px;}",
		"." + cssPrefix + "-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;}",
		"." + cssPrefix + "-list{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;}",
		"." + cssPrefix + "-msg{max-width:100%;padding:8px 10px;border-radius:10px;font-size:13px;line-height:1.55;word-break:break-word;}",
		"." + cssPrefix + "-msg-user{align-self:flex-end;background:var(--dsw-alias-state-business-primary,#8B5CF6);color:#fff;border-bottom-right-radius:4px;}",
		"." + cssPrefix + "-msg-ai{align-self:flex-start;background:var(--dsw-alias-bg-raised,#26221D);color:var(--dsw-alias-label-primary,#e8e4dc);border-bottom-left-radius:4px;}",
		"." + cssPrefix + "-msg-tool{align-self:flex-start;background:transparent;border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14));color:var(--dsw-alias-label-tertiary,#8b8578);font-size:12px;font-family:ui-monospace,monospace;padding:5px 9px;}",
		"." + cssPrefix + "-msg-tool b{color:var(--dsw-alias-state-business-primary,#8B5CF6);font-weight:600;}",
		"." + cssPrefix + "-hint{flex:none;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8578);text-align:center;}",
		// Markdown 消息体：块间距收敛、标题缩小、表格可横向滚动不撑破气泡
		"." + cssPrefix + "-md p{margin:0 0 6px;white-space:pre-wrap;}",
		"." + cssPrefix + "-md p:last-child{margin-bottom:0;}",
		"." + cssPrefix + "-md h1,." + cssPrefix + "-md h2,." + cssPrefix + "-md h3,." + cssPrefix + "-md h4,." + cssPrefix + "-md h5,." + cssPrefix + "-md h6{margin:8px 0 4px;font-size:14px;line-height:1.4;}",
		"." + cssPrefix + "-md h1{font-size:15px;}",
		"." + cssPrefix + "-md ul,." + cssPrefix + "-md ol{margin:2px 0 6px;padding-left:18px;}",
		"." + cssPrefix + "-md li{margin:2px 0;white-space:pre-wrap;}",
		"." + cssPrefix + "-md blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));opacity:.9;white-space:pre-wrap;}",
		"." + cssPrefix + "-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px;}",
		"." + cssPrefix + "-md pre{margin:4px 0;padding:8px 10px;background:rgba(0,0,0,.22);border-radius:8px;overflow-x:auto;white-space:pre;}",
		"." + cssPrefix + "-md pre code{background:none;padding:0;font-size:12px;line-height:1.5;}",
		"." + cssPrefix + "-md table{border-collapse:collapse;margin:6px 0;font-size:12px;display:block;max-width:100%;overflow-x:auto;}",
		"." + cssPrefix + "-md th,." + cssPrefix + "-md td{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));padding:4px 8px;text-align:left;vertical-align:top;}",
		"." + cssPrefix + "-md th{background:rgba(127,127,127,.12);font-weight:600;}",
		"." + cssPrefix + "-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));margin:8px 0;}",
		"." + cssPrefix + "-md a{color:inherit;text-decoration:underline;text-underline-offset:2px;}",
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
		var paused = props.paused === true;
		var markdown = props.markdown !== false; // 默认开；user 消息也常含 markdown
		var listRef = react.useRef(null);
		var stickRef = react.useRef(true);
		var [items, setItems] = react.useState([]);
		var [err, setErr] = react.useState(null);
		var pausedRef = react.useRef(paused);
		pausedRef.current = paused;

		if (!styleEnsured) { ccpgChatPaneEnsureStyle(cssPrefix); styleEnsured = true; }

		react.useEffect(function () {
			if (!sessionId) return;
			var stop = false;
			var timer = null;
			var tick = function () {
				if (stop) return;
				// paused 时不再发请求也不排下一轮；恢复后先立即补一拍再回节拍
				if (pausedRef.current) { timer = setTimeout(tick, pollMs); return; }
				apiCall("session.history", { sessionId: sessionId, maxMessages: maxMessages }).then(function (v) {
					if (stop) return;
					setItems(historyToItems(v, formatTool));
					setErr(null);
				}).catch(function (e) {
					if (!stop) setErr(String(e.message || e));
				}).finally(function () {
					if (!stop) { timer && clearTimeout(timer); timer = setTimeout(tick, pollMs); }
				});
			};
			tick();
			return function () { stop = true; if (timer) clearTimeout(timer); };
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
					var isUser = it.kind === "user";
					var body = markdown ? ccpgMdBlocks(react, it.text) : it.text;
					return react.createElement("div", {
						className: cssPrefix + "-msg " + (isUser ? cssPrefix + "-msg-user" : cssPrefix + "-msg-ai")
							+ (markdown ? " " + cssPrefix + "-md" : ""),
						key: idx,
					}, body);
				}),
			),
			hint ? react.createElement("div", { className: cssPrefix + "-hint" }, hint) : null,
		);
	};
}
