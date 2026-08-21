import { Download, Eye } from 'lucide-react';
import {
  DocumentPreviewButton,
  DocumentPreviewDialog,
  documentMimeType,
  documentPreviewKind,
} from 'dsh-ccpg-document-preview/react';
import 'dsh-ccpg-document-preview/styles.css';
import { apiUrl } from './api.js';

function normalizeArtifact(artifact) {
  const name = artifact?.name || artifact?.path || 'document';
  return {
    ...artifact,
    name,
    mimeType: documentMimeType(name, artifact?.mimeType),
    previewUrl: artifact?.previewUrl || artifact?.url || '',
    downloadUrl: artifact?.downloadUrl || artifact?.url || artifact?.previewUrl || '',
  };
}

function legacyArtifact(nodeLabel, file) {
  const base = apiUrl(`/artifact?node=${encodeURIComponent(nodeLabel)}&file=${encodeURIComponent(file)}`);
  return normalizeArtifact({
    name: file,
    previewUrl: `${base}&preview=1`,
    downloadUrl: base,
  });
}

export function ArtifactPreviewModal({ artifact, onClose }) {
  return <DocumentPreviewDialog document={normalizeArtifact(artifact)} onClose={onClose} title="文件预览" />;
}

export function ArtifactPreviewButton({ artifact, className = 'artifact-action', children = '预览' }) {
  const normalized = normalizeArtifact(artifact);
  if (!normalized.previewUrl || !documentPreviewKind(normalized.name, normalized.mimeType)) return null;
  return <DocumentPreviewButton document={normalized} className={className} title={`预览 ${normalized.name}`}>{children}</DocumentPreviewButton>;
}

export function ArtifactLinks({ nodeLabel, artifacts = [] }) {
  const files = artifacts.filter((file) => file && !file.endsWith('/'));
  const dirs = artifacts.filter((file) => file?.endsWith('/'));

  return (
    <div className="artifact-list">
      {files.map((file) => {
        const artifact = legacyArtifact(nodeLabel, file);
        return (
          <div key={file} className="artifact-row">
            <span className="artifact-name" title={file}>{file}</span>
            <span className="artifact-actions">
              <ArtifactPreviewButton artifact={artifact}>
                <Eye size={14} aria-hidden="true" />
              </ArtifactPreviewButton>
              <a className="artifact-action" href={artifact.downloadUrl} download title={`下载 ${file}`} aria-label={`下载 ${file}`}>
                <Download size={14} aria-hidden="true" />
              </a>
            </span>
          </div>
        );
      })}
      {dirs.map((dir) => <div key={dir} className="artifact-row artifact-dir">{dir}</div>)}
    </div>
  );
}
