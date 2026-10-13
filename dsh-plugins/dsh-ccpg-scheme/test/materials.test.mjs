import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, symlink, readdir, mkdir, stat, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMaterialFile, renderPdfPages } from '../lib/materials.js';

const require = createRequire(new URL('../../dsh-ccpg-document-preview/package.json', import.meta.url));
const JSZip = require('jszip');

async function writePdfFixture(root, name = 'brief.pdf', text = 'Page one', pages = [{ text }, {}]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids = pages.map((page) => {
    const stream = [
      page.text ? `BT /F1 12 Tf 20 100 Td (${page.text.replace(/[\\()]/g, '\\$&')}) Tj ET` : '',
      page.image ? 'q 50 0 0 50 20 20 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff0000> EI Q' : '',
      page.vector ? '0 0 1 rg 20 20 100 40 re f' : '',
    ].filter(Boolean).join('\n');
    const contentId = objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annotationId = page.annotation ? objects.push('<< /Type /Annot /Subtype /Text /Rect [120 120 140 140] /Contents (Source note not in text layer) >>') : null;
    return objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R${annotationId ? ` /Annots [${annotationId} 0 R]` : ''} >>`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const input = join(root, name); await writeFile(input, pdf);
  return input;
}

test('plain source is preserved, hash reused, and no empty parse is accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-parse-'));
  const input = join(root, 'brief.md'); await writeFile(input, '# 项目\n总车位 55');
  const first = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(first.status, 'complete'); assert.equal(first.reused, false);
  assert.match(await readFile(first.markdownPath, 'utf8'), /总车位 55/);
  const second = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(second.reused, true); assert.equal(second.sha256, first.sha256);
  await writeFile(first.markdownPath, 'tampered');
  assert.equal((await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') })).reused, false);
  await writeFile(join(root, 'empty.txt'), '');
  await assert.rejects(parseMaterialFile({ inputPath: join(root, 'empty.txt'), outputRoot: join(root, 'parsed') }), /empty/i);
  await symlink(input, join(root, 'link.md'));
  await assert.rejects(parseMaterialFile({ inputPath: join(root, 'link.md'), outputRoot: join(root, 'parsed') }), /symlink/i);
});

test('cache reuse validates image bytes and rejects malicious relative paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-cache-'));
  const input = join(root, 'brief.md'); await writeFile(input, '正文');
  const first = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  const target = join(first.markdownPath, '..');
  const cache = JSON.parse(await readFile(join(target, 'parse.json'), 'utf8'));
  cache.images = ['../../outside.png'];
  await writeFile(join(target, 'parse.json'), JSON.stringify(cache));
  await writeFile(join(root, 'outside.png'), 'outside');
  assert.equal((await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') })).reused, false);
  const current = JSON.parse(await readFile(join(target, 'parse.json'), 'utf8'));
  assert.deepEqual(current.images, []);
});

test('output ancestors and source ancestors cannot redirect through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-paths-'));
  const realInput = join(root, 'real', 'brief.md'); await mkdir(join(root, 'real'), { recursive: true }); await writeFile(realInput, '正文');
  await symlink(join(root, 'real'), join(root, 'source-link'));
  await assert.rejects(parseMaterialFile({ inputPath: join(root, 'source-link', 'brief.md'), outputRoot: join(root, 'parsed') }), /symlink/i);
  await mkdir(join(root, 'out-real'), { recursive: true }); await symlink(join(root, 'out-real'), join(root, 'out-link'));
  await assert.rejects(parseMaterialFile({ inputPath: realInput, outputRoot: join(root, 'out-link', 'parsed') }), /symlink/i);
});

test('DOCX preserves body, table numbers and extracted images without treating summary as parse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-docx-'));
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>项目说明 &amp; 原始材料</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>55</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  zip.file('word/media/image1.png', Buffer.from('png-fixture'));
  const input = join(root, 'brief.docx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  const markdown = await readFile(result.markdownPath, 'utf8');
  assert.match(markdown, /项目说明 & 原始材料/); assert.match(markdown, /数量/); assert.match(markdown, /55/);
  assert.equal(result.status, 'needs-review'); assert.equal(result.images.length, 1);
  assert.deepEqual(await readFile(result.images[0]), Buffer.from('png-fixture'));
  assert.equal(result.coverage.method, 'structural-extraction');
});

test('pure text DOCX completes without a visual-reading requirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-docx-text-'));
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Parking spaces: 55</w:t></w:r></w:p></w:body></w:document>');
  const input = join(root, 'text.docx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.match(await readFile(result.markdownPath, 'utf8'), /Parking spaces: 55/);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.coverage.unreadImages, []);
});

test('readable Office preserves images for native document review without forcing visual work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-docx-readable-with-image-'));
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Source facts: 55</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/media/photo.png', Buffer.from('business-image-fixture'));
  const input = join(root, 'readable.docx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'needs-review');
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.coverage.unreadImages, ['images/photo.png']);
  assert.equal(result.coverage.requiresVisual, false);
  assert.match(await readFile(result.markdownPath, 'utf8'), /Source facts: 55/);
});

test('explicit Word watermark is not a visual gap, while reuse in body remains a gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-docx-watermark-'));
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Parking spaces: 55</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/header1.xml', '<w:hdr xmlns:w="urn:word" xmlns:v="urn:vml" xmlns:r="urn:rels"><w:p><v:shape id="WordPictureWatermark1"><v:imagedata r:id="rId1"/></v:shape></w:p></w:hdr>');
  zip.file('word/_rels/header1.xml.rels', '<Relationships><Relationship Id="rId1" Target="media/watermark.png"/></Relationships>');
  zip.file('word/media/watermark.png', Buffer.from('watermark-fixture'));
  const input = join(root, 'watermark.docx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.images, []);
  assert.deepEqual(result.coverage.decorativeImages, ['word/media/watermark.png']);
  assert.match(await readFile(result.markdownPath, 'utf8'), /Parking spaces: 55/);
  zip.file('word/document.xml', '<w:document xmlns:w="urn:word" xmlns:a="urn:drawing" xmlns:r="urn:rels"><w:body><w:p><w:r><w:t>Parking spaces: 55</w:t><a:blip r:embed="rId2"/></w:r></w:p></w:body></w:document>');
  zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId2" Target="media/watermark.png"/></Relationships>');
  await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const mixed = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(mixed.status, 'needs-review'); assert.equal(mixed.images.length, 1);
});

test('Excel worksheet background does not require reading but a drawing using it does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-xlsx-background-'));
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="urn:rels"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns:r="urn:rels"><sheetData><row r="1"><c r="A1"><v>55</v></c></row></sheetData><picture r:id="rId2"/></worksheet>');
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId2" Target="../media/background.png"/></Relationships>');
  zip.file('xl/media/background.png', Buffer.from('background-fixture'));
  const input = join(root, 'background.xlsx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.images, []);
  assert.deepEqual(result.coverage.decorativeImages, ['xl/media/background.png']);
  assert.match(await readFile(result.markdownPath, 'utf8'), /A1: 55/);
  zip.file('xl/drawings/drawing1.xml', '<drawing xmlns:a="urn:drawing" xmlns:r="urn:rels"><a:blip r:embed="rId3"/></drawing>');
  zip.file('xl/drawings/_rels/drawing1.xml.rels', '<Relationships><Relationship Id="rId3" Target="../media/background.png"/></Relationships>');
  await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const mixed = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(mixed.status, 'needs-review'); assert.equal(mixed.images.length, 1);
});

test('a watermark filename, regular header picture and image-only document are not discarded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-docx-keep-images-'));
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Source text</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/header1.xml', '<w:hdr xmlns:w="urn:word" xmlns:v="urn:vml" xmlns:r="urn:rels"><w:p><v:shape id="HeaderPicture1"><v:imagedata r:id="rId1"/></v:shape></w:p></w:hdr>');
  zip.file('word/_rels/header1.xml.rels', '<Relationships><Relationship Id="rId1" Target="media/watermark.png"/></Relationships>');
  zip.file('word/media/watermark.png', Buffer.from('real-image-fixture'));
  const input = join(root, 'keep.docx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const regular = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(regular.status, 'needs-review'); assert.equal(regular.images.length, 1);
  zip.file('word/document.xml', '<w:document xmlns:w="urn:word"><w:body/></w:document>');
  zip.file('word/header1.xml', '<w:hdr xmlns:w="urn:word" xmlns:v="urn:vml" xmlns:r="urn:rels"><w:p><v:shape id="WordPictureWatermark1"><v:imagedata r:id="rId1"/></v:shape></w:p></w:hdr>');
  await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const imageOnly = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(imageOnly.status, 'needs-vision'); assert.equal(imageOnly.images.length, 1);
});

test('pure text PDF completes without rendering pages or requesting visual reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-text-'));
  const input = await writePdfFixture(root, 'text.pdf', '', [{ text: 'Parking spaces: 55' }, { text: 'Staff: 12' }]);
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  const markdown = await readFile(result.markdownPath, 'utf8');
  assert.match(markdown, /Parking spaces: 55/); assert.match(markdown, /Staff: 12/);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.coverage.unreadPages, []);
  assert.deepEqual(result.coverage.visualPages, []);
  assert.deepEqual(result.images, []);
});

test('PDF extraction and page counting work when the Desktop host restricts builtin module require', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-desktop-'));
  const input = await writePdfFixture(root, 'text.pdf', '', [{ text: 'Parking spaces: 55' }]);
  const materialsUrl = new URL('../lib/materials.js', import.meta.url).href;
  for (const firstOperation of ['parse', 'render', 'electron-utility']) {
    const code = `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      if (${JSON.stringify(firstOperation)} === 'electron-utility') {
        Object.defineProperty(process.versions, 'electron', { value: '44.0.0' });
        process.type = 'utility';
      }
      const builtin = process.getBuiltinModule;
      const restricted = (name) => name === 'module' ? {} : builtin(name);
      process.getBuiltinModule = restricted;
      const { parseMaterialFile, renderPdfPages } = await import(${JSON.stringify(materialsUrl)});
      const inputPath = ${JSON.stringify(input)};
      const parse = () => parseMaterialFile({ inputPath, outputRoot: ${JSON.stringify(join(root, firstOperation, 'parsed'))} });
      const render = () => renderPdfPages({ inputPath, outputRoot: ${JSON.stringify(join(root, firstOperation, 'rendered'))}, pages: [1] });
      let parsed; let rendered;
      if (${JSON.stringify(firstOperation)} === 'parse') { parsed = await parse(); rendered = await render(); }
      else { rendered = await render(); parsed = await parse(); }
      assert.match(await readFile(parsed.markdownPath, 'utf8'), /Parking spaces: 55/);
      assert.equal(parsed.status, 'complete');
      assert.deepEqual(parsed.images, []);
      assert.equal(rendered.coverage.pageCount, 1);
      assert.equal((await readFile(rendered.images[0])).subarray(1, 4).toString(), 'PNG');
      assert.equal(process.getBuiltinModule, restricted);
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 60000 });
  }
});

