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
node "$DSH_BIN" plugin --profile "$PROFILE" add \
  "$HERE/dsh-ccpg-tools" "$HERE/dsh-ccpg-orchestrator" "$HERE/dsh-ccpg-web" "$HERE/dsh-ccpg-canvasui" "$HERE/dsh-ccpg-larkauth" "$HERE/dsh-ccpg-brand" 2>&1 | grep -v "declares no dsh.bundle" || true
echo "✓ 插件已安装"

# 3. 依赖引导（SDK 软链进插件源码目录 + profile 兜底）
sh "$HERE/bootstrap-deps.sh" "$PDIR" >/dev/null
SDK_DIR=$(node -e "console.log(require('path').dirname(require('path').dirname(process.argv[1])) + '/node_modules/@deepseek-ai')" "$DSH_BIN")
for pkg in dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-larkauth dsh-ccpg-brand; do
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
    - id: dsh-ccpg-larkauth
      name: 'dsh-ccpg-larkauth'
    - id: ccpg-brand
      name: 'dsh-ccpg-brand'
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

echo ""
echo "安装完成。启动："
echo "  GLM_API_KEY=你的key $HERE/start.sh $PROFILE"
echo "主入口（官方 UI + 聊天 + 工作流 tab）: http://127.0.0.1:$PORT/"
echo "独立画布入口: http://127.0.0.1:$PORT/wf1/"
