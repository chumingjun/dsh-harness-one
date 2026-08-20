// dsh-ccpg-web 浏览器入口（bundle 工厂格式，window.__ModuleLoader__.load 注册）。
// 官方 UI 侧边栏 footer 注册「Workflow One 画布」入口，点击打开 /wf1/。
// host 半（lib/index.js）与 client 半（本文件）经 package.json 的 dsh.client 声明关联。

window.__ModuleLoader__.load({
	id: "dsh-ccpg-web",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const CANVAS_URL = "/wf1/";

		// footer action：随侧边栏折叠态渲染（wide=完整行，rail=图标）
		function WorkflowOneEntry(props) {
			const wide = props?.wide;
			const open = () => { window.open(CANVAS_URL, "_blank"); };
			return react.createElement(
				"button",
				{
					onClick: open,
					title: "打开 Workflow One 工作流画布",
					style: {
						display: "inline-flex", alignItems: "center", gap: "8px",
						width: wide ? "auto" : "36px",
						alignSelf: wide ? "stretch" : "center",
						height: "34px", margin: "3px 2px",
						padding: wide ? "0 12px" : "0",
						border: "1px solid transparent", borderRadius: "10px",
						background: "transparent", color: "inherit",
						fontSize: "14px", cursor: "pointer", whiteSpace: "nowrap",
					overflow: "hidden",
					transition: "background .15s ease",
				},
				onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))"; },
				onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
				onMouseDown: (e) => { e.currentTarget.style.transform = "scale(.97)"; },
				onMouseUp: (e) => { e.currentTarget.style.transform = ""; },
			},
				react.createElement("span", { style: { fontSize: "16px", lineHeight: 1 } }, "🧩"),
				wide ? react.createElement("span", null, "Workflow One 画布") : null,
			);
		}

		// 官方 footerActions 容器是横向 flex；dsh-ccpg 系插件有多个 footer 入口时
		// 会挤成一行，注入样式改为纵向堆叠。用 [class*=] 属性选择器而非完整类名——
		// css-module 哈希前缀（hHd-Xa_）随 dsh 构建变化，footerActions 本地名才是稳定锚点。
		function ensureFooterColumnStyle() {
			if (document.getElementById("wf1-footer-column-style")) return;
			var el = document.createElement("style");
			el.id = "wf1-footer-column-style";
			el.textContent = '[class*="footerActions"]{flex-direction:column;align-items:stretch}';
			document.head.appendChild(el);
		}

		function apply(ctx) {
			ensureFooterColumnStyle();
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-ccpg-canvas",
				order: 10, // dsh-ccpg 系入口排序基准：画布 10 < 飞书账号 20，纵向堆叠时画布在上
			}, WorkflowOneEntry));
		}

		exports.apply = apply;
		exports.name = "dsh-ccpg-web/client";
		exports.inject = ['slots'];
		return exports;
	},
});
