import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as scheme from '../lib/index.js';
import { SchemeStore, createProject, registerMaterial } from '../lib/core.js';

const sdk = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
const sharp = createRequire(sdk.resolve('@deepseek-ai/dsh-attachment-local'))('sharp');
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-material-routing-'));
  const cwd = join(base, 'project'); const rules = join(base, 'rules');
  await mkdir(cwd); await mkdir(join(rules, 'skills', 'one'), { recursive: true });
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'test', version: '1', resources: [], dataMappings: {},
    chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [{ id: 'brief', required: true }], outputs: [{ id: 'body', kind: 'body' }], blockers: [] }],
  }));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const ctx = new Context();
  const agent = (id, child = false) => ({ ctx, options: { provider: 'test', model: 'vision' }, session: { id, header: { cwd, ...(child ? { origin: 'subagent', parentSession: 'parent' } : {}) }, requestHeader() { return {}; } } });
  const agents = new Map([['parent', agent('parent')], ['child', agent('child', true)], ['other', agent('other', true)]]);
  let modalities = ['text', 'image'];
  for (const [key, value] of Object.entries({
    systemPrompt: { tools() {}, section() {}, getSectionOrder() { return 0; } },
    sessions: { get(id) { return agents.get(String(id))?.session; } },
    webServer: { register() {} }, approval: {}, commands: { register() {} }, connection: {},
    llm: { async resolveModelInfo() { return { inputModalities: modalities }; } },
  })) { ctx.provide(key); ctx.set(key, value); }
  const runtime = new ToolRuntime(ctx);
  const { LocalFileSystem } = await import(sdk.resolve('@deepseek-ai/dsh-fs-local'));
  const { LocalAttachmentStore } = await import(sdk.resolve('@deepseek-ai/dsh-attachment-local'));
  const fsMount = await ctx.plugin(LocalFileSystem, { cwd });
  const attachmentMount = await ctx.plugin(LocalAttachmentStore, { dshHome: join(base, 'home') });
  const toolsMount = await ctx.plugin(await import(sdk.resolve('@deepseek-ai/dsh-tool-fs')), {});
  const schemeMount = await ctx.plugin(scheme, {});
  t.after(async () => { await schemeMount.dispose(); await toolsMount.dispose(); await attachmentMount.dispose(); await fsMount.dispose(); });
  let call = 0;
  const invoke = (name, args, id = 'parent', signal = new AbortController().signal) => runtime.execute({ name, arguments: { projectId: 'p', ...args }, agent: agents.get(id), callId: `routing-${++call}`, signal });
  return { cwd, store, ctx, runtime, invoke, modalities(value) { modalities = value; } };
}

async function pdfFixture(cwd, name, textOnly = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >>${textOnly ? ' /Contents 6 0 R' : ''} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 45 >>\nstream\nBT /F1 12 Tf 20 100 Td (Source text) Tj ET\nendstream',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  await writeFile(join(cwd, name), pdf);
}

