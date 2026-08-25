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

		function apply(ctx) {
			ensureDotStyle();
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