test('PDF text beside an image retains a content review requirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-text-image-'));
  const input = await writePdfFixture(root, 'mixed.pdf', '', [{ text: 'Parking spaces: 55', image: true }]);
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'needs-review');
  assert.deepEqual(result.coverage.unreadPages, []);
  assert.deepEqual(result.coverage.visualPages, [1]);
});

test('readable PDF requests document review without turning an image page into mandatory visual work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-readable-with-image-'));
  const input = await writePdfFixture(root, 'readable-image.pdf', '', [{ text: 'Source facts: 55', image: true }]);
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'needs-review');
  assert.deepEqual(result.coverage.visualPages, [1]);
  assert.equal(result.coverage.requiresVisual, false);
});

test('mixed PDF visual coverage includes only image and scanned pages, preserving text-layer coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-mixed-'));
  const input = await writePdfFixture(root, 'mixed.pdf', '', [
    { text: 'Text-only first page' },
    { text: 'A caption beside an image', image: true },
    { image: true },
    { text: 'Text-only last page' },
  ]);
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'needs-vision');
  assert.deepEqual(result.coverage.unreadPages, [3]);
  assert.deepEqual(result.coverage.visualPages, [2, 3]);
  assert.deepEqual(result.images, []);
});

test('PDF vector content and annotations are not declared complete just because text was extracted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-visual-content-'));
  const input = await writePdfFixture(root, 'visual.pdf', '', [
    { text: 'Text-only page' },
    { text: 'Chart caption', vector: true },
    { text: 'Annotated text', annotation: true },
  ]);
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'needs-review');
  assert.deepEqual(result.coverage.unreadPages, []);
  assert.deepEqual(result.coverage.visualPages, [2, 3]);
});

