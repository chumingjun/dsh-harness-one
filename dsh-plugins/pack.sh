#!/bin/sh
# 打包 dsh-ccpg-* 插件为可分发 tarball（release 用，CI 与本地同源）。
#
# 产物：dsh-ccpg-plugins-<tag>.tar.gz，内容 = dsh-plugins/ 里八个插件 + setup/start/build/bootstrap 脚本，
# 且满足"拿到即装"（产物不入库，本脚本现场构建）：
#   - 画布已构建：dsh-ccpg-web/web-dist/ 由第 1 步 build-web.sh 现场生成，装包机无需再跑构建
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
PLUGINS="dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-brand dsh-ccpg-llm-guard"
# 聚合壳（bundle patch 挂载八插件 + better-sidebar，可选件 env 门控）；其 node_modules 是本地安装产物，不打包
AGG="dsh-ccpg-one"

# ---- 0. node（>=20）----
NODE_BIN="${WF1_NODE:-}"
[ -z "$NODE_BIN" ] && NODE_BIN=$(node -e "console.log(Number(process.versions.node.split('.')[0])>=20?process.execPath:'')" 2>/dev/null || true)
[ -z "$NODE_BIN" ] && { echo "✗ 需要 node>=20（或设 WF1_NODE 指向）"; exit 1; }
echo "✓ node: $("$NODE_BIN" -v)"
PATH=$(dirname "$NODE_BIN"):$PATH
export PATH

# ---- 0.1 插件清单 ----
for p in $PLUGINS; do
  [ -f "$HERE/$p/package.json" ] || { echo "✗ 插件缺失: $p/package.json"; exit 1; }
  "$NODE_BIN" -e "const p=require(process.argv[1]); if(p.name!==process.argv[2]) throw new Error('package name 应为 '+process.argv[2])" \
    "$HERE/$p/package.json" "$p"
done
echo "✓ 八个插件清单已校验"

# ---- 1. 构建画布（生成 dsh-ccpg-web/web-dist）----
sh "$HERE/build-web.sh"
echo "✓ 画布已构建"

# ---- 2. orchestrator 真依赖（ajv/cron-parser/QuickJS WASM）----
cd "$HERE/dsh-ccpg-orchestrator"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
echo "✓ orchestrator 依赖已装"

# ---- 2.5 canvasui bundle 重建（必须在 rsync 组装之前）----
# lib/client.js 是拼接产物（src/client.js @include shared/ 片段）：先重建源码目录再组装，
# rsync 才会把新产物带进归档——放组装之后就只校验了源码目录，归档仍是旧文件。
sh "$HERE/build-canvasui.sh"
sh "$HERE/build-canvasui.sh" --check
echo "✓ canvasui bundle 已重建并校验"

# ---- 3. 组装（rsync 到临时目录）----
rm -rf "$OUT" "$DIST_DIR"
mkdir -p "$OUT" "$DIST_DIR"
cd "$REPO_ROOT"

rsync -a --delete \
  --exclude 'node_modules/@deepseek-ai' \
  --exclude 'dsh-ccpg-one/node_modules' \
  --exclude 'dsh-ccpg-one/pnpm-lock.yaml' \
  --exclude 'web-dist' \
  "$HERE/" "$OUT/dsh-plugins/"
# web-dist 单独拷（构建产物，rsync 排除了但需要带）
rsync -a "$HERE/dsh-ccpg-web/web-dist/" "$OUT/dsh-plugins/dsh-ccpg-web/web-dist/"

# 清理插件包内运行时数据与残余
for p in $PLUGINS; do
  rm -rf "$OUT/dsh-plugins/$p/data/runs" \
         "$OUT/dsh-plugins/$p/data/run-artifacts" \
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

# 校验：web-dist、八插件目录、bundle patch 与 document-preview 构建入口必须完整。
[ -f "$OUT/dsh-plugins/dsh-ccpg-web/web-dist/index.html" ] || { echo "✗ web-dist/index.html 缺失（构建失败？）"; exit 1; }
for p in $PLUGINS $AGG; do
  [ -f "$OUT/dsh-plugins/$p/package.json" ] || { echo "✗ 打包目录缺失: $p/package.json"; exit 1; }
  # dsh.bundle.patch 声明与 patch 文件必须在场：setup.sh 的挂载全靠它
  "$NODE_BIN" -e "const p=require(process.argv[1]+'/package.json'); if(!p.dsh?.bundle?.patch) throw new Error('缺 dsh.bundle.patch 声明')" \
    "$OUT/dsh-plugins/$p" || { echo "✗ $p 缺 dsh.bundle.patch 声明"; exit 1; }
  [ -f "$OUT/dsh-plugins/$p/cordis.patch.yml" ] || { echo "✗ $p/cordis.patch.yml 缺失"; exit 1; }
done
"$NODE_BIN" - "$OUT/dsh-plugins/dsh-ccpg-document-preview/package.json" <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const root = path.dirname(file);
const entries = new Set();
const add = (value) => {
  if (typeof value === 'string' && value.startsWith('./')) entries.add(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(add);
};
add(pkg.main);
add(pkg.exports);
for (const entry of entries) {
  if (entry !== './package.json' && !fs.existsSync(path.resolve(root, entry))) {
    throw new Error(`归档构建入口缺失: ${entry}`);
  }
}
if (!entries.size) throw new Error('document-preview 未声明 main/exports 构建入口');
NODE

# QuickJS 分发 smoke：必须从临时归档目录加载 WASM 并完成最小脚本执行。
"$NODE_BIN" --input-type=module - "$OUT/dsh-plugins/dsh-ccpg-orchestrator" <<'NODE'
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = process.argv[2];
const { runScript } = await import(pathToFileURL(join(root, 'lib', 'script-runner.js')));
const workspaceDir = mkdtempSync(join(tmpdir(), 'wf1-pack-script-'));
try {
  const result = await runScript({
    workspaceDir,
    input: { value: 41 },
    code: 'function main(input) { return { value: input.value + 1 }; }',
  });
  if (result.value?.value !== 42) throw new Error('QuickJS smoke 输出错误');
} finally {
  rmSync(workspaceDir, { recursive: true, force: true });
}
NODE
echo "✓ QuickJS WASM 归档 smoke 通过"

# 说明：dsh-better-sidebar（侧边栏工作台宿主）不打进 tarball —— 它是 registry npm 包，
# setup.sh 安装时从 npm 拉取（canvasui 软依赖它，失败仅损失「对话记录」tab）。

# ---- 4. 打包 ----
cd "$OUT"
tar -czf "$TAR" dsh-plugins
for p in $PLUGINS $AGG; do
  tar -tzf "$TAR" "dsh-plugins/$p/package.json" >/dev/null 2>&1 \
    || { echo "✗ tarball 缺失: $p/package.json"; exit 1; }
done
if tar -tzf "$TAR" | grep -q '/node_modules/@deepseek-ai/'; then
  echo "✗ tarball 含不可分发的 @deepseek-ai SDK 软链"
  exit 1
fi
echo "✓ 打包完成: $TAR ($(du -h "$TAR" | cut -f1))"
echo "内容:"
tar -tzf "$TAR" | grep -E "dsh-plugins/[^/]+/?$" | sort -u
