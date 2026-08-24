import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject as hostInject, name as hostName } from '../src/host.js';
import {
  canPreviewDocument,
  createDocumentPreviewHost,
  documentExtension,
  documentMimeType,
  documentPreviewKind,
  normalizePreviewDocument,
} from '../src/index.js';

test('detects supported preview formats by extension', () => {
  const cases = {
    'notes.txt': 'text', 'readme.md': 'markdown', 'data.json': 'json', 'table.csv': 'csv',
    'photo.PNG': 'image', 'page.html': 'html', 'report.pdf': 'pdf', 'letter.docx': 'docx',
    'legacy.xls': 'sheet', 'book.xlsx': 'sheet', 'slides.pptx': 'pptx',
  };
  for (const [name, kind] of Object.entries(cases)) assert.equal(documentPreviewKind(name), kind, name);
});

test('rejects unsupported legacy DOC and PPT even with conflicting mime', () => {
  assert.equal(documentPreviewKind('legacy.doc'), null);
  assert.equal(documentPreviewKind('legacy.ppt'), null);
  assert.equal(documentPreviewKind('legacy.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), null);
  assert.equal(documentPreviewKind('legacy.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), null);
});

test('normalizes URL and MIME fields', () => {
  assert.equal(documentExtension('/tmp/Book.XLSX'), 'xlsx');
  assert.equal(documentMimeType('book.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.deepEqual(normalizePreviewDocument({ name: 'book.xlsx', url: '/book' }), {
    name: 'book.xlsx', url: '/book', previewUrl: '/book', downloadUrl: '/book',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
});

test('createDocumentPreviewHost exposes pure helper API', () => {
  const host = createDocumentPreviewHost();
  assert.equal(host.name, 'dsh-ccpg-document-preview');
  assert.equal(host.supports({ name: 'a.pdf' }), true);
  assert.equal(host.kind({ name: 'a.ppt' }), null);
  assert.equal(canPreviewDocument({ name: 'a.docx' }), true);
});

test('host entry declares the plugin shape and serves client-assets static files', async () => {
  assert.equal(hostName, 'dsh-ccpg-document-preview');
  assert.deepEqual(hostInject, ['webServer']);
  const routes = [];
  apply({ webServer: { register: (r) => routes.push(r) }, logger: { info() {} } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  const ASSET_ROUTE = '/plugins/dsh-ccpg-document-preview/client-assets';
  assert.equal(routes[0].path, ASSET_ROUTE);
  async function hit(url) {
    const res = { code: 0, headers: {}, writeHead(code, h) { this.code = code; this.headers = h || {}; }, end(b) { this.body = b; } };
    await routes[0].handler({ url }, res);
    return res;
  }
  const css = await hit(`${ASSET_ROUTE}/document-preview.css`);
  assert.equal(css.code, 200);
  assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.ok(css.body.length > 0);
  const traversal = await hit(`${ASSET_ROUTE}/%2e%2e/%2e%2e/package.json`);
  assert.equal(traversal.code, 404);
  const missing = await hit(`${ASSET_ROUTE}/nope.js`);
  assert.equal(missing.code, 404);
});

test('apply tolerates a missing webServer', () => {
  assert.doesNotThrow(() => apply({ logger: { info() {} } }));
});

