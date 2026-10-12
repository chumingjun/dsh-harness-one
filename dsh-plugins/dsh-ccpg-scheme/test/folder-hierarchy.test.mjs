import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuConnector } from '../lib/connectors.js';
import { publicationSummary } from '../lib/publications.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'ccpg-cloud-hierarchy-'));
const directory = join(root, 'snapshot');
const receipts = join(root, '.ccpg-scheme', 'publications');
await mkdir(directory); await mkdir(receipts, { recursive: true });
const objects = new Map();
const writes = [];
let failFolder = false;
let omitFolder = false;
let failMove = false;
let approvals = 0;
const value = (args, flag) => args[args.indexOf(flag) + 1];
const cli = { async run(args, options) {
  assert.deepEqual(args.slice(-2), ['--as', 'user']);
  const verb = args[1];
  if (verb === 'files') {
    const parent = JSON.parse(value(args, '--params')).folder_token;
    return { ok: true, data: { files: [...objects.values()].filter(item => item.parent === parent && !(omitFolder && item.type === 'folder')).map(item => ({ token: item.token, name: item.name, type: item.type })), has_more: false } };
  }
  if (verb === '+fetch') {
    const item = objects.get(value(args, '--doc'));
    return { ok: true, data: { content: item.content, revision_id: item.revision } };
  }
  if (verb === '+download') {
    await writeFile(join(options.cwd, value(args, '--output')), objects.get(value(args, '--file-token')).bytes);
    return { ok: true, data: {} };
  }
  writes.push(args);
  if (verb === '+create-folder') {
    const token = `folder-${objects.size}`;
    objects.set(token, { token, type: 'folder', name: value(args, '--name'), parent: args.includes('--folder-token') ? value(args, '--folder-token') : '' });
    if (failFolder && args.includes('--folder-token')) throw new Error('timeout after creating chapter folder');
    return { ok: true, data: { token, url: `https://example.feishu.cn/drive/folder/${token}` } };
  }
  if (verb === '+update-title') {
    objects.get(value(args, '--token')).name = value(args, '--title');
    return { ok: true, data: { updated: true } };
  }
  if (verb === '+move') {
    objects.get(value(args, '--file-token')).parent = value(args, '--folder-token');
    if (failMove) throw new Error('timeout after moving original');
    return { ok: true, data: { ready: true } };
  }
  if (verb === '+create' || verb === '+update') {
    const token = verb === '+update' ? value(args, '--doc') : `doc-${objects.size}`;
    const item = objects.get(token) || { token, type: 'docx', parent: value(args, '--parent-token'), revision: 0 };
    item.content = await readFile(join(options.cwd, value(args, '--content').slice(1)), 'utf8');
    item.revision++;
    objects.set(token, item);
    return { ok: true, data: { document_id: token, url: `https://example.feishu.cn/docx/${token}` } };
  }
  if (verb === '+upload') {
    const token = args.includes('--file-token') ? value(args, '--file-token') : `file-${objects.size}`;
    const item = objects.get(token) || { token, type: 'file', parent: value(args, '--folder-token') };
    item.bytes = await readFile(join(options.cwd, value(args, '--file')));
    objects.set(token, item);
    return { ok: true, data: { file_token: token, url: `https://example.feishu.cn/file/${token}` } };
  }
  throw new Error(`unexpected command ${args}`);
} };
const definitions = [{ id: 'one', code: '1', order: 1, title: '范围' }, { id: 'two', code: '2', order: 2, title: '质量计划的管理' }];
let sequence = 0;
async function publish(scope, body = '# 正文\n', attachment = true) {
  await writeFile(join(directory, '完整方案.md'), body);
  await writeFile(join(directory, '表格.csv'), '名称,值\n现场,55');
  const operationId = `publish-${++sequence}`;
  const snapshot = { directory, artifactPath: join(directory, '完整方案.md'), markdown: body,
    chapters: [{ chapterId: scope === 'full' ? 'two' : scope, artifactId: 'artifact', revision: 1 }],
    attachments: attachment ? [{ chapterId: scope === 'full' ? 'two' : scope, outputId: 'table', name: '表格.csv', path: '表格.csv', sha256: hash('名称,值\n现场,55') }] : [],
    files: [{ path: '完整方案.md', sha256: hash(body) }, ...(attachment ? [{ path: '表格.csv', sha256: hash('名称,值\n现场,55') }] : [])] };
  return createFeishuConnector({ larkUserCli: cli }).publishDelivery({
    snapshot, scope, projectRoot: root, chapterDefinitions: definitions, title: scope, folderTitle: '测试项目 质量方案',
    operationId, receiptPath: join(receipts, `${operationId}.ndjson`), target: { mode: 'create' }, confirmed: true, authorizeUpdate: async () => { approvals++; },
  });
}
try {
  const second = await publish('two');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.folder.token, second.schemeFolder?.token, 'chapter body belongs to a child folder');
  assert.equal(objects.get(second.folder.token).name, '02 质量计划的管理');
  assert.equal(objects.get(second.folder.token).parent, second.schemeFolder.token);
  assert.equal(objects.get(second.body.token).parent, second.folder.token);
  assert.equal(objects.get(second.attachments[0].token).parent, second.folder.token);
  const before = writes.length;
  const repeated = await publish('two');
  assert.equal(repeated.reused, true); assert.equal(writes.length, before);
  const full = await publish('full', '# 全文\n');
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(full.folder.token, second.schemeFolder.token);
  assert.equal(objects.get(full.body.token).parent, second.schemeFolder.token);
  assert.equal(full.attachments[0].token, second.attachments[0].token, 'full publication reuses chapter attachments');
  assert.equal(writes.filter(args => args[1] === '+upload').length, 1);
  assert.equal(approvals, 0, 'creating full正文 with unchanged existing attachments does not require a second approval');
  const changed = await publish('two', '# 更新正文\n');
  assert.equal(changed.ok, true, JSON.stringify(changed)); assert.equal(changed.body.token, second.body.token);
  const summary = await publicationSummary(root);
  assert.equal(summary.two.schemeFolder.token, second.schemeFolder.token);
  assert.equal(summary.two.folder.token, second.folder.token);

  // Simulate an old flat publication without modifying its original receipt.
  objects.get(changed.body.token).parent = second.schemeFolder.token;
  objects.get(changed.attachments[0].token).parent = second.schemeFolder.token;
  for (const name of ['publish-1', 'publish-3', 'publish-4']) {
    const path = join(receipts, `${name}.ndjson`);
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const line of lines) if (line.result?.verified) {
      delete line.result.layoutVersion;
      line.result.folder = second.schemeFolder;
      delete line.result.schemeFolder;
      for (const item of line.result.attachments) delete item.folder;
    }
    await writeFile(path, lines.map(JSON.stringify).join('\n') + '\n');
  }
  const migrated = await publish('two', '# 更新正文\n');
  assert.equal(migrated.ok, true, JSON.stringify(migrated));
  assert.equal(migrated.body.token, second.body.token);
  assert.equal(objects.get(migrated.body.token).parent, second.folder.token);
  assert.equal(objects.get(migrated.attachments[0].token).parent, second.folder.token);
  assert.equal(writes.filter(args => args[1] === '+create').length, 2, 'migration never recreates documents');

  failFolder = true;
  assert.equal((await publish('one', '# 第一章\n', false)).code, 'uncertain');
  const count = writes.length;
  assert.equal((await publish('one', '# 第一章\n', false)).code, 'uncertain');
  assert.equal(writes.length, count, 'unknown chapter-folder writes are never replayed');
  failFolder = false;
  omitFolder = true;
  definitions.push({ id: 'three', code: '3', order: 3, title: '术语' });
  assert.equal((await publish('three', '# 第三章\n', false)).code, 'uncertain', 'a created chapter folder must be listed under the scheme root');
  const beforeFullUpdate = writes.filter(args => args[1] === '+create').length;
  assert.equal((await publish('full', '# 更新全文\n')).code, 'uncertain', 'full publication does not claim success when chapter folder membership is missing');
  assert.equal(writes.filter(args => args[1] === '+create').length, beforeFullUpdate, 'full update keeps its original token');
  omitFolder = false;
  definitions.push({ id: 'four', code: '4', order: 4, title: '质量目标' });
  const fourth = await publish('four', '# 第四章\n', false);
  assert.equal(fourth.ok, true, JSON.stringify(fourth));
  objects.get(fourth.body.token).parent = second.schemeFolder.token;
  const fourthPath = join(receipts, `publish-${sequence}.ndjson`);
  const fourthLines = (await readFile(fourthPath, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const line of fourthLines) if (line.result?.verified) {
    delete line.result.layoutVersion;
    line.result.folder = second.schemeFolder;
    delete line.result.schemeFolder;
  }
  await writeFile(fourthPath, fourthLines.map(JSON.stringify).join('\n') + '\n');
  failMove = true;
  assert.equal((await publish('four', '# 第四章更新并归位\n', false)).code, 'uncertain');
  assert.equal(writes.at(-1)[1], '+move', 'failure occurred after moving the known original');
  const afterLostMove = writes.length;
  assert.equal((await publish('four', '# 第四章更新并归位\n', false)).code, 'uncertain');
  assert.equal(writes.length, afterLostMove, 'unknown original-document moves stop rather than recreating or replaying');
  console.log('ok - scheme/chapter hierarchy, original-address migration, shared attachments, persistence and unknown-write protection');
} finally { await rm(root, { recursive: true, force: true }); }
