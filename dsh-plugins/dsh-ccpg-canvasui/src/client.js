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

		// @include ../../shared/chat-pane.js
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
