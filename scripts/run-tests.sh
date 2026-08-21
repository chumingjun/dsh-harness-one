#!/bin/sh
# 全量单测聚合入口（根 npm test / ECC pre-push / PR CI 共用）。
# 各套件均为零依赖 node:assert 脚本，直接 node 运行；任一失败即退出非零。
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)

fail=0
run_suite() { # run_suite <目录> <glob>
  dir=$1 glob=$2
  for t in "$HERE/$dir"/$glob; do
    [ -e "$t" ] || continue
    if out=$(node "$t" 2>&1); then
      echo "✓ ${t#"$HERE"/}"
    else
      echo "✗ ${t#"$HERE"/}"
      echo "$out" | tail -20
      fail=1
    fi
  done
}

run_suite web/src '*.test.mjs'
run_suite dsh-plugins/dsh-ccpg-orchestrator/test '*.test.mjs'
run_suite dsh-plugins/shared '*.test.mjs'

# document-preview 用 node --test runner
echo "→ dsh-plugins/dsh-ccpg-document-preview/test"
(cd "$HERE/dsh-plugins/dsh-ccpg-document-preview" && npm test --silent) || fail=1

if [ "$fail" -ne 0 ]; then
  echo "存在失败用例"
  exit 1
fi
echo "✓ 全部单测通过"
