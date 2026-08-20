import { Download, ExternalLink, Eye, FileText, Link2, PackageOpen } from 'lucide-react';
import { ArtifactLinks, ArtifactPreviewButton } from './ArtifactPreview.jsx';
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

function FileList({ files }) {
  const directFiles = files.filter((file) => file.url || file.downloadUrl);
  const legacyFiles = files.filter((file) => !file.url && !file.downloadUrl);
  const orphanFiles = legacyFiles.filter((file) => !file.nodeLabel && !file.nodeId);
  return (
    <div className="result-file-list">
      {directFiles.map((file) => {
        const artifact = { ...file, downloadUrl: file.downloadUrl || file.url };
        return (
          <div className="result-file" key={`${file.nodeId || file.nodeLabel || ''}:${file.path}`}>
            <span className="result-file-name">{file.name}</span>
            {file.nodeLabel && <span className="result-file-source">{file.nodeLabel}</span>}
            <ArtifactPreviewButton artifact={artifact} className="result-file-action">
              <Eye size={14} aria-hidden="true" />
            </ArtifactPreviewButton>
            <a className="result-file-action" href={artifact.downloadUrl} download title="下载文件" aria-label={`下载 ${file.name}`}>
              <Download size={14} aria-hidden="true" />
            </a>
          </div>
        );
      })}
      <LegacyArtifacts files={legacyFiles} />
      {orphanFiles.map((file) => (
        <div className="result-file result-file-disabled" key={file.path} title="接口未提供文件下载地址或产物节点">
          <span className="result-file-name">{file.name}</span>
        </div>
      ))}
    </div>
  );
}

function LinkList({ links }) {
  return (
    <div className="result-link-list">
      {links.map((link) => (
        <a className="result-link" href={link.url} target="_blank" rel="noopener noreferrer" key={link.url}>
          <span>{link.label || link.url}</span>
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}

export function ResultViewer({
  title = '最终成果',
  coreText = '',
  files = [],
  links = [],
  emptyText = '本次运行没有生成最终成果。',
  legacyInferred = false,
}) {
  return (
    <div className="result-viewer">
      <section className="result-block result-core">
        <div className="result-section-head">
          <PackageOpen size={15} />
          <h4>{title}</h4>
          {legacyInferred && <span className="result-legacy-badge">历史推断</span>}
        </div>
        {coreText ? (
          <article className="result-markdown markdown-preview">
            <MarkdownDocument content={coreText} />
          </article>
        ) : <p className="result-empty result-final-empty">{emptyText}</p>}
      </section>

      {files.length > 0 && (
        <section className="result-block">
          <div className="result-section-head">
            <Download size={15} />
            <h4>最终文件</h4>
            <span className="result-count">{files.length}</span>
          </div>
          <FileList files={files} />
        </section>
      )}

      {links.length > 0 && (
        <section className="result-block">
          <div className="result-section-head">
            <Link2 size={15} />
            <h4>最终链接</h4>
            <span className="result-count">{links.length}</span>
          </div>
          <LinkList links={links} />
        </section>
      )}
    </div>
  );
}

export function ProcessArtifacts({ results = [], files = [] }) {
  const textResults = results.filter((row) => row.output);
  if (!textResults.length && !files.length) return null;
  return (
    <details className="result-process-artifacts">
      <summary>
        <span>过程产出</span>
        <span>{textResults.length + files.length}</span>
      </summary>
      <div className="result-process-artifacts-body">
        {textResults.map((row) => (
          <details className="result-process-output" key={row.nodeId}>
            <summary>{row.nodeLabel}</summary>
            <article className="result-markdown markdown-preview">
              <MarkdownDocument content={row.output} />
            </article>
          </details>
        ))}
        {files.length > 0 && (
          <section className="result-block">
            <div className="result-section-head">
              <FileText size={15} />
              <h4>过程文件</h4>
              <span className="result-count">{files.length}</span>
            </div>
            <FileList files={files} />
          </section>
        )}
      </div>
    </details>
  );
}

export default ResultViewer;
