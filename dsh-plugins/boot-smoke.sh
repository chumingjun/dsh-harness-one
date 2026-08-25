#!/bin/sh
# boot-smoke.sh — release tarball 的安装+启动端到端冒烟。
#
# 在隔离环境完整走一遍"用户拿到包"的路径：解包 → setup 聚合安装 → dsh 启动 →
# 探活官方 UI / 独立画布 / better-sidebar 挂载 → 关停清理。better-sidebar 使用
# 聚合包声明的精确版本，渠道间版本漂移会在这里（而不是用户机器上）先炸。
#
# 用法：sh boot-smoke.sh <tarball> [端口]
# 环境隔离：DSH_HOME / HOME 之外的全局态不触碰；profile 与临时目录用完即删。
# 依赖：node>=24.15、npm i -g @deepseek-ai/dsh、curl；模型不需要 key
#（smoke 只验证插件挂载与页面可服务，不发真实 LLM 请求）。
set -e

TARBALL="${1:?用法: sh boot-smoke.sh <tarball> [端口]}"
PORT="${2:-4199}"
[ -f "$TARBALL" ] || { echo "✗ tarball 不存在: $TARBALL"; exit 1; }

# 隔离的 DSH_HOME：不污染真实 ~/.dsh
SMOKE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/wf1-boot-smoke.XXXXXX")
export DSH_HOME="$SMOKE_ROOT/dsh-home"
mkdir -p "$DSH_HOME"
PROFILE="wf1-smoke"
cleanup() {
  pkill -f "dsh.*$PROFILE" 2>/dev/null || true
  rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT HUP INT TERM

echo "· smoke 根目录: $SMOKE_ROOT"
tar -xzf "$TARBALL" -C "$SMOKE_ROOT"
[ -d "$SMOKE_ROOT/dsh-plugins" ] || { echo "✗ tarball 缺 dsh-plugins/"; exit 1; }

echo "· 聚合安装（--one，better-sidebar 走 vendor tgz）…"
if ! ( cd "$SMOKE_ROOT" && DSH_HOME="$DSH_HOME" sh dsh-plugins/setup.sh --one "$PROFILE" "$PORT" ) \
  >"$SMOKE_ROOT/setup.log" 2>&1; then
  cat "$SMOKE_ROOT/setup.log"
  exit 1
fi

# 安装结果断言：聚合包 node_modules 里 better-sidebar 实体在场（vendor 件被真正消费）
BS_DIR="$SMOKE_ROOT/dsh-plugins/dsh-ccpg-one/node_modules/dsh-better-sidebar"
[ -f "$BS_DIR/package.json" ] || { echo "✗ better-sidebar 未装入聚合包"; exit 1; }
BS_VER=$(node -e "console.log(require(process.argv[1]).version)" "$BS_DIR/package.json")
echo "✓ better-sidebar 装入: $BS_VER"

echo "· 启动 dsh（$PROFILE @ $PORT）…"
( cd "$SMOKE_ROOT" && DSH_HOME="$DSH_HOME" \
    sh dsh-plugins/start.sh "$PROFILE" --no-open >"$SMOKE_ROOT/boot.log" 2>&1 ) &
BOOT_PID=$!

# 探活：dsh 官方 UI 首载慢，放宽到 60s；每 2s 重试
probe() { curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$1"; }
ok=""
for i in $(seq 1 30); do
  code=$(probe "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { echo "✗ 官方 UI 未就绪（60s 内无 200）"; tail -20 "$SMOKE_ROOT/boot.log"; exit 1; }
echo "✓ 官方 UI 200"

code=$(probe "http://127.0.0.1:$PORT/wf1/")
[ "$code" = "200" ] || { echo "✗ 独立画布 /wf1/ 非 200（$code）"; exit 1; }
echo "✓ 独立画布 /wf1/ 200"

# better-sidebar 真挂载：官方 UI HTML 引用其 client bundle（canvasui 的侧栏 tab 依赖它）。
# UI 200 ≠ client-modules 注入完成（首载注入有延迟），同样放宽到 60s 重试。
bs_ok=""
for i in $(seq 1 30); do
  if curl -s --max-time 5 "http://127.0.0.1:$PORT/" | grep -q "better-sidebar/client.js"; then bs_ok=1; break; fi
  sleep 2
done
if [ -z "$bs_ok" ]; then
  echo "✗ 官方 UI 未加载 better-sidebar/client.js（上游 API 变更或挂载失败）"
  tail -20 "$SMOKE_ROOT/boot.log"
  exit 1
fi
echo "✓ better-sidebar client 已挂载"

echo "✓ boot-smoke 全部通过（tarball $(basename "$TARBALL") · sidebar $BS_VER）"
