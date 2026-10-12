import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeishuConnector } from '../lib/connectors.js';

test('feishu connector reads document snapshots through explicit current-user CLI', async () => {
  const calls = [];
  const connector = createFeishuConnector({
    now: () => '2026-10-09T00:00:00.000Z',
    larkUserCli: {
      run(args) {
        calls.push(args);
        return Promise.resolve({
          ok: true,
          data: {
            document_id: 'doccn123',
            revision_id: 12,
            content: '# Title\n\nBody',
          },
        });
      },
    },
  });

  const snapshot = await connector.readResource({ type: 'document', url: 'https://example.feishu.cn/docx/doccn123' });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.content, '# Title\n\nBody');
  assert.equal(snapshot.metadata.source, 'feishu');
  assert.equal(snapshot.metadata.resourceId, 'doccn123');
  assert.equal(snapshot.metadata.revisionId, 12);
  assert.deepEqual(calls[0], ['docs', '+fetch', '--doc', 'https://example.feishu.cn/docx/doccn123', '--doc-format', 'markdown', '--scope', 'full', '--as', 'user']);
});

test('feishu connector blocks unsupported resources and permission failures clearly', async () => {
  const connector = createFeishuConnector({
    larkUserCli: { run: () => Promise.resolve({ ok: false, error: { message: 'forbidden: no permission' } }) },
  });
  assert.deepEqual(await connector.readResource({ type: 'base', url: 'base-token' }), {
    ok: false,
    code: 'unsupported-resource',
    error: 'Feishu resource type base is not supported by this connector yet',
  });
  const denied = await connector.readResource({ type: 'document', url: 'doc_1' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'permission-denied');
});

test('feishu publish persists intent before CLI and records uncertain create without retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-feishu-pub-'));
  const artifactPath = join(root, 'artifact.md');
  const logPath = join(root, 'publications.ndjson');
  await writeFile(artifactPath, '# Final\n');
  const calls = [];
  const connector = createFeishuConnector({
    now: () => '2026-10-09T00:00:00.000Z',
    larkUserCli: {
      run(args) {
        calls.push(args);
        return Promise.resolve({ ok: true, data: { title: 'Final but no id' } });
      },
    },
  });

  await assert.rejects(
    () => connector.publishDocument({ artifactPath, title: 'Final', target: { mode: 'create' }, receiptPath: logPath }),
    /confirmed/i,
  );
  const result = await connector.publishDocument({
    artifactPath,
    title: 'Final',
    target: { mode: 'create', parentToken: 'fld123' },
    confirmed: true,
    receiptPath: logPath,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'uncertain');
  assert.equal(calls.length, 1, 'uncertain create must not be repeated blindly');
  assert.deepEqual(calls[0], ['docs', '+create', '--title', 'Final', '--doc-format', 'markdown', '--content', '@./content.md', '--parent-token', 'fld123', '--as', 'user']);
  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[0].event, 'intent');
  assert.equal(records[0].artifact.sha256.length, 64);
  assert.equal(records[1].event, 'receipt');
  assert.equal(records[1].status, 'uncertain');
});

test('publication uses an immutable relative snapshot and verifies remote content before success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-pub-snapshot-'));
  const artifactPath = join(root, 'body.md');
  const receiptPath = join(root, 'receipt.ndjson');
  await writeFile(artifactPath, '# 正文\n车位 55\n');
  const calls = [];
  const connector = createFeishuConnector({ larkUserCli: { async run(args, options) {
    calls.push(args);
    if (args[1] === '+create') {
      await writeFile(artifactPath, 'new local edits');
      const content = args[args.indexOf('--content') + 1];
      assert.ok(content.startsWith('@./'));
      assert.equal(await readFile(join(options.cwd, content.slice(2)), 'utf8'), '# 正文\n车位 55\n');
      return { ok: true, data: { document: { document_id: 'doc123', revision_id: 1, url: 'https://example.feishu.cn/docx/doc123' } } };
    }
    return { ok: true, data: { document: { document_id: 'doc123', revision_id: 1, content: '# 正文\n车位 55\n' } } };
  } } });
  const result = await connector.publishDocument({ artifactPath, target: { mode: 'create', parentToken: 'folder123' }, confirmed: true, receiptPath, operationId: 'publish-1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verified, true);
  assert.equal(calls.length, 2);
  const again = await connector.publishDocument({ artifactPath, target: { mode: 'create', parentToken: 'folder123' }, confirmed: true, receiptPath, operationId: 'publish-1' });
  assert.equal(again.reused, true);
  assert.equal(calls.length, 2);
});

