#!/bin/sh
# 启动  profile（参数：profile 名，默认 ）
PROFILE="${1:-}"
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# 定位能跑 Workflow One 的 node（>=24.15，内置 node:sqlite）与 dsh bin
NODE_BIN="${DSH_NODE:-}"
[ -z "$NODE_BIN" ] && NODE_BIN=$(node -e "const [a,b]=process.versions.node.split('.').map(Number); console.log(a>24||(a===24&&b>=15)?process.execPath:'')" 2>/dev/null || true)
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>24||(a===24&&b>=15)?0:1)" 2>/dev/null; then
  echo "✗ 需要 node>=24.15（或设 DSH_NODE 指向）"
  exit 1
fi

DSH_BIN=$("$NODE_BIN" -e "console.log(require.resolve('@deepseek-ai/dsh/lib/bin.js'))" 2>/dev/null || true)
[ -z "$DSH_BIN" ] && DSH_BIN=$(command -v dsh 2>/dev/null || true)
[ -z "$DSH_BIN" ] && DSH_BIN="$HOME/.local/npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_BIN" ] || { echo "✗ 未找到 dsh"; exit 1; }
DSH_BIN=$("$NODE_BIN" -e "console.log(require('fs').realpathSync(process.argv[1]))" "$DSH_BIN")

exec "$NODE_BIN" --expose-internals "$DSH_BIN" --profile "$PROFILE"
