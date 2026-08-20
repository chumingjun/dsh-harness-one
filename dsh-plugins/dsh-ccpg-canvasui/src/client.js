// dsh-ccpg-canvasui 浏览器入口（bundle 工厂格式，window.__ModuleLoader__.load 注册）。
// 在官方 UI 的 conversation.view list 插槽注册 id="workflow" 的第二个视图 tab：
//   [💬 对话][▦ 工作流] —— 会话顶部 tab 切换，与官方聊天共用同一 dsh session。
// tab 内部左右分栏：
//   左 = iframe 载同源 /wf1/ 画布（React Flow 重前端，iframe 隔离最稳，画布代码零改动）
//   右 = 轻量聊天记录栏（dsh-plugins/shared/chat-pane.js 共享面板）——官方 renderSlot 被封在
//        entry 自己 children 的槽上（q6 闭包校验），官方聊天组件嵌不进来；
//        自绘只读流（用户消息/AI 回复/工具调用行），输入仍走底部官方 composer。
// 画布 ↔ 宿主经 postMessage 桥接：
//   宿主 → 画布：{type:'wf1-session', sessionId}（画布据此绑 AI 助手工具作用域）
//   画布 → 宿主：{type:'wf1-ready'}
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
		var SPLIT_KEY = "wf1:canvasui:split";
		var DEFAULT_CHAT_PX = 360;
		var MIN_CHAT = 240;
		var MIN_CANVAS = 320;

		// @include ../../shared/chat-pane.js
		var ChatPane = createChatPane(react, {
			title: "对话记录",
			hint: "输入框在下方 · 切到「对话」tab 看完整交互",
			formatTool: function (name, args) {
				if (name === "canvas_graph_patch" && args && args.ops) return args.ops.length + " 个操作";
				return "";
			},
		});

		function ensureStyle() {
			if (document.getElementById("wf1-canvasui-style")) return;
			var el = document.createElement("style");
			el.id = "wf1-canvasui-style";
			el.textContent = [
					// 官方 viewArea 是 flex "1 0 auto"（shrink=0），普通流内 iframe 会把它撑高。
					// root 正常占满 viewArea 并建立定位上下文，split 再 absolute 锁在该内容区内。
					".wf1-view-root{position:relative;display:block;flex:1 1 0;width:100%;height:100%;min-height:0;overflow:hidden;}",
					".wf1-split{display:flex;width:100%;height:100%;max-height:100%;min-height:0;position:absolute;inset:0;background:var(--dsw-alias-bg-canvas,#14120F);}",
				".wf1-split-canvas{flex:1;min-width:0;position:relative;display:flex;}",
				".wf1-split-canvas iframe{width:100%;height:100%;border:0;display:block;flex:1;}",
				".wf1-split-handle{flex:none;width:5px;cursor:col-resize;background:transparent;position:relative;z-index:3;}",
				".wf1-split-handle:hover,.wf1-split-handle[data-dragging='1']{background:var(--dsw-alias-state-business-primary,#8B5CF6);opacity:.6;}",
				".wf1-split-chat{flex:none;min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));background:var(--dsw-alias-bg-base);}",
				".wf1-split[data-chat-collapsed='1'] .wf1-split-chat{display:none;}",
					".wf1-chat-toggle{flex:none;position:absolute;top:10px;right:10px;z-index:4;min-width:34px;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;background:var(--dsw-alias-bg-raised,#26221D);color:var(--dsw-alias-label-primary,#e8e4dc);cursor:pointer;font-size:13px;font-weight:600;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,.32);}",
					".wf1-chat-toggle:hover{border-color:var(--dsw-alias-state-business-primary,#8B5CF6);color:#fff;}",
					".wf1-split[data-chat-collapsed='1'] .wf1-chat-toggle{top:auto;right:0;bottom:calc(50% - 66px);transform:none;width:42px;height:132px;padding:12px 9px;border-radius:10px 0 0 10px;border-right:0;background:var(--dsw-alias-state-business-primary,#8B5CF6);color:#fff;writing-mode:vertical-rl;text-orientation:upright;letter-spacing:2px;box-shadow:-3px 0 14px rgba(0,0,0,.4);}",
					".wf1-split[data-chat-collapsed='1'] .wf1-chat-toggle:hover{filter:brightness(1.12);}",
				].join("\n");
			document.head.appendChild(el);
		}

		function readSplit() {
			var v = Number(localStorage.getItem(SPLIT_KEY));
			return Number.isFinite(v) && v >= MIN_CHAT ? v : DEFAULT_CHAT_PX;
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
					style: { position: "absolute", top: 8, right: 44, fontSize: 12, color: "#8b8578", pointerEvents: "none" },
				}, "画布加载中…"),
			);
		}

		// ---- 聊天记录半：shared/chat-pane.js（构建期内联，见文件头说明）----

		// ---- 工作流视图：左画布 | 右聊天记录 ----
		function WorkflowView(props) {
			var chatPx0 = react.useState(readSplit);
			var chatPx = chatPx0[0], setChatPx = chatPx0[1];
			var collapsed0 = react.useState(localStorage.getItem("wf1:canvasui:chatCollapsed") === "1");
			var collapsed = collapsed0[0], setCollapsed = collapsed0[1];
			var draggingRef = react.useRef(false);
			var rootRef = react.useRef(null);
			var chatPxRef = react.useRef(chatPx);
			chatPxRef.current = chatPx;

			var onPointerDown = function (e) {
				draggingRef.current = true;
				e.currentTarget.dataset.dragging = "1";
				if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
			};
			var onPointerMove = function (e) {
				if (!draggingRef.current || !rootRef.current) return;
				var rect = rootRef.current.getBoundingClientRect();
				var next = Math.round(rect.right - e.clientX);
				setChatPx(Math.max(MIN_CHAT, Math.min(rect.width - MIN_CANVAS, next)));
			};
			var onPointerUp = function (e) {
				if (!draggingRef.current) return;
				draggingRef.current = false;
				e.currentTarget.dataset.dragging = "";
				localStorage.setItem(SPLIT_KEY, String(chatPxRef.current));
			};

			var toggleChat = function () {
				var next = !collapsed;
				setCollapsed(next);
				localStorage.setItem("wf1:canvasui:chatCollapsed", next ? "1" : "0");
			};

				return react.createElement("div", { className: "wf1-view-root" },
					react.createElement("div", {
						ref: rootRef,
						className: "wf1-split",
						"data-chat-collapsed": collapsed ? "1" : undefined,
					},
						react.createElement("div", { className: "wf1-split-canvas" },
							react.createElement(CanvasPane, { sessionId: props.sessionId }),
							react.createElement("button", {
								className: "wf1-chat-toggle",
								title: collapsed ? "展开对话记录" : "收起对话记录",
								"aria-label": collapsed ? "展开对话记录" : "收起对话记录",
								onClick: toggleChat,
							}, collapsed ? "展开对话" : "收起"),
						),
						collapsed ? null : react.createElement("div", {
							className: "wf1-split-handle",
							onPointerDown: onPointerDown,
							onPointerMove: onPointerMove,
							onPointerUp: onPointerUp,
							onPointerCancel: onPointerUp,
						}),
						collapsed ? null : react.createElement("div", {
							className: "wf1-split-chat", style: { width: chatPx + "px" } },
							react.createElement(ChatPane, { sessionId: props.sessionId }),
						),
					),
				);
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
		}

		exports.apply = apply;
		exports.name = "dsh-ccpg-canvasui/client";
		exports.inject = ["slots"];
		return exports;
	},
});
