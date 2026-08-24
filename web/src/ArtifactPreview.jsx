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

/** 新架构产物 URL：run + nodeId 定位节点工作区/运行快照（后端 /wf1/api/artifact） */
function runArtifact(runId, nodeId, file) {
  const query = `run=${encodeURIComponent(runId)}&node=${encodeURIComponent(nodeId)}&file=${encodeURIComponent(file)}`;
  const base = apiUrl(`/artifact?${query}`);
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

/** 文件名本体可点击：可预览→开预览弹窗；不可预览→退化为下载链接；无地址→纯文本 */
export function ArtifactNameLink({ artifact, className = 'artifact-name', children }) {
  const normalized = normalizeArtifact(artifact);
  const label = children ?? normalized.name;
  if (normalized.previewUrl && documentPreviewKind(normalized.name, normalized.mimeType)) {
    return (
      <DocumentPreviewButton document={normalized} className={`${className} ${className}-link`} title={`预览 ${normalized.name}`}>
        {label}
      </DocumentPreviewButton>
    );
  }
  if (normalized.downloadUrl) {
    return (
      <a className={`${className} ${className}-link`} href={normalized.downloadUrl} download title={`下载 ${normalized.name}`}>
        {label}
      </a>
    );
  }
  return <span className={className} title={normalized.name}>{label}</span>;
}

/** 按文件名在产物清单里反查可预览 artifact（正文行内引用点击预览用） */
export function findArtifactByName(files = [], name) {
  const target = String(name || '').trim();
  if (!target) return null;
  const hit = files.find((f) => f && (f.name === target
    || String(f.path || '').split('/').filter(Boolean).at(-1) === target));
  if (!hit) return null;
  if (hit.previewUrl || hit.url || hit.downloadUrl) return normalizeArtifact(hit);
  if (hit.nodeLabel && hit.path) return legacyArtifact(hit.nodeLabel, hit.path);
  return null;
}

export function ArtifactLinks({ nodeLabel, runId, nodeId, artifacts = [] }) {
  const files = artifacts.filter((file) => file && !file.endsWith('/'));
  const dirs = artifacts.filter((file) => file?.endsWith('/'));
  const artifactFor = (file) => (
    runId && nodeId ? runArtifact(runId, nodeId, file) : legacyArtifact(nodeLabel, file)
  );

  return (
    <div className="artifact-list">
      {files.map((file) => {
        const artifact = artifactFor(file);
        return (
          <div key={file} className="artifact-row">
            <ArtifactNameLink artifact={artifact} className="artifact-name" />
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