test('warnings and remote mismatch are uncertain, and update requires matching remote base', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-pub-verify-'));
  const artifactPath = join(root, 'body.md'); await writeFile(artifactPath, '# Expected\n55');
  let writes = 0;
  const connector = createFeishuConnector({ larkUserCli: { async run(args) {
    if (['+create', '+update'].includes(args[1])) { writes++; return { ok: true, data: { document: { document_id: 'doc123' }, warnings: ['media skipped'] } }; }
    return { ok: true, data: { document: { document_id: 'doc123', revision_id: 2, content: 'remote edits' } } };
  } } });
  assert.equal((await connector.publishDocument({ artifactPath, confirmed: true, target: { mode: 'create', parentToken: 'folder123' } })).code, 'uncertain');
  await assert.rejects(connector.publishDocument({ artifactPath, confirmed: true, target: { mode: 'update', doc: 'doc123' } }), /base|revision/i);
  const conflict = await connector.publishDocument({ artifactPath, confirmed: true, target: { mode: 'update', doc: 'doc123', revisionId: 1, sha256: 'f'.repeat(64) } });
  assert.equal(conflict.code, 'remote-conflict');
  assert.equal(writes, 1);
});

test('publication accepts Feishu Markdown serialization while rejecting changed content and structure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-pub-markdown-'));
  const artifactPath = join(root, 'body.md');
  const body = '# 管理\n\n| 项目 | 值 |\n| --- | --- |\n| 车位 | 55 |\n\n版本 V\\[年\\]\n\n[来源](https://example.com/source)\n';
  const remote = body.replace('| --- | --- |', '|-|-|').replace('V\\[年\\]', 'V[年]');
  await writeFile(artifactPath, body);
  const publish = (content) => createFeishuConnector({ larkUserCli: { async run(args) {
    if (args[1] === '+create') return { ok: true, data: { document_id: 'doc' } };
    return { ok: true, data: { document: { content, revision_id: 1 } } };
  } } }).publishDocument({ artifactPath, confirmed: true, target: { mode: 'create' } });
  assert.equal((await publish(remote)).ok, true);
  for (const changed of [
    remote.replace('55', '56'),
    remote.replace('# 管理', '## 管理'),
    remote.replace('| 车位 | 55 |', '| 55 | 车位 |'),
    remote.replace('/source', '/different'),
    remote.replace('| 车位 | 55 |\n', ''),
  ]) assert.equal((await publish(changed)).code, 'uncertain');
});

