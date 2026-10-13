import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const name of Object.keys(manifest.dependencies)) {
  assert(!/libreoffice-kit|@napi-rs\/canvas|koffi|sharp/.test(name), `platform-specific runtime dependency: ${name}`);
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (/libreoffice-kit|@napi-rs\/canvas|koffi|sharp/.test(specifier)) throw new Error(`native runtime forbidden: ${specifier}`);
    return next(specifier, context);
  },
});
const root = mkdtempSync(join(tmpdir(), 'scheme-portable-'));
try {
  const { parseMaterialFile, renderPdfPages } = await import('../lib/materials.js');
  const { createWordDocument } = await import('../lib/word.js');
  const inputPath = join(root, 'source.pdf');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 12 Tf 10 100 Td (Portable facts: 55) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, value] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${value}\nendobj\n`; }
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  writeFileSync(inputPath, pdf);
  const parsed = await parseMaterialFile({ inputPath, outputRoot: join(root, 'parsed') });
  assert.equal(parsed.status, 'complete');
  assert.match(readFileSync(parsed.markdownPath, 'utf8'), /Portable facts: 55/);
  const rendered = await renderPdfPages({ inputPath, outputRoot: join(root, 'rendered'), pages: [1] });
  assert.equal(readFileSync(rendered.images[0]).subarray(1, 4).toString(), 'PNG');
  const asset = { path: 'page.png', mime: 'image/png', base64: readFileSync(rendered.images[0]).toString('base64') };
  const word = await createWordDocument({ markdown: '前文\n\n![图片](page.png)\n\n后文', assets: [asset] });
  const zip = await JSZip.loadAsync(word);
  const xml = await zip.file('word/document.xml').async('string');
  assert(xml.indexOf('前文') < xml.indexOf('<w:drawing>'));
  assert(xml.indexOf('<w:drawing>') < xml.indexOf('后文'));
  const image = Object.values(zip.files).find((file) => file.name.startsWith('word/media/') && !file.dir);
  assert.deepEqual(await image.async('nodebuffer'), Buffer.from(asset.base64, 'base64'));
} finally {
  hooks.deregister();
  rmSync(root, { recursive: true, force: true });
}
console.log('✓ PDF text/render and Word images without any native OS dependency');
