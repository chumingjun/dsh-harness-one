// 节点变量引用：提示词/输入文本中用 {{节点名}} 或 {{节点ID}} 引用上游节点输出。
// 规则：
// - 只有直接上游的输出可引用；引用了不可用的变量时保留原文字样并在 provenance 里报告
// - {{@节点名}}：引用该上游输出，仅当它执行成功；失败/跳过时整段（含前一空行）被移除
// - 内置变量：{{$trigger}}（本次运行触发输入）、{{$upstream}}（全部直接上游的带标注拼接，兼容旧行为）
// - 文本中没有任何 {{...}} 且存在上游 → 回退为全量上游注入（旧行为），保证旧图不破

export const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

// 渲染模板。ctx: { outputs: Map<id,string>, labels: Map<id,string>, incomingIds: [id], triggerInput }
// 返回 { text, missing: [varName], used: [nodeId] }
export function renderTemplate(template, ctx) {
  const missing = [];
  const used = new Set();
  const { outputs, labels, incomingIds, triggerInput } = ctx;
  const upstreamSet = new Set(incomingIds);

  const resolve = (name) => {
    if (name === '$trigger') return triggerInput || '';
    if (name === '$upstream') {
      const parts = incomingIds.map((id) => outputs.get(id)).filter(Boolean)
        .map((out, i) => `── 来自 [${labels.get(incomingIds[i]) || incomingIds[i]}] ──\n${out}`);
      return parts.join('\n\n');
    }
    if (name.startsWith('@')) {
      const key = name.slice(1);
      const id = matchNode(key, upstreamSet, labels);
      if (id == null) { missing.push(key); return null; } // null = 整段移除
      used.add(id);
      return outputs.get(id) ?? '';
    }
    const id = matchNode(name, upstreamSet, labels);
    if (id == null) { missing.push(name); return `{{${name}}}`; } // 保留原样
    used.add(id);
    return outputs.get(id) ?? '';
  };

  // 先处理 {{@...}} 的段落移除语义：以空行分隔的段为单位
  const segments = String(template ?? '').split(/\n\n+/);
  const outSegs = [];
  for (const seg of segments) {
    let drop = false;
    const rendered = seg.replace(VAR_RE, (full, name) => {
      if (!name.startsWith('@')) return full;
      const v = resolve(name);
      if (v === null) { drop = true; return full; }
      return v;
    });
    if (!drop) {
      // 段内再渲染普通变量
      outSegs.push(rendered.replace(VAR_RE, (full, name) => {
        const v = resolve(name);
        return v === null ? full : v;
      }));
    }
  }
  let text = outSegs.join('\n\n');

  // 兼容回退：模板没出现任何变量且存在上游 → 全量注入
  const hasAnyVar = VAR_RE.test(String(template ?? '')) || String(template ?? '').includes('{{');
  if (!hasAnyVar && incomingIds.length > 0 && outputs.size > 0) {
    const parts = [];
    for (const id of incomingIds) {
      const out = outputs.get(id);
      if (!out) continue;
      parts.push(`── 来自 [${labels.get(id) || id}] ──\n${out}`);
    }
    const upstream = parts.join('\n\n');
    text = text ? `${text}\n\n${upstream}` : upstream;
    incomingIds.forEach((id) => used.add(id));
  }

  return { text, missing: [...new Set(missing)], used: [...used] };
}

// 按名字或 ID 匹配上游节点（精确名 > 精确 ID > 忽略大小写的名）
function matchNode(key, upstreamSet, labels) {
  for (const id of upstreamSet) {
    if ((labels.get(id) || '') === key) return id;
  }
  for (const id of upstreamSet) {
    if (id === key) return id;
  }
  for (const id of upstreamSet) {
    if ((labels.get(id) || '').toLowerCase() === key.toLowerCase()) return id;
  }
  return null;
}