test('PDF reads text layer with page locations and scanned blank pages remain unverified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-'));
  const stream = 'BT /F1 12 Tf 20 100 Td (Parking spaces: 55) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const input = join(root, 'brief.pdf'); await writeFile(input, pdf);
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.match(await readFile(result.markdownPath, 'utf8'), /Parking spaces: 55/);
  assert.equal(result.status, 'needs-vision'); assert.equal(result.coverage.pages, 2);
  assert.deepEqual(result.coverage.unreadPages, [2]);
  assert.equal((await readdir(join(root, 'parsed'))).length, 1);
});

test('PDF renders only selected pages and keeps visual coverage pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-render-'));
  const input = await writePdfFixture(root);
  const result = await renderPdfPages({ inputPath: input, outputRoot: join(root, 'rendered'), pages: [1] });
  assert.deepEqual(result.pages, [1]);
  assert.equal(result.images.length, 1);
  assert.equal((await stat(result.images[0])).isFile(), true);
  assert.equal(result.reused, false);
  assert.equal(result.coverage.visualVerified, false);
});

test('Office page requests hand the original back to native document reading without a system converter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-office-render-'));
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Page one</w:t><w:br w:type="page"/><w:t>Page two</w:t></w:r></w:p></w:body></w:document>');
  const input = join(root, 'brief.docx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputRoot = join(root, 'rendered');
  const first = await renderPdfPages({ inputPath: input, outputRoot, pages: [2] });
  assert.deepEqual(first.pages, []); assert.deepEqual(first.images, []);
  assert.equal(first.sourcePath, await realpath(input));
  assert.equal(first.coverage.requiresDocumentRead, true);
  assert.match(first.nextAction, /original Office document/);
  assert.equal(first.coverage.visualVerified, false);
  const parsed = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.match(await readFile(parsed.markdownPath, 'utf8'), /Page one[\s\S]*Page two/);
  assert.equal(await readFile(input, 'base64'), (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64'));
});

test('PDF render cache reuses normalized page selections and separates source or selection changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-render-reuse-'));
  const input = await writePdfFixture(root);
  const outputRoot = join(root, 'rendered');
  const first = await renderPdfPages({ inputPath: input, outputRoot, pages: [2, 1] });
  const second = await renderPdfPages({ inputPath: input, outputRoot, pages: 'all', maxPages: 2 });
  assert.equal(second.reused, true);
  assert.deepEqual(second.pages, first.pages);
  assert.deepEqual(second.images, first.images);
  assert.equal(second.coverage.visualVerified, false);
  assert.equal(second.coverage.visualVerification, 'pending-model-result');
  const changedSelection = await renderPdfPages({ inputPath: input, outputRoot, pages: [1] });
  assert.equal(changedSelection.reused, false);
  const changedDpi = await renderPdfPages({ inputPath: input, outputRoot, pages: [1], dpi: 72 });
  assert.equal(changedDpi.reused, false);
  assert.notDeepEqual(changedDpi.images, changedSelection.images);
  await writePdfFixture(root, 'brief.pdf', 'Changed source');
  const changedSource = await renderPdfPages({ inputPath: input, outputRoot, pages: [1, 2] });
  assert.equal(changedSource.reused, false);
});