test('delivery reconciles completed remote writes after verification failure without creating duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-delivery-reconcile-'));
  const body = '# 正文\n\n| 项目 | 值 |\n| --- | --- |\n| 数量 | 55 |\n\n版本 V\\[年\\]\n';
  const artifactPath = join(root, '完整方案.md');
  await writeFile(artifactPath, body);
  const receiptPath = join(root, 'receipt.ndjson');
  const snapshot = { directory: root, artifactPath, markdown: body, attachments: [], revision: 1, digest: 'fixed' };
  let remote = 'incomplete';
  let writes = 0;
  const connector = createFeishuConnector({ larkUserCli: { async run(args) {
    if (args[1] === '+create-folder') { writes++; return { ok: true, data: { token: 'folder' } }; }
    if (args[1] === '+create') { writes++; return { ok: true, data: { document_id: 'doc' } }; }
    if (args[1] === '+fetch') return { ok: true, data: { content: remote, revision_id: 2 } };
    if (args[1] === 'files') return { ok: true, data: { files: [{ token: 'doc' }] } };
    throw new Error('unexpected write during reconciliation');
  } } });
  const publish = () => connector.publishDelivery({ snapshot, receiptPath, operationId: 'same', confirmed: true, target: { mode: 'create' } });
  assert.equal((await publish()).code, 'uncertain');
  assert.equal((await publish()).code, 'uncertain', 'real content mismatch must remain blocked');
  remote = body.replace('| --- | --- |', '|-|-|').replace('V\\[年\\]', 'V[年]');
  const recovered = await publish();
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.verified, true);
  assert.equal(recovered.body.token, 'doc');
  assert.equal(writes, 2);

  const lostPath = join(root, 'lost.ndjson');
  await writeFile(lostPath, [
    { event: 'intent', operationId: 'lost', step: 'folder' },
    { event: 'receipt', operationId: 'lost', step: 'delivery', status: 'uncertain', result: { ok: false, code: 'uncertain' } },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal((await connector.publishDelivery({ snapshot, receiptPath: lostPath, operationId: 'lost', confirmed: true, target: { mode: 'create' } })).code, 'uncertain');
  assert.equal(writes, 2, 'unknown cloud write outcome must never be replayed');
  await writeFile(lostPath, JSON.stringify({ event: 'intent', operationId: 'crashed', step: 'folder' }) + '\n');
  assert.equal((await connector.publishDelivery({ snapshot, receiptPath: lostPath, operationId: 'crashed', confirmed: true, target: { mode: 'create' } })).code, 'uncertain');
  assert.equal(writes, 2, 'a crash before the final receipt must not duplicate an unknown write');
});

test('spreadsheet read preserves exact typed values and rejects incomplete coverage', async () => {
  const calls = [];
  const connector = createFeishuConnector({ larkUserCli: { async run(args) {
    calls.push(args);
    return { ok: true, data: { sheets: [{ name: '材料表', range: 'A1:B3', columns: ['字段', '值'], data: [['编号', '000001234567890123'], ['车位', 55]], dtypes: { 字段: 'object', 值: 'object' } }] } };
  } } });
  const resource = await connector.readResource({ type: 'sheets', url: 'https://example.feishu.cn/sheets/sheet123', sheetId: 'data', range: 'A1:B3' });
  assert.equal(resource.ok, true);
  assert.match(resource.content, /000001234567890123/);
  assert.equal(resource.metadata.range, 'A1:B3');
  assert.ok(calls[0].includes('+table-get'));
  const partial = createFeishuConnector({ larkUserCli: { run: async () => ({ ok: true, data: { sheets: [{ name: '材料表', truncated: true, columns: [], data: [] }] } }) } });
  assert.equal((await partial.readResource({ type: 'sheets', url: 'sheet123', sheetId: 'data' })).code, 'incomplete-resource');
});

