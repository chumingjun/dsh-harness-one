import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // dist/ 是构建产物不入库：CI checkout 后可能不存在，命中测试用临时产物目录的文件
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client-assets');
  const fixtureAvailable = existsSync(assetsDir);
  if (fixtureAvailable) {
    const css = await hit(`${ASSET_ROUTE}/document-preview.css`);
    assert.equal(css.code, 200);
    assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');
    assert.ok(css.body.length > 0);
  }
  const traversal = await hit(`${ASSET_ROUTE}/%2e%2e/%2e%2e/package.json`);
  assert.equal(traversal.code, 404);
  const missing = await hit(`${ASSET_ROUTE}/nope.js`);
  assert.equal(missing.code, 404);
});

test('apply tolerates a missing webServer', () => {
  assert.doesNotThrow(() => apply({ logger: { info() {} } }));
});


// ---- univer 渲染器纯函数 ----

test('univer: .univer maps to univer kind and previewable', () => {
  assert.equal(documentPreviewKind('报表.univer'), 'univer');
  assert.equal(documentMimeType('报表.univer'), 'application/x-univer');
  assert.equal(canPreviewDocument({ name: '报表.univer' }), true);
});



test('univer-core: resolveEndpointOf/fileKeyOf/pickWorktree 纯函数', async () => {
  const { resolveEndpointOf, fileKeyOf, pickWorktree } = await import('../src/univer-core.js');
  // resolve 端点推导：run 形态与 legacy 形态都取同基址；非 artifact 路径拒绝
  assert.equal(
    resolveEndpointOf('http://x/wf1/api/artifact?run=r1&node=n1&file=a.univer'),
    'http://x/wf1/api/univer/resolve?run=r1&node=n1&file=a.univer',
  );
  assert.equal(
    resolveEndpointOf('/wf1/api/artifact?node=数据节点&file=%E6%8A%A5%E8%A1%A8.univer'),
    '/wf1/api/univer/resolve?node=数据节点&file=%E6%8A%A5%E8%A1%A8.univer',
  );
  assert.equal(resolveEndpointOf('http://x/other?file=a.univer'), '');
  assert.equal(resolveEndpointOf(''), '');
  // fileKeyOf 与 host 侧 fileKeyOf 同语义：utf8 base64url（纯 Web API，浏览器可用）
  assert.equal(fileKeyOf('/tmp/a.univer'), Buffer.from('/tmp/a.univer', 'utf8').toString('base64url'));
  assert.equal(fileKeyOf('/tmp/中文名.univer'), Buffer.from('/tmp/中文名.univer', 'utf8').toString('base64url'));
  // worktree 选择：最新 draft 优先 → 无 draft 取最新 → 空列表 null
  assert.equal(pickWorktree([]), null);
  assert.equal(pickWorktree(null), null);
  assert.equal(pickWorktree([{ worktreeId: 'a', status: 'merged', createdAt: '2026-01-01' }]), 'a');
  assert.equal(pickWorktree([
    { worktreeId: 'old', status: 'draft', createdAt: '2026-01-01' },
    { worktreeId: 'new', status: 'draft', createdAt: '2026-02-01' },
    { worktreeId: 'm', status: 'merged', createdAt: '2026-03-01' },
  ]), 'new');
  assert.equal(pickWorktree([
    { worktreeId: 'm1', status: 'merged', createdAt: '2026-01-01' },
    { worktreeId: 'm2', status: 'merged', createdAt: '2026-05-01' },
  ]), 'm2');
});