test('PDF render cache validates image bytes before reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-render-tamper-'));
  const input = await writePdfFixture(root);
  const outputRoot = join(root, 'rendered');
  const first = await renderPdfPages({ inputPath: input, outputRoot, pages: [1] });
  await writeFile(first.images[0], 'tampered');
  const second = await renderPdfPages({ inputPath: input, outputRoot, pages: [1] });
  assert.equal(second.reused, false);
  assert.notDeepEqual(await readFile(second.images[0]), Buffer.from('tampered'));
});

test('PDF render cache rejects poisoned metadata paths and oversized sources before native rendering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-render-safety-'));
  const input = await writePdfFixture(root);
  const outputRoot = join(root, 'rendered');
  await renderPdfPages({ inputPath: input, outputRoot, pages: [1] });
  const [cacheName] = await readdir(outputRoot);
  const metadataPath = join(outputRoot, cacheName, 'render.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.match(metadata.rendererVersion, /^\d+\.\d+\.\d+/);
  metadata.images[0].path = '../../outside.png';
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(join(root, 'outside.png'), 'outside');
  await assert.rejects(renderPdfPages({ inputPath: input, outputRoot, pages: [1] }), /unsafe|cache image/i);
  await assert.rejects(renderPdfPages({ inputPath: input, outputRoot: join(root, 'too-large'), pages: [1], maxBytes: 2 }), /too large/i);
  await assert.rejects(renderPdfPages({ inputPath: input, outputRoot: join(root, 'out-of-range'), pages: [3] }), /exceeds 2 pages/i);
  await assert.rejects(renderPdfPages({ inputPath: input, outputRoot: join(root, 'too-many'), pages: 'all', maxPages: 1 }), /page limit/i);
});