test('managed chapter publication reuses content and updates original tokens while rejecting remote conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-managed-publish-'));
  const directory = join(root, 'snapshot'); const receipts = join(root, '.ccpg-scheme', 'publications');
  await mkdir(directory); await mkdir(receipts, { recursive: true });
  let content = '# Original\n'; let revision = 1; let creates = 0; let updates = 0; let binary = Buffer.from('one'); let uploads = 0;
  await writeFile(join(directory, '完整方案.md'), content); await writeFile(join(directory, 'attachment.txt'), binary);
  const cli = { async run(args, options) {
    if (args[1] === '+create-folder') return { ok: true, data: { token: args.includes('--folder-token') ? 'chapter-folder' : 'folder', url: 'https://example.feishu.cn/drive/folder/folder' } };
    if (args[1] === '+create') { creates++; return { ok: true, data: { document_id: 'original', url: 'https://example.feishu.cn/docx/original' } }; }
    if (args[1] === '+update') {
      updates++; assert.equal(args[args.indexOf('--doc') + 1], 'original');
      assert.equal(args[args.indexOf('--revision-id') + 1], String(revision));
      content = await readFile(join(options.cwd, args[args.indexOf('--content') + 1].slice(2)), 'utf8'); revision++;
      return { ok: true, data: { document: { revision_id: revision }, result: 'success' } };
    }
    if (args[1] === '+fetch') return { ok: true, data: { document_id: 'original', revision_id: revision, content } };
    if (args[1] === '+upload') {
      if (uploads++) assert.equal(args[args.indexOf('--file-token') + 1], 'attachment-original');
      binary = await readFile(join(options.cwd, args[args.indexOf('--file') + 1].slice(2)));
      return { ok: true, data: { file_token: 'attachment-original', url: 'https://example.feishu.cn/file/attachment-original' } };
    }
    if (args[1] === '+download') { await writeFile(join(options.cwd, args[args.indexOf('--output') + 1].slice(2)), binary); return { ok: true, data: {} }; }
    if (args[1] === 'files') return { ok: true, data: { files: JSON.parse(args[args.indexOf('--params') + 1]).folder_token === 'folder' ? [{ token: 'chapter-folder' }] : [{ token: 'original' }, { token: 'attachment-original' }] } };
    throw new Error(`unexpected ${args}`);
  } };
  const connector = createFeishuConnector({ larkUserCli: cli });
  const publish = async (operationId, text, bytes = binary) => {
    await writeFile(join(directory, '完整方案.md'), text); await writeFile(join(directory, 'attachment.txt'), bytes);
    return connector.publishDelivery({ snapshot: { directory, artifactPath: join(directory, '完整方案.md'), markdown: text, attachments: [{ path: 'attachment.txt', name: 'attachment.txt', chapterId: 'one', outputId: 'table', sha256: createHash('sha256').update(bytes).digest('hex') }], files: [{ path: '完整方案.md', sha256: createHash('sha256').update(text).digest('hex') }, { path: 'attachment.txt', sha256: createHash('sha256').update(bytes).digest('hex') }] }, scope: 'one', projectRoot: root, title: 'Chapter', target: { mode: 'create' }, confirmed: true, authorizeUpdate: async () => {}, operationId, receiptPath: join(receipts, `${operationId}.ndjson`) });
  };
  const first = await publish('one', content); assert.equal(first.ok, true, JSON.stringify(first));
  const same = await publish('unrelated-revision', content);
  assert.equal(same.reused, true); assert.equal(creates, 1); assert.equal(uploads, 1);
  const changed = await publish('changed', '# Updated\n', Buffer.from('two'));
  assert.equal(changed.ok, true, JSON.stringify(changed)); assert.equal(changed.body.token, first.body.token); assert.equal(changed.updated, true);
  assert.equal(creates, 1); assert.equal(updates, 1); assert.equal(uploads, 2);
  const reverted = await publish('revert', '# Original\n', Buffer.from('one'));
  assert.equal(reverted.updated, true); assert.equal(reverted.body.token, 'original'); assert.equal(updates, 2); assert.equal(uploads, 3);
  content = '# User edited remotely\n'; revision++;
  const conflict = await publish('conflict', '# New local content\n');
  assert.equal(conflict.code, 'remote-conflict'); assert.equal(updates, 2); assert.equal(creates, 1);
  await rm(root, { recursive: true, force: true });
});

