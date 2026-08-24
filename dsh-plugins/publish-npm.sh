#!/bin/sh
# 发布自包含 npm 插件：实现包先发，聚合包最后发。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
MODE="${1:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
[ -z "$MODE" ] || [ "$MODE" = "--dry-run" ] || { echo "用法: sh publish-npm.sh [--dry-run]"; exit 1; }

sh "$HERE/build-web.sh"
node "$HERE/../scripts/verify-plugin-packages.mjs"

for pkg in \
  dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui \
  dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-llm-guard dsh-ccpg-brand \
  dsh-ccpg-one
do
  echo "→ npm publish $pkg ${MODE}"
  (cd "$HERE/$pkg" && npm publish --registry "$NPM_REGISTRY" --access public $MODE)
done
