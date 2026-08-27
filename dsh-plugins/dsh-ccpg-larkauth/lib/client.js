// dsh-ccpg-larkauth 浏览器入口（bundle 工厂格式，window.__ModuleLoader__.load 注册）。
// 两处集成 dsh 官方 Web UI：
//   1) 设置面板新增「飞书账号」section（settings.section）：授权状态 + 扫码登录 + 退出
//   2) 侧边栏 footer「飞书账号」入口（sidebar.footer.action）：点击打开设置并定位到本 section
// 数据走宿主同源 fetch /wf1/api/lark-auth（host 半注册的端点），不依赖 connection RPC。

window.__ModuleLoader__.load({
	id: "dsh-ccpg-larkauth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		var API = "/wf1/api/lark-auth";

		function apiGet() {
			return fetch(API).then(function (r) { return r.json(); });
		}
		function apiPost(body) {
			return fetch(API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}).then(function (r) { return r.json(); });
		}

		// ---- 状态点（绿=valid 黄=needs_refresh 灰=未登录/未装） ----
		function dotClass(status) {
			var u = status && status.user;
			if (!status || !status.installed) return "larka-dot off";
			if (u && u.tokenStatus === "valid") return "larka-dot ok";
			if (u && u.userName) return "larka-dot warn";
			return "larka-dot off";
		}

		// ---- 设置面板 section 组件 ----
		function LarkAuthSection(props) {
			var close = props && props.close;
			var status0 = props && props.initialStatus;
			var st = react.useState(status0 || null);
			var status = st[0], setStatus = st[1];
			var lo = react.useState(null);
			var login = lo[0], setLogin = lo[1];
			var be = react.useState(false);
			var busy = be[0], setBusy = be[1];
		var pollRef = react.useRef(null);
		var deadlineRef = react.useRef(0);
		var se = react.useState(null);
		var startError = se[0], setStartError = se[1];

			var load = react.useCallback(function () {
				apiGet().then(function (d) { if (d.ok) setStatus(d.status); }).catch(function () {});
			}, []);
			react.useEffect(function () {
				if (!status0) load();
				return function () { if (pollRef.current) clearTimeout(pollRef.current); };
			}, [load]);
			// 未安装（宿主正在后台自动安装）时轮询状态，装好即切换到登录界面
			react.useEffect(function () {
				if (status && !status.installed) {
					var t = setTimeout(load, 4000);
					return function () { clearTimeout(t); };
				}
			}, [status, load]);

			var schedulePoll = function (deviceCode) {
				if (pollRef.current) clearTimeout(pollRef.current);
				pollRef.current = setTimeout(function () {
					if (Date.now() > deadlineRef.current) { setLogin(null); return; }
					apiPost({ action: "poll", deviceCode: deviceCode }).then(function (d) {
						if (d.ok) { setStatus(d.status); setLogin(null); return; }
						schedulePoll(deviceCode);
					}).catch(function () { schedulePoll(deviceCode); });
				}, 4000);
			};

		var start = function () {
			setBusy(true);
			apiPost({ action: "start" }).then(function (d) {
				if (!d.ok) { setBusy(false); setStartError(d.error || "发起登录失败"); return; }
				return apiPost({ action: "qrcode", verificationUrl: d.verificationUrl }).then(function (q) {
					setLogin({
						verificationUrl: d.verificationUrl,
						deviceCode: d.deviceCode,
						qrDataUrl: q.ok ? q.dataUrl : null,
					});
					deadlineRef.current = Date.now() + (d.expiresIn || 600) * 1000;
					schedulePoll(d.deviceCode);
					setBusy(false);
				});
			}).catch(function () { setBusy(false); setStartError("网络错误，请重试"); });
		};

			var cancel = function () {
				if (pollRef.current) clearTimeout(pollRef.current);
				setLogin(null);
			};

			var logout = function () {
				setBusy(true);
				apiPost({ action: "logout" }).then(function () { setBusy(false); load(); }).catch(function () { setBusy(false); });
			};

			if (!status) {
				return react.createElement("div", { style: S.muted }, "正在加载飞书授权状态…");
			}
			if (!status.installed) {
				return react.createElement("div", { style: S.wrap },
					react.createElement("div", { style: S.warn },
						status.installing
							? "正在自动安装 lark-cli（飞书官方 CLI），通常 1 分钟内完成…"
							: "本机未安装 lark-cli（飞书官方 CLI）。"),
					react.createElement("div", { style: S.actions },
						react.createElement("button", {
							style: Object.assign({}, S.btn, S.btnPrimary),
							disabled: busy || status.installing,
							onClick: function () {
								setBusy(true);
								apiPost({ action: "install" }).then(function (d) {
									setBusy(false);
									if (d.status) setStatus(d.status); else load();
								}).catch(function () { setBusy(false); load(); });
							},
						}, status.installing ? "安装中…" : "自动安装 lark-cli"),
						close ? react.createElement("button", { style: S.btn, onClick: close }, "关闭") : null),
					status.runtime === "desktop"
						? react.createElement("div", { style: S.muted }, "确认后将安装到当前 Desktop profile；切换 profile 时需分别安装。")
						: react.createElement("div", { style: S.muted },
							"安装后此处即可扫码登录；也可手动执行 ",
							react.createElement("code", { style: S.code }, "npm i -g @larksuite/cli")));
			}

			var u = status.user || {};
			var loggedIn = u.tokenStatus === "valid";
			var needsRefresh = u.userName && u.tokenStatus !== "valid";
			var renew = status.autoRenew || {};
			var renewText = renew.lastAt
				? " · 自动续约 " + String(renew.lastAt).slice(11, 19) +
					(renew.lastResult === "renewed" ? " ✓" : renew.lastResult === "fresh" ? "（有效）" : renew.lastResult ? "（" + renew.lastResult + "）" : "")
				: "";

			return react.createElement("div", { style: S.wrap },
				react.createElement("div", { style: S.stateRow },
					react.createElement("span", { className: dotClass(status) }),
					react.createElement("strong", null, u.userName || "未登录飞书账号"),
					u.userName ? react.createElement("span", { style: S.muted },
						u.tokenStatus === "valid" ? "（已授权，agent 默认以用户身份执行，token 自动续约）" : "（token 需刷新，重新扫码即可）") : null),
				react.createElement("div", { style: S.meta },
					"App " + (status.appId || "-") + " · 默认身份 " + (status.defaultIdentity || "-") + " · bot " + ((status.bot && status.bot.status) || "-") +
					(u.expiresAt ? " · user token 至 " + String(u.expiresAt).slice(11, 16) : "") + renewText),
				react.createElement("div", { style: S.actions },
					loggedIn
						? react.createElement("button", { style: S.btn, onClick: logout, disabled: busy }, "退出登录")
						: react.createElement("button", { style: Object.assign({}, S.btn, S.btnPrimary), onClick: start, disabled: busy },
							needsRefresh ? "重新扫码授权" : "扫码登录飞书"),
					close ? react.createElement("button", { style: S.btn, onClick: close }, "关闭") : null),
				startError ? react.createElement("div", { style: S.warn },
					startError, " · ", react.createElement("a", {
						href: "#", style: S.link, onClick: function (e) { e.preventDefault(); setStartError(null); start(); },
					}, "重试")) : null,
				login ? react.createElement("div", { style: S.qrBox },
					react.createElement("div", { style: S.qrTip }, "用飞书 App 扫码完成授权（10 分钟内有效）"),
					react.createElement("div", { style: S.qrRow },
						login.qrDataUrl
							? react.createElement("img", { src: login.qrDataUrl, alt: "飞书登录二维码", style: S.qrImg })
							: react.createElement("div", { style: S.qrLoading }, "二维码生成中…"),
						react.createElement("div", { style: S.qrSide },
							react.createElement("a", { href: login.verificationUrl, target: "_blank", rel: "noreferrer", style: S.link }, "打不开扫码？点这里授权 →"),
							react.createElement("span", { style: S.muted }, "等待扫码确认…"),
							react.createElement("button", { style: S.btn, onClick: cancel }, "取消")))) : null);
		}

		// 样式（内联，避免与宿主 CSS 约定耦合；色值对齐官方 --dsw 变量优先）
		var S = {
			wrap: { display: "flex", flexDirection: "column", gap: "12px", fontSize: "14px" },
			stateRow: { display: "flex", alignItems: "center", gap: "8px" },
			muted: { color: "var(--dsw-alias-text-secondary, #888)", fontSize: "12px" },
			warn: { color: "var(--dsw-alias-text-warning, #B45309)", fontSize: "13px", lineHeight: 1.6 },
			code: { fontFamily: "ui-monospace, monospace", background: "var(--dsw-alias-bg-sunken, rgba(0,0,0,.06))", padding: "1px 5px", borderRadius: "4px" },
			meta: { color: "var(--dsw-alias-text-secondary, #888)", fontSize: "12px", fontFamily: "ui-monospace, monospace" },
			actions: { display: "flex", gap: "8px" },
			btn: {
				height: "30px", padding: "0 14px", borderRadius: "8px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-strong, rgba(0,0,0,.2))",
				background: "var(--dsw-alias-bg-default, transparent)",
				color: "inherit", fontSize: "13px",
			},
			btnPrimary: {
				borderColor: "transparent",
				background: "var(--dsw-alias-accent-bg, #4F46E5)",
				color: "var(--dsw-alias-accent-fg, #fff)",
			},
			qrBox: { border: "1px solid var(--dsw-alias-border, rgba(0,0,0,.1))", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" },
			qrTip: { fontSize: "12px", color: "var(--dsw-alias-text-secondary, #888)" },
			qrRow: { display: "flex", gap: "14px", alignItems: "center" },
			qrImg: { width: "168px", height: "168px", background: "#fff", padding: "6px", borderRadius: "8px" },
			qrLoading: { width: "168px", height: "168px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", color: "#666", background: "#fff", borderRadius: "8px" },
			qrSide: { display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" },
			link: { fontSize: "13px", color: "var(--dsw-alias-accent-bg, #4F46E5)" },
		};

	// 全局样式：注入一次（官方 UI 无此类名约定）。
	// larka-entry 几何逐项对齐官方设置触发器（ui-settings-general VOzbGW_trigger）：
	// 宽态 42px 满行 12px 圆角、收起态 36px 圆——两态都与「设置」按钮同轴。
	// footerActions 官方是横向 flex：多个 footer.action 注册者（如 dsh-remote-web-ui）
	// 会并排挤一行。slot anchor 是 display:contents（不参与布局），真正的 flex 上下文
	// 是 anchor 的父容器；这里用 :has() 命中「含有本入口的 footerActions 容器」，
	// 改为纵向堆叠——每个 footer 图标独占一行，与设置按钮同宽对齐。
	function ensureDotStyle() {
		if (document.getElementById("larka-dot-style")) return;
		var css = ".larka-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#9CA3AF}"
			+ ".larka-dot.ok{background:#10B981;box-shadow:0 0 6px rgba(16,185,129,.5)}"
			+ ".larka-dot.warn{background:#F59E0B;box-shadow:0 0 6px rgba(245,158,11,.5)}"
			+ ".larka-entry{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;"
			+ "color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;"
			+ "flex:none;align-items:center;justify-content:flex-start;gap:8px;margin:4px -2px;"
			+ "padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;"
			+ "display:flex;overflow:hidden;white-space:nowrap}"
			+ ".larka-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".larka-entry.larka-rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}"
			+ ":has(> [data-slot=\"sidebar.footer.action\"] .larka-entry){display:flex;flex-direction:column}";
		var el = document.createElement("style");
		el.id = "larka-dot-style";
		el.textContent = css;
		document.head.appendChild(el);
	}

		// ---- 侧边栏 footer 入口：点击打开设置面板 ----
		// settings 面板由官方 ui-settings 打开；这里用官方入口同款方式：派发打开设置后切换到本 section。
		function LarkAuthEntry(props) {
			var wide = props && props.wide;
			ensureDotStyle();
			var st = react.useState(null);
			react.useEffect(function () {
				apiGet().then(function (d) { if (d.ok) st[1](d.status); }).catch(function () {});
			}, []);
			var openSettings = function () {
				// 官方设置触发器挂 [data-slot="settings.trigger"]（ui-settings-general 注册）；
				// 找它所属的 button 点击打开设置面板，飞书账号 section 随面板可见。
				var slot = document.querySelector('[data-slot="settings.trigger"]');
				var btn = slot ? slot.closest("button") : null;
				if (btn) btn.click();
			};
			var label = st[0] && st[0].user && st[0].user.tokenStatus === "valid"
				? "飞书 " + (st[0].user.userName || "已登录") : "飞书账号";
			// 几何走 larka-entry/larka-rail 类（见 ensureDotStyle）：与官方设置按钮逐项同款
			return react.createElement("button", {
				onClick: openSettings,
				title: "飞书账号授权（lark-cli 扫码登录）",
				className: wide ? "larka-entry" : "larka-entry larka-rail",
			},
				react.createElement("span", { className: dotClass(st[0]) }),
				wide ? react.createElement("span", null, label) : null);
		}

		// ---- 设置导航图标注入 ----
		// 官方 ui-settings-general 的 navIcon 是编译期写死的 id→图标映射，第三方 section
		// 统一回退齿轮且无扩展口（SlotMap 只有 id/order/label）。DOM 最小补丁：定位文本
		// 精确等于「飞书账号」的导航按钮，前置一枚 16px 描边 currentColor 的自绘 SVG。
		var NAV_ICON_MARK = "data-larka-nav-icon";
		function startSettingsNavIcon(labelText, svgMarkup) {
			// 非 DOM 宿主（单测加载 bundle）直接跳过
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
			// 官方行内的回退齿轮不删除（React 自己的节点）——纯 CSS 隐藏，避免 reconcile 冲突
			if (!document.getElementById("larka-nav-icon-style")) {
				var styleEl = document.createElement("style");
				styleEl.id = "larka-nav-icon-style";
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
		// 飞书账号导航图标：官方 Lark 鸟形 brand mark 单色剪影
		// （path 数据取自 dashboard-icons 的 lark.svg，坐标精简到 0.1 位）
		var LARK_NAV_ICON_SVG =
			"<svg viewBox=\"62.16 94.5 407.87 324.19\" width=\"16\" height=\"16\" aria-hidden=\"true\" fill=\"currentColor\"><path d=\"M274.2 264.8q.515-.517 1.0-1.0c.685-.688 1.4-1.3 2.1-1.9l1.4-1.4 4.1-4.1 5.6-5.6 4.8-4.8 4.6-4.5 4.8-4.7 4.3-4.3 6.1-6.1c1.1-1.1 2.3-2.3 3.5-3.3 2.2-2.1 4.5-4 6.9-5.8 2.2-1.7 4.3-3.3 6.5-4.9 3.1-2.2 6.4-4.3 9.7-6.3 3.2-1.9 6.6-3.7 10.1-5.4 3.2-1.6 6.5-3.0 9.8-4.2 1.8-.684 3.8-1.4 5.6-2.1.914-.344 1.9-.688 2.9-.914-8.6-33.7-24.2-64.6-45.3-90.9-4.1-5.1-10.4-8.1-17.0-8.1H130.8c-3.2 0-4.5 4-1.9 5.9 59.5 43.7 109.1 99.9 145.0 164.8 0-.226.2-.34.3-.457m0 0\"/><path d=\"M204.8 418.7c90.3 0 169.0-49.8 210.1-123.5 1.5-2.6 2.9-5.3 4.2-7.9q-3.1 6-6.9 11.3l-2.7 3.8c-1.1 1.5-2.4 3.0-3.7 4.5-1.0 1.1-2.1 2.3-3.1 3.3-2.1 2.2-4.3 4.2-6.6 6.2a53 53 0 0 1-3.9 3.2c-1.6 1.1-3.1 2.3-4.7 3.4-1.0.683-2.1 1.4-3.1 1.9-1.1.684-2.2 1.3-3.3 1.9a131 131 0 0 1-7.0 3.5c-2.1.918-4.1 1.8-6.3 2.5-2.3.801-4.6 1.6-7.0 2.3-3.5.914-7.1 1.7-10.7 2.3-2.6.457-5.3.687-8 .914-2.9.23-5.6.23-8.5.23-3.1 0-6.3-.23-9.5-.57a83 83 0 0 1-7.1-1.0c-2.1-.34-4.1-.801-6.2-1.3-1.0-.227-2.2-.57-3.2-.797-3.0-.8-6.1-1.6-9.0-2.5-1.5-.457-3.0-.914-4.5-1.3-2.2-.683-4.5-1.4-6.6-2.1-1.8-.57-3.7-1.1-5.4-1.7q-2.6-.86-5.1-1.7c-1.1-.344-2.3-.8-3.5-1.1-1.4-.457-2.9-1.0-4.2-1.5-1.0-.344-2.1-.687-3.0-1.0-1.9-.688-4-1.5-5.9-2.2-1.1-.457-2.3-.914-3.4-1.3-1.5-.57-3.1-1.1-4.6-1.8-1.6-.687-3.2-1.3-4.8-1.9-1.0-.457-2.1-.797-3.1-1.3-1.3-.57-2.6-1.0-3.9-1.6-1.0-.457-1.9-.8-3.0-1.3l-3.1-1.4c-.914-.344-1.8-.801-2.7-1.1a44 44 0 0 1-2.5-1.1c-.8-.345-1.7-.802-2.5-1.1-.914-.344-1.7-.801-2.5-1.1-1.0-.457-2.2-1.0-3.2-1.5-1.1-.575-2.3-1.0-3.4-1.6-1.3-.574-2.4-1.1-3.7-1.7-1.0-.457-2.1-1.0-3.1-1.5-54.2-27.0-102.2-63.1-143.1-106.7-2.1-2.2-5.7-.684-5.7 2.3l.112 154.4v12.6c0 7.3 3.5 14.1 9.6 18.2 38.2 24.8 83.8 39.5 132.9 39.5m0 0\"/><path d=\"M414.8 295.2c0 .113-.113.1-.113.2zl.8-1.5c-.343.5-.574 1.0-.8 1.5m3.8-7.0.226-.457.1-.23q-.17.5-.34.7m0 0\"/><path d=\"M470.0 201.1c-18.3-9.0-38.9-14.1-60.7-14.1-12.9 0-25.5 1.8-37.4 5.1-1.4.344-2.7.8-4.1 1.3-.914.3-1.9.574-2.9.914-1.9.688-3.8 1.4-5.6 2.1-3.3 1.3-6.6 2.7-9.8 4.2-3.4 1.6-6.7 3.4-10.1 5.4a128 128 0 0 0-9.7 6.3c-2.3 1.6-4.5 3.2-6.5 4.9a154 154 0 0 0-6.9 5.8c-1.1 1.1-2.4 2.2-3.5 3.3l-6.1 6.1-4.3 4.3-4.8 4.7-4.6 4.5-4.8 4.8-11.1 11.1c-.687.7-1.4 1.4-2.1 1.9l-1.0 1.0c-.457.5-1.0 1.0-1.6 1.5-.57.6-1.1 1.0-1.7 1.6a244.4 244.4 0 0 1-49.8 35.3c1.0.457 2.2 1.0 3.2 1.5.8.3 1.7.797 2.5 1.1.8.3 1.7.801 2.5 1.1.801.3 1.6.684 2.5 1.1.914.3 1.8.802 2.7 1.1l3.1 1.4c1.0.457 1.9.801 3.0 1.3 1.3.57 2.6 1.0 3.9 1.6 1.0.46 2.1.8 3.1 1.3 1.6.687 3.2 1.3 4.8 1.9 1.5.57 3.1 1.1 4.6 1.8 1.1.457 2.3.914 3.4 1.3 1.9.684 4 1.5 5.9 2.2a81 81 0 0 1 3.0 1.0c1.4.457 2.9 1.0 4.2 1.5 1.1.343 2.3.8 3.5 1.1q2.6.86 5.1 1.7c1.8.57 3.7 1.1 5.4 1.7 2.2.688 4.5 1.4 6.6 2.1 1.5.457 3.0.914 4.5 1.3 3.0.914 5.9 1.7 9.0 2.5 1.0.344 2.2.574 3.2.8 2.1.458 4.1.915 6.2 1.3 2.4.457 4.7.8 7.1 1.0 3.2.34 6.4.571 9.5.571 2.9 0 5.7 0 8.5-.23 2.6-.227 5.4-.457 8-.914 3.7-.57 7.2-1.4 10.7-2.3 2.4-.683 4.7-1.4 7.0-2.3 2.2-.8 4.2-1.6 6.3-2.5 2.4-1.0 4.7-2.3 7.0-3.5 1.1-.57 2.2-1.3 3.3-1.9 1.0-.687 2.1-1.3 3.1-1.9 1.6-1.0 3.2-2.2 4.7-3.4a52 52 0 0 0 3.9-3.2c2.3-1.9 4.5-4 6.6-6.2 1.0-1.0 2.1-2.2 3.1-3.3 1.3-1.5 2.5-3.0 3.7-4.5.918-1.3 1.8-2.5 2.7-3.8 2.5-3.5 4.8-7.3 6.9-11.2l2.3-4.7 21.1-42.2v.113c6.7-14.7 16.2-28.1 27.7-39.4m0 0\"/></svg>";

		function apply(ctx) {
			ensureDotStyle();
			startSettingsNavIcon("飞书账号", LARK_NAV_ICON_SVG);
			// 1) 设置面板「飞书账号」section（无 locale 字典时 label 用字符串）
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "lark-auth",
				order: 20,
				label: () => "飞书账号",
			}, LarkAuthSection));
			// 2) 侧边栏 footer 入口
		ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
			name: "sidebar.footer.action",
			id: "lark-auth-entry",
			order: 20,
		}, LarkAuthEntry));
		}

		exports.apply = apply;
		exports.name = "dsh-ccpg-larkauth/client";
		exports.inject = ["slots"];
		return exports;
	},
});