test('delivery publishes body and binary attachments into one folder with explicit user CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-feishu-delivery-'));
  const snapshotDir = join(root, 'revision-1');
  await mkdir(join(snapshotDir, '附件', '1 章'), { recursive: true });
  const body = '# 正文\n\n交付内容\n';
  const attachment = Buffer.from([0, 1, 2, 255, 10]);
  await writeFile(join(snapshotDir, '完整方案.md'), body);
  await writeFile(join(snapshotDir, '附件', '1 章', '1-counts.xlsx'), attachment);
  const receiptPath = join(root, 'receipt.ndjson');
  const calls = [];
  const connector = createFeishuConnector({
    larkUserCli: {
      async run(args, options = {}) {
        calls.push({ args, options });
        assert.deepEqual(args.slice(-2), ['--as', 'user']);
        if (args[0] === 'drive' && args[1] === '+create-folder') return { ok: true, data: { token: 'fld-1', url: 'https://example.feishu.cn/drive/fld-1' } };
        if (args[0] === 'docs' && args[1] === '+create') return { ok: true, data: { document_id: 'doc-1', url: 'https://example.feishu.cn/docx/doc-1' } };
        if (args[0] === 'drive' && args[1] === '+upload') return { ok: true, data: { file_token: 'file-1', url: 'https://example.feishu.cn/file/file-1' } };
        if (args[0] === 'docs' && args[1] === '+fetch') return { ok: true, data: { document_id: 'doc-1', revision_id: 2, content: body } };
        if (args[0] === 'drive' && args[1] === 'files' && args[2] === 'list') return { ok: true, data: { files: [
          { name: '完整方案', token: 'doc-1', type: 'docx', parent_token: 'fld-1' },
          { name: '1-counts.xlsx', token: 'file-1', type: 'file', parent_token: 'fld-1' },
        ], has_more: false } };
        if (args[0] === 'drive' && args[1] === '+download') {
          const output = args[args.indexOf('--output') + 1];
          await writeFile(join(options.cwd, output.slice(2)), attachment);
          return { ok: true, data: {} };
        }
        throw new Error(`unexpected call: ${args.join(' ')}`);
      },
    },
  });
  const result = await connector.publishDelivery({
    snapshot: {
      directory: snapshotDir,
      artifactPath: join(snapshotDir, '完整方案.md'),
      digest: 'delivery-digest',
      revision: 1,
      markdown: body,
      attachments: [{ path: '附件/1 章/1-counts.xlsx', name: 'counts.xlsx', sha256: createHash('sha256').update(attachment).digest('hex'), bytes: attachment.length }],
      files: [{ path: '完整方案.md', sha256: 'ignored' }],
    },
    title: 'Final',
    target: { mode: 'create', parentToken: 'parent-1' },
    confirmed: true,
    receiptPath,
    operationId: 'delivery-1',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verified, true);
  assert.equal(result.folder.token, 'fld-1');
  assert.equal(result.attachments.length, 1);
  const upload = calls.find(({ args }) => args[1] === '+upload');
  assert.equal(upload.args[upload.args.indexOf('--file') + 1], './附件/1 章/1-counts.xlsx');
  assert.equal(upload.options.cwd, snapshotDir);
  assert.ok(calls.some(({ args }) => args[0] === 'drive' && args[1] === 'files' && args[2] === 'list'));
});

