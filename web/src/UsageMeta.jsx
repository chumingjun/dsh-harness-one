// 用量展示组件（#64）：节点详情 meta 区 / 成果面板运行级合计共用。
// 口径防误读（issue 核心诉求）：
// - 输入列是「未命中缓存部分」，总输入读取 = input + cacheRead；
// - cacheRead/cacheWrite 计价与全价不同（通常 ~0.1x / ~1.25x），不得拿 token 数直接乘单价算钱；
// - 上游未回报 usage（部分流式调用被砍/provider 未回）时显示「用量无记录」，绝不渲染成 0。
import { formatTokens } from './usage-format.js';

export function UsageMeta({ usage, title }) {
  if (!usage || typeof usage !== 'object') {
    return <span className="usage-meta usage-none" title="本次运行未收到模型侧用量回报（可能是流式调用未回传）">用量无记录</span>;
  }
  const t = title || '输入为未命中缓存部分；总输入读取 = 输入 + 缓存读。缓存读写计价与全价不同，请勿按 token 数直接估算账单金额。';
  return (
    <span className="usage-meta" title={t}>
      <span className="usage-out" title="模型输出 token">↑{formatTokens(usage.outputTokens)}</span>
      <span className="usage-in" title="输入（未命中缓存部分）">↓{formatTokens(usage.inputTokens)}</span>
      {usage.cacheReadTokens ? <span className="usage-cache" title="缓存读（总输入读取 = 输入 + 缓存读）">⇦{formatTokens(usage.cacheReadTokens)}</span> : null}
      {usage.cacheWriteTokens ? <span className="usage-cache" title="缓存写">⇨{formatTokens(usage.cacheWriteTokens)}</span> : null}
    </span>
  );
}
