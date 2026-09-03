#!/bin/sh
# 打包 Workflow One 插件为可分发 tarball（release 用，CI 与本地同源）。
#
# 产物：dsh-harness-one-plugins-<tag>.tar.gz，内容 = 单包 dsh-harness-one（7 合 1）
#      + 独立可选 brand 插件 + setup/start/build/assemble/bootstrap 脚本，
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
#   DSH_NODE   构建与打包用的 node（默认自动探测，要求 >=22.15.0；兼容旧名 WF1_NODE）
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
TAG="${1:-$(git -C "$REPO_ROOT" describe --tags --abbrev=0 2>/dev/null || echo 0.0.0)}"
TAG="${TAG#v}"
OUT="${PACK_DIR:-/tmp/dsh-ccpg-pack}"
DIST_DIR="$REPO_ROOT/dist-release"
PKG="dsh-harness-one-plugins-$TAG"
TAR="$DIST_DIR/$PKG.tar.gz"
PLUGINS="dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-llm-guard"
OPTIONAL_PLUGINS="dsh-ccpg-brand"
# 单包（assemble-one.sh 装配产物，7 插件合一）；brand 独立可选
AGG="dsh-harness-one"

# ---- 0. node（>=22.15.0，内置 node:sqlite）----
NODE_BIN="${DSH_NODE:-${WF1_NODE:-}}"
[ -z "$NODE_BIN" ] && NODE_BIN=$(node -e "const [a,b]=process.versions.node.split('.').map(Number); console.log(a>22||(a===22&&b>=15)?process.execPath:'')" 2>/dev/null || true)
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=15)?0:1)" 2>/dev/null; then
  echo "✗ 需要 node>=22.15.0（或设 DSH_NODE 指向）"
  exit 1
fi
echo "✓ node: $("$NODE_BIN" -v)"
PATH=$(dirname "$NODE_BIN"):$PATH
export PATH
# release 与 npm 聚合包使用同一精确 sidebar 版本，避免两个渠道漂移。
SIDEBAR_VER=$("$NODE_BIN" -e "console.log(require(process.argv[1]).dependencies['dsh-better-sidebar'] || '')" "$HERE/dsh-ccpg-one/package.json")
[ -n "$SIDEBAR_VER" ] || { echo "✗ dsh-ccpg-one 未声明 dsh-better-sidebar 精确依赖"; exit 1; }

# ---- 0.1 插件清单 ----
for p in $PLUGINS $OPTIONAL_PLUGINS; do
  [ -f "$HERE/$p/package.json" ] || { echo "✗ 插件缺失: $p/package.json"; exit 1; }
  "$NODE_BIN" -e "const p=require(process.argv[1]); if(p.name!==process.argv[2]) throw new Error('package name 应为 '+process.argv[2])" \
    "$HERE/$p/package.json" "$p"
done
echo "✓ 七个默认插件 + 独立可选 brand 清单已校验"

# ---- 1. 构建画布（生成 dsh-ccpg-web/web-dist）----
sh "$HERE/build-web.sh"
echo "✓ 画布已构建"

# ---- 1.2 单包装配（干净 checkout 无产物目录，此处现装）----
sh "$HERE/assemble-one.sh"
echo "✓ 单包已装配（7 插件合一）"

# ---- 2. orchestrator 真依赖（ajv/cron-parser/QuickJS WASM）----
cd "$HERE/dsh-ccpg-orchestrator"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
# npm ci/install 重建 node_modules，会抹掉 setup.sh 第 3 步建的 SDK 软链
# （bootstrap 的 @deepseek-ai/* 指向 dsh 主安装）——此处按同款逻辑补链，
# 否则 pack 过后本机 npm test 全挂（plugin-storage.integration 等解析不到 SDK）。
SDK_DIR=""
DSH_PROBE=$(node -e "console.log(require.resolve('@deepseek-ai/dsh/lib/bin.js'))" 2>/dev/null || true)
[ -z "$DSH_PROBE" ] && DSH_PROBE=$(command -v dsh 2>/dev/null || true)
[ -z "$DSH_PROBE" ] && for c in "$HOME/.local/npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
  [ -f "$c" ] && DSH_PROBE="$c" && break
done
[ -n "$DSH_PROBE" ] && DSH_PROBE=$(node -e "console.log(require('fs').realpathSync(process.argv[1]))" "$DSH_PROBE")
[ -n "$DSH_PROBE" ] && SDK_DIR=$(node -e "console.log(require('path').dirname(require('path').dirname(process.argv[1])))" "$DSH_PROBE")/node_modules/@deepseek-ai
if [ -n "$SDK_DIR" ] && [ -d "$SDK_DIR/dsh-tools" ]; then
  mkdir -p node_modules/@deepseek-ai
  for dep in schemastery cordis dsh-tools dsh-llm dsh-session dsh-agent; do
    T="node_modules/@deepseek-ai/$dep"
    [ -d "$SDK_DIR/$dep" ] || continue
    [ -L "$T" ] || ln -s "$SDK_DIR/$dep" "$T"
  done
