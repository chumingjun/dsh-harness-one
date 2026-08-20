#!/bin/sh
# 构建画布 dist（base=/wf1/）注入 API base 后拷入 dsh-ccpg-web/web-dist
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../web"
WF1_BASE=/wf1/ npm run build >/dev/null
rm -rf "$HERE/dsh-ccpg-web/web-dist"
cp -r dist "$HERE/dsh-ccpg-web/web-dist"
node -e "
const fs=require('fs');
const p='$HERE/dsh-ccpg-web/web-dist/index.html';
let h=fs.readFileSync(p,'utf8');
h=h.replace('<head>', '<head><script>window.__WF1_API_BASE__=\"/wf1\";</script>');
fs.writeFileSync(p,h);
"
# web/dist 留给 Express 入口（默认 base）——重新用默认 base 构建一份
npm run build >/dev/null
echo "✓ 双构建完成：web-dist（/wf1/ base）+ web/dist（根 base，Express 用）"
