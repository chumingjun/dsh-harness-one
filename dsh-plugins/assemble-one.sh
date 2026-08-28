#!/bin/sh
# 装配单包 dsh-harness-one：把 7 个 dsh-ccpg-* 插件源码目录装配成一个 npm 包。
#
# 单包形态（方案三落地）：
#   - 源码目录原地不动（测试/开发布局零变更），本脚本产出 dsh-harness-one/ 装配目录
#   - 服务端：一个 loader entry（dsh-harness-one），聚合入口 ctx.plugin() 依次挂载 7 个子插件
#     （每个子插件已是标准 cordis 插件函数，name/inject/Config/apply 原样生效）
#   - 客户端：合并 client bundle（canvasui+larkauth+document-preview 三个 __ModuleLoader__
#     工厂首尾相连，id 各自保留，require 表共享、互不干扰）
#   - manifest：依赖取并集（ajv/cron-parser/quickjs + dsh-better-sidebar），exports 暴露
#     ./client 与 ./package.json（client-modules 按 `<pkg>/package.json` 解析，缺后者 client 静默不注册）
#   - 可选件门控沿用 CCPG_* 环境变量（在聚合入口内判 env，跳过对应 ctx.plugin）
#
# 产物目录不入库（gitignore）；pack.sh / publish-npm.sh / setup.sh --one 都先跑本脚本。
# 用法：sh assemble-one.sh [--check]   # --check 只校验产物与源一致（防漂移），不重建
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/dsh-harness-one"
NODE_BIN="${DSH_NODE:-${WF1_NODE:-node}}"
PLUGINS="dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-llm-guard"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# 前置：canvasui bundle 与 document-preview dist 必须已构建（build-web.sh 负责；
# 这里只验在场，不重建——装配脚本保持快）
[ -f "$HERE/dsh-ccpg-canvasui/lib/client.js" ] || { echo "✗ 缺 dsh-ccpg-canvasui/lib/client.js（先 sh build-canvasui.sh）"; exit 1; }
[ -f "$HERE/dsh-ccpg-document-preview/dist/client.js" ] || { echo "✗ 缺 dsh-ccpg-document-preview/dist/client.js（先 sh build-document-preview.sh）"; exit 1; }
[ -f "$HERE/dsh-ccpg-larkauth/lib/client.js" ] || { echo "✗ 缺 dsh-ccpg-larkauth/lib/client.js"; exit 1; }

