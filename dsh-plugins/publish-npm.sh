#!/bin/sh
# 发布 npm 包（v0.5.0 起单包模式）：
#   dsh-harness-one —— 单包含全部 7 个插件（assemble-one.sh 装配）
#   dsh-ccpg-brand  —— 独立可选插件（保留）
# 老 8 包（dsh-ccpg-one + 7 子包）已停更：deprecate 指向 dsh-harness-one。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
MODE="${1:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PACK_DIR="${NPM_PACK_DIR:-$REPO_ROOT/dist-release}"
LEGACY="dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-llm-guard dsh-ccpg-one"
[ -z "$MODE" ] || [ "$MODE" = "--dry-run" ] || { echo "用法: sh publish-npm.sh [--dry-run]"; exit 1; }

VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$HERE/dsh-ccpg-one/package.json")
[ -z "${GITHUB_REF_NAME:-}" ] || [ "$GITHUB_REF_NAME" = "v$VERSION" ] \
  || { echo "✗ tag $GITHUB_REF_NAME 与版本 v$VERSION 不一致"; exit 1; }

if [ "${SKIP_BUILD:-}" != "1" ]; then
  sh "$HERE/build-web.sh"
  sh "$HERE/assemble-one.sh"
  node "$REPO_ROOT/scripts/verify-plugin-packages.mjs"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$PACK_DIR"

# npm pack：单包（装配目录，files 字段裁剪）+ brand
(cd "$HERE/dsh-harness-one" && npm pack --silent --ignore-scripts --pack-destination "$PACK_DIR" >/dev/null)
(cd "$HERE/dsh-ccpg-brand" && npm pack --silent --ignore-scripts --pack-destination "$PACK_DIR" >/dev/null)
TARBALL="$PACK_DIR/dsh-harness-one-$VERSION.tgz"
[ -f "$TARBALL" ] || { echo "✗ 缺 $TARBALL"; exit 1; }

# 归档完整性：入口/合并 client/画布/preview 资产/运行时依赖实体
for f in package/lib/index.js package/lib/client.js \
         package/dsh-ccpg-web/web-dist/index.html \
         package/dsh-ccpg-canvasui/lib/client.js \
         package/dsh-ccpg-document-preview/dist/client.js; do
  tar -tzf "$TARBALL" "$f" >/dev/null 2>&1 || { echo "✗ tarball 缺失: $f"; exit 1; }
done
echo "✓ 单包 tarball 完整性通过（dsh-harness-one-$VERSION）"

# 安装冒烟：file: tgz 装进干净目录，校验关键文件落位、无 SDK 泄漏
mkdir -p "$TMP/install-smoke"
npm install --prefix "$TMP/install-smoke" "$TARBALL" \
  --ignore-scripts --no-audit --no-fund --legacy-peer-deps --registry "$NPM_REGISTRY" >/dev/null
for f in node_modules/dsh-harness-one/lib/index.js \
         node_modules/dsh-harness-one/lib/client.js \
         node_modules/dsh-better-sidebar/package.json \
         node_modules/ajv/package.json; do
  [ -f "$TMP/install-smoke/$f" ] || { echo "✗ 安装后缺少: $f"; exit 1; }
done
ls "$TMP/install-smoke/node_modules/@deepseek-ai/dsh-host-webserver" >/dev/null 2>&1 \
  && { echo "✗ 安装引入了 @deepseek-ai SDK 拷贝（peer 泄漏，会遮蔽 dsh 全局版本）"; exit 1; }
echo "✓ 全新安装 smoke 通过（无 SDK 泄漏）"

publish_one() {
  npm view "$1@$2" version --registry "$NPM_REGISTRY" >/dev/null 2>&1 && {
    echo "✓ $1@$2 已发布，跳过"
    return 0
  }
  if [ "$MODE" != "--dry-run" ] && [ -z "${NODE_AUTH_TOKEN:-}" ]; then
    echo "✗ 缺少 NODE_AUTH_TOKEN（GitHub Actions 中配置 NPM_TOKEN secret）"
    exit 1
  fi
  npm publish "$PACK_DIR/$1-$2.tgz" --registry "$NPM_REGISTRY" --access public $MODE
}

publish_one dsh-harness-one "$VERSION"
publish_one dsh-ccpg-brand "$(node -e "console.log(require(process.argv[1]).version)" "$HERE/dsh-ccpg-brand/package.json")"

# 老 8 包 deprecate（幂等；本地 dry-run 跳过——没有 token 也不该碰线上元数据）
if [ "$MODE" != "--dry-run" ]; then
  for pkg in $LEGACY; do
    npm deprecate "$pkg@*" "Renamed to dsh-harness-one — run the in-app one-click upgrade (设置 → Workflow One → 检查更新) to migrate, or: dsh plugin --profile <name> add dsh-harness-one" \
      --registry "$NPM_REGISTRY" >/dev/null 2>&1 \
      && echo "✓ deprecated $pkg" \
      || echo "⚠ deprecate $pkg 失败（可手动执行）"
  done
fi