test('PDF render cache rejects symlink sources, output ancestors, metadata and images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-render-links-'));
  const input = await writePdfFixture(root);
  const outputRoot = join(root, 'rendered');
  await symlink(input, join(root, 'source.pdf'));
  await assert.rejects(renderPdfPages({ inputPath: join(root, 'source.pdf'), outputRoot }), /symlink/i);
  await mkdir(join(root, 'output-real'));
  await symlink(join(root, 'output-real'), join(root, 'output-link'));
  await assert.rejects(renderPdfPages({ inputPath: input, outputRoot: join(root, 'output-link', 'rendered') }), /symlink/i);
  const first = await renderPdfPages({ inputPath: input, outputRoot, pages: [1] });
  const [cacheName] = await readdir(outputRoot);
  const metadataPath = join(outputRoot, cacheName, 'render.json');
  const savedMetadata = join(root, 'saved-render.json');
  await rename(metadataPath, savedMetadata);
  await symlink(savedMetadata, metadataPath);
  await assert.rejects(renderPdfPages({ inputPath: input, outputRoot, pages: [1] }), /symlink/i);
  const otherRoot = join(root, 'other-rendered');
  const other = await renderPdfPages({ inputPath: input, outputRoot: otherRoot, pages: [1] });
  const savedImage = join(root, 'saved-image.png');
  await rename(other.images[0], savedImage);
  await symlink(first.images[0], other.images[0]);
  await assert.rejects(renderPdfPages({ inputPath: input, outputRoot: otherRoot, pages: [1] }), /symlink/i);
});

