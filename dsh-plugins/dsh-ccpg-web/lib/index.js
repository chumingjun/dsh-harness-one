// dsh-ccpg-web：物业编排画布的静态托管插件。
// 用 ctx.webServer 的 prefix 路由把 mvp-canvas/web/dist 挂到 /wf1/，
// SPA index 回退到 dist/index.html。

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const name = 'dsh-ccpg-web';
export const inject = ['webServer'];

export const Config = z.object({
  /** 画布 dist 目录；默认取插件包 web-dist/（构建时拷入） */
  distDir: z.string().default(join(__dirname, '..', 'web-dist')),
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function apply(ctx, config) {
  const dist = config.distDir;
  if (!existsSync(join(dist, 'index.html'))) {
    ctx.logger?.warn?.('dsh-ccpg-web: dist 里没有 index.html（先构建画布并拷入 web-dist/）');
  }

  // 官方 UI 依赖 crypto.randomUUID，浏览器只在 secure context（https/localhost）暴露；
  // 经 plain HTTP 局域网/Tailscale IP 访问时补 polyfill，否则「加载提供方目录失败」。
  ctx.webServer.tapIndex?.((html) => html.replace(
    '<head>',
    `<head><script>if(!crypto.randomUUID){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=[...b].map(function(x){return x.toString(16).padStart(2,'0')});return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10,16).join('');};}</script>`,
  ));

  ctx.webServer.register({
    kind: 'prefix',
    path: '/wf1',
    async handler(req, res) {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let rel = urlPath.replace(/^\/wf1\/?/, '');
      if (!rel || rel === 'index.html') rel = 'index.html';
      const file = join(dist, rel);
      // 防逃逸 + 存在性：不存在一律回退 SPA index
      if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(readFileSync(file));
        return;
      }
      // /wf1/api/* 不该落到这里（exact 路由已接管）；其余路径回退 SPA
      if (urlPath.startsWith('/wf1/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const index = join(dist, 'index.html');
      if (existsSync(index)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(readFileSync(index));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('dsh-ccpg-web: dist 未构建');
      }
    },
  });
}
