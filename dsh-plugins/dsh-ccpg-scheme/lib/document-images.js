// Standard inline Markdown images; keep fenced examples literal.
export function mapDocumentImages(markdown, transform) {
  return String(markdown || '').split(/(^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[^\n]*(?:\n|$))/gm).map((part, index) => index % 2 ? part : part.replace(/!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^()\n]*\)[^\s()]*)*))(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g, (match, alt, angled, plain, title = '') => {
    const source = angled ?? plain;
    const next = transform(source, alt);
    return next == null || next === source ? match : `![${alt}](<${next}>${title})`;
  })).join('');
}

export function imageMime(bytes) {
  if (bytes[0] === 0x89 && bytes.subarray(1, 8).toString('hex') === '504e470d0a1a0a') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('unsupported image bytes: use PNG, JPEG, GIF or WebP');
}
