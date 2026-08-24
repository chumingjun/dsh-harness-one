#!/bin/sh
# 发布 dsh-ccpg-one + 七个子插件共 8 个包到 npm。
# 子插件必须是 registry 公共包：loader 与 client-modules 都从 profile 根按包名解析 entry，
# bundleDependencies 嵌套布局两处都解析不到（loader ERR_MODULE_NOT_FOUND / client 静默不注册）。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
MODE="${1:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PACK_DIR="${NPM_PACK_DIR:-$REPO_ROOT/dist-release}"
PACKAGES="dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-llm-guard"
[ -z "$MODE" ] || [ "$MODE" = "--dry-run" ] || { echo "用法: sh publish-npm.sh [--dry-run]"; exit 1; }

VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$HERE/dsh-ccpg-one/package.json")
[ -z "${GITHUB_REF_NAME:-}" ] || [ "$GITHUB_REF_NAME" = "v$VERSION" ] \
  || { echo "✗ tag $GITHUB_REF_NAME 与聚合包版本 v$VERSION 不一致"; exit 1; }

# 聚合包声明的子插件依赖版本必须与子插件实际版本一致（npm 安装按声明解析）。
version_of() { node -e "console.log(require(process.argv[1]).version)" "$HERE/$1/package.json"; }
for pkg in $PACKAGES; do
  DECLARED=$(node -e "console.log(require(process.argv[1]).dependencies['$pkg'] || '')" "$HERE/dsh-ccpg-one/package.json")
  ACTUAL=$(version_of "$pkg")
  [ "$DECLARED" = "$ACTUAL" ] || { echo "✗ $pkg 依赖声明 $DECLARED 与实际版本 $ACTUAL 不一致"; exit 1; }
done

if [ "${SKIP_BUILD:-}" != "1" ]; then
  sh "$HERE/build-web.sh"
  node "$REPO_ROOT/scripts/verify-plugin-packages.mjs"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$PACK_DIR"

# 逐包 npm pack（files 字段裁剪内容；构建产物已在 build 步生成）
for pkg in $PACKAGES dsh-ccpg-one; do
  (cd "$HERE/$pkg" && npm pack --silent --ignore-scripts --pack-destination "$PACK_DIR" >/dev/null)
done
TARBALL="$PACK_DIR/dsh-ccpg-one-$VERSION.tgz"
for pkg in $PACKAGES; do
  tar -tzf "$TARBALL" package/cordis.patch.yml >/dev/null
  PV=$(version_of "$pkg")
  [ -f "$PACK_DIR/$pkg-$PV.tgz" ] || { echo "✗ 缺 $pkg-$PV.tgz"; exit 1; }
done
tar -tzf "$PACK_DIR/dsh-ccpg-web-$VERSION.tgz" package/web-dist/index.html >/dev/null
tar -tzf "$PACK_DIR/dsh-ccpg-canvasui-$VERSION.tgz" package/lib/client.js >/dev/null
echo "✓ 8 个 npm 包已打包至 $PACK_DIR"

# 安装冒烟：本地 registry 模拟（file: tgz 直装聚合包——npm 会连同 7 个 registry 依赖从
# NPM_REGISTRY 解析；dry-run 阶段子插件尚未发布，逐包 file: 预装后再装聚合包对齐 registry 语义）。
mkdir -p "$TMP/install-smoke"
for pkg in $PACKAGES; do
  PV=$(version_of "$pkg")
  npm install --prefix "$TMP/install-smoke" "$PACK_DIR/$pkg-$PV.tgz" \
    --ignore-scripts --no-audit --no-fund --legacy-peer-deps --registry "$NPM_REGISTRY" >/dev/null
done
npm install --prefix "$TMP/install-smoke" "$TARBALL" \
  --ignore-scripts --no-audit --no-fund --legacy-peer-deps --registry "$NPM_REGISTRY" >/dev/null
for pkg in $PACKAGES dsh-better-sidebar; do
  [ -f "$TMP/install-smoke/node_modules/$pkg/package.json" ] \
    || { echo "✗ npm 安装后缺少顶层依赖: $pkg"; exit 1; }
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

for pkg in $PACKAGES; do
  publish_one "$pkg" "$(version_of "$pkg")"
done
publish_one dsh-ccpg-one "$VERSION"
