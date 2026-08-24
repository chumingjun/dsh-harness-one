#!/bin/sh
# 启动  profile（参数：profile 名，默认 ）
PROFILE="${1:-}"
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# 定位能跑 dsh 的 node（>=20）与 dsh bin
NODE_BIN="${DSH_NODE:-}"
[ -z "$NODE_BIN" ] && NODE_BIN=$(node -e "const v=process.versions.node.split('.')[0]; console.log(v>=20?process.execPath:'')" 2>/dev/null || true)
[ -z "$NODE_BIN" ] && { echo "✗ 需要 node>=20（或设 DSH_NODE 指向）"; exit 1; }

DSH_BIN=$("$NODE_BIN" -e "console.log(require.resolve('@deepseek-ai/dsh/lib/bin.js'))" 2>/dev/null || true)
[ -z "$DSH_BIN" ] && DSH_BIN=$(command -v dsh 2>/dev/null || true)
[ -z "$DSH_BIN" ] && DSH_BIN="$HOME/.local/npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_BIN" ] || { echo "✗ 未找到 dsh"; exit 1; }
DSH_BIN=$("$NODE_BIN" -e "console.log(require('fs').realpathSync(process.argv[1]))" "$DSH_BIN")

exec "$NODE_BIN" --expose-internals "$DSH_BIN" --profile "$PROFILE"
