#!/bin/sh
# Workflow One 插件本地分发安装脚本（模拟别人拿到这个仓库后的完整安装）。
# 前提：已 npm i -g @deepseek-ai/dsh，且 node >= 20
# 用法：
#   sh setup.sh                  # 安装到默认 profile dsh-ccpg（端口 4021，七插件逐个挂载）
#   sh setup.sh <profile> <端口> # 安装到自定义 profile
#   sh setup.sh --one <profile> <端口>  # 聚合安装：dsh plugin add 只装 dsh-ccpg-one 一个包，
#                                       # 七插件挂载全由聚合包的 bundle patch 提供；
#                                       可选件用环境变量开关（CCPG_NO_LARK/NO_PREVIEW/
#                                       NO_SIDEBAR/NO_GUARD、CCPG_ONLY_CORE，见 dsh-ccpg-one/cordis.patch.yml）
set -e
AGGREGATE=0
if [ "${1:-}" = "--one" ]; then AGGREGATE=1; shift; fi
PROFILE="${1:-dsh-ccpg}"
PORT="${2:-4021}"
HERE=$(cd "$(dirname "$0")" && pwd)
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGINS="dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-llm-guard"
# better-sidebar 安装源：release 包 vendor/ 里的 tgz 优先（pack 当次 npm latest，
# 断网/下架也能装），没有则回退 npm registry 拉最新。源码仓库 checkout 没有
# vendor/（不入库），自动走 registry。
SIDEBAR_TGZ=""
for f in "$HERE"/vendor/dsh-better-sidebar-*.tgz; do
  [ -f "$f" ] && SIDEBAR_TGZ="$f"
done
if [ -n "$SIDEBAR_TGZ" ]; then
  SIDEBAR_SRC="$SIDEBAR_TGZ"
  echo "· better-sidebar 用本地 vendor: $(basename "$SIDEBAR_TGZ")"
else
  SIDEBAR_SRC="dsh-better-sidebar@latest"
  echo "· better-sidebar 未发现 vendor tgz，从 npm 拉 $SIDEBAR_SRC"
fi

# 安装前先校验完整分发目录，避免 plugin add 部分成功后留下半成品 profile。
for pkg in $PLUGINS; do
  [ -f "$HERE/$pkg/package.json" ] || { echo "✗ 插件缺失: $HERE/$pkg/package.json"; exit 1; }
  node -e "const p=require(process.argv[1]); if(p.name!==process.argv[2]) throw new Error('package name 应为 '+process.argv[2])" \
    "$HERE/$pkg/package.json" "$pkg" || exit 1
done
if [ "$AGGREGATE" = 1 ]; then
  [ -f "$HERE/dsh-ccpg-one/cordis.patch.yml" ] || { echo "✗ 聚合包缺失: dsh-ccpg-one/cordis.patch.yml"; exit 1; }
  node -e "const p=require('$HERE/dsh-ccpg-one/package.json'); if(!p.dsh?.bundle?.patch) throw new Error('dsh-ccpg-one 缺 dsh.bundle.patch')" || exit 1
fi

# orchestrator 真实依赖（含 QuickJS WASM）：源码安装与分发包都由脚本兜底，用户无需手动 npm install。
if [ ! -d "$HERE/dsh-ccpg-orchestrator/node_modules/quickjs-emscripten" ]; then
  if [ -f "$HERE/dsh-ccpg-orchestrator/package-lock.json" ]; then
    npm ci --no-audit --no-fund --prefix "$HERE/dsh-ccpg-orchestrator"
  else
    npm install --no-audit --no-fund --prefix "$HERE/dsh-ccpg-orchestrator"
  fi
fi
node --input-type=module - "$HERE/dsh-ccpg-orchestrator" <<'NODE'
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = process.argv[2];
const { runScript } = await import(pathToFileURL(join(root, 'lib', 'script-runner.js')));
const workspaceDir = mkdtempSync(join(tmpdir(), 'wf1-setup-script-'));
try {
  const result = await runScript({ workspaceDir, input: { value: 1 }, code: 'function main(input) { return input.value + 1; }' });
  if (result.value !== 2) throw new Error('QuickJS smoke 输出错误');
} finally {
  rmSync(workspaceDir, { recursive: true, force: true });
}
NODE
echo "✓ QuickJS 脚本运行时可用"

