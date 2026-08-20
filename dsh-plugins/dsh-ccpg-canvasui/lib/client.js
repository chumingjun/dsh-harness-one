// dsh-ccpg-canvasui 浏览器入口（bundle 工厂格式，window.__ModuleLoader__.load 注册）。
// 职责一：在官方 UI 的 conversation.view list 插槽注册 id="workflow" 的第二个视图 tab：
//   [💬 对话][▦ 工作流] —— 会话顶部 tab 切换，与官方聊天共用同一 dsh session。
//   tab 内容 = iframe 载同源 /wf1/ 画布全宽（React Flow 重前端，iframe 隔离最稳）。
// 职责二：向 DSH-better-sidebar（社区侧边栏工作台）注册「对话记录」tab（+ 菜单第一位）。
//   组件复用 dsh-plugins/shared/chat-pane.js 共享面板：只读聊天流（用户消息/AI 回复/
//   工具调用行），输入仍走底部官方 composer；visible=false 时暂停轮询。
//   接入是软依赖（ctx.inject(['betterSidebar'],…)）：未安装 better-sidebar 时
//   静默跳过，工作流 tab 等其余表面不受影响。
// 画布 ↔ 宿主经 postMessage 桥接：
//   宿主 → 画布：{type:'wf1-session', sessionId}（画布据此绑 AI 助手工具作用域）
//   画布 → 宿主：{type:'wf1-ready'}；{type:'wf1-open-chat'}（切到工作流 tab 时宿主
//   经 better-sidebar 的 openTab 展开侧边栏聚焦「对话记录」）
//
// ⚠ 本文件是源文件（src/client.js），真正的插件 bundle 是构建产物 lib/client.js：
//   sh ../build-canvasui.sh 把下面 // @include 标记的共享片段（如 chat-pane.js）
//   内联拼接后生成。改这里或改 shared/ 后必须重跑构建，直接改 lib/ 会被覆盖。

