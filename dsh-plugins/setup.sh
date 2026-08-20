#!/bin/sh
# Workflow One 插件本地分发安装脚本（模拟别人拿到这个仓库后的完整安装）。
# 前提：已 npm i -g @deepseek-ai/dsh，且 node >= 20
# 用法：
#   sh setup.sh                  # 安装到默认 profile dsh-ccpg（端口 4021）
#   sh setup.sh <profile> <端口> # 安装到自定义 profile
set -e
PROFILE="${1:-dsh-ccpg}"
PORT="${2:-4021}"
HERE=$(cd "$(dirname "$0")" && pwd)
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGINS="dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-brand"

# 安装前先校验完整分发目录，避免 plugin add 部分成功后留下半成品 profile。
for pkg in $PLUGINS; do
  [ -f "$HERE/$pkg/package.json" ] || { echo "✗ 插件缺失: $HERE/$pkg/package.json"; exit 1; }
  node -e "const p=require(process.argv[1]); if(p.name!==process.argv[2]) throw new Error('package name 应为 '+process.argv[2])" \
    "$HERE/$pkg/package.json" "$pkg" || exit 1
done

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

# canvasui 客户端 bundle 兜底构建：lib/client.js 是 src/client.js 内联 shared/ 片段的
# 拼接产物。分发包里已带成品；源码安装或改过 shared/ 后以 --check 校验，不一致则重建。
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
# dsh-ccpg-canvasui 的工作流 tab 和 larkauth 的设置面板都注册进官方 UI——缺它就没有 tab。
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
PLUGIN_PATHS=""
for pkg in $PLUGINS; do
  PLUGIN_PATHS="$PLUGIN_PATHS $HERE/$pkg"
done
PLUGIN_LOG=$(mktemp "${TMPDIR:-/tmp}/dsh-ccpg-plugin-add.XXXXXX")
trap 'rm -f "$PLUGIN_LOG"' EXIT HUP INT TERM
# PLUGIN_PATHS 按受控插件目录拆分为多个参数。
if ! node "$DSH_BIN" plugin --profile "$PROFILE" add $PLUGIN_PATHS >"$PLUGIN_LOG" 2>&1; then
  grep -v "declares no dsh.bundle" "$PLUGIN_LOG" >&2 || true
  echo "✗ 插件安装失败"
  exit 1
fi
grep -v "declares no dsh.bundle" "$PLUGIN_LOG" || true
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
if [ -f "$PDIR/cordis.patch.yml" ] && grep -q dsh-ccpg-orchestrator "$PDIR/cordis.patch.yml"; then
  echo "✓ patch 已含 dsh-ccpg 配置（跳过）"
else
  cat > "$PDIR/cordis.patch.yml" << EOF
# dsh-ccpg 系插件 profile：物业编排插件 + web 服务
# 模型 provider 按需替换（示例为 GLM BigModel anthropic 兼容端点）
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      glm-bigmodel:
        displayName: GLM (BigModel)
        apiKeyEnv: GLM_API_KEY
        api: anthropic-messages
        baseURL: https://open.bigmodel.cn/api/anthropic
        models:
          - id: glm-5.3
            name: GLM-5.3
            contextWindow: 262144
            maxTokens: 32768
          - id: glm-5.2
            name: GLM-5.2
            contextWindow: 262144
            maxTokens: 32768
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: glm-bigmodel
    model: glm-5.3
- insert:
    - id: dsh-ccpg-tools
      name: 'dsh-ccpg-tools'
    - id: dsh-ccpg-orchestrator
      name: 'dsh-ccpg-orchestrator'
    - id: dsh-ccpg-web
      name: 'dsh-ccpg-web'
    - id: dsh-ccpg-canvasui
      name: 'dsh-ccpg-canvasui'
    - id: dsh-ccpg-document-preview
      name: 'dsh-ccpg-document-preview'
    - id: dsh-ccpg-larkauth
      name: 'dsh-ccpg-larkauth'
    - id: ccpg-brand
      name: 'dsh-ccpg-brand'
# 注意：dsh-better-sidebar 不在这里手写挂载行——它走 npm 包自带的
# dsh.bundle.patch（dsh plugin add 一步完成安装+挂载），手写会双挂载。
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

# 兼容已安装的 profile：在 canvasui 后幂等插入文档预览插件，保留用户的其他 patch 配置。
if ! grep -q "name: ['\"]\{0,1\}dsh-ccpg-document-preview" "$PDIR/cordis.patch.yml"; then
  node - "$PDIR/cordis.patch.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const anchor = /(\n[ \t]*- id: dsh-ccpg-canvasui\r?\n[ \t]*name: ['"]?dsh-ccpg-canvasui['"]?[^\r\n]*)/;
if (!anchor.test(source)) {
  console.error('✗ 无法定位 dsh-ccpg-canvasui，未修改 profile patch');
  process.exit(1);
}
const updated = source.replace(anchor, "$1\n    - id: dsh-ccpg-document-preview\n      name: 'dsh-ccpg-document-preview'");
fs.writeFileSync(file, updated);
NODE
  echo "✓ document-preview 已按序插入 profile patch"
fi

# 4.5 DSH-better-sidebar（社区侧边栏工作台，npm 安装）——「对话记录」tab 的宿主。
# canvasui 对它是软依赖：装不上只损失聊天记录 tab，工作流画布不受影响，故失败仅告警。
# 走 registry npm 包（自带 dsh.bundle.patch，dsh plugin add 一步完成安装+挂载）。
if ! node "$DSH_BIN" plugin --profile "$PROFILE" add dsh-better-sidebar@latest >/dev/null 2>&1; then
  echo "⚠ dsh-better-sidebar 安装失败（侧边栏「对话记录」tab 不可用；可稍后手动：dsh plugin --profile $PROFILE add dsh-better-sidebar）"
else
  echo "✓ dsh-better-sidebar 已安装（侧边栏工作台 + 对话记录 tab）"
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
# feishu-cli 技能种子由 larkauth 插件启动时自动写入 ~/.dsh/skills 与 ~/.dsh/workflow-one-skills

echo ""
echo "安装完成。启动："
echo "  GLM_API_KEY=你的key $HERE/start.sh $PROFILE"
echo "主入口（官方 UI + 聊天 + 工作流 tab）: http://127.0.0.1:$PORT/"
echo "独立画布入口: http://127.0.0.1:$PORT/wf1/"
