#!/bin/sh
# 构建 dsh-ccpg-canvasui 客户端 bundle：lib/client.js。
#
# 插件 client bundle 必须自包含（dsh module-loader 禁跨插件值导入），共享 UI 片段
# （dsh-plugins/shared/*.js）通过源文件 src/client.js 里的标记行在构建期内联：
#   // @include <相对本文件的路径>
# 本脚本把每个标记替换为对应文件内容（按标记行的缩进左对齐补 tab），生成 lib/client.js。
# 缺文件 / 循环嵌套 / 生成物语法错误都会失败退出；--check 只校验不写盘。
#
# 用法：sh build-canvasui.sh [--check]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/dsh-ccpg-canvasui/src/client.js"
OUT="$HERE/dsh-ccpg-canvasui/lib/client.js"
NODE_BIN="${WF1_NODE:-node}"

[ -f "$SRC" ] || { echo "✗ 缺源文件: $SRC"; exit 1; }

"$NODE_BIN" - "$SRC" "$OUT" "$@" <<'NODE'
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const out = process.argv[3];
const checkOnly = process.argv.slice(4).includes('--check');

const lines = fs.readFileSync(src, 'utf8').split('\n');
const result = [];
const seen = [];

for (const line of lines) {
  const m = line.match(/^(\s*)\/\/\s*@include\s+(\S+)\s*$/);
  if (!m) { result.push(line); continue; }
  const indent = m[1];
  const target = path.resolve(path.dirname(src), m[2]);
  if (seen.includes(target)) throw new Error(`@include 循环: ${m[2]}`);
  seen.push(target);
  if (!fs.existsSync(target)) throw new Error(`@include 目标缺失: ${m[2]} → ${target}`);
  const body = fs.readFileSync(target, 'utf8').replace(/\n+$/, '').split('\n')
    .map((l) => (l ? indent + l : l));
  result.push(...body);
}

const text = result.join('\n');
// 产物必须是可执行 JS：共享片段拼错（重复声明/悬空语法）在这里拦住，不留到浏览器。
new Function(text);
if (!text.includes('window.__ModuleLoader__.load')) {
  throw new Error('产物缺少 __ModuleLoader__.load 注册（源文件被改坏？）');
}

if (checkOnly) {
  // 不只验语法：把拼接结果与盘上 lib/client.js 逐字比对，缺文件/有差异都算失败
  // ——pack.sh/setup.sh 据此拦截"改了 shared/ 或 src/ 忘了重建"的漂移。
  if (!fs.existsSync(out)) throw new Error(`产物缺失: ${out}（先跑 sh build-canvasui.sh）`);
  const current = fs.readFileSync(out, 'utf8');
  if (current !== text) throw new Error('产物与源不一致（src/client.js 或 shared/ 改动未重建），先跑 sh build-canvasui.sh');
  console.log(`✓ canvasui bundle 与源一致（${current.split('\n').length} 行）`);
} else {
  fs.writeFileSync(out, text);
  console.log(`✓ ${path.relative(path.dirname(out), out)} 已生成（${text.split('\n').length} 行，内联 ${seen.length} 个共享片段）`);
}
NODE
