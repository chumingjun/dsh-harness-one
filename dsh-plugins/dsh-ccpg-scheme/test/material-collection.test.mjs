import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFeishuMaterials } from '../lib/material-collection.js';

const url = 'https://example.feishu.cn/sheets/list1?sheet=data';
const cells = {
  revision: 12, has_more: false,
  ranges: [{
    actual_range: 'A1:C4', row_indices: [1, 2, 3, 4], col_indices: ['A', 'B', 'C'],
    cells: [
      [{ value: '输入资料' }, { value: '项目材料' }, { value: '收集模板' }],
      [{ value: '合同' }, { value: '合同', rich_text: [{ link: 'https://example.feishu.cn/docx/doc1', text: '合同' }] }, { value: '模板', rich_text: [{ mention_token: 'wiki1', mention_type: 22, text: '模板' }] }],
      [{ value: '图纸' }, { value: 'https://example.feishu.cn/drive/file/file1' }, { formula: '=HYPERLINK("https://example.feishu.cn/docx/doc1?from=copy","合同")' }],
      [{ value: '说明' }, { value: '无权限', rich_text: [{ link: 'https://example.feishu.cn/docx/denied', text: '无权限' }] }, { value: 'https://attacker.invalid/file/leak' }],
    ],
  }],
};

function fixtureCli({ snapshot = cells, pending = false, revision } = {}) {
  const calls = [];
  let resumed = false;
  return {
    calls,
    async run(args, options) {
      calls.push(args);
      assert.deepEqual(args.slice(-2), ['--as', 'user']);
      const arg = (flag) => args[args.indexOf(flag) + 1];
      const put = async (path, data) => { await writeFile(join(options.cwd, path), typeof data === 'string' ? data : JSON.stringify(data)); };
      if (args[1] === '+table-get' || args[1] === '+cells-get') {
        const data = args[1] === '+table-get' ? { revision, sheets: [{ name: '材料清单', range: 'A1:C4' }] } : snapshot;
        await put(arg('--output-path'), data);
        return { ok: true, data: { complete: true } };
      }
      if (args[1] === '+inspect') {
        const source = arg('--url');
        if (source.includes('/denied')) return { ok: false, error: { subtype: 'permission_denied', message: 'forbidden' } };
        return { ok: true, data: source.includes('/wiki/')
          ? { type: 'docx', token: 'template1', title: '../合同' }
          : source.includes('/file/') ? { type: 'file', token: 'file1', title: '平面图.pdf' }
            : { type: 'docx', token: 'doc1', title: '合同' } };
      }
      if (args[1] === '+task_result') {
        assert.equal(arg('--ticket'), 'ticket1');
        assert.equal(arg('--file-token'), 'doc1');
        resumed = true;
        return { ok: true, data: { ready: true, file_token: 'export1' } };
      }
      if (args[1] === '+export') {
        if (pending && arg('--token') === 'doc1' && !resumed) return { ok: true, data: { ready: false, timed_out: true, ticket: 'ticket1' } };
        await put(arg('--file-name'), 'PK Office source');
      } else if (args[1] === '+export-download') {
        await put(arg('--file-name'), 'PK Office source');
      } else if (args[1] === '+download') {
        await put(arg('--output'), '%PDF-1.7 source');
      } else throw new Error(`unexpected command ${args}`);
      return { ok: true, data: { ready: true } };
    },
  };
}