# 画布产物前置校验：web-dist 不入库（gitignore），源码安装必须先跑 build-web.sh。
# 分发包自带成品，此校验自然通过。
if [ ! -f "$HERE/dsh-ccpg-web/web-dist/index.html" ]; then
  echo "✗ 画布未构建（dsh-ccpg-web/web-dist 缺 index.html）——先跑: sh $HERE/build-web.sh"
  exit 1
fi
echo "✓ 画布产物就绪"

# canvasui 客户端 bundle 兜底构建：lib/client.js 由 src/client.js 生成（gitignore，不入库）。
# 源码安装或改过 src/client.js 后以 --check 校验，不一致则重建。
if ! sh "$HERE/build-canvasui.sh" --check >/dev/null 2>&1; then
  echo "· canvasui bundle 缺失或与源不一致，重建…"
  sh "$HERE/build-canvasui.sh"
fi
sh "$HERE/build-canvasui.sh" --check >/dev/null || { echo "✗ canvasui bundle 构建失败"; exit 1; }
echo "✓ canvasui bundle 就绪"

# 定位 dsh bin
DSH_BIN=$(node -e "console.log(require.resolve('@deepseek-ai/dsh/lib/bin.js'))" 2>/dev/null || true)
[ -z "$DSH_BIN" ] && for c in "$HOME/.local/npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
  [ -f "$c" ] && DSH_BIN="$c" && break
done
[ -z "$DSH_BIN" ] && { echo "✗ 未找到 dsh（先 npm i -g @deepseek-ai/dsh，需要 node>=20）"; exit 1; }

# 1. 建_profile（已存在则跳过）
# bundles 必须含 dsh-web-app：官方 Web UI（聊天/侧边栏/会话管理）是它的 surface；
# dsh-ccpg-canvasui 的工作流侧栏入口和 larkauth 的设置面板都注册进官方 UI。
PDIR="$DSH_HOME/profiles/$PROFILE"
if [ ! -f "$PDIR/package.json" ]; then
  mkdir -p "$PDIR"
  cat > "$PDIR/package.json" << EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
EOF
  echo "[]" > "$PDIR/cordis.yml"
  echo "[]" > "$PDIR/cordis.patch.yml"
  echo "✓ 已创建 profile: $PROFILE"
fi

# 2. 装插件（dsh plugin → pnpm 本地链接）
cd "$PDIR"
PLUGIN_LOG=$(mktemp "${TMPDIR:-/tmp}/dsh-ccpg-plugin-add.XXXXXX")
trap 'rm -f "$PLUGIN_LOG"' EXIT HUP INT TERM
if [ "$AGGREGATE" = 1 ]; then
  # ---- 聚合安装：只 add dsh-ccpg-one（七插件 + better-sidebar 全由它的 bundle patch 挂载）----
  # 先装聚合包自身的 file: 依赖（七插件实体进聚合包 node_modules；overrides 钉 SDK 版本，
  # 见 dsh-ccpg-one/pnpm-workspace.yaml——registry latest 停 0.0.1-rc.1，0.1.x 只在 next tag）。
  # better-sidebar：vendor tgz 在场则临时注入 file: override（npm 不可达也能装），
  # pnpm install 完成后（无论成败）移除——workspace yaml 不留本机路径残留。
  WS_YML="$HERE/dsh-ccpg-one/pnpm-workspace.yaml"
  rm_vendor_ov() {
    [ -f "$WS_YML" ] || return 0
    sed -i.bak "/\"dsh-better-sidebar\": \"file:/d" "$WS_YML" && rm -f "$WS_YML.bak"
  }
  if [ -n "$SIDEBAR_TGZ" ]; then
    sed -i.bak "/^overrides:/a\\
  \"dsh-better-sidebar\": \"file:$SIDEBAR_TGZ\"
