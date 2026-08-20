#!/bin/sh
# 打包 dsh-ccpg-* 插件为可分发 tarball（release 用，CI 与本地同源）。
#
# 产物：dsh-ccpg-plugins-<tag>.tar.gz，内容 = dsh-plugins/ 里六个插件 + setup/start/build/bootstrap 脚本，
# 且满足"拿到即装"：
#   - 画布已构建：dsh-ccpg-web/web-dist/ 已生成（build-web.sh 产物），无需再跑构建
#   - orchestrator 真依赖已装：ajv/cron-parser 在 dsh-ccpg-orchestrator/node_modules/（本地 setup.sh 直接
#     dsh plugin add 源码目录，依赖必须随包）
#   - 不含 @deepseek-ai/* SDK 软链：它们是 dsh 主安装内层 bundled deps 的软链，换机器无效，装包后由
#     setup.sh 的 bootstrap-deps.sh 按本机 dsh 重链
#   - 不含运行时数据：credentials.json / runs / workspaces / attachments / triggers / 全局变量等
#
# 用法：
#   sh pack.sh [tag]     # tag 默认取最近 git tag（无则 0.0.0）
# 环境变量：
#   PACK_DIR   打包根目录（默认 /tmp/dsh-ccpg-pack），结束后可删
#   WF1_NODE   构建画布用的 node（默认自动探测，要求 >=20）
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
TAG="${1:-$(git -C "$REPO_ROOT" describe --tags --abbrev=0 2>/dev/null || echo 0.0.0)}"
TAG="${TAG#v}"
OUT="${PACK_DIR:-/tmp/dsh-ccpg-pack}"
DIST_DIR="$REPO_ROOT/dist-release"
PKG="dsh-ccpg-plugins-$TAG"
TAR="$DIST_DIR/$PKG.tar.gz"

# ---- 0. node（>=20）----
NODE_BIN="${WF1_NODE:-}"
[ -z "$NODE_BIN" ] && NODE_BIN=$(node -e "console.log(Number(process.versions.node.split('.')[0])>=20?process.execPath:'')" 2>/dev/null || true)
[ -z "$NODE_BIN" ] && [ -x /tmp/node-v22.20.0-darwin-arm64/bin/node ] && NODE_BIN=/tmp/node-v22.20.0-darwin-arm64/bin/node
[ -z "$NODE_BIN" ] && { echo "✗ 需要 node>=20（或设 WF1_NODE 指向）"; exit 1; }
echo "✓ node: $("$NODE_BIN" -v)"

# ---- 1. 构建画布（生成 dsh-ccpg-web/web-dist）----
sh "$HERE/build-web.sh"
echo "✓ 画布已构建"

# ---- 2. orchestrator 真依赖（ajv/cron-parser）----
cd "$HERE/dsh-ccpg-orchestrator"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
echo "✓ orchestrator 依赖已装"

# ---- 3. 组装（rsync 到临时目录）----
rm -rf "$OUT" "$DIST_DIR"
mkdir -p "$OUT" "$DIST_DIR"
cd "$REPO_ROOT"

rsync -a --delete \
  --exclude 'node_modules/@deepseek-ai' \
  --exclude 'web-dist' \
  "$HERE/" "$OUT/dsh-plugins/"
# web-dist 单独拷（构建产物，rsync 排除了但需要带）
rsync -a "$HERE/dsh-ccpg-web/web-dist/" "$OUT/dsh-plugins/dsh-ccpg-web/web-dist/"

# 清理插件包内运行时数据与残余
for p in dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-larkauth dsh-ccpg-brand; do
  rm -rf "$OUT/dsh-plugins/$p/data/runs" \
         "$OUT/dsh-plugins/$p/data/workspaces" \
         "$OUT/dsh-plugins/$p/data/attachments" \
         "$OUT/dsh-plugins/$p/data/credentials.json" \
         "$OUT/dsh-plugins/$p/data/triggers.json" \
         "$OUT/dsh-plugins/$p/data/global-variables.json" \
         "$OUT/dsh-plugins/$p/data/graph.json"
done
# 保留 data/workflows 种子示例、data/skills 技能、data 目录本身（mkdir 兜底）
mkdir -p "$OUT/dsh-plugins/dsh-ccpg-orchestrator/data/runs"
rmdir "$OUT/dsh-plugins/dsh-ccpg-orchestrator/data/runs" 2>/dev/null || true

# 校验：web-dist 必须有 index.html
[ -f "$OUT/dsh-plugins/dsh-ccpg-web/web-dist/index.html" ] || { echo "✗ web-dist/index.html 缺失（构建失败？）"; exit 1; }

# ---- 4. 打包 ----
cd "$OUT"
tar -czf "$TAR" dsh-plugins
echo "✓ 打包完成: $TAR ($(du -h "$TAR" | cut -f1))"
echo "内容:"
tar -tzf "$TAR" | grep -E "dsh-plugins/[^/]+/?$" | sort -u
