#!/bin/sh
# 本地分发依赖引导：把 dsh 主安装内层的 @deepseek-ai SDK 包软链进 profile node_modules，
# 供 dsh-ccpg-* 插件解析。npm 安装 dsh 时这些 SDK 包是 dsh 的 bundled deps（在 dsh 包自己的
# node_modules 里），插件的解析路径够不到，registry 上版本又滞后，故本地分发用软链引导。
# 用法：sh bootstrap-deps.sh <profile目录>
set -e
PROFILE_DIR="$1"
[ -z "$PROFILE_DIR" ] && { echo "用法: $0 <profile目录>   例: sh bootstrap-deps.sh ~/.dsh/profiles/dsh-ccpg-test"; exit 1; }

DSH_BIN=$(node -e "console.log(require.resolve('@deepseek-ai/dsh/lib/bin.js'))" 2>/dev/null || true)
[ -z "$DSH_BIN" ] && for c in "$HOME/.local/npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
  [ -f "$c" ] && DSH_BIN="$c" && break
done
[ -z "$DSH_BIN" ] && { echo "找不到 dsh 安装（先 npm i -g @deepseek-ai/dsh）"; exit 1; }

# <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js → dsh 包目录
DSH_PKG=$(node -e "console.log(require('path').dirname(require('path').dirname(process.argv[1])))" "$DSH_BIN")
SDK_DIR="$DSH_PKG/node_modules/@deepseek-ai"
[ -d "$SDK_DIR/dsh-tools" ] || { echo "SDK 目录异常: $SDK_DIR"; exit 1; }
echo "dsh SDK: $SDK_DIR"

mkdir -p "$PROFILE_DIR/node_modules/@deepseek-ai"
for pkg in schemastery cordis dsh-tools dsh-llm dsh-session; do
  [ -d "$SDK_DIR/$pkg" ] || continue
  TARGET="$PROFILE_DIR/node_modules/@deepseek-ai/$pkg"
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then rm -rf "$TARGET"; fi
  ln -s "$SDK_DIR/$pkg" "$TARGET"
  echo "linked @deepseek-ai/$pkg"
done
echo "✓ 依赖引导完成 → $PROFILE_DIR"
