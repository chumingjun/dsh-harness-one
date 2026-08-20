import { basename, relative, resolve, sep } from 'node:path';

export function safeFileId(value, fallback = 'item') {
  const clean = String(value ?? '')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 180);
  return clean || fallback;
}

export function safeFilename(value, fallback = 'file') {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  const name = basename(normalized).replace(/[\u0000-\u001f]/g, '').slice(0, 240);
  return name && name !== '.' && name !== '..' ? name : fallback;
}

export function resolveInside(baseDir, requestedPath) {
  const base = resolve(baseDir);
  const target = resolve(base, String(requestedPath ?? ''));
  const rel = relative(base, target);
  if (rel === '') return target;
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.includes('\u0000')) return null;
  return target;
}