" "$WS_YML" && rm -f "$WS_YML.bak"
  fi
  if ! (cd "$HERE/dsh-ccpg-one" && pnpm install --no-frozen-lockfile) >/dev/null 2>&1; then
    rm_vendor_ov
    echo "✗ dsh-ccpg-one 依赖安装失败（在该目录跑 pnpm install 看详情）"
    exit 1
  fi
  rm_vendor_ov
  # better-sidebar 走聚合包 peer（optional）声明，不单独 add——聚合 patch 已挂它，双 add 会 duplicate id。
  if ! node "$DSH_BIN" plugin --profile "$PROFILE" add "$HERE/dsh-ccpg-one" >"$PLUGIN_LOG" 2>&1; then
    cat "$PLUGIN_LOG" >&2
    echo "✗ 聚合包安装失败"
    exit 1
  fi
  cat "$PLUGIN_LOG"
  # link: 安装时聚合包实体留在源码目录，loader 从 profile 根解析不到聚合 patch 挂载的
  # 子插件/better-sidebar——补链进 profile node_modules（npm 渠道 pnpm 会放实体，无需此步）。
  for pkg in $PLUGINS dsh-better-sidebar; do
    if [ ! -e "$PDIR/node_modules/$pkg" ]; then
      if [ "$pkg" = dsh-better-sidebar ]; then
        ln -s "$HERE/dsh-ccpg-one/node_modules/$pkg" "$PDIR/node_modules/$pkg" 2>/dev/null || true
      else
        ln -s "$HERE/$pkg" "$PDIR/node_modules/$pkg"
      fi
    fi
  done
else
  PLUGIN_PATHS=""
  for pkg in $PLUGINS; do
    PLUGIN_PATHS="$PLUGIN_PATHS $HERE/$pkg"
  done
  # PLUGIN_PATHS 按受控插件目录拆分为多个参数。
  if ! node "$DSH_BIN" plugin --profile "$PROFILE" add $PLUGIN_PATHS >"$PLUGIN_LOG" 2>&1; then
    cat "$PLUGIN_LOG" >&2
    echo "✗ 插件安装失败"
    exit 1
  fi
  cat "$PLUGIN_LOG"
fi
rm -f "$PLUGIN_LOG"
trap - EXIT HUP INT TERM
echo "✓ 插件已安装"

# 3. 依赖引导（SDK 软链进插件源码目录 + profile 兜底）
sh "$HERE/bootstrap-deps.sh" "$PDIR" >/dev/null
SDK_DIR=$(node -e "console.log(require('path').dirname(require('path').dirname(process.argv[1])) + '/node_modules/@deepseek-ai')" "$DSH_BIN")
for pkg in $PLUGINS; do
  mkdir -p "$HERE/$pkg/node_modules/@deepseek-ai"
  for dep in schemastery cordis dsh-tools dsh-llm dsh-session; do
    [ -d "$SDK_DIR/$dep" ] || continue
    T="$HERE/$pkg/node_modules/@deepseek-ai/$dep"
    [ -L "$T" ] || ln -s "$SDK_DIR/$dep" "$T"
  done
done
echo "✓ 依赖已引导"

# 4. patch 组装（不覆盖已有 patch —— 已有则提示）
# 七个默认插件的挂载行不再手写：各插件自带 dsh.bundle.patch（cordis.patch.yml），
# dsh plugin add 依据声明自动进 bundles 层并挂载——手写行会双挂载（duplicate route）。
# patch 只写端口；模型 provider 完全交给 dsh 自带体系（deepseek-official 默认，
# key 与选型在官方 UI「模型」页 / ~/.dsh/settings.yaml 配置），插件不掺和。
if [ -f "$PDIR/cordis.patch.yml" ] && grep -q "dsh-host-webserver" "$PDIR/cordis.patch.yml"; then
  echo "✓ patch 已含 webserver 配置（跳过）"
