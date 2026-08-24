// Host 半：dsh 插件入口。注册 client-assets 静态路由——上游 dsh-client-modules
// 只服务 /plugins/<id>/client.js 精确路径，本插件 runtime 的懒加载 chunk 与样式
// 由这条 prefix 路由自托管（与 Desktop/普通 profile 行为一致）。
// 纯函数工具库在 ./index.js（浏览器 bundle 也从那里 import，勿在此加 node 内置依赖）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-ccpg-document-preview';
// 可选注入：宿主没有 webServer（纯库复用/测试）时插件仍可加载，路由跳过。
export const inject = ['webServer'];

const ASSET_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const ASSET_ROUTE = '/plugins/dsh-ccpg-document-preview/client-assets';

export function apply(ctx) {
  if (!ctx.webServer?.register) return;
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client-assets');
  ctx.webServer.register({
    kind: 'prefix',
    path: ASSET_ROUTE,
    async handler(req, res) {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(ASSET_ROUTE.length).replace(/^[./]+/, '');
      const file = join(assetsDir, rel);
      if (file.startsWith(assetsDir + sep) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, {
          'Content-Type': ASSET_MIME[extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(readFileSync(file));
        return;
      }
      res.writeHead(404);
      res.end();
    },
  });
  ctx.logger?.info?.('dsh-ccpg-document-preview: client-assets 静态路由已注册');
}
