// token 数格式化：千位以上用 k/m 简写，避免 meta 区被 7 位数撑爆。
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}
