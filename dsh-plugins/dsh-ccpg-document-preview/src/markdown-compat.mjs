// LLM 产出的中文文稿常见两类非规范 markdown，规范渲染器按原文漏出：
// 1. GFM 表格缺 | --- | --- | 分隔行（分隔行是 GFM 规范强制的表头定界）
// 2. **粗体**紧贴中文（闭定界符前后是汉字/全角标点）——CommonMark 侧翼规则
//    按西文空白判定，CJK 文本里定界符无法闭合，星号原样漏出
// 这里提供统一插件清单与纯字符串预处理，供预览弹窗（src/react.jsx）与画布
// 卡片（web/src/MarkdownDocument.jsx）两条渲染管线共用；独立纯 .mjs 是为了
// node --test 在无 JSX 加载器环境下直接单测。
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';

// remark-cjk-friendly 须在 gfm 之前注册（改写 emphasis 侧翼分类）
export const markdownRemarkPlugins = [remarkCjkFriendly, remarkGfm];

// 分隔行识别：GFM 允许 |:---| 与 |---:| 等对齐变体，单元格只含 -、=、:
// （宽松匹配），不匹配则该行组按普通段落处理。
const DELIMITER_CELL = /^:?[-=]+:?$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;

// 竖线行：非空、含 |、非分隔行自身；行内代码片段与 \| 转义不参与分列
// （与 GFM 的表格分列规则一致，列数才不会算错）。
function pipeRowCells(line) {
  if (!line.includes('|')) return null;
  const bare = line.replace(/`[^`]*`/g, '').replace(/\\\|/g, '·');
  if (!bare.trim() || !bare.includes('|')) return null;
  const cells = bare.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
  return cells.length >= 2 ? cells : null;
}

function isDelimiterRow(line) {
  const cells = pipeRowCells(line);
  return Boolean(cells) && cells.every((cell) => DELIMITER_CELL.test(cell.trim()));
}

// 连续竖线行构成隔离段落且不含分隔行时，在首行后补一行等宽分隔行。
// 已带分隔行的合法表格、散落在正文段落中的竖线行原样返回。
export function repairMissingTableDelimiter(text) {
  if (!text || !text.includes('|')) return text;
  const lines = text.split('\n');
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[2][0].repeat(3);
      out.push(line);
      index += 1;
      while (index < lines.length && !lines[index].includes(marker)) { out.push(lines[index]); index += 1; }
      if (index < lines.length) { out.push(lines[index]); index += 1; }
      continue;
    }
    if (!pipeRowCells(line)) { out.push(line); index += 1; continue; }
    const block = [];
    while (index < lines.length && pipeRowCells(lines[index])) { block.push(lines[index]); index += 1; }
    if (block.length >= 2 && !block.some(isDelimiterRow)) {
      const width = pipeRowCells(block[0]).length;
      out.push(block[0], `|${' --- |'.repeat(width)}`);
      out.push(...block.slice(1));
    } else out.push(...block);
  }
  return out.join('\n');
}
