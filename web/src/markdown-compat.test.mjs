// 卡片侧 markdown 兼容层回归：共享模块经 dsh-ccpg-document-preview/markdown
// 导入（file: 软链），管线用 web 自己的依赖组装，插件清单与
// MarkdownDocument.jsx 同款（cjk-friendly 在 gfm 前）+ 预处理。
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { markdownRemarkPlugins, repairMissingTableDelimiter } from 'dsh-ccpg-document-preview/markdown';

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup', 'caption', 'br',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'style', 'align', 'colspan', 'rowspan'],
  },
};

const render = async (content) => String(await unified()
  .use(remarkParse)
  .use(markdownRemarkPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeStringify)
  .process(repairMissingTableDelimiter(content)));

// 实况样例一：缺分隔行的多列中文表格（原样漏出整段竖线）
const table = await render(
  '| 配套用房/场地 | 配套场地：1栋一层老人活动中心；活动场地：中心广场。 | 配套场地分散于多栋架空层。 |\n'
  + '| 管理用房 | 物业服务中心共计3间，管理用房不足。 | 沟通增加物业用房。 |',
);
assert.match(table, /<th>配套用房\/场地<\/th>/);
assert.match(table, /<td>管理用房<\/td>/);
assert.ok(!table.includes('| 管理用房'), table);

// 实况样例二：闭定界符前是全角冒号、后紧贴汉字的粗体（星号原样漏出）
const bold = await render('**周边环境概述：**项目位于深圳市南山区海德一道200号，地处南山商业文化中心区。');
assert.match(bold, /<strong>周边环境概述：<\/strong>项目位于深圳市南山区/);
assert.ok(!bold.includes('**'), bold);

// 已带分隔行的合法表格与常规语法不回归
assert.match(await render('| a | b |\n| --- | --- |\n| 1 | 2 |'), /<td>1<\/td>/);
assert.match(await render('正常 **粗体** 正常'), /<strong>粗体<\/strong>/);
assert.match(await render('[链接](https://example.com)'), /href="https:\/\/example.com"/);

console.log('✓ markdown-compat（卡片侧管线）：缺分隔行表格 + CJK 粗体修复与常规回归全部通过');