test('chapters and full scheme reuse one project folder across restarts and legacy receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-project-folder-'));
  const directory = join(root, 'snapshot');
  const receipts = join(root, 'publications');
  await mkdir(directory); await mkdir(receipts);
  await writeFile(join(directory, '完整方案.md'), '# Body\n');
  const snapshot = { directory, artifactPath: join(directory, '完整方案.md'), markdown: '# Body\n', attachments: [] };
  let folders = 0; let documents = 0; let denied = false;
  const cli = { async run(args) {
    if (args[1] === '+create-folder') { folders++; assert.equal(args[args.indexOf('--name') + 1], '项目方案'); return { ok: true, data: { token: 'shared-folder' } }; }
    if (args[1] === '+create') { documents++; assert.equal(args[args.indexOf('--parent-token') + 1], 'shared-folder'); return { ok: true, data: { document_id: `doc-${documents}` } }; }
    if (args[1] === '+fetch') return { ok: true, data: { content: '# Body\n' } };
    if (args[1] === 'files') return denied ? { ok: false, error: 'permission denied' } : { ok: true, data: { files: Array.from({ length: documents }, (_, i) => ({ token: `doc-${i + 1}` })) } };
    throw new Error('unexpected');
  } };
  const publish = (operationId, target = { mode: 'create' }) => createFeishuConnector({ larkUserCli: cli }).publishDelivery({
    snapshot, title: operationId, folderTitle: '项目方案', confirmed: true, target,
    operationId, receiptPath: join(receipts, `${operationId}.ndjson`),
  });
  const first = await publish('chapter-1');
  const second = await publish('chapter-2');
  const full = await publish('full');
  assert.ok(first.ok && second.ok && full.ok);
  assert.equal(folders, 1, 'one scheme must not create a folder per chapter or full export');
  assert.equal(documents, 3);
  assert.equal(second.folder.token, first.folder.token);
  assert.equal(full.folder.token, first.folder.token);
  assert.equal((await publish('chapter-2')).reused, true);
  denied = true;
  assert.equal((await publish('chapter-3')).code, 'permission-denied');
  assert.equal(documents, 3, 'inaccessible existing folder must stop before any new document');
  denied = false;
  assert.equal((await publish('elsewhere', { mode: 'create', parentToken: 'different-parent' })).code, 'folder-conflict');
  assert.equal(folders, 1, 'destination changes must not silently split a scheme');

  const legacyRoot = await mkdtemp(join(tmpdir(), 'ccpg-legacy-folder-'));
  await writeFile(join(legacyRoot, 'legacy.ndjson'), [
    { event: 'intent', step: 'folder', operationId: 'old', at: '2026-10-11', args: ['drive', '+create-folder', '--name', 'Chapter 2'] },
    { event: 'receipt', step: 'folder', operationId: 'old', at: '2026-10-11', status: 'completed', result: { token: 'shared-folder' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const legacy = await createFeishuConnector({ larkUserCli: cli }).publishDelivery({ snapshot, confirmed: true, target: { mode: 'create' }, receiptPath: join(legacyRoot, 'new.ndjson'), operationId: 'new' });
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(legacy.folder.token, 'shared-folder');
  assert.equal(folders, 1, 'already-created legacy folder is adopted without another cloud folder');
});

test('an unknown scheme folder creation blocks later chapter publications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-folder-uncertain-'));
  await writeFile(join(root, '完整方案.md'), '# Body\n');
  const snapshot = { directory: root, artifactPath: join(root, '完整方案.md'), markdown: '# Body\n', attachments: [] };
  let creates = 0;
  const publish = (operationId) => createFeishuConnector({ larkUserCli: { async run() { creates++; throw new Error('timeout after cloud creation'); } } }).publishDelivery({
    snapshot, confirmed: true, target: { mode: 'create' }, operationId, receiptPath: join(root, `${operationId}.ndjson`),
  });
  assert.equal((await publish('chapter-1')).code, 'uncertain');
  assert.equal((await publish('chapter-2')).code, 'uncertain');
  assert.equal(creates, 1, 'later chapters must not create another folder after an unknown cloud write');
  const legacyRoot = await mkdtemp(join(tmpdir(), 'ccpg-folder-lost-legacy-'));
  await writeFile(join(legacyRoot, 'old.ndjson'), JSON.stringify({ event: 'intent', step: 'folder', operationId: 'old' }) + '\n');
  const legacy = await createFeishuConnector({ larkUserCli: { async run() { creates++; throw new Error('must not create'); } } }).publishDelivery({
    snapshot, confirmed: true, target: { mode: 'create' }, operationId: 'new', receiptPath: join(legacyRoot, 'new.ndjson'),
  });
  assert.equal(legacy.code, 'uncertain');
  assert.equal(creates, 1, 'an unknown legacy folder must also stop a new chapter');
});

