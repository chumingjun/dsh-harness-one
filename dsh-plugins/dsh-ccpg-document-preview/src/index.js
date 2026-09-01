export const MIME_BY_EXTENSION = Object.freeze({
  avif: 'image/avif', csv: 'text/csv', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif', html: 'text/html', htm: 'text/html', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  json: 'application/json', log: 'text/plain', md: 'text/markdown', mdown: 'text/markdown',
  pdf: 'application/pdf', png: 'image/png', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain',
  univer: 'application/x-univer', webp: 'image/webp', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

const KIND_BY_MIME = Object.freeze({
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/x-univer': 'univer',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'markdown',
  'text/plain': 'text',
});

const IMAGE_MIMES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const LEGACY_EXTENSIONS = new Set(['doc', 'ppt']);

function baseMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

export function documentExtension(name) {
  const leaf = String(name || '').split(/[\\/]/).pop() || '';
  const dot = leaf.lastIndexOf('.');
  return dot > -1 ? leaf.slice(dot + 1).toLowerCase() : '';
}

export function documentMimeType(name, mimeType) {
  return baseMime(mimeType) || MIME_BY_EXTENSION[documentExtension(name)] || '';
}

export function documentPreviewKind(name, mimeType) {
  const extension = documentExtension(name);
  if (LEGACY_EXTENSIONS.has(extension)) return null;
  const mime = documentMimeType(name, mimeType);
  if (mime === 'application/msword' || mime === 'application/vnd.ms-powerpoint') return null;
  if (IMAGE_MIMES.has(mime)) return 'image';
  return KIND_BY_MIME[mime] || null;
}

export function canPreviewDocument(document) {
  return Boolean(document && documentPreviewKind(document.name, document.mimeType));
}

export function normalizePreviewDocument(document) {
  if (!document || typeof document !== 'object') throw new TypeError('document is required');
  const name = String(document.name || 'document');
  const mimeType = documentMimeType(name, document.mimeType);
  return {
    ...document,
    name,
    mimeType,
    previewUrl: document.previewUrl || document.url || '',
    downloadUrl: document.downloadUrl || document.url || document.previewUrl || '',
  };
}

export function previewErrorMessage(reason) {
  if (reason?.name === 'AbortError') return '';
  if (reason?.status === 404) return '文件不存在或已随运行历史清理。';
  if (reason?.status === 409) return '当前工作区会话已失效，请刷新页面后重试。';
  if (reason?.status >= 500) return '文档服务暂时不可用，请稍后重试。';
  const raw = String(reason?.message || reason || '');
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return '文档加载失败，请检查连接后重试。';
  }
  return raw || '文档加载失败，请稍后重试。';
}

export async function fetchPreviewResponse(url, options = {}) {
  if (!url) throw new Error('预览地址缺失，无法加载文档。');
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...options });
  } catch (reason) {
    if (reason?.name === 'AbortError') throw reason;
    const error = new Error(previewErrorMessage(reason));
    error.code = 'preview-network-error';
    error.cause = reason;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(previewErrorMessage({ status: response.status }));
    error.status = response.status;
    error.code = response.status === 404 ? 'preview-not-found' : response.status === 409 ? 'preview-session-required' : 'preview-http-error';
    throw error;
  }
  return response;
}

export async function loadPreviewText(url, options = {}) {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const response = await fetchPreviewResponse(url, { signal: options.signal });
  const declaredSize = Number(response.headers.get('content-length') || 0);
  const message = `Text preview exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB`;
  if (declaredSize > maxBytes) throw new Error(message);
  const text = await response.text();
  if (new Blob([text]).size > maxBytes) throw new Error(message);
  return text;
}

export async function loadPreviewArrayBuffer(url, options = {}) {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const response = await fetchPreviewResponse(url, { signal: options.signal });
  const declaredSize = Number(response.headers.get('content-length') || 0);
  const message = `Document preview exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB`;
  if (declaredSize > maxBytes) throw new Error(message);
  const data = await response.arrayBuffer();
  if (data.byteLength > maxBytes) throw new Error(message);
  return data;
}

export function createDocumentPreviewHost() {
  return {
    name: 'dsh-ccpg-document-preview',
    supports: (document) => canPreviewDocument(document),
    kind: (document) => documentPreviewKind(document?.name, document?.mimeType),
    normalize: normalizePreviewDocument,
  };
}
