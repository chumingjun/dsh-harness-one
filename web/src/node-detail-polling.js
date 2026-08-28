// 节点详情弹窗轮询纯逻辑（issue #52，可单测）：
// nextPollDelayMs —— running 节点持续轮询（1.5s），终态停止；
// shouldAutoSelectTrace —— 首次加载到 trace 且用户尚未手动选 tab 时自动进「执行过程」。

export const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(['success', 'error', 'canceled', 'skipped', 'pending']);

export function nextPollDelayMs(status) {
  return status === 'running' ? POLL_INTERVAL_MS : null;
}

export function shouldAutoSelectTrace(detail, isFirstLoad, userTouchedTab) {
  return Boolean(isFirstLoad && !userTouchedTab && detail?.trace);
}
