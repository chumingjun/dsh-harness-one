import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublications, publicationSummary, deliveryContentDigest } from '../lib/publications.js';

const root = await mkdtemp(join(tmpdir(), 'ccpg-publication-history-'));
try {
  const directory = join(root, '.ccpg-scheme', 'publications');
  await mkdir(directory, { recursive: true });
  const manifest = { chapterId: 'chapter-2', revision: 12, chapters: [{ chapterId: 'chapter-2', artifactId: 'old', revision: 1 }], files: [{ path: '完整方案.md', bytes: 8, sha256: 'abc' }] };
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const snapshotDir = join(root, 'outputs', 'delivery', 'chapter-2', `revision-12-${digest.slice(0, 12)}`);
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(join(snapshotDir, '交付清单.json'), JSON.stringify(manifest));
  const result = { ok: true, verified: true, digest, body: { token: 'doc-original', url: 'https://example.feishu.cn/docx/doc-original', content: 'private body', revisionId: 3 }, folder: { token: 'folder', url: 'https://example.feishu.cn/drive/folder/folder' }, attachments: [] };
  const receipt = join(directory, 'legacy.ndjson');
  const data = `${JSON.stringify({ event: 'receipt', operationId: 'old', step: 'delivery', status: 'published', at: '2026-10-11T01:00:00Z', result })}\n`;
  await writeFile(receipt, data);
  const legacy = await readPublications(root);
  assert.equal(legacy[0].scope, 'chapter-2');
  assert.equal(legacy[0].contentDigest, deliveryContentDigest(manifest));
  assert.equal(deliveryContentDigest(manifest), deliveryContentDigest({ ...manifest, revision: 99, chapters: [{ artifactId: 'new' }] }), 'global state and artifact revisions are not cloud content');
  const first = await publicationSummary(root);
  assert.equal(first['chapter-2'].body.url, result.body.url);
  assert.deepEqual(first['chapter-2'].chapters, manifest.chapters);
  assert(!JSON.stringify(first).includes('private body'), 'results metadata never ships cloud text to the UI');
  assert.equal(await readFile(receipt, 'utf8'), data, 'loading historical links does not rewrite user records');
  await writeFile(join(directory, 'update.ndjson'), [
    { event: 'snapshot', operationId: 'update', scope: 'chapter-2', contentDigest: 'new', chapters: manifest.chapters },
    { event: 'receipt', operationId: 'update', step: 'delivery', status: 'published', at: '2026-10-12T01:00:00Z', result: { ...result, body: { ...result.body, revisionId: 4 } } },
  ].map(JSON.stringify).join('\n'));
  const updated = await publicationSummary(root);
  assert.equal(updated['chapter-2'].body.token, 'doc-original');
  assert.equal(updated['chapter-2'].body.revisionId, 4);
  assert.equal(updated['chapter-2'].history.length, 2);
  await writeFile(join(directory, 'unknown.ndjson'), `${JSON.stringify({ event: 'snapshot', operationId: 'unknown', scope: 'chapter-2', contentDigest: 'pending' })}\n${JSON.stringify({ event: 'intent', operationId: 'unknown', step: 'body', at: '2026-10-12T02:00:00Z' })}\n`);
  assert.equal((await publicationSummary(root))['chapter-2'].blocked, true, 'an unknown write remains blocked even after the local revision changes');
  assert.equal((await publicationSummary(root))['chapter-2'].body.url, result.body.url, 'unknown writes do not hide the previous verified link');
  console.log('ok - historical publications survive reload, track original document updates, and block unknown writes');
} finally { await rm(root, { recursive: true, force: true }); }
