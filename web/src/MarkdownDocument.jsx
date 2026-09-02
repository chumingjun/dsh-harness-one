import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { DocumentPreviewButton } from 'dsh-ccpg-document-preview/react';
import { findArtifactByName } from './ArtifactPreview.jsx';

// agent 产出的文稿常见「markdown 套 HTML 表格」混合格式：不开 raw 解析时
// <table>/<br/> 等标签整面转义成源码墙。rehype-raw 放行原始 HTML，
// rehype-sanitize 白名单收口防脚本注入；td/th 的 vertical-align 等内联样式属性放行。
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

// files：本次运行的产物清单。正文里用行内 code 引用的产物文件名（`xxx.md`）
// 命中清单时渲染成可点击按钮，点击直接开预览弹窗。
export default function MarkdownDocument({ content, files = [] }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        // 窄面板里表格列被挤压错位：套一层横向滚动容器，表格保持自然宽度
        table: ({ node, ...props }) => <div className="md-table-wrap"><table {...props} /></div>,
        code: ({ node, className, children, ...props }) => {
          const text = String(children ?? '');
          const inline = !className && !text.includes('\n');
          const artifact = inline && files.length ? findArtifactByName(files, text) : null;
          if (artifact) {
            return (
              <DocumentPreviewButton document={artifact} className="md-file-link" title={`预览 ${artifact.name}`}>
                <code {...props}>{text}</code>
              </DocumentPreviewButton>
            );
          }
          return <code {...props} className={className}>{children}</code>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