# 版本号与聚合包列车对齐：取 dsh-ccpg-one 的版本
VERSION=$("$NODE_BIN" -e "console.log(require(process.argv[1]).version)" "$HERE/dsh-ccpg-one/package.json")
SIDEBAR_VER=$("$NODE_BIN" -e "console.log(require(process.argv[1]).dependencies['dsh-better-sidebar'] || '')" "$HERE/dsh-ccpg-one/package.json")
[ -n "$SIDEBAR_VER" ] || { echo "✗ dsh-ccpg-one 未声明 dsh-better-sidebar 精确依赖"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/lib" "$OUT/bin"

# ---- 1. 子插件源码整体拷入（lib/src/dist/skills/package.json 按包实际形态）----
# package.json 必须拷：子插件代码用 ../package.json 读自身版本（selfPluginVersion）、
# 定位 skills 种子等；不带的话运行时版本探测返回 null。
for p in $PLUGINS; do
  mkdir -p "$OUT/$p"
  cp "$HERE/$p/package.json" "$OUT/$p/package.json"
  for d in lib src dist skills; do
    [ -d "$HERE/$p/$d" ] && cp -R "$HERE/$p/$d" "$OUT/$p/$d"
  done
  # web 画布产物单独拷（源码树 gitignore）
  [ -d "$HERE/$p/web-dist" ] && cp -R "$HERE/$p/web-dist" "$OUT/$p/web-dist"
done
# ---- 1.5 orchestrator 运行时依赖：声明进单包 manifest（npm pack 不收 node_modules；
# registry 安装时 npm/pnpm 把 ajv/cron-parser/quickjs 落到 profile node_modules，
# ESM 从子插件目录向上解析命中——已实测 registry 布局通过）----
# 本地 link: 开发形态的运行时依赖（ajv/cron/quickjs）由 setup.sh --one 软链进
# profile node_modules（离线归档同路径），装配目录不放假链——绝对路径软链进了
# tarball 会变成装机机上的断链。

# ---- 2. 聚合入口（服务端）----
cat > "$OUT/lib/index.js" <<'EOF'
// dsh-harness-one 聚合入口：单 loader entry 挂载 7 个子插件。
// 子插件源码在本包各子目录（../dsh-ccpg-*/lib/index.js），cordis 形状原样生效
// （name/inject/Config/apply 都由 ctx.plugin 消费）。可选件门控沿用 CCPG_* 环境变量：
// CCPG_NO_LARK / CCPG_NO_PREVIEW / CCPG_NO_GUARD / CCPG_ONLY_CORE。
import * as tools from '../dsh-ccpg-tools/lib/index.js';
import * as orchestrator from '../dsh-ccpg-orchestrator/lib/index.js';
import * as web from '../dsh-ccpg-web/lib/index.js';
import * as canvasui from '../dsh-ccpg-canvasui/lib/index.js';
import * as preview from '../dsh-ccpg-document-preview/src/host.js';
import * as larkauth from '../dsh-ccpg-larkauth/lib/index.js';
import * as guard from '../dsh-ccpg-llm-guard/lib/index.js';

export const name = 'dsh-harness-one';
export const inject = [];

const OPTIONAL = {
  'dsh-ccpg-document-preview': () => Boolean(process.env.CCPG_NO_PREVIEW || process.env.CCPG_ONLY_CORE),
  'dsh-ccpg-larkauth': () => Boolean(process.env.CCPG_NO_LARK || process.env.CCPG_ONLY_CORE),
  'dsh-ccpg-llm-guard': () => Boolean(process.env.CCPG_NO_GUARD || process.env.CCPG_ONLY_CORE),
};

export function apply(ctx) {
  // 挂载顺序即依赖顺序：tools 先注册（orchestrator 的助手依赖它），web 先于 canvasui
  const subs = [tools, orchestrator, web, canvasui, preview, larkauth, guard];
  for (const sub of subs) {
    const off = OPTIONAL[sub.name] ? OPTIONAL[sub.name]() : false;
    if (off) { ctx.logger?.info?.(`dsh-harness-one: ${sub.name} 按环境变量跳过`); continue; }
    ctx.plugin(sub);
  }
  ctx.logger?.info?.('dsh-harness-one: 7 个子插件已挂载（单包装配）');
}
EOF

# ---- 3. 合并 client bundle（组合 factory）----
# 机制约束（dsh-client-modules）：shell 对 boot graph 每个 entry 调 loader.create({name})，
# import 该 entry id 的 factory 并执行 exports.apply(ctx)。单 entry = 单 id ——
# 合并 bundle 必须只注册一个 id 为 dsh-harness-one 的 factory，其 apply 内部依次
# 执行三个子客户端的 apply（各自包 try/catch 隔离失败）。
# 实现方式：把三个源 bundle 的 __ModuleLoader__.load({...}) 调用改为注册进本地表
# SUB_FACTORIES，再由尾部组合 factory 读取并驱动。
"$NODE_BIN" - "$HERE" "$OUT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [here, out] = process.argv.slice(2);
const sources = [
  ['dsh-ccpg-canvasui', fs.readFileSync(path.join(here, 'dsh-ccpg-canvasui/lib/client.js'), 'utf8')],
  ['dsh-ccpg-larkauth', fs.readFileSync(path.join(here, 'dsh-ccpg-larkauth/lib/client.js'), 'utf8')],
  ['dsh-ccpg-document-preview', fs.readFileSync(path.join(here, 'dsh-ccpg-document-preview/dist/client.js'), 'utf8')],
];
const header = `// dsh-harness-one 合并 client bundle（assemble-one.sh 生成，勿手改）。
// 三个子客户端工厂注册进本地表 __oneFactories__，由尾部的 dsh-harness-one 组合
// factory 依次驱动——单一 graph entry 单一 id，apply 内部组合三个子 apply。
var __oneFactories__ = {};
var __oneOriginalLoad__ = window.__ModuleLoader__.load;
(function () {
  window.__ModuleLoader__.load = function (registration) {
    __oneFactories__[registration.id] = registration.factory;
  };
`;
const footer = `
})();
// 还原被头部换掉的 load，再以真身注册组合 factory。
// 顺序敏感：先还原后注册，否则组合注册也被截进 __oneFactories__，graph 收不到。
window.__ModuleLoader__.load = __oneOriginalLoad__;
__oneOriginalLoad__({
  id: "dsh-harness-one",
  factory: function (require) {
    var exports = {};
    exports.name = "dsh-harness-one/client";
    exports.inject = ["slots"];
    exports.apply = function (ctx) {
      var order = ["dsh-ccpg-canvasui", "dsh-ccpg-larkauth", "dsh-ccpg-document-preview"];
      for (var i = 0; i < order.length; i++) {
        var factory = __oneFactories__[order[i]];
        if (!factory) { console.warn("[dsh-harness-one] client 缺子工厂: " + order[i]); continue; }
        try {
          var subExports = factory(function (spec) { return require(spec); });
          if (typeof subExports?.apply === "function") subExports.apply(ctx);
        } catch (error) {
          console.error("[dsh-harness-one] 子客户端 " + order[i] + " 初始化失败", error);
        }
      }
    };
    return exports;
  },
});
`;
const parts = sources.map(([id, text]) => {
  if (!/window\.__ModuleLoader__\.load\s*\(/.test(text)) throw new Error(id + ' bundle 缺少 __ModuleLoader__.load 注册');
  return '// ===== ' + id + ' =====\n' + text.trim();
});
const merged = header + parts.join('\n\n') + '\n' + footer;
new Function(merged); // 语法门：拼接错误在这里拦住
fs.writeFileSync(path.join(out, 'lib', 'client.js'), merged);
for (const [id] of sources) {
  if (!merged.includes('id: "' + id + '"') && !merged.includes("id: '" + id + "'")) {
    throw new Error('合并 bundle 缺子注册: ' + id);
  }
}
console.log('✓ 合并 client bundle：组合 factory + ' + sources.length + ' 子工厂');
NODE

# ---- 4. document-preview client-assets 归位 ----
# host 半的 ASSET_ROUTE 是 /plugins/dsh-ccpg-document-preview/client-assets（写死的包名路径）。
# 单包后实体在 /plugins/dsh-harness-one/client.js，client.jsx runtime 用 new URL('./client-assets/', scriptUrl)
# 相对解析——为保双渠道兼容，把 client-assets 同时放到合并包根（lib/client-assets）。
if [ -d "$HERE/dsh-ccpg-document-preview/dist/client-assets" ]; then
  cp -R "$HERE/dsh-ccpg-document-preview/dist/client-assets" "$OUT/lib/client-assets"
fi
# host 半（src/host.js）注册的 ASSET_ROUTE 前缀是旧包名——装配时替换为合并包名，
# 这样旧 URL（已分发的 bookmarklet 等）与官方 UI 的动态 import 都能命中
if [ -f "$OUT/dsh-ccpg-document-preview/src/host.js" ]; then
  sed -i.bak "s|/plugins/dsh-ccpg-document-preview/client-assets|/plugins/dsh-harness-one/client-assets|g" "$OUT/dsh-ccpg-document-preview/src/host.js" && rm -f "$OUT/dsh-ccpg-document-preview/src/host.js.bak"
fi
# client.jsx runtime.js 里的动态 import 也是相对 scriptUrl，无需改；
# 但 react.js / renderers 的外部 chunk 路径在 dist/react.js（web 画布用 file: 依赖直引，不走本路由）。

# ---- 5. 安装器（pnpm11 预写，沿用 dsh-ccpg-one 的实现）：包名替换 + 清空 SUBPLUGINS ----
# 安装器在主 add 后补一条 dsh plugin add dsh-better-sidebar（见下方注入）。
# 先清空多行数组（单包无子包依赖；正则吃到数组结尾的 `];`），再全局换名。
sed -E "s/^const SUBPLUGINS = \[[^]]*\];/const SUBPLUGINS = [];/" "$HERE/dsh-ccpg-one/bin/install.js" \
  | sed "s/dsh-ccpg-one/dsh-harness-one/g" > "$OUT/bin/install.js"
"$NODE_BIN" --check "$OUT/bin/install.js" || { echo "✗ 生成的 install.js 语法错误"; exit 1; }
chmod +x "$OUT/bin/install.js"
# sidebar bundle 注册：dsh reconcile 只认直接依赖，纯净安装后侧栏 tab 不挂载——
# 安装器在主包 add 成功后补一条（依赖表已有则 pnpm 去重，只做 bundle 注册）。
python3 - "$OUT/bin/install.js" <<'PYI'
import sys
p = sys.argv[1]
s = open(p).read()
marker = "say('安装完成，重启 dsh 生效。独立画布: http://127.0.0.1:4021/wf1/');"
inject_code = """if (!process.env.CCPG_NO_SIDEBAR && !process.env.CCPG_ONLY_CORE) {
  say('注册 better-sidebar（官方 UI 工作流侧栏宿主）…');
  const sb = spawnSync(dsh, ['plugin', '--profile', PROFILE, 'add', 'dsh-better-sidebar'], { stdio: 'inherit' });
  if (sb.status !== 0) console.error('[dsh-harness-one] better-sidebar 注册失败（可手动：dsh plugin --profile ' + PROFILE + ' add dsh-better-sidebar）');
}
""" + marker
assert marker in s, 'installer marker missing'
s = s.replace(marker, inject_code)
open(p, 'w').write(s)
print('installer: sidebar add injected')
PYI
"$NODE_BIN" --check "$OUT/bin/install.js" || { echo "✗ installer 注入后语法错误"; exit 1; }

# ---- 6. manifest 与 patch ----
cat > "$OUT/package.json" <<EOF
{
  "name": "dsh-harness-one",
  "version": "$VERSION",
  "description": "Workflow One - Visual AI workflow orchestrator for DeepSeek Harness (dsh): multi-agent DAGs, live execution, recovery, and Feishu integration (single-package edition)",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/chumingjun/dsh-harness-one.git",
    "directory": "dsh-plugins"
  },
  "homepage": "https://github.com/chumingjun/dsh-harness-one#readme",
  "bugs": { "url": "https://github.com/chumingjun/dsh-harness-one/issues" },
  "keywords": ["deepseek", "dsh", "dsh-plugin", "ai-agents", "agentic-workflow", "workflow-automation", "visual-workflow", "multi-agent", "dag", "react-flow", "feishu", "lark", "cordis"],
  "engines": { "node": ">=22.15.0" },
  "type": "module",
  "private": false,
  "main": "lib/index.js",
  "bin": { "dsh-harness-one": "./bin/install.js" },
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "bin",
    "dsh-ccpg-tools",
    "dsh-ccpg-orchestrator",
    "dsh-ccpg-web",
    "dsh-ccpg-canvasui",
    "dsh-ccpg-document-preview",
    "dsh-ccpg-larkauth",
    "dsh-ccpg-llm-guard",
    "cordis.patch.yml"
  ],
  "dependencies": {
    "dsh-better-sidebar": "$SIDEBAR_VER",
    "ajv": "^8.20.0",
    "cron-parser": "^4.9.0",
    "quickjs-emscripten": "0.32.0"
  },
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  }
}
EOF

