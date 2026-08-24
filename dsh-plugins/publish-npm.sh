#!/bin/sh
# 只发布 dsh-ccpg-one；七个内部插件作为 bundleDependencies 装进同一个 npm 包。
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

if [ "${SKIP_BUILD:-}" != "1" ]; then
  sh "$HERE/build-web.sh"
  node "$REPO_ROOT/scripts/verify-plugin-packages.mjs"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
STAGE="$TMP/dsh-ccpg-one"
mkdir -p "$STAGE/node_modules" "$TMP/packages" "$PACK_DIR"
cp "$HERE/dsh-ccpg-one/package.json" "$HERE/dsh-ccpg-one/cordis.patch.yml" "$STAGE/"
cp -R "$HERE/dsh-ccpg-one/lib" "$STAGE/lib"
[ ! -f "$HERE/dsh-ccpg-one/LICENSE" ] || cp "$HERE/dsh-ccpg-one/LICENSE" "$STAGE/LICENSE"

for pkg in $PACKAGES; do
  (cd "$HERE/$pkg" && npm pack --silent --ignore-scripts --pack-destination "$TMP/packages" >/dev/null)
  mkdir -p "$STAGE/node_modules/$pkg"
  tar -xzf "$TMP/packages/$pkg-$VERSION.tgz" --strip-components=1 -C "$STAGE/node_modules/$pkg"
done

(cd "$STAGE" && npm pack --silent --ignore-scripts --pack-destination "$PACK_DIR" >/dev/null)
TARBALL="$PACK_DIR/dsh-ccpg-one-$VERSION.tgz"
for pkg in $PACKAGES; do
  tar -tzf "$TARBALL" "package/node_modules/$pkg/package.json" >/dev/null
done
tar -tzf "$TARBALL" package/node_modules/dsh-ccpg-web/web-dist/index.html >/dev/null
tar -tzf "$TARBALL" package/node_modules/dsh-ccpg-canvasui/lib/client.js >/dev/null
echo "✓ 聚合 npm 包已校验: $TARBALL ($(du -h "$TARBALL" | cut -f1))"

mkdir -p "$TMP/install-smoke"
npm install --prefix "$TMP/install-smoke" "$TARBALL" --ignore-scripts --no-audit --no-fund --registry "$NPM_REGISTRY" >/dev/null
for pkg in $PACKAGES; do
  [ -f "$TMP/install-smoke/node_modules/dsh-ccpg-one/node_modules/$pkg/package.json" ] \
    || [ -f "$TMP/install-smoke/node_modules/$pkg/package.json" ] \
    || { echo "✗ npm 安装后缺少 bundled dependency: $pkg"; exit 1; }
done
echo "✓ 聚合 npm 包全新安装 smoke 通过"

if npm view "dsh-ccpg-one@$VERSION" version --registry "$NPM_REGISTRY" >/dev/null 2>&1; then
  echo "✓ dsh-ccpg-one@$VERSION 已发布，跳过重复 publish"
  exit 0
fi
if [ "$MODE" != "--dry-run" ] && [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  echo "✗ 缺少 NODE_AUTH_TOKEN（GitHub Actions 中配置 NPM_TOKEN secret）"
  exit 1
fi
npm publish "$TARBALL" --registry "$NPM_REGISTRY" --access public $MODE