test('document-level material completion keeps one material for a multi-image Office file', async (t) => {
  const { cwd, invoke } = await fixture(t);
  const JSZip = createRequire(import.meta.url)('jszip'); const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Two source illustrations</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/media/first.png', png); zip.file('word/media/second.png', png);
  await writeFile(join(cwd, 'two.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const parsed = JSON.parse((await invoke('material_parse', { sourcePath: 'two.docx' })).value);
  assert.equal(parsed.parse.images.length, 2);
  assert.equal(Object.keys(SchemeStore.load(cwd).state.materials).length, 1);
  await writeFile(join(cwd, 'materials/parsed/review.md'), '# Source review\n\nTwo source illustrations are retained as one document-level material.');
  const done = await invoke('material_complete', {
    materialId: parsed.material.id,
    sourceSha256: parsed.parse.sha256,
    markdownPath: 'materials/parsed/review.md',
    review: 'Reviewed once with the native document capabilities.',
    unresolved: []
  });
  assert.equal(done.isError, false, JSON.stringify(done));
  const final = JSON.parse(done.value);
  assert.equal(final.complete, true);
  assert.equal((await invoke('chapter_prepare', { chapterId: 'one', inputBindings: { brief: final.material.id } })).isError, false);
});

test('scanned material remains one reviewable document until native multimodal review completes', async (t) => {
  const { cwd, invoke } = await fixture(t); await writeFile(join(cwd, 'scan.png'), png);
  const parsed = JSON.parse((await invoke('material_parse', { sourcePath: 'scan.png' })).value);
  assert.equal(parsed.material.parseStatus, 'needs-vision');
  await writeFile(join(cwd, 'materials/parsed/scan-review.md'), '# Scan review\n\nThe page is readable only after multimodal review.');
  const done = JSON.parse((await invoke('material_complete', {
    materialId: parsed.material.id,
    sourceSha256: parsed.parse.sha256,
    markdownPath: 'materials/parsed/scan-review.md',
    review: 'Native multimodal review completed with one unresolved field.',
    unresolved: ['one field is unreadable']
  })).value);
  assert.equal(done.complete, false);
  assert.equal(done.material.parseStatus, 'needs-review');
  assert.equal((await invoke('chapter_prepare', { chapterId: 'one', inputBindings: { brief: done.material.id } })).isError, true);
});

test('PDF parsing stays document-level and page rendering is explicit opt-in', async (t) => {
  const { cwd, invoke } = await fixture(t); await pdfFixture(cwd, 'source.pdf');
  const parsed = JSON.parse((await invoke('material_parse', { sourcePath: 'source.pdf' })).value);
  assert.equal(parsed.material.parseStatus, 'needs-vision');
  const rendered = JSON.parse((await invoke('material_render_pages', { sourcePath: 'source.pdf', pages: [2] })).value);
  assert.equal(rendered.images.length, 1);
  for (const name of ['material_visual_batch', 'material_visual_read', 'material_complete_visual']) {
    const legacy = await invoke(name, { materialId: parsed.material.id });
    assert.equal(legacy.isError, true);
    assert.match(legacy.error.message, /unknown tool|not found|unavailable/i);
  }
});

test('project_status does not flood the model with stored cell locations', async (t) => {
  const { store, invoke } = await fixture(t);
  const sourceLocations = Array.from({ length: 10000 }, (_, i) => `Data!A${i + 1}`);
  const material = await registerMaterial(store, { name: 'Workbook', text: 'Source data', metadata: { source: 'project-file', coverage: { sourceLocations } } });
  const status = await invoke('project_status', {});
  assert.equal(status.isError, false);
  assert.ok(Buffer.byteLength(status.value) < 12000);
  const result = JSON.parse(status.value).state.materials[material.id];
  assert.equal(result.coverageCounts.sourceLocations, 10000);
  assert.equal(SchemeStore.load(store.root).state.materials[material.id].metadata.coverage.sourceLocations.length, 10000);
});

test('document review excludes export watermarks from reusable source Markdown', async (t) => {
  const { cwd, store, invoke } = await fixture(t);
  const JSZip = createRequire(import.meta.url)('jszip'); const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Source facts: 55</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/header1.xml', '<w:hdr xmlns:w="urn:word" xmlns:v="urn:vml" xmlns:r="urn:rels"><v:shape id="WordPictureWatermark1"><v:imagedata r:id="rId1"/></v:shape></w:hdr>');
  zip.file('word/_rels/header1.xml.rels', '<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');
  zip.file('word/media/image1.png', png);
  await writeFile(join(cwd, 'export.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const parsed = JSON.parse((await invoke('material_parse', { sourcePath: 'export.docx' })).value);
  const prior = SchemeStore.load(cwd).state.materials[parsed.material.id];
  const text = await readFile(join(cwd, prior.contentPath), 'utf8');
  await writeFile(join(cwd, 'materials/parsed/export-review.md'), `${text}\n\n<!-- export watermark: name/time; ignore -->`);
  const done = JSON.parse((await invoke('material_complete', {
    materialId: prior.id,
    sourceSha256: parsed.parse.sha256,
    markdownPath: 'materials/parsed/export-review.md',
    review: 'The export watermark is presentation metadata and is excluded from source facts.',
    unresolved: []
  })).value);
  assert.equal(done.complete, true);
  const reviewed = await readFile(join(cwd, done.material.contentPath), 'utf8');
  assert.match(reviewed, /Source facts: 55/);
  assert.doesNotMatch(reviewed, /Old name\/time watermark/);
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'pending');
});

test('native document review saves one reusable material without any image receipt or child session', async (t) => {
  const { cwd, invoke } = await fixture(t);
  const JSZip = createRequire(import.meta.url)('jszip'); const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Original number: 55</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/media/logo.png', png);
  await writeFile(join(cwd, 'source.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const parsed = JSON.parse((await invoke('material_parse', { sourcePath: 'source.docx' })).value);
  await writeFile(join(cwd, 'materials/parsed/review.md'), 'The embedded image is the company logo; it adds no project data.');
  const args = { materialId: parsed.material.id, sourceSha256: parsed.parse.sha256, markdownPath: 'materials/parsed/review.md', review: 'Reviewed the whole document using native Office capabilities; body text and logo retained.', unresolved: [] };
  const done = await invoke('material_complete', args);
  assert.equal(done.isError, false, JSON.stringify(done));
  const final = JSON.parse(done.value);
  assert.equal(final.complete, true);
  const text = await readFile(join(cwd, final.material.contentPath), 'utf8');
  assert.match(text, /Original number: 55/); assert.match(text, /company logo/);
  assert.equal((await invoke('material_complete', args)).isError, false);
  const reused = JSON.parse((await invoke('material_parse', { sourcePath: 'source.docx' })).value);
  assert.equal(reused.material.id, final.material.id);
  assert.equal((await invoke('chapter_prepare', { chapterId: 'one', inputBindings: { brief: final.material.id } })).isError, false);
});

test('native material completion rejects changed sources, escaping paths and cancellation, and retains unresolved gaps', async (t) => {
  const { cwd, invoke } = await fixture(t);
  await writeFile(join(cwd, 'source.png'), png);
  const parsed = JSON.parse((await invoke('material_parse', { sourcePath: 'source.png' })).value);
  await writeFile(join(cwd, 'materials/parsed/native.md'), 'Decoded source number: uncertain.');
  const args = { materialId: parsed.material.id, sourceSha256: parsed.parse.sha256, markdownPath: 'materials/parsed/native.md', review: 'Native multimodal interpretation of source.', unresolved: ['number is unreadable'] };
  assert.equal((await invoke('material_complete', { ...args, sourceSha256: 'a'.repeat(64) })).isError, true);
  assert.equal((await invoke('material_complete', { ...args, markdownPath: '../outside.md' })).isError, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await invoke('material_complete', args, 'parent', controller.signal)).isError, true);
  const done = await invoke('material_complete', args);
  assert.equal(done.isError, false, JSON.stringify(done));
  const final = JSON.parse(done.value);
  assert.equal(final.complete, false);
  assert.equal((await invoke('chapter_prepare', { chapterId: 'one', inputBindings: { brief: final.material.id } })).isError, true);
  await writeFile(join(cwd, 'source.png'), Buffer.concat([png, Buffer.from('changed')]));
  assert.equal((await invoke('material_complete', args)).isError, true);
  assert.equal(createHash('sha256').update(await readFile(join(cwd, 'source.png'))).digest('hex') === args.sourceSha256, false);
});

test('native material completion rejects symlinked sources and tampered saved results', async (t) => {
  const { cwd, invoke } = await fixture(t);
  await mkdir(join(cwd, 'input')); await writeFile(join(cwd, 'input/source.png'), png);
  const parsed = JSON.parse((await invoke('material_parse', { sourcePath: 'input/source.png' })).value);
  await writeFile(join(cwd, 'materials/parsed/review.md'), 'Exact source interpretation.');
  const args = { materialId: parsed.material.id, sourceSha256: parsed.parse.sha256, markdownPath: 'materials/parsed/review.md', review: 'Read the source using native capabilities.', unresolved: [] };
  const final = JSON.parse((await invoke('material_complete', args)).value);
  await writeFile(join(cwd, final.material.contentPath), 'tampered');
  assert.equal((await invoke('material_complete', args)).isError, true);
  await rename(join(cwd, 'input'), join(cwd, 'real-input'));
  await symlink(join(cwd, 'real-input'), join(cwd, 'input'));
  const redirected = await invoke('material_complete', args);
  assert.equal(redirected.isError, true); assert.match(redirected.error.message, /symlink/i);
});
