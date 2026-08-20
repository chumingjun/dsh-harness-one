#!/bin/sh
# 构建 dsh-ccpg-document-preview，并校验 package.json 声明的运行时入口。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR="$HERE/dsh-ccpg-document-preview"
PACKAGE_JSON="$PLUGIN_DIR/package.json"

[ -f "$PACKAGE_JSON" ] || { echo "✗ document-preview 插件缺失: $PACKAGE_JSON"; exit 1; }
node -e "
const p=require(process.argv[1]);
if(p.name!=='dsh-ccpg-document-preview') throw new Error('package name 应为 dsh-ccpg-document-preview');
if(!p.scripts || !p.scripts.build) throw new Error('package.json 必须声明 scripts.build');
" "$PACKAGE_JSON"

cd "$PLUGIN_DIR"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --package-lock=false --no-audit --no-fund
fi
npm run build

node - "$PACKAGE_JSON" <<'NODE'
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
  if (entry === './package.json') continue;
  if (!fs.existsSync(path.resolve(root, entry))) {
    throw new Error(`构建入口缺失: ${entry}`);
  }
}
if (!entries.size) throw new Error('package.json 未声明 main/exports 构建入口');
NODE
echo "✓ document-preview 构建与入口校验完成"
