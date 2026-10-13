function headingInfo(value) {
  const title = String(value || '').replace(/[*`]/g, '').trim();
  return {
    title,
    code: title.match(/^(\d+(?:\.\d+)+)(?:[.、]?\s|$)/)?.[1] || '',
  };
}

export function splitReviewSections(body = '') {
  const kept = []; const blocks = []; let block = null; let fence = null; let lastHeading = null;
  for (const line of String(body).split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      (block ? block.lines : kept).push(line);
      continue;
    }
    const heading = !fence && line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading && block && heading[1].length <= block.level) { blocks.push(block); block = null; }
    if (heading && /^(?:\d+(?:\.\d+)*[.、]?\s*)?(待确认事项|待核实事项|待核对事项|待确认项|待确认问题)$/.test(heading[2].replace(/[*`]/g, '').trim())) {
      if (block) blocks.push(block);
      block = { level: heading[1].length, lines: [], section: lastHeading };
    } else {
      (block ? block.lines : kept).push(line);
      if (heading) lastHeading = headingInfo(heading[2]);
    }
  }
  if (block) blocks.push(block);
  const messages = blocks.flatMap(({ lines, section }) => {
    const items = []; let current = [];
    const pushCurrent = () => {
      const message = current.join('\n').trim();
      if (message) items.push({
        message,
        ...(section?.code ? { sectionCode: section.code } : {}),
        ...(section?.title ? { sectionLabel: section.title } : {}),
      });
      current = [];
    };
    for (const line of lines) {
      const start = line.match(/^\s*(?:\d+[.)、]|[-*+])\s+(.+)$/);
      if (start) { pushCurrent(); current = [start[1]]; }
      else current.push(line.trim());
    }
    pushCurrent();
    return items;
  });
  const bodyText = String(body);
  const outputBody = blocks.length ? kept.join('\n').trim() : bodyText;
  return {
    body: outputBody,
    items: messages.map(({ message, ...location }, index) => ({
      id: `body-review-${index + 1}`,
      message,
      ...location,
      status: 'pending',
      required: true,
    })),
  };
}

export function documentReview({ body = '', confirmations = [], confirmed = false } = {}) {
  const extracted = splitReviewSections(stripGenerationNotes(body));
  let section = null; let fence = null;
  for (const line of extracted.body.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) { section = headingInfo(heading[1]); continue; }
    if (!line.replace(/(`+).*?\1/g, '').split(PLACEHOLDER_SPLIT).some((part) => PLACEHOLDER_TOKEN.test(part))) continue;
    extracted.items.push({
      id: `inline-review-${extracted.items.length + 1}`, message: line.trim(),
      ...(section?.code ? { sectionCode: section.code } : {}),
      ...(section?.title ? { sectionLabel: section.title } : {}),
      status: 'pending', required: true,
    });
  }
  const items = [];
  // Inline gaps belong to the current text; independent business checks survive edits.
  const currentConfirmations = confirmations.filter(item => !/^inline-review-/.test(item.id || '')
    || extracted.items.some(current => current.message === item.message && current.sectionCode === item.sectionCode));
  for (const item of [...currentConfirmations, ...extracted.items]) {
    const duplicate = items.find((prior) => String(prior.message || '').trim() === String(item.message || '').trim()
      && (!prior.sectionCode || !item.sectionCode || prior.sectionCode === item.sectionCode));
    if (!duplicate) {
      items.push({ ...item });
      continue;
    }
    if (!duplicate.sectionCode && item.sectionCode) duplicate.sectionCode = item.sectionCode;
    if (!duplicate.sectionLabel && item.sectionLabel) duplicate.sectionLabel = item.sectionLabel;
    if (!duplicate.headingAnchor && item.headingAnchor) duplicate.headingAnchor = item.headingAnchor;
    if (item.status && (duplicate.id === item.id || !duplicate.status)) duplicate.status = item.status;
    if (/^inline-review-/.test(duplicate.id || '')) duplicate.status = 'pending';
  }
  return { body: extracted.body, items: items.map((item) => ({ ...item, status: confirmed ? 'confirmed' : item.status || 'pending' })) };
}
export const PLACEHOLDER_SPLIT = /(\{\{[^}\n]+\}\}|\[(?:待补充|待确认|待核验|待核实|待填写|需补充)[^\]\n]*\]|(?:待补充|待确认|待核验|待核实|待填写|需补充|TODO|TBD|XXX|XX项目))/gi;
export const PLACEHOLDER_TOKEN = /^(?:\{\{[^}\n]+\}\}|\[(?:待补充|待确认|待核验|待核实|待填写|需补充)[^\]\n]*\]|待补充|待确认|待核验|待核实|待填写|需补充|TODO|TBD|XXX|XX项目)$/i;

export function stripGenerationNotes(body = '') {
  const kept = []; let fence = null; let dropping = false;
  for (const line of String(body).split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      dropping = false;
    }
    if (!fence && !marker) {
      if (!line.trim() || /^ {0,3}#{1,6}\s|^\s*\|/.test(line)) dropping = false;
      const text = line.replace(/^\s*>\s?/, '').replace(/[*`]/g, '').trim();
      // Only self-referential compilation notes; ordinary contractual/legal basis stays.
      if (/^(?:本章|本表|本节|本方案|本章节|该表|该章).*(?:依据|基于|根据).*(?:编制|生成|整理)/.test(text)
        || /^(?:编制说明|生成说明|材料来源说明)[：:]/.test(text)) dropping = true;
      if (dropping) continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

