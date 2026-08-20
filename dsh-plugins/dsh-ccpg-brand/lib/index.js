// dsh-ccpg-brand：CCPG 品牌定制插件（host 半）。
// 官方 UI 无品牌插槽（brand row 是 dsh-client-ui-sidebar 外壳自留地，BrandWordmark 硬编码 SVG），
// 所以走宿主服务 seam 定制，三条腿：
//   1) tapIndex 改 <title> 为「CCPG AI 工作台」+ 注入品牌 CSS（藏原字标、logoRow 换 CCPG logo+文案）
//   2) exact /ccpg/logo.png  服务插件 assets 里的 logo（CSS background-image 引用）
//   3) exact /favicon.svg    用 logo 生成的 favicon 接管浏览器标签图标（exact 优先于 SPA fallback）
// 主题色不动官方默认；暗色主题下给 logo 加轻微亮度补偿（原图文字是中灰，暗底略暗）。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');

export const name = 'dsh-ccpg-brand';
export const inject = ['webServer'];

export const Config = z.object({
  /** 页面 title（浏览器标签） */
  title: z.string().default('CCPG AI 工作台'),
  /** 聊天对话区 hero 标题文案 */
  heroHeadline: z.string().default('CCPG AI 工作台'),
});

const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveFile(res, file) {
  res.writeHead(200, { 'Content-Type': MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

// favicon：logo.png 内嵌成 data URI 的 SVG（保留透明底；浏览器把它当任意尺寸图标）
function faviconSvg() {
  const b64 = readFileSync(join(ASSETS, 'logo.png')).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 30"><image href="data:image/png;base64,${b64}" width="110" height="30"/></svg>`;
}

// 品牌 CSS：类名锚点用 [class*="本地名"]——css-module 哈希前缀（如 hHd-Xa_/pXSMma_）随 dsh 构建变，
// 本地名 brand/logoRow/headlineText 稳定（与 dsh-ccpg-web footerActions 注入同一套约定）。
const BRAND_CSS = `
/* ---- 侧边栏品牌行：只放 CCPG logo（logo 本身含品牌字样） ---- */
[class*="logoRow"] [class*="brand"] svg { display: none; }
[class*="logoRow"] [class*="brand"]::before {
  content: "";
  flex: none;
  width: 110px; height: 30px;
  background: url(/ccpg/logo.png) center/contain no-repeat;
}
/* 暗色主题下灰字 logo 略提亮 */
body[data-ds-dark-theme] [class*="logoRow"] [class*="brand"]::before {
  filter: brightness(1.25);
}

/* ---- 聊天对话区 hero 标题：「探索未至之境」→「CCPG AI 工作台」 ----
   headlineText 是 HeroShell 的 span（继承 headline 26px/500），
   用 font-size:0 藏原文、::after 按原字号放新文案。
   鱼形图标（fish svg）换成 CCPG logo；「预览版」徽章隐藏。 */
[class*="headlineText"] { font-size: 0; }
[class*="headlineText"]::after {
  content: "%HERO%";
  font-size: 26px;
}
/* 鱼形图标换成 CCPG logo 图标。注意:pXSMma_fish 类挂在鲸鱼 svg 本体上(不是外包 span)，
   所以背景必须挂外层 fishHitbox 容器、svg 整体 display:none——
   若把 background 画在 svg 上，鲸鱼图形会叠在 logo 上。
   用 icon.svg(logo 左侧裁出的 26×26 彩色图标)而非整张 logo：
   整张 110×30 在 34px 格里只显示成 34×9，太小；图标占满格子。 */
[class*="fishHitbox"] {
  width: 34px; height: 34px;
  background: url(/ccpg/icon.svg) center/contain no-repeat;
}
[class*="fishHitbox"] > svg { display: none; }
[class*="previewBadge"] { display: none; }
`;

export function apply(ctx, config) {
  const css = BRAND_CSS.replaceAll('%HERO%', config.heroHeadline);

  // 1) index.html 变换：title + favicon + 品牌 CSS
  ctx.webServer.tapIndex((html) => html
    .replace(/<title>[^<]*<\/title>/, `<title>${config.title}</title>`)
    .replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    .replace('</head>', `<style id="ccpg-brand">${css}</style></head>`));

  // 2) 静态资源（/ccpg/ 前缀独立，不与官方 SPA 路径冲突）：
  //    logo.png 整图（侧边栏用）；icon.svg = 裁出的 26×26 彩色图标（hero 用，占满方格）
  ctx.webServer.register({
    kind: 'exact',
    path: '/ccpg/logo.png',
    handler(_req, res) { serveFile(res, join(ASSETS, 'logo.png')); },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/ccpg/icon.svg',
    handler(_req, res) { serveFile(res, join(ASSETS, 'icon.svg')); },
  });

  // 3) favicon 接管（官方 dist 的 /favicon.svg 走 SPA fallback；exact 路由优先命中）
  ctx.webServer.register({
    kind: 'exact',
    path: '/favicon.svg',
    handler(_req, res) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(faviconSvg()); },
  });
}
