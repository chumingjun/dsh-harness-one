import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DocumentPreviewButton } from 'dsh-ccpg-document-preview/react';
import { findArtifactByName } from './ArtifactPreview.jsx';

// files：本次运行的产物清单。正文里用行内 code 引用的产物文件名（`xxx.md`）
// 命中清单时渲染成可点击按钮，点击直接开预览弹窗。
export default function MarkdownDocument({ content, files = [] }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
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
