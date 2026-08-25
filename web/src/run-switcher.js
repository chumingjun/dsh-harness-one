// RunSwitcher 胶囊模型（纯函数，可单测）：
// 合并 /runs 列表与本地已见运行，按「LIVE 优先、开始时间倒序」排序，截断展示。

export const SOURCE_ICON = { manual: '▶', schedule: '⏰', webhook: '🪝', resume: '↻', replay: '↺', assistant: '✦' };
export const SOURCE_LABEL = { manual: '手动', schedule: '定时', webhook: 'Webhook', resume: '续跑', replay: '重放', assistant: '助手' };

export function switcherCapsules(runs, { max = 6 } = {}) {
  const list = [...(runs || [])];
  list.sort((a, b) => {
    const liveDiff = Number(Boolean(b.live)) - Number(Boolean(a.live));
    if (liveDiff) return liveDiff;
    return new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime();
  });
  const shown = list.slice(0, max);
  return {
    shown: shown.map((r) => ({
      runId: r.runId,
      status: r.live ? 'running' : r.status,
      live: Boolean(r.live),
      source: r.source || 'manual',
      startedAt: r.startedAt,
      progress: r.live && r.progress ? `${r.progress.done ?? '?'}/${r.progress.total ?? '?'}` : null,
      resumedFrom: Boolean(r.resumedFrom),
    })),
    overflow: Math.max(0, list.length - shown.length),
  };
}

export function capsuleTime(startedAt) {
  if (!startedAt) return '';
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}