test('delivery resumes confirmed mutations, rejects update mode, and stops after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-feishu-delivery-resume-'));
  await writeFile(join(root, '完整方案.md'), '# Body\n');
  const attachmentPath = join(root, 'a.txt');
  await writeFile(attachmentPath, 'a');
  const snapshot = { directory: root, artifactPath: join(root, '完整方案.md'), revision: 1, digest: 'd', markdown: '# Body\n', attachments: [{ path: 'a.txt', name: 'a.txt', bytes: 1 }], files: [] };
  await assert.rejects(() => createFeishuConnector({ larkUserCli: { run: async () => ({ ok: true, data: {} }) } }).publishDelivery({ snapshot, target: { mode: 'update', doc: 'doc' }, confirmed: true }), /create-only|update/i);
  const receiptPath = join(root, 'receipt.ndjson');
  let folderCreates = 0; let docCreates = 0; let uploads = 0;
  const cli = {
    async run(args, options = {}) {
      if (args[1] === '+create-folder') { folderCreates++; return { ok: true, data: { token: 'fld-1' } }; }
      if (args[1] === '+create') { docCreates++; return { ok: true, data: { document_id: 'doc-1' } }; }
      if (args[1] === '+upload') { uploads++; return { ok: true, data: { file_token: 'file-1' } }; }
      if (args[1] === '+fetch') return { ok: true, data: { document_id: 'doc-1', content: '# Body\n' } };
      if (args[1] === 'files') return { ok: true, data: { files: [{ token: 'doc-1', parent_token: 'fld-1' }, { token: 'file-1', parent_token: 'fld-1' }] } };
      if (args[1] === '+download') { await writeFile(join(options.cwd, args[args.indexOf('--output') + 1]), 'a'); return { ok: true, data: {} }; }
      throw new Error('unexpected');
    },
  };
  const connector = createFeishuConnector({ larkUserCli: cli });
  const first = await connector.publishDelivery({ snapshot, title: 'Final', target: { mode: 'create' }, confirmed: true, receiptPath, operationId: 'resume-1' });
  assert.equal(first.ok, true);
  const second = await connector.publishDelivery({ snapshot, title: 'Final', target: { mode: 'create' }, confirmed: true, receiptPath, operationId: 'resume-1' });
  assert.equal(second.reused, true);
  assert.equal(folderCreates, 1); assert.equal(docCreates, 1); assert.equal(uploads, 1);
  const cancelPath = join(root, 'cancel.ndjson'); const controller = new AbortController(); controller.abort();
  const cancelled = await connector.publishDelivery({ snapshot, title: 'Final', target: { mode: 'create' }, confirmed: true, signal: controller.signal, receiptPath: cancelPath, operationId: 'cancel-1' });
  assert.equal(cancelled.code, 'cancelled');
});

