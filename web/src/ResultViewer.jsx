import { Download, ExternalLink, Eye, FileText, Link2 } from 'lucide-react';
import { ArtifactLinks } from './ArtifactPreview.jsx';
import MarkdownDocument from './MarkdownDocument.jsx';

function LegacyArtifacts({ files }) {
  const groups = new Map();
  for (const file of files) {
    const key = file.nodeLabel || file.nodeId || '';
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file.path);
  }
  return [...groups.entries()].map(([nodeLabel, artifacts]) => (
    <div className="result-file-group" key={nodeLabel}>
      <span className="result-file-source">{nodeLabel}</span>
      <ArtifactLinks nodeLabel={nodeLabel} artifacts={artifacts} />
    </div>
  ));
}

export function ResultViewer({ coreText = '', files = [], links = [] }) {
  const directFiles = files.filter((file) => file.url);
  const legacyFiles = files.filter((file) => !file.url);
  const orphanFiles = legacyFiles.filter((file) => !file.nodeLabel && !file.nodeId);

  return (
    <div className="result-viewer">
      <section className="result-block result-core">
        <div className="result-section-head">
          <FileText size={15} />
          <h4>核心文本</h4>
        </div>
        {coreText ? (
          <article className="result-markdown markdown-preview">
            <MarkdownDocument content={coreText} />
          </article>
        ) : <p className="result-empty">本次运行没有核心文本。</p>}
      </section>

      {(files.length > 0) && (
        <section className="result-block">
          <div className="result-section-head">
            <Download size={15} />
            <h4>文件</h4>
            <span className="result-count">{files.length}</span>
          </div>
          <div className="result-file-list">
            {directFiles.map((file) => (
              <div className="result-file" key={`${file.nodeLabel || ''}:${file.path}`}>
                <span className="result-file-name">{file.name}</span>
                {file.nodeLabel && <span className="result-file-source">{file.nodeLabel}</span>}
                {file.previewUrl && (
                  <a className="result-file-action" href={file.previewUrl} target="_blank" rel="noopener noreferrer" title="预览文件" aria-label={`预览 ${file.name}`}>
                    <Eye size={14} aria-hidden="true" />
                  </a>
                )}
                <a className="result-file-action" href={file.url} download title="下载文件" aria-label={`下载 ${file.name}`}>
                  <Download size={14} aria-hidden="true" />
                </a>
              </div>
            ))}
            <LegacyArtifacts files={legacyFiles} />
            {orphanFiles.map((file) => (
              <div className="result-file result-file-disabled" key={file.path} title="接口未提供文件下载地址或产物节点">
                <span className="result-file-name">{file.name}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {(links.length > 0) && (
        <section className="result-block">
          <div className="result-section-head">
            <Link2 size={15} />
            <h4>链接</h4>
            <span className="result-count">{links.length}</span>
          </div>
          <div className="result-link-list">
            {links.map((link) => (
              <a className="result-link" href={link.url} target="_blank" rel="noopener noreferrer" key={link.url}>
                <span>{link.label || link.url}</span>
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default ResultViewer;
