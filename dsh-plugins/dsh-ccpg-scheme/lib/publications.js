import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const deliveryContentDigest = (snapshot) => createHash('sha256').update(JSON.stringify(snapshot.files)).digest('hex');

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function legacySnapshots(root) {
  const manifests = new Map();
  const visit = async (path) => {
    for (const entry of await entries(path)) if (entry.isDirectory()) {
      const directory = join(path, entry.name);
      if (entry.name.startsWith('revision-') && !entry.name.endsWith('.tmp')) {
        try {
          const manifest = JSON.parse(await readFile(join(directory, '交付清单.json'), 'utf8'));
          const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
          manifests.set(digest, manifest);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else await visit(directory);
    }
  };
  await visit(join(root, 'outputs', 'delivery'));
  await visit(join(root, 'outputs', 'final'));
  return manifests;
}

export async function readPublications(root) {
  const records = [];
  let legacy;
  const directory = join(root, '.ccpg-scheme', 'publications');
  for (const entry of await entries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.ndjson') || entry.name === 'folder.ndjson') continue;
    const lines = (await readFile(join(directory, entry.name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const metadata = lines.find((item) => item.event === 'snapshot');
    const final = lines.findLast((item) => item.step === 'delivery' && item.event === 'receipt');
    const result = final?.result;
    let scope = metadata?.scope; let manifest;
    if (!scope) {
      legacy ||= await legacySnapshots(root);
      manifest = legacy.get(result?.digest);
      if (!manifest) {
        const titleIntent = lines.find((item) => item.step === 'body' && item.event === 'intent' && item.args?.includes('--title'));
        const folderIntent = lines.find((item) => item.step === 'folder' && item.event === 'intent');
        const title = titleIntent?.args?.[titleIntent.args.indexOf('--title') + 1];
        const parentIndex = folderIntent?.args?.indexOf('--folder-token') ?? -1;
        const parentToken = parentIndex < 0 ? undefined : folderIntent.args[parentIndex + 1];
        for (const [digest, candidate] of legacy) {
          const operationId = createHash('sha256').update(JSON.stringify({ projectId: candidate.projectId, chapterId: candidate.chapterId, title, target: { mode: 'create', parentToken }, digest: candidate.files.find((item) => item.path === '完整方案.md')?.sha256, deliveryDigest: digest, revision: candidate.revision })).digest('hex');
          if (operationId === entry.name.slice(0, -7)) { manifest = candidate; break; }
        }
      }
      scope = manifest && (manifest.chapterId || 'full');
    }
    if (!scope) continue;
    records.push({
      scope, operationId: metadata?.operationId || final?.operationId,
      receiptPath: join(directory, entry.name), at: final?.at || lines.at(-1)?.at || '',
      status: final?.status || 'uncertain', result,
      contentDigest: metadata?.contentDigest || (manifest && deliveryContentDigest(manifest)),
      chapters: metadata?.chapters || manifest?.chapters || [],
      blocked: lines.some((item) => item.event === 'intent' && !lines.some((done) => done.step === item.step && done.status === 'completed')) || Boolean(final && final.status !== 'published' && lines.some((item) => item.status === 'completed' && item.step !== 'folder')),
    });
  }
  return records.sort((a, b) => a.at.localeCompare(b.at));
}

export async function publicationSummary(root) {
  const scopes = {};
  for (const record of await readPublications(root)) {
    const current = scopes[record.scope] ||= { history: [] };
    if (record.result?.verified) {
      const { content, ...body } = record.result.body;
      Object.assign(current, { ok: true, verified: true, body, folder: record.result.folder, schemeFolder: record.result.schemeFolder, layoutVersion: record.result.layoutVersion, contentDigest: record.contentDigest, chapters: record.chapters, at: record.at });
      current.history.push({ body, folder: record.result.folder, schemeFolder: record.result.schemeFolder, at: record.at });
    } else if (record.result?.body && !current.body) {
      const { content, ...body } = record.result.body;
      Object.assign(current, { body, folder: record.result.folder });
    }
    current.blocked = current.blocked || record.blocked;
  }
  return scopes;
}