fi
echo "✓ orchestrator 依赖已装"

# ---- 2.5 canvasui bundle 重建（必须在 rsync 组装之前）----
# lib/client.js 由 src/client.js 生成：先重建源码目录再组装，
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
  --exclude 'data/runs' \
  --exclude 'data/run-artifacts' \
  --exclude 'data/workspaces' \
  --exclude 'data/attachments' \
  --exclude 'data/credentials.json' \
  --exclude 'data/triggers.json' \
  --exclude 'data/global-variables.json' \
  "$HERE/" "$OUT/dsh-plugins/"
# web-dist 单独拷（构建产物，rsync 排除了但需要带）
rsync -a "$HERE/dsh-ccpg-web/web-dist/" "$OUT/dsh-plugins/dsh-ccpg-web/web-dist/"

# 单包运行时依赖实体化：装配目录不带 node_modules（防打包机绝对路径软链断链），
# 归档现场把 orchestrator 依赖树拷成实体——离线装机 setup.sh --one 直接软链可用。
ONE_NM="$OUT/dsh-plugins/dsh-harness-one/node_modules"
rm -rf "$ONE_NM"; mkdir -p "$ONE_NM"
for dep in ajv cron-parser quickjs-emscripten fast-deep-equal fast-uri json-schema-traverse require-from-string luxon @jitl; do
  cp -R "$HERE/dsh-ccpg-orchestrator/node_modules/$dep" "$ONE_NM/$dep"
done

# 清理插件包内运行时数据与残余
for p in $PLUGINS $OPTIONAL_PLUGINS dsh-harness-one; do
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

# 校验：web-dist、默认/独立插件目录、bundle patch 与 document-preview 构建入口必须完整。
[ -f "$OUT/dsh-plugins/dsh-ccpg-web/web-dist/index.html" ] || { echo "✗ web-dist/index.html 缺失（构建失败？）"; exit 1; }
for p in $PLUGINS $OPTIONAL_PLUGINS $AGG; do
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
import { DatabaseSync } from 'node:sqlite';
const root = process.argv[2];
const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE smoke (value INTEGER) STRICT; INSERT INTO smoke VALUES (1)');
if (database.prepare('SELECT value FROM smoke').get().value !== 1) throw new Error('node:sqlite smoke 输出错误');
database.close();
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

# ---- 3.5 vendor better-sidebar（与聚合包同版，源码仓库不进二进制）----
# 从 npm 拉精确版本 tgz 放进归档 vendor/；setup.sh 优先装它，
# 安装机断网/包下架也不缺件（依赖树仍走在线装）。
mkdir -p "$OUT/dsh-plugins/vendor"
( cd "$OUT/dsh-plugins/vendor" && npm pack "dsh-better-sidebar@$SIDEBAR_VER" --silent >/dev/null ) \
  || { echo "✗ npm pack dsh-better-sidebar@$SIDEBAR_VER 失败（网络？）"; exit 1; }
[ -f "$OUT/dsh-plugins/vendor/dsh-better-sidebar-$SIDEBAR_VER.tgz" ] \
  || { echo "✗ vendor tgz 缺失: dsh-better-sidebar-$SIDEBAR_VER.tgz"; exit 1; }
echo "✓ 已 vendor dsh-better-sidebar@$SIDEBAR_VER ($(du -h "$OUT/dsh-plugins/vendor/dsh-better-sidebar-$SIDEBAR_VER.tgz" | cut -f1))"

# ---- 4. 打包 ----
cd "$OUT"
tar -czf "$TAR" dsh-plugins
for p in $PLUGINS $OPTIONAL_PLUGINS $AGG; do
  tar -tzf "$TAR" "dsh-plugins/$p/package.json" >/dev/null 2>&1 \
    || { echo "✗ tarball 缺失: $p/package.json"; exit 1; }
done
tar -tzf "$TAR" "dsh-plugins/vendor/dsh-better-sidebar-$SIDEBAR_VER.tgz" >/dev/null 2>&1 \
  || { echo "✗ tarball 缺失: vendor/dsh-better-sidebar-$SIDEBAR_VER.tgz"; exit 1; }
if tar -tzf "$TAR" | grep -q '/node_modules/@deepseek-ai/'; then
  echo "✗ tarball 含不可分发的 @deepseek-ai SDK 软链"
  exit 1
fi
echo "✓ 打包完成: $TAR ($(du -h "$TAR" | cut -f1))"
echo "内容:"
tar -tzf "$TAR" | grep -E "dsh-plugins/[^/]+/?$" | sort -u
