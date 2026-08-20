import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiUrl } from './api.js';
import { Modal } from './ui.jsx';

const MarkdownDocument = lazy(() => import('./MarkdownDocument.jsx'));
const isMarkdown = (file) => /\.md(?:own)?$/i.test(file || '');

function artifactUrl(nodeLabel, file) {
  return apiUrl(`/artifact?node=${encodeURIComponent(nodeLabel)}&file=${encodeURIComponent(file)}`);
}

function MarkdownPreview({ nodeLabel, file, onClose }) {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const url = artifactUrl(nodeLabel, file);

  useEffect(() => {
    let alive = true;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
        return res.text();
      })
      .then((text) => alive && setContent(text))
      .catch((err) => alive && setError(err?.message || String(err)));
    return () => { alive = false; };
  }, [url]);

  return (
    <Modal className="artifact-preview-modal" title={`预览 · ${file}`} onClose={onClose} footer={(
      <>
        <a className="btn" href={url} download>下载原文件</a>
        <button className="btn btn-primary" onClick={onClose}>关闭</button>
      </>
    )}>
      {error && <p className="panel-error">{error}</p>}
      {!error && !content && <p className="panel-empty">正在加载文档…</p>}
      {content && (
        <article className="markdown-preview">
          <Suspense fallback={<p className="panel-empty">正在准备预览…</p>}>
            <MarkdownDocument content={content} />
          </Suspense>
        </article>
      )}
    </Modal>
  );
}

export function ArtifactLinks({ nodeLabel, artifacts = [] }) {
  const [previewFile, setPreviewFile] = useState(null);
  const files = artifacts.filter((file) => file && !file.endsWith('/'));
  const dirs = artifacts.filter((file) => file?.endsWith('/'));

  return (
    <>
      <div className="artifact-list">
        {files.map((file) => {
          const url = artifactUrl(nodeLabel, file);
          return (
            <div key={file} className="artifact-row">
              <span className="artifact-name" title={file}>{file}</span>
              <span className="artifact-actions">
                {isMarkdown(file) && (
                  <button type="button" className="artifact-action" onClick={() => setPreviewFile(file)}>预览</button>
                )}
                <a className="artifact-action" href={url} download>下载</a>
              </span>
            </div>
          );
        })}
        {dirs.map((dir) => <div key={dir} className="artifact-row artifact-dir">{dir}</div>)}
      </div>
      {previewFile && createPortal(
        <MarkdownPreview nodeLabel={nodeLabel} file={previewFile} onClose={() => setPreviewFile(null)} />,
        document.body,
      )}
    </>
  );
}
