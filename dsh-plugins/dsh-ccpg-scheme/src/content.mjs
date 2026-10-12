import { mapDocumentImages } from '../lib/document-images.js';
export { PLACEHOLDER_SPLIT, PLACEHOLDER_TOKEN } from '../lib/document-review.js';

const MAX_BYTES = 25 * 1024 * 1024;

export function safeDownloadName(value) {
  return String(value || 'attachment').replace(/^.*\//, '').replace(/[\\\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 180) || 'attachment';
}

export function attachmentBytes(item) {
  if (typeof item?.base64 === 'string') {
    if (item.base64.length > MAX_BYTES * 4 / 3 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.base64)) throw new Error('Invalid attachment base64');
    return Uint8Array.from(atob(item.base64), (character) => character.charCodeAt(0));
  }
  if (typeof item?.content !== 'string') throw new Error('Attachment content unavailable');
  const bytes = new TextEncoder().encode(item.content);
  if (bytes.length > MAX_BYTES) throw new Error('Attachment exceeds 25 MiB');
  return bytes;
}

export function safeImageSource(value) {
  if (typeof value !== 'string' || value.length > MAX_BYTES * 4 / 3 + 100 || !/^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return '';
  return value;
}

export function resolveImageSource(value, images = {}) {
  if (safeImageSource(value)) return value;
  try {
    for (const key of [value, decodeURIComponent(value)]) if (Object.hasOwn(images, key)) return safeImageSource(images[key]);
  } catch {}
  return '';
}

export function attachmentImage(item) {
  const extension = item?.name?.match(/\.(png|jpe?g|gif|webp)$/i)?.[1]?.toLowerCase();
  if (!extension || !item?.base64) return '';
  return safeImageSource(`data:image/${extension.startsWith('jp') ? 'jpeg' : extension};base64,${item.base64}`);
}

export function needsMarkdownFallback(value, images = {}) {
  const text = value || '';
  if (/<\/?[a-z][a-z\d-]*(?:\s[^>]*|\s*\/?)>|<!--/i.test(text)) return true;
  let unresolved = false;
  mapDocumentImages(text, (source) => { if (!resolveImageSource(source, images)) unresolved = true; });
  // shortcut: reference-style images retain source editing; add editor support when needed.
  return unresolved || /!\[[^\]]*\](?!\()/.test(text);
}

export function attachmentText(item) {
  if (typeof item?.content === 'string') return item.content.length <= 1024 * 1024 ? item.content : null;
  if (!/\.(?:md|markdown|txt|csv|json|log)$/i.test(item?.name || '')) return null;
  try {
    const bytes = attachmentBytes(item);
    return bytes.length <= 1024 * 1024 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null;
  } catch { return null; }
}