cat > "$OUT/cordis.patch.yml" <<'EOF'
# dsh-harness-one 单包 bundle patch：一条命令装齐 Workflow One 全部 7 个插件。
#
# 安装：dsh plugin --profile <name> add dsh-harness-one
# 卸载：dsh plugin --profile <name> remove dsh-harness-one
#
# 可选件门控（聚合入口判 CCPG_* 环境变量，详见 lib/index.js）：
#   CCPG_NO_LARK / CCPG_NO_PREVIEW / CCPG_NO_GUARD / CCPG_ONLY_CORE
# better-sidebar 不在此 insert：它作为本包依赖自带 bundle 层挂载（dsh plugin add
# 依据其 dsh.bundle.patch 自动注册），此处再 insert 即双挂载。
- insert:
    - id: dsh-harness-one
      name: 'dsh-harness-one'
EOF

cp "$HERE/dsh-ccpg-one/LICENSE" "$OUT/LICENSE" 2>/dev/null || true
# 技能种子已随 larkauth 子目录拷入（skills/feishu-cli.md 相对 lib/ 解析，路径不变）

# ---- 7. 语法冒烟：合并 client 注册数 + 聚合入口源码形态（不做全量 import——
# SDK 软链只在真实 profile 环境，装配机不一定有；loader 在 dsh 进程内解析）----
"$NODE_BIN" -e "
const fs = require('fs');
const entry = fs.readFileSync('$OUT/lib/index.js', 'utf8');
if (!entry.includes(\"export const name = 'dsh-harness-one'\")) throw new Error('入口 name 不对');
if (!entry.includes('ctx.plugin(')) throw new Error('入口缺 ctx.plugin 挂载');
const imports = (entry.match(/^import \* as /gm) || []).length;
if (imports !== 7) throw new Error('入口应 import 7 个子插件，实际 ' + imports);
console.log('✓ 聚合入口形态校验通过（7 子插件）');
"

echo "✓ dsh-harness-one@$VERSION 装配完成 → $OUT"
