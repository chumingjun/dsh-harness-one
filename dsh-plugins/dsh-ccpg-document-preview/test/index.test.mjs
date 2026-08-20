import assert from 'node:assert/strict';
import test from 'node:test';
import Host, {
  canPreviewDocument,
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

test('Host default export exposes pure helper API', () => {
  const host = Host();
  assert.equal(host.name, 'dsh-ccpg-document-preview');
  assert.equal(host.supports({ name: 'a.pdf' }), true);
  assert.equal(host.kind({ name: 'a.ppt' }), null);
  assert.equal(canPreviewDocument({ name: 'a.docx' }), true);
});