test('collects all rich mentions, hyperlinks and formula URLs locally, deduplicates and reports failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-collection-'));
  const cli = fixtureCli();
  const result = await collectFeishuMaterials({ root, url, larkUserCli: cli });
  assert.equal(result.total, 4);
  assert.equal(result.downloaded, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.complete, false);
  assert.equal(result.ignored.length, 1, 'foreign URLs are reported without being contacted');
  const files = await readdir(join(root, result.directory));
  assert.equal(files.length, 3);
  assert.ok(files.includes('合同.docx'));
  assert.ok(files.includes('平面图.pdf'));
  assert.ok(files.every((file) => !/[a-f0-9]{16}/.test(file)));
  const index = JSON.parse(await readFile(join(root, result.indexPath), 'utf8'));
  assert.equal(index.records.find((item) => item.token === 'doc1').uses.length, 2);
  assert.equal(index.records.find((item) => item.token === 'doc1').sha256.length, 64);
  assert.equal(cli.calls.filter((args) => args[1] === '+export').length, 2);
  assert.ok(cli.calls.every((args) => !args.some((arg) => arg.includes('attacker.invalid'))));
  for (const args of cli.calls) for (const flag of ['--output', '--output-dir', '--file-name', '--output-path']) {
    if (args.includes(flag)) assert.ok(!args[args.indexOf(flag) + 1].startsWith('/'));
  }
  const before = cli.calls.filter((args) => ['+export', '+download'].includes(args[1])).length;
  const again = await collectFeishuMaterials({ root, url, larkUserCli: cli });
  assert.equal(again.downloaded, 3);
  assert.equal(cli.calls.filter((args) => ['+export', '+download'].includes(args[1])).length, before, 'valid local originals are reused');
});

test('resumes an export ticket instead of creating the export again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-collection-pending-'));
  const cli = fixtureCli({ pending: true });
  const first = await collectFeishuMaterials({ root, url, larkUserCli: cli });
  assert.equal(first.pending, 1);
  const second = await collectFeishuMaterials({ root, url, larkUserCli: cli });
  assert.equal(second.pending, 0);
  assert.equal(second.downloaded, 3);
  assert.equal(cli.calls.filter((args) => args[1] === '+export' && args.includes('doc1')).length, 1);
});

test('does not claim a truncated list is complete or download to a symlink outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-collection-safety-'));
  const cli = fixtureCli({ snapshot: { ...cells, has_more: true } });
  await assert.rejects(collectFeishuMaterials({ root, url, larkUserCli: cli }), /incomplete|truncated/i);
  assert.equal(cli.calls.some((args) => args[1] === '+export'), false);
  const outside = await mkdtemp(join(tmpdir(), 'scheme-collection-outside-'));
  const linked = await mkdtemp(join(tmpdir(), 'scheme-collection-linked-'));
  await mkdir(join(linked, 'materials', 'input'), { recursive: true });
  await symlink(outside, join(linked, 'materials', 'input', '飞书材料'));
  await assert.rejects(collectFeishuMaterials({ root: linked, url, larkUserCli: fixtureCli() }), /unsafe|symlink/i);
  assert.deepEqual(await readdir(outside), []);
});

test('refuses missing columns, partial rows and incorrect row locations before downloading', async () => {
  for (const change of [
    (range) => { range.col_indices = ['A', 'B']; range.cells = range.cells.map((row) => row.slice(0, 2)); },
    (range) => { range.cells[3].pop(); },
    (range) => { range.row_indices = [1, 2, 3, 3]; },
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'scheme-collection-coverage-'));
    const snapshot = structuredClone(cells);
    change(snapshot.ranges[0]);
    const cli = fixtureCli({ snapshot });
    await assert.rejects(collectFeishuMaterials({ root, url, larkUserCli: cli }), /coverage/i);
    assert.equal(cli.calls.some((args) => args[1] === '+export'), false);
  }
});

test('recovers a lock left by a terminated process and preserves an active collection lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-collection-lock-'));
  await mkdir(join(root, '.ccpg-scheme'));
  const lock = join(root, '.ccpg-scheme', 'material-collection.lock');
  await writeFile(lock, '2147483647');
  assert.equal((await collectFeishuMaterials({ root, url, larkUserCli: fixtureCli() })).downloaded, 3);
  await writeFile(lock, String(process.pid));
  await assert.rejects(collectFeishuMaterials({ root, url, larkUserCli: fixtureCli() }), /already running/i);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
});

test('refuses a list that changes between range discovery and rich-link reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheme-collection-revision-'));
  const cli = fixtureCli({ revision: 11 });
  await assert.rejects(collectFeishuMaterials({ root, url, larkUserCli: cli }), /changed while collecting/);
  assert.equal(cli.calls.some((args) => args[1] === '+export'), false);
});