window.__ModuleLoader__.load({
	id: "dsh-ccpg-canvasui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		var CANVAS_URL = "/wf1/";
		var CHAT_TAB_TYPE = "ccpg:chat";
		var CHAT_TAB_ORDER = 5; // better-sidebar + 菜单升序，内置最小 explorer=10 → 排第一

		// better-sidebar 服务句柄：注册时存，供 WorkflowView 的 openTab 联动用
		//（conversation.view entry 的 owner props 拿不到 ctx，走模块级引用）。
		var betterSidebarRef = { svc: null };

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
				// 主题适配：颜色一律走官方 --dsw-alias-* 令牌（layout 主题呈现器把它们投影到
				// body，亮/暗/皮肤自动跟随）；回退值仅令牌缺失时兜底。
				"." + cssPrefix + "-head{flex:none;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;gap:8px;}",
				"." + cssPrefix + "-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;}",
				"." + cssPrefix + "-list{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;}",
				"." + cssPrefix + "-msg{max-width:100%;padding:8px 10px;border-radius:10px;font-size:13px;line-height:1.55;word-break:break-word;}",
				"." + cssPrefix + "-msg-user{align-self:flex-end;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border-bottom-right-radius:4px;}",
				"." + cssPrefix + "-msg-ai{align-self:flex-start;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-bottom-left-radius:4px;}",
				"." + cssPrefix + "-msg-tool{align-self:flex-start;background:transparent;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:ui-monospace,monospace;padding:5px 9px;}",
				"." + cssPrefix + "-msg-tool b{color:var(--dsw-alias-state-business-primary);font-weight:600;}",
				"." + cssPrefix + "-hint{flex:none;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center;}",
				// Markdown 消息体：块间距收敛、标题缩小、表格可横向滚动不撑破气泡
				"." + cssPrefix + "-md p{margin:0 0 6px;white-space:pre-wrap;}",
				"." + cssPrefix + "-md p:last-child{margin-bottom:0;}",
				"." + cssPrefix + "-md h1,." + cssPrefix + "-md h2,." + cssPrefix + "-md h3,." + cssPrefix + "-md h4,." + cssPrefix + "-md h5,." + cssPrefix + "-md h6{margin:8px 0 4px;font-size:14px;line-height:1.4;}",
				"." + cssPrefix + "-md h1{font-size:15px;}",
				"." + cssPrefix + "-md ul,." + cssPrefix + "-md ol{margin:2px 0 6px;padding-left:18px;}",
				"." + cssPrefix + "-md li{margin:2px 0;white-space:pre-wrap;}",
				"." + cssPrefix + "-md blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l3);opacity:.9;white-space:pre-wrap;}",
				"." + cssPrefix + "-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-interactive-bg-hover);padding:1px 5px;border-radius:4px;}",
				"." + cssPrefix + "-md pre{margin:4px 0;padding:8px 10px;background:var(--dsw-alias-markdown-code-block);border-radius:8px;overflow-x:auto;white-space:pre;}",
				"." + cssPrefix + "-md pre code{background:none;padding:0;font-size:12px;line-height:1.5;}",
				"." + cssPrefix + "-md table{border-collapse:collapse;margin:6px 0;font-size:12px;display:block;max-width:100%;overflow-x:auto;}",
				"." + cssPrefix + "-md th,." + cssPrefix + "-md td{border:1px solid var(--dsw-alias-border-l2);padding:4px 8px;text-align:left;vertical-align:top;}",
				"." + cssPrefix + "-md th{background:var(--dsw-alias-interactive-bg-hover);font-weight:600;}",
				"." + cssPrefix + "-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:8px 0;}",
				"." + cssPrefix + "-md a{color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));text-decoration:underline;text-underline-offset:2px;}",
				// 用户 brand 底气泡里的行内码/链接换成前景安全色（叠层 fill 在 brand 底上会脏）
				"." + cssPrefix + "-msg-user ." + cssPrefix + "-md code{background:var(--dsw-alias-interactive-bg-hover);}",
				"." + cssPrefix + "-msg-user ." + cssPrefix + "-md a{color:var(--dsw-alias-label-primary-foreground,#fff);}",
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
						err ? react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-error,#ef4444)" } }, "同步失败") : null,
					),
					react.createElement("div", { className: cssPrefix + "-list", ref: listRef, onScroll: onScroll },
						items.length === 0 ? react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#8b8578)", fontSize: 12, textAlign: "center", marginTop: 20 } }, emptyText) : null,
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
		var ChatPane = createChatPane(react, {
			title: "对话记录",
			hint: "输入框在下方 · 侧边栏可切换其他页面",
			formatTool: function (name, args) {
				if (name === "canvas_graph_patch" && args && args.ops) return args.ops.length + " 个操作";
				return "";
			},
		});

		// better-sidebar 的 TabComponentProps：{ctx, store, scope:{sessionId,cwd}, tab, visible}。
		// visible=面板开且是激活 tab —— 门控轮询（官方建议，见 external-plugin-guide §4.2）。
		function SidebarChatTab(props) {
			var scope = props.scope || {};
			return react.createElement(ChatPane, {
				sessionId: scope.sessionId,
				paused: props.visible === false,
			});
		}

		function ensureStyle() {
			if (document.getElementById("wf1-canvasui-style")) return;
			var el = document.createElement("style");
			el.id = "wf1-canvasui-style";
			el.textContent = [
					// 官方 viewArea 是 flex "1 0 auto"（shrink=0），普通流内 iframe 会把它撑高。
					// root 正常占满 viewArea 并建立定位上下文，iframe absolute 锁在该内容区内。
					".wf1-view-root{position:relative;display:block;flex:1 1 0;width:100%;height:100%;min-height:0;overflow:hidden;}",
					".wf1-canvas-fill{position:absolute;inset:0;display:flex;}",
					".wf1-canvas-fill iframe{width:100%;height:100%;border:0;display:block;flex:1;}",
				].join("\n");
			document.head.appendChild(el);
		}

		// ---- 画布半：常驻 iframe（tab 切换不重载）----
		// 官方视图 tab 是 only 过滤渲染：非活动 entry 整体卸载，iframe 若挂在 React 树里
		// 切 tab 即销毁重载（几秒）。解法：iframe 挂在模块级 detached 容器，entry mount 时
		// appendChild 移入、卸载时移回 —— contentWindow 全程存活，切 tab 瞬时。
		var persistentHost = null;
		function ensurePersistentHost() {
			if (persistentHost) return persistentHost;
			persistentHost = document.createElement("div");
			persistentHost.style.cssText = "width:100%;height:100%;display:flex;";
			var frame = document.createElement("iframe");
			frame.src = CANVAS_URL;
			frame.title = "工作流画布";
			frame.allow = "clipboard-write";
			frame.style.cssText = "width:100%;height:100%;border:0;display:block;flex:1;";
			frame.addEventListener("load", function () { canvasReady = true; });
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

			// sessionId 或画布 ready 任一就绪即（重）发绑定
			react.useEffect(function () {
				var frame = frameRef.current;
				if (!frame || !ready || !sessionId) return;
				try {
					frame.contentWindow.postMessage({ type: "wf1-session", sessionId: sessionId }, window.location.origin);
				} catch (e) { /* 画布未就绪 */ }
			}, [sessionId, ready]);

			react.useEffect(function () {
				function onMessage(ev) {
					if (ev.source !== frameRef.current?.contentWindow) return;
					var d = ev.data;
					if (!d || typeof d !== "object") return;
					if (d.type === "wf1-ready") { canvasReady = true; setReady(true); }
				}
				window.addEventListener("message", onMessage);
				return function () { window.removeEventListener("message", onMessage); };
			}, []);

				return react.createElement("div", { style: { position: "relative", width: "100%", height: "100%", minHeight: 0 } },
					react.createElement("div", { ref: mountRef, style: { position: "absolute", inset: 0 } }),
					ready ? null : react.createElement("div", {
					style: { position: "absolute", top: 8, right: 12, fontSize: 12, color: "#8b8578", pointerEvents: "none" },
				}, "画布加载中…"),
			);
		}

		// ---- 工作流视图：全宽画布（聊天记录在 better-sidebar 侧边栏「对话记录」tab）----
		function WorkflowView(props) {
			// 进入工作流视图时把侧边栏「对话记录」tab 展开到眼前（服务句柄来自
			// betterSidebarRef——conversation.view 的 owner props 里拿不到 ctx）：
			// path 种子是"内容型打开"，面板折叠时会自动展开（type-only 不会）。
			react.useEffect(function () {
				var svc = betterSidebarRef.svc;
				if (!svc) return;
				try {
					svc.openTab({ type: CHAT_TAB_TYPE, title: "对话记录", path: "ccpg-chat" });
				} catch (e) { /* 侧边栏状态异常不阻塞画布 */ }
			}, []);

			return react.createElement("div", { className: "wf1-view-root" },
				react.createElement("div", { className: "wf1-canvas-fill" },
					react.createElement(CanvasPane, { sessionId: props.sessionId }),
				),
			);
		}

		// 会话首次出现时自动打开「对话记录」：better-sidebar 新会话默认种子是空
		// Files 窗（editor-home），我们让聊天记录成为默认第一个 tab——
		// ① 检测到种子态（只有那个无 path 的 editor tab）就把它关掉；
		// ② openTab 带 path 种子（内容型打开）→ 面板折叠时自动展开。
		// 已有别的布局（用户动过）不动；该会话处理过一次就不再管。
		function ccpgSidebarAllTabs(state) {
			var out = [];
			(function walk(node) {
				if (!node || node.kind !== "leaf") {
					(node && node.children || []).forEach(walk);
					return;
				}
				(node.tabs || []).forEach(function (t) { out.push(t); });
			})(state && state.splits);
			(function walkB(node) {
				if (!node || node.kind !== "leaf") {
					(node && node.children || []).forEach(walkB);
					return;
				}
				(node.tabs || []).forEach(function (t) { out.push(t); });
			})(state && state.bottomSplits);
			return out;
		}

		function autoOpenChatForSession(svc, sessionId) {
			if (!svc || !sessionId) return;
			autoOpenChatForSession.done = autoOpenChatForSession.done || {};
			if (autoOpenChatForSession.done[sessionId]) return;
			try {
				var snap = svc.getSnapshot && svc.getSnapshot();
				if (!snap || snap.sessionId !== sessionId || !snap.state) return;
				var all = ccpgSidebarAllTabs(snap.state);
				if (all.some(function (t) { return t.type === CHAT_TAB_TYPE; })) {
					autoOpenChatForSession.done[sessionId] = 1;
					return;
				}
				svc.openTab({ type: CHAT_TAB_TYPE, title: "对话记录", path: "ccpg-chat" });
				// 关种子 Files 窗：check() 首跑可能早于 store 从 localStorage hydrate——
				// 快照是"新种子态"（Files id 是刚铸的 uid），hydrate 后被持久化状态整体
				// 覆盖，对着旧实例 closeTab 无效。所以关完一拍后再校验补关一次。
				var closeSeeds = function () {
					try {
						var s2 = svc.getSnapshot && svc.getSnapshot();
						if (!s2 || s2.sessionId !== sessionId || !s2.state) return;
						ccpgSidebarAllTabs(s2.state)
							.filter(function (t) { return t.type === "editor" && !t.path; })
							.forEach(function (t) { svc.closeTab(t.id); });
					} catch (e) { /* 忽略 */ }
				};
				closeSeeds();
				setTimeout(closeSeeds, 600);
				autoOpenChatForSession.done[sessionId] = 1;
			} catch (e) { /* 状态异常不阻塞 */ }
		}

		function apply(ctx) {
			ensureStyle();

			ctx.slots.inject("conversation.view", function () {
				return ctx.slots.register({
					name: "conversation.view",
					id: "workflow",
					order: 1,
					label: function () { return "工作流"; },
				}, WorkflowView);
			});

			// DSH-better-sidebar「对话记录」tab：软依赖注入（服务未上线时 fiber 静默挂起，
			// 装上 better-sidebar 后自动激活；卸载/HMR 时 effect 自动撤销注册）。
			try {
				ctx.inject(["betterSidebar"], function (scope) {
					betterSidebarRef.svc = scope.betterSidebar;
					scope.effect(function () { return function () { betterSidebarRef.svc = null; }; }, "canvasui: sidebar svc ref");
					scope.effect(function () {
						return scope.betterSidebar.registerTab({
							id: CHAT_TAB_TYPE,
							title: function () { return "对话记录"; },
							icon: function (size) {
								return react.createElement("svg", {
									viewBox: "0 0 16 16", width: size || 14, height: size || 14,
									"aria-hidden": true, fill: "none", stroke: "currentColor",
									"stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round",
								},
									react.createElement("path", { d: "M2.5 3.5h11v7h-6.5L4 13v-2.5H2.5z" }));
							},
							order: CHAT_TAB_ORDER,
							single: true,
							component: SidebarChatTab,
						});
					}, "canvasui: better-sidebar chat tab");
					// 订阅状态：会话切换时做一次「默认打开聊天记录」
					scope.effect(function () {
						var svc = scope.betterSidebar;
						if (!svc || !svc.subscribeState) return;
						var check = function () {
							try { autoOpenChatForSession(svc, (svc.getSnapshot() || {}).sessionId); } catch (e) { /* 忽略 */ }
						};
						var off = svc.subscribeState(check);
						check();
						return off;
					}, "canvasui: sidebar auto-open");
				});
			} catch (e) { /* 老运行时无 ctx.inject：跳过侧边栏注册，工作流 tab 不受影响 */ }
		}

		exports.apply = apply;
		exports.name = "dsh-ccpg-canvasui/client";
		exports.inject = ["slots"];
		return exports;
	},
});