test('image delivery preserves body and attachment positions and verifies actual remote images without changing originals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-feishu-images-'));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const imagePath = '图片/one/园林图.png';
  const body = '# 正文\n\nBefore\n\n![园林图](<图片/one/园林图.png>)\n\nAfter\n';
  const attachmentBody = '# 附件\n\n![园林图](<../../图片/one/园林图.png>)\n\n说明\n';
  await mkdir(join(root, '图片', 'one'), { recursive: true });
  await mkdir(join(root, '附件', 'one'), { recursive: true });
  await mkdir(join(root, '飞书附件'), { recursive: true });
  await writeFile(join(root, imagePath), image);
  await writeFile(join(root, '完整方案.md'), body);
  await writeFile(join(root, '飞书正文.md'), body.replace('<图片/', '<@./图片/'));
  await writeFile(join(root, '附件', 'one', '说明.md'), attachmentBody);
  await writeFile(join(root, '飞书附件', '说明.md'), attachmentBody.replace('<../../图片/', '<@./图片/'));
  const snapshot = { directory: root, artifactPath: join(root, '完整方案.md'), revision: 1, digest: 'd', markdown: body,
    assets: [{ path: imagePath, sha256: createHash('sha256').update(image).digest('hex') }],
    attachments: [{ path: '附件/one/说明.md', publicationPath: '飞书附件/说明.md', name: '说明.md', content: attachmentBody }] };
  const reads = [];
  const updates = [];
  let remoteRevision = 1;
  const connectorFor = (fault = '') => createFeishuConnector({ larkUserCli: { async run(args, options) {
    assert.deepEqual(args.slice(-2), ['--as', 'user']);
    if (args[1] === '+create-folder') return { ok: true, data: { token: args.includes('--folder-token') ? 'chapter-fld' : 'fld' } };
    if (args[1] === '+create') {
      const path = args[args.indexOf('--content') + 1].slice(3);
      assert.ok(['飞书正文.md', '飞书附件/说明.md'].includes(path));
      assert.match(await readFile(join(options.cwd, path), 'utf8'), /!\[园林图\]\(<@\.\/图片\/one\/园林图\.png>\)/);
      return { ok: true, data: { document_id: path === '飞书正文.md' ? 'body' : 'attachment', ...(fault === 'warning' ? { warnings: ['image skipped'] } : {}) } };
    }
    if (args[1] === '+update') {
      assert.equal(args[args.indexOf('--command') + 1], 'block_replace');
      const token = args[args.indexOf('--doc') + 1];
      assert.ok(['body', 'attachment'].includes(token));
      assert.match(await readFile(join(options.cwd, args[args.indexOf('--content') + 1].slice(3)), 'utf8'), /<@\.\/图片\/one\/园林图\.png>/);
      updates.push(token);
      return { ok: true, data: { result: 'success' } };
    }
    if (args[1] === '+fetch') {
      const isBody = args[args.indexOf('--doc') + 1] === 'body';
      const content = isBody ? '# 正文\n\nBefore\n\n<img token="img-1" caption="园林图"/>\n\nAfter\n' : '# 附件\n\n<img token="img-2"/>\n\n说明\n';
      return { ok: true, data: { revision_id: remoteRevision, content: fault === 'position' ? content.replace('Before', 'After') : content } };
    }
    if (args[1] === '+media-download') {
      if (fault === 'download') throw new Error('download unavailable');
      const path = args[args.indexOf('--output') + 1];
      assert.ok(path.startsWith('./.feishu-verify-'));
      reads.push(args[args.indexOf('--token') + 1]);
      await writeFile(join(options.cwd, path), fault === 'bytes' ? 'wrong' : image);
      return { ok: true, data: {} };
    }
    if (args[1] === 'files') return { ok: true, data: { files: [{ token: 'body' }, { token: 'attachment' }, { token: 'chapter-fld' }] } };
    throw new Error(`unexpected call ${args.join(' ')}`);
  } } });
  const publish = (fault = '') => connectorFor(fault).publishDelivery({ snapshot, confirmed: true, target: { mode: 'create' } });
  const result = await publish();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verified, true);
  assert.deepEqual(reads, ['img-1', 'img-2']);
  assert.equal(result.attachments[0].kind, 'document');
  assert.equal((await publish('position')).code, 'uncertain');
  assert.equal((await publish('bytes')).code, 'uncertain');
  assert.equal((await publish('warning')).code, 'uncertain');
  assert.equal((await publish('download')).code, 'uncertain');
  assert.deepEqual(await readFile(join(root, imagePath)), image);
  const receipts = join(root, '.ccpg-scheme', 'publications');
  await mkdir(receipts, { recursive: true });
  snapshot.files = [{ path: imagePath, sha256: 'original-image' }];
  const managed = (id) => connectorFor().publishDelivery({ snapshot, scope: 'one', projectRoot: root, authorizeUpdate: async () => {}, receiptPath: join(receipts, `${id}.ndjson`), operationId: id, confirmed: true, target: { mode: 'create' } });
  const original = await managed('original');
  assert.equal(original.ok, true);
  snapshot.files = [{ path: imagePath, sha256: 'new-image' }];
  const updated = await managed('updated');
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.body.token, original.body.token);
  assert.deepEqual(updates, ['body', 'attachment'], 'images in body and document attachments are refreshed at the original addresses');
});
