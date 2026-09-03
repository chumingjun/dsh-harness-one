// react-markdown 的 sanitize 白名单：与画布卡片侧（web/src/MarkdownDocument.jsx）
// 同款配置。独立成纯 .mjs 是为了 node --test 能在无 JSX 加载器环境下直接单测；
// src/react.jsx 具名导入使用。
import { defaultSchema } from 'rehype-sanitize';

// agent 产出的文稿常见「markdown 套 HTML 表格」混合格式：rehype-raw 放行原始
// HTML 后，这里以白名单收口防脚本注入；td/th 的 colspan/rowspan/内联样式放行。
export const markdownSanitizeSchema = {
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