else
  cat > "$PDIR/cordis.patch.yml" << EOF
# dsh-ccpg 系插件 profile：仅 web 服务端口覆盖（插件挂载走各自的 dsh.bundle.patch）。
# 模型 provider 用 dsh 自带配置：官方 UI「模型」页选型并保存 key（写入 ~/.dsh
# settings/credentials），或环境变量注入 dsh 默认 provider 的 key。
# webserver：dsh-web-app bundle 已挂该行（默认 127.0.0.1:3080），这里只覆盖端口。
# host 127.0.0.1=本机访问；局域网/Tailscale 远程改 host 为 0.0.0.0（注意 dsh agent 有 bash 能力，仅在可信网络开放）。
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: $PORT
EOF
  echo "✓ patch 已写入（端口 $PORT）"
fi

# 4.5 DSH-better-sidebar（社区侧边栏工作台，npm 安装）——「工作流」侧栏的宿主。
# canvasui 对它是软依赖：装不上时官方 UI 内无法打开画布，独立 /wf1/ 入口仍可用，故失败仅告警。
# 逐插件模式：走 registry npm 包单独 add（自带 dsh.bundle.patch 一步挂载）。
# 聚合模式：聚合包 peer(optional) 已带 + bundle patch 已挂，单独 add 会 duplicate id——跳过。
if [ "$AGGREGATE" != 1 ]; then
  if ! node "$DSH_BIN" plugin --profile "$PROFILE" add "$SIDEBAR_SRC" >/dev/null 2>&1; then
    echo "⚠ dsh-better-sidebar 安装失败（官方 UI 工作流侧栏不可用；可稍后手动：dsh plugin --profile $PROFILE add $SIDEBAR_SRC）"
  else
    echo "✓ dsh-better-sidebar 已安装（侧边栏工作台 + 工作流画布）"
  fi
fi

# 5. lark-cli（飞书官方 CLI）——飞书账号扫码登录与 agent 飞书操作依赖它。
# 装到 ~/.local/npm-global（插件按此路径探测；启动时插件也会自检补装，这里先装好免去首启等待）。
LARK_BIN="$HOME/.local/npm-global/bin/lark-cli"
if [ ! -x "$LARK_BIN" ] && ! command -v lark-cli >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    mkdir -p "$HOME/.local/npm-global/bin"
    npm install -g @larksuite/cli --prefix "$HOME/.local/npm-global" >/dev/null 2>&1 \
      && echo "✓ lark-cli 已安装（$LARK_BIN）" \
      || echo "⚠ lark-cli 安装失败（可稍后手动 npm i -g @larksuite/cli，或启动后插件会自动重试）"
  else
    echo "⚠ 未找到 npm，跳过 lark-cli 安装（插件启动时会自动重试）"
  fi
else
  echo "✓ lark-cli 已存在"
fi
# 已登录过飞书则把默认身份固定为 user（插件启动时也会执行，此处幂等）
[ -x "$LARK_BIN" ] && "$LARK_BIN" config default-as user >/dev/null 2>&1 || true
# feishu-cli 技能种子由 larkauth 插件启动时自动写入 ~/.dsh/skills（dsh 原生技能根）

echo ""
echo "安装完成。启动："
echo "  $HERE/start.sh $PROFILE"
echo "模型在官方 UI「模型」页配置（或环境变量注入 dsh 默认 provider 的 key）——插件不写死任何模型。"
if [ "$AGGREGATE" = 1 ]; then
  echo "聚合安装：可选件开关（启动前 export）——"
  echo "  CCPG_NO_LARK=1 关飞书登录 · CCPG_NO_PREVIEW=1 关文档预览"
  echo "  CCPG_NO_SIDEBAR=1 关侧边栏 · CCPG_NO_GUARD=1 关防护 · CCPG_ONLY_CORE=1 只留核心五件"
fi
echo "主入口（官方 UI 对话 + 右侧工作流画布）: http://127.0.0.1:$PORT/"
echo "独立画布入口: http://127.0.0.1:$PORT/wf1/"