test('PDF render cache invalidates changed renderer metadata and never trusts visual confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-pdf-render-version-'));
  const input = await writePdfFixture(root);
  const outputRoot = join(root, 'rendered');
  await renderPdfPages({ inputPath: input, outputRoot, pages: [1] });
  const [cacheName] = await readdir(outputRoot);
  const metadataPath = join(outputRoot, cacheName, 'render.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.coverage = { visualVerified: true, visualVerification: 'verified' };
  await writeFile(metadataPath, JSON.stringify(metadata));
  const reused = await renderPdfPages({ inputPath: input, outputRoot, pages: [1] });
  assert.equal(reused.reused, true);
  assert.equal(reused.coverage.visualVerified, false);
  assert.equal(reused.coverage.visualVerification, 'pending-model-result');
  metadata.rendererVersion = '0.0.0';
  await writeFile(metadataPath, JSON.stringify(metadata));
  assert.equal((await renderPdfPages({ inputPath: input, outputRoot, pages: [1] })).reused, false);
});

test('image inputs preserve the original image for native multimodal interpretation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-image-'));
  const input = join(root, 'photo.png'); await writeFile(input, Buffer.from('png-fixture'));
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'needs-vision');
  assert.equal(result.images.length, 1);
  assert.deepEqual(await readFile(result.images[0]), Buffer.from('png-fixture'));
});

test('xlsx embedded media is preserved for document review instead of an unsupported part', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-material-xlsx-media-'));
  const source = join(root, 'media.xlsx');
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>value</t></is></c></row></sheetData></worksheet>');
  zip.file('xl/media/image1.png', Buffer.from('image bytes'));
  await writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await parseMaterialFile({ inputPath: source, outputRoot: join(root, 'parsed') });
  assert.equal(result.status, 'needs-review'); assert.equal(result.images.length, 1);
  assert.deepEqual(result.coverage.unreadImages, ['images/image1.png']);
  assert.deepEqual(result.coverage.unsupportedParts, []);
});

test('XLSX extraction preserves worksheet structure, formulas, stored values, and source cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-xlsx-'));
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="停车位" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>');
  zip.file('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>车位数</t></si><si><r><t>备注</t></r></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>55.00</v></c><c r="B2"><f>SUM(A1:A1)</f><v>0</v></c></row></sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>');
  zip.file('xl/tables/table1.xml', '<table name="ParkingTable" ref="A1:C2"><tableColumns><tableColumn name="车位数"/><tableColumn name="合计"/><tableColumn name="备注"/></tableColumns></table>');
  const input = join(root, 'brief.xlsx'); await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') });
  const markdown = await readFile(result.markdownPath, 'utf8');
  assert.match(markdown, /停车位/); assert.match(markdown, /55\.00/); assert.match(markdown, /B2/);
  assert.match(markdown, /SUM\(A1:A1\)/); assert.match(markdown, /stored value: 0/);
  assert.match(markdown, /A3:B3/); assert.match(markdown, /ParkingTable/);
  assert.match(markdown, /A1/); assert.match(markdown, /C1/);
  assert.equal(result.coverage.method, 'ooxml-structural-extraction');
});

test('Office archive limits reject excessive entries before extraction and preserve prior cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-zip-limits-'));
  const input = join(root, 'brief.docx'); const zip = new JSZip();
  zip.file('word/document.xml', '<document><p><r><t>正文</t></r></p></document>');
  await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputRoot = join(root, 'parsed');
  const first = await parseMaterialFile({ inputPath: input, outputRoot });
  await writeFile(first.markdownPath, 'invalidate cache');
  await assert.rejects(parseMaterialFile({ inputPath: input, outputRoot, maxArchiveEntries: 0 }), /entry limit/i);
  assert.equal(await readFile(first.markdownPath, 'utf8'), 'invalidate cache');
});

test('corrupt Office input and out-of-range size are explicit failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-invalid-'));
  const input = join(root, 'bad.docx'); await writeFile(input, 'not an office zip');
  await assert.rejects(parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed') }), /zip|corrupt|invalid/i);
  await assert.rejects(parseMaterialFile({ inputPath: input, outputRoot: join(root, 'parsed'), maxBytes: 2 }), /too large/i);
});
