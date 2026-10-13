import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { SaxesParser } from 'saxes';
import MarkdownIt from 'markdown-it';
import { mapDocumentImages } from './document-images.js';
import { deliveryContentDigest, readPublications } from './publications.js';

const nowIso = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(value).digest('hex');

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String(error.hint || error.message || JSON.stringify(error));
}

function classifyFailure(result) {
  const text = `${errorText(result?.error)} ${result?.raw || ''}`.toLowerCase();
  if (/permission|forbidden|unauthorized|not authorized|no permission|access denied|无权限|未授权/.test(text)) return 'permission-denied';
  if (/timeout|timed out|超时|partial/.test(text)) return 'uncertain';
  return 'cli-error';
}

function documentContent(data) {
  if (typeof data?.content === 'string') return data.content;
  if (typeof data?.markdown === 'string') return data.markdown;
  if (typeof data?.document?.content === 'string') return data.document.content;
  if (typeof data?.document?.markdown === 'string') return data.document.markdown;
  return null;
}

function documentId(data) {
  return data?.document_id || data?.document?.document_id || data?.document?.token || data?.token || data?.url || null;
}

function documentRevision(data) {
  return data?.revision_id ?? data?.document?.revision_id ?? data?.document?.revisionId ?? null;
}

async function appendReceipt(path, value) {
  if (!path) return;
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

function createdTarget(data) {
  const token = data?.document_id || data?.document?.document_id || data?.document?.token || data?.token;
  const url = data?.url || data?.document?.url;
  return token || url ? { token: token || null, url: url || null } : null;
}

function driveTarget(data) {
  const value = data?.folder || data?.file || data?.drive || data;
  const token = value?.token || value?.folder_token || value?.file_token || value?.fileToken || data?.folder_token || data?.file_token;
  const url = value?.url || data?.url;
  return token || url ? { token: token || null, url: url || null } : null;
}

function listPayload(data) {
  return data?.data && !Array.isArray(data.data) ? data.data : data || {};
}

function safeSnapshotPath(root, value) {
  const path = String(value || '');
  if (!path || path.startsWith('/') || path.split(/[\\/]/).some((part) => !part || part === '..')) throw new Error(`unsafe delivery path: ${path}`);
  const resolved = join(root, path);
  const outside = relative(root, resolved);
  if (outside === '..' || outside.startsWith(`..${sep}`)) throw new Error(`unsafe delivery path: ${path}`);
  return resolved;
}

const incomplete = (data) => data?.complete === false || data?.truncated === true || data?.has_more === true || ['partial_success', 'failed'].includes(data?.result) || data?.warnings?.length > 0;
const normalized = (content) => String(content).replace(/\r\n/g, '\n').trim();
const markdown = new MarkdownIt({ html: true });
const sameDocument = (expected, actual) => markdown.render(normalized(expected)) === markdown.render(normalized(actual));
const tableCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

async function publicationHistory(path) {
  if (!path) return [];
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function schemeFolderHistory(path) {
  const history = await publicationHistory(path);
  if (history.length) return history;
  const legacy = [];
  const unresolved = [];
  for (const file of (await readdir(dirname(path))).filter((name) => name.endsWith('.ndjson') && name !== 'folder.ndjson').sort()) {
    const records = await publicationHistory(join(dirname(path), file));
    for (const receipt of records.filter((item) => item.step === 'folder' && item.status === 'completed' && item.result?.token)) {
      const intent = records.find((item) => item.event === 'intent' && item.step === 'folder' && item.operationId === receipt.operationId);
      const index = intent?.args?.indexOf('--folder-token') ?? -1;
      legacy.push({ ...receipt, parentToken: index < 0 ? null : intent.args[index + 1] });
    }
    unresolved.push(...records.filter((item) => item.event === 'intent' && item.step === 'folder' && !records.some((receipt) => receipt.operationId === item.operationId && receipt.step === 'folder' && receipt.status === 'completed' && receipt.result?.token)));
  }
  const first = (legacy.length ? legacy : unresolved).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))[0];
  if (first) { await appendReceipt(path, first); return [first]; }
  return [];
}

export function createFeishuConnector({ larkUserCli, now = nowIso } = {}) {
  if (!larkUserCli?.run) throw new TypeError('larkUserCli.run is required');
  return {
    async readResource({ type = 'document', url, scope = 'full', sheetId, sheetName, range } = {}) {
      if (!['document', 'doc', 'docx', 'wiki', 'sheet', 'sheets'].includes(String(type))) {
        return { ok: false, code: 'unsupported-resource', error: `Feishu resource type ${type} is not supported by this connector yet` };
      }
      if (!url) throw new Error('url is required');
      if (['sheet', 'sheets'].includes(type)) {
        if ((!sheetId && !sheetName) || (sheetId && sheetName)) throw new Error('choose exactly one sheetId or sheetName');
        const args = ['sheets', '+table-get', '--url', String(url), ...(sheetId ? ['--sheet-id', String(sheetId)] : ['--sheet-name', String(sheetName)]), ...(range ? ['--range', String(range)] : []), '--max-chars', '500000', '--as', 'user'];
        const result = await larkUserCli.run(args, { timeoutMs: 60000 });
        if (!result.ok) return { ok: false, code: classifyFailure(result), error: errorText(result.error) || 'lark-cli read failed' };
        const sheets = result.data?.sheets;
        if (!Array.isArray(sheets) || sheets.length !== 1) return { ok: false, code: 'unsupported-output', error: 'expected one selected sheet' };
        if (incomplete(result.data) || sheets.some(incomplete)) return { ok: false, code: 'incomplete-resource', error: 'sheet read incomplete; select a smaller range', metadata: { range, sheets } };
        const sheet = sheets[0];
        if (!Array.isArray(sheet.columns) || !Array.isArray(sheet.data) || !sheet.range) return { ok: false, code: 'unsupported-output', error: 'sheet values or source range missing' };
        const content = [`# ${sheet.name || sheetId || sheetName}`, '', `| ${sheet.columns.map(tableCell).join(' | ')} |`, `| ${sheet.columns.map(() => '---').join(' | ')} |`, ...sheet.data.map((row) => `| ${sheet.columns.map((_, index) => tableCell(row[index])).join(' | ')} |`)].join('\n');
        return { ok: true, content, snapshot: result.data, metadata: { source: 'feishu', type: 'sheets', url: String(url), sheetId, sheetName, range: sheet.range, revisionId: result.data.revision ?? null, fetchedAt: now(), sha256: sha(content) } };
      }
      const args = ['docs', '+fetch', '--doc', String(url), '--doc-format', 'markdown', '--scope', String(scope), '--as', 'user'];
      const result = await larkUserCli.run(args, { timeoutMs: 60000 });
      if (!result.ok) return { ok: false, code: classifyFailure(result), error: errorText(result.error) || result.raw || 'lark-cli read failed' };
      const content = documentContent(result.data);
      if (content == null) return { ok: false, code: 'unsupported-output', error: 'lark-cli fetch returned no recognized document content' };
      if (incomplete(result.data) || incomplete(result.data?.document)) return { ok: false, code: 'incomplete-resource', error: 'document read is incomplete; choose a narrower scope', snapshot: result.data };
      return {
        ok: true,
        content,
        snapshot: result.data,
        metadata: {
          source: 'feishu',
          type: 'document',
          url: String(url),
          resourceId: documentId(result.data),
          revisionId: documentRevision(result.data),
          fetchedAt: now(),
          sha256: sha(content),
        },
      };
    },

    async publishDocument({ artifactPath, title, target, confirmed = false, receiptPath, operationId = randomUUID() } = {}) {
      if (!confirmed) throw new Error('confirmed target is required before publishing to Feishu');
      if (!artifactPath) throw new Error('artifactPath is required');
      if (!target?.mode || !['create', 'update'].includes(target.mode)) throw new Error('target.mode must be create or update');
      if (target.mode === 'update' && !target.doc) throw new Error('target.doc is required for update');
      if (target.mode === 'update' && (!Number.isSafeInteger(target.revisionId) || !target.sha256)) throw new Error('remote base revision and sha256 are required for update');
      let lock; let snapshotDir;
      try {
        if (receiptPath) lock = await open(`${receiptPath}.lock`, 'wx', 0o600);
        const history = (await publicationHistory(receiptPath)).filter((item) => item.operationId === operationId);
        if (history.length) {
          const receipt = history.findLast((item) => item.event === 'receipt');
          return receipt?.status === 'published' ? { ...receipt.result, reused: true } : { ok: false, code: 'uncertain', error: 'existing publication must be reconciled before another write' };
        }
        if (target.mode === 'update') {
          const prior = await this.readResource({ url: target.doc });
          if (!prior.ok) return prior;
          if (prior.metadata.revisionId !== target.revisionId || prior.metadata.sha256 !== target.sha256) return { ok: false, code: 'remote-conflict', error: 'remote document changed; confirm a new base before replacing it' };
        }
        const content = await readFile(artifactPath);
        let hasImages = /<img\b/i.test(content.toString('utf8'));
        mapDocumentImages(content.toString('utf8'), () => { hasImages = true; });
        if (hasImages) return { ok: false, code: 'unsupported-image-update', error: 'image documents require a new verified delivery folder; the existing document was not changed' };
        const artifact = { path: artifactPath, sha256: sha(content), bytes: content.length };
        snapshotDir = await mkdtemp(join(dirname(artifactPath), '.feishu-publish-'));
        await writeFile(join(snapshotDir, 'content.md'), content, { flag: 'wx', mode: 0o600 });
        await appendReceipt(receiptPath, { event: 'intent', operationId, at: now(), target, artifact, title: title || '' });
        const args = target.mode === 'create'
          ? ['docs', '+create', '--title', String(title || 'Untitled'), '--doc-format', 'markdown', '--content', '@./content.md', ...(target.parentToken ? ['--parent-token', String(target.parentToken)] : []), '--as', 'user']
          : ['docs', '+update', '--doc', String(target.doc), '--command', 'overwrite', '--revision-id', String(target.revisionId), '--doc-format', 'markdown', '--content', '@./content.md', '--as', 'user'];
        let result;
        try { result = await larkUserCli.run(args, { timeoutMs: 120000, cwd: snapshotDir }); }
        catch (error) { result = { ok: false, error: `uncertain: ${errorText(error)}` }; }
        let outcome;
        if (!result.ok) outcome = { ok: false, code: classifyFailure(result), error: errorText(result.error) || 'lark-cli publish failed' };
        else {
          const data = result.data || {};
          const remote = target.mode === 'create' ? createdTarget(data) : { token: target.doc, url: data.url || data.document?.url || null };
          if (!remote?.token && !remote?.url || incomplete(data)) outcome = { ok: false, code: 'uncertain', error: 'publish response is partial or has no remote identifier', remote };
          else {
            const readback = await this.readResource({ url: remote.token || remote.url });
            outcome = readback.ok && sameDocument(content.toString('utf8'), readback.content)
              ? { ok: true, verified: true, remote, revisionId: readback.metadata.revisionId, artifact }
              : { ok: false, code: 'uncertain', error: 'remote read-back did not verify the fixed publication snapshot', remote };
          }
        }
        await appendReceipt(receiptPath, { event: 'receipt', operationId, at: now(), status: outcome.ok ? 'published' : outcome.code, result: outcome });
        return outcome;
      } finally {
        if (snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
        if (lock) { await lock.close(); await rm(`${receiptPath}.lock`); }
      }
    },

    async publishDelivery({ snapshot, title, folderTitle, target, confirmed = false, receiptPath, operationId = randomUUID(), signal, scope, projectRoot, chapterDefinitions = [], authorizeUpdate } = {}) {
      if (!confirmed) throw new Error('confirmed target is required before publishing to Feishu');
      if (!snapshot?.directory || !snapshot?.artifactPath) throw new Error('delivery snapshot is required');
      if (target?.mode !== 'create') throw new Error('delivery publishing requires a create-only target');
      for (const attachment of snapshot.attachments || []) {
        safeSnapshotPath(snapshot.directory, attachment.path);
        if (attachment.publicationPath) safeSnapshotPath(snapshot.directory, attachment.publicationPath);
      }
      const folderReceiptPath = receiptPath && join(dirname(receiptPath), 'folder.ndjson');
      let lock; let folderLock; let verifyDirectory;
      try {
        if (folderReceiptPath) folderLock = await open(`${folderReceiptPath}.lock`, 'wx', 0o600);
        if (receiptPath) lock = await open(`${receiptPath}.lock`, 'wx', 0o600);
        const history = (await publicationHistory(receiptPath)).filter((item) => item.operationId === operationId);
        const final = history.findLast((item) => item.event === 'receipt' && item.step === 'delivery');
        if (final?.status === 'published') return { ...final.result, reused: true };
        const allRecords = scope ? (await readPublications(projectRoot)).filter((item) => item.operationId !== operationId) : [];
        const records = allRecords.filter((item) => item.scope === scope);
        if (records.some((item) => item.blocked)) return { ok: false, code: 'uncertain', error: '本章之前的飞书写入结果待核对，未重复创建文档' };
        const previous = records.findLast((item) => item.result?.verified);
        const contentDigest = scope ? deliveryContentDigest(snapshot) : undefined;
        if (previous?.contentDigest === contentDigest && previous && previous.result.layoutVersion === 2) {
          const result = { ...previous.result, contentDigest, chapters: snapshot.chapters, reused: true };
          if (JSON.stringify(previous.chapters) !== JSON.stringify(snapshot.chapters)) {
            await appendReceipt(receiptPath, { event: 'snapshot', operationId, scope, contentDigest, chapters: snapshot.chapters, at: now() });
            await appendReceipt(receiptPath, { event: 'receipt', operationId, step: 'delivery', at: now(), status: 'published', result });
          }
          return result;
        }
        const prior = previous?.result;
        const completed = new Map(history.filter((item) => item.event === 'receipt' && item.status === 'completed').map((item) => [item.step, item.result]));
        // A failed read-back can be retried only when every cloud write has a confirmed target.
        if (final?.status === 'uncertain' && (
          ['folder', 'body', ...(snapshot.attachments || []).map((item) => `attachment:${item.path}`)].some((step) => !completed.has(step))
          || history.some((item) => item.event === 'intent' && !completed.has(item.step))
        )) return { ...final.result, reused: true };
        const gaps = [];
        const fail = async (code, error, folder = null, extra = {}) => {
          const result = { ok: false, code, error, ...(folder ? { folder } : {}), ...(gaps.length ? { gaps: [...gaps] } : {}), ...extra };
          await appendReceipt(receiptPath, { event: 'receipt', operationId, step: 'delivery', at: now(), status: code, result });
          return result;
        };
        const cancelled = (folder) => signal?.aborted ? fail('cancelled', 'publishing cancelled', folder) : null;
        const attachmentKey = (item) => item.outputId && item.chapterId ? `${item.chapterId}:${item.outputId}` : item.path;
        const originalAttachment = (item) => {
          const candidates = allRecords.filter((record) => record.result?.verified).flatMap((record) => record.result.attachments || []);
          return candidates.findLast((original) => original.outputId && original.chapterId && attachmentKey(original) === attachmentKey(item))
            || prior?.attachments?.find((original) => original.path === item.path);
        };
        if (allRecords.some((record) => record.blocked && record.chapters.some((chapter) => snapshot.attachments?.some((item) => item.chapterId === chapter.chapterId)))) return fail('uncertain', '相关章节之前的飞书附件写入待核对，未创建副本');
        const originals = [...new Map([
          ...(prior ? [{ ...prior.body, kind: 'document' }] : []),
          ...(snapshot.attachments || []).map(originalAttachment).filter(Boolean),
        ].map((item) => [item.token, item])).values()];
        const requiresUpdate = Boolean(prior) || (snapshot.attachments || []).some((item) => {
          const original = originalAttachment(item);
          return original && (original.sha256 !== item.sha256 || item.publicationPath && snapshot.assets?.length || scope && !original.folder);
        });
        const bases = new Map();
        if (originals.length) {
          if (requiresUpdate && !authorizeUpdate) return fail('update-authorization-required', '请明确更新原飞书文档，未创建副本');
          if (signal?.aborted) return fail('cancelled', 'publishing cancelled', prior?.folder);
          const checkDirectory = await mkdtemp(join(snapshot.directory, '.feishu-base-'));
          try {
            for (const [index, original] of originals.entries()) {
              const step = original.token === prior?.body.token ? 'body' : `attachment:${snapshot.attachments.find((item) => originalAttachment(item)?.token === original.token)?.path || original.path}`;
              if (completed.has(step)) continue;
              if (original.kind === 'document') {
                const remote = await this.readResource({ url: original.token || original.url });
                if (!remote.ok) return remote;
                if (!Number.isSafeInteger(original.revisionId) || remote.metadata.revisionId !== original.revisionId || !sameDocument(original.content, remote.content)) return fail('remote-conflict', '飞书文档已被修改，请先核对远端内容；未覆盖或新建副本', prior?.folder);
                bases.set(original.token, remote.metadata.revisionId);
              } else {
                const output = `./${relative(snapshot.directory, join(checkDirectory, String(index))).split(sep).join('/')}`;
                const remote = await larkUserCli.run(['drive', '+download', '--file-token', String(original.token), '--output', output, '--as', 'user'], { timeoutMs: 120000, cwd: snapshot.directory });
                if (!remote?.ok) return fail(classifyFailure(remote), errorText(remote?.error) || '无法核对原飞书附件', prior?.folder);
                if (sha(await readFile(join(snapshot.directory, output))) !== original.sha256) return fail('remote-conflict', '飞书附件已被修改，请先核对；未覆盖或新建副本', prior?.folder);
              }
            }
            for (const attachment of snapshot.attachments || []) {
              const original = originalAttachment(attachment);
              if (original && original.kind !== (attachment.publicationPath ? 'document' : 'file')) return fail('attachment-kind-conflict', '原附件类型已改变，请先核对交付形式；未创建副本', prior?.folder);
              if (!original && prior?.attachments.some((item) => !item.outputId && item.name === attachment.name)) return fail('attachment-identity-missing', '历史附件无法安全对应，请先核对附件；未创建副本', prior?.folder);
            }
            if (requiresUpdate) await authorizeUpdate(prior || { body: originals[0] });
          } finally { await rm(checkDirectory, { recursive: true, force: true }); }
        }
        if (scope && !history.some((item) => item.event === 'snapshot')) await appendReceipt(receiptPath, { event: 'snapshot', operationId, scope, contentDigest, chapters: snapshot.chapters, at: now() });
        const updateArgs = (original, path) => ['docs', '+update', '--doc', String(original.token), '--command', 'block_replace', '--start-block-id', '0', '--end-block-id', '-1', '--revision-id', String(bases.get(original.token)), '--doc-format', 'markdown', '--content', `@./${path}`, '--as', 'user'];
        const folderHistory = folderReceiptPath ? await schemeFolderHistory(folderReceiptPath) : [];
        const runStep = async (step, args, parse, folder = null) => {
          const stopped = await cancelled(folder);
          if (stopped) return stopped;
          if (completed.has(step)) return completed.get(step);
          if (history.some((item) => item.event === 'intent' && item.step === step)) return fail('uncertain', `delivery step ${step} has an unverified write; no duplicate was created`, folder);
          const shared = step === 'folder' || step === 'folder-title' || step.startsWith('chapter-folder:') || step.startsWith('move:');
          if (shared && folderHistory.some((item) => item.event === 'intent' && item.step === step && !folderHistory.some((done) => done.step === step && done.status === 'completed'))) return fail('uncertain', `目录操作 ${step} 结果待核对，未重复写入`, folder);
          if (shared) {
            const intent = { event: 'intent', operationId, step, at: now(), parentToken: folder?.token || target.parentToken || null };
            await appendReceipt(folderReceiptPath, intent); folderHistory.push(intent);
          }
          await appendReceipt(receiptPath, { event: 'intent', operationId, step, at: now(), args: args.slice(0, -2), folder });
          let result;
          try { result = await larkUserCli.run(args, { timeoutMs: 120000, cwd: snapshot.directory }); }
          catch (error) {
            return fail('uncertain', `delivery step ${step} outcome is uncertain: ${errorText(error)}`, folder);
          }
          if (!result?.ok) return fail(classifyFailure(result), errorText(result?.error) || result?.raw || `delivery step ${step} failed`, folder);
          if (incomplete(result.data) || incomplete(result.data?.document)) return fail('uncertain', `delivery step ${step} returned incomplete content or warnings`, folder, { remote: parse(result.data || {}) });
          const parsed = parse(result.data || {});
          if (!parsed) return fail('uncertain', `delivery step ${step} returned no remote identifier`, folder);
          if (shared) {
            const receipt = { event: 'receipt', operationId, step, at: now(), status: 'completed', parentToken: folder?.token || target.parentToken || null, result: parsed };
            await appendReceipt(folderReceiptPath, receipt); folderHistory.push(receipt);
          }
          await appendReceipt(receiptPath, { event: 'receipt', operationId, step, at: now(), status: 'completed', result: parsed });
          completed.set(step, parsed);
          return parsed;
        };

        const listMembers = async (folder) => {
          const files = []; let pageToken;
          const seen = new Set();
          do {
            const result = await larkUserCli.run(['drive', 'files', 'list', '--params', JSON.stringify({ folder_token: folder.token, page_size: 200, ...(pageToken ? { page_token: pageToken } : {}) }), '--as', 'user'], { timeoutMs: 60000, cwd: snapshot.directory });
            if (!result?.ok) return fail(classifyFailure(result), errorText(result?.error) || '无法核对飞书目录', folder);
            const page = listPayload(result.data);
            if (!Array.isArray(page.files) || page.has_more && (!page.next_page_token || seen.has(page.next_page_token))) return fail('uncertain', '飞书目录清单不完整，未继续写入', folder);
            files.push(...page.files);
            pageToken = page.has_more ? page.next_page_token : null;
            seen.add(pageToken);
          } while (pageToken);
          return files;
        };
        const savedFolder = folderHistory.findLast((item) => item.step === 'folder' && item.status === 'completed');
        if (!completed.has('folder') && history.some((item) => item.event === 'intent' && item.step === 'folder')) return fail('uncertain', '原文件夹创建结果待核对，未重复创建');
        if (savedFolder && target.parentToken && savedFolder.parentToken !== target.parentToken) return fail('folder-conflict', '方案已关联飞书文件夹，请继续使用原文件夹');
        if (!savedFolder && folderHistory.some((item) => item.step === 'folder')) return fail('uncertain', '方案文件夹创建结果待核对，未重复创建');
        if (savedFolder && !completed.has('folder')) {
          const stopped = await cancelled(savedFolder.result); if (stopped) return stopped;
          const accessible = await listMembers(savedFolder.result);
          if (accessible?.ok === false) return accessible;
          await appendReceipt(receiptPath, { event: 'receipt', operationId, step: 'folder', at: now(), status: 'completed', result: savedFolder.result });
          completed.set('folder', savedFolder.result);
        }
        let schemeFolder = await runStep('folder', ['drive', '+create-folder', '--name', String(folderTitle || title || 'Untitled'), ...(target.parentToken ? ['--folder-token', String(target.parentToken)] : []), '--as', 'user'], (data) => {
          const remote = driveTarget(data);
          return remote && { ...remote, name: folderTitle || title || 'Untitled' };
        });
        if (!schemeFolder?.token) return schemeFolder?.ok === false ? schemeFolder : fail('uncertain', 'folder creation was not verified');
        if (scope && folderTitle && !schemeFolder.name) {
          const renamed = folderHistory.findLast((item) => item.step === 'folder-title' && item.status === 'completed');
          if (renamed) completed.set('folder-title', renamed.result);
          schemeFolder = await runStep('folder-title', ['drive', '+update-title', '--token', schemeFolder.token, '--type', 'folder', '--title', folderTitle, '--as', 'user'], () => ({ ...schemeFolder, name: folderTitle }), schemeFolder);
          if (schemeFolder?.ok === false) return schemeFolder;
        }
        const chapterFolders = new Map();
        const getChapterFolder = async (chapterId) => {
          if (!scope) return schemeFolder;
          if (chapterFolders.has(chapterId)) return chapterFolders.get(chapterId);
          const definition = chapterDefinitions.find((item) => item.id === chapterId);
          const code = definition?.code || definition?.order;
          const name = `${code ? String(code).split('.').map((part) => part.padStart(2, '0')).join('.') + ' ' : ''}${definition?.title || (chapterId === scope ? title : chapterId)}`;
          const step = `chapter-folder:${chapterId}`;
          const saved = folderHistory.findLast((item) => item.step === step && item.status === 'completed');
          if (saved) {
            if (saved.parentToken !== schemeFolder.token) return fail('folder-conflict', '章节目录不属于当前方案，未继续写入', schemeFolder);
            const accessible = await listMembers(saved.result);
            if (accessible?.ok === false) return accessible;
            completed.set(step, saved.result);
          }
          const remote = await runStep(step, ['drive', '+create-folder', '--name', name, '--folder-token', schemeFolder.token, '--as', 'user'], driveTarget, schemeFolder);
          if (!remote?.token) return remote?.ok === false ? remote : fail('uncertain', '章节目录创建未核实', schemeFolder);
          chapterFolders.set(chapterId, remote);
          return remote;
        };
        const folder = scope && scope !== 'full' ? await getChapterFolder(scope) : schemeFolder;
        if (folder?.ok === false) return folder;
        const placeOriginal = async (original, destination) => {
          if (!original || !scope) return;
          const members = await listMembers(destination);
          if (members?.ok === false) return members;
          if (members.some((item) => item.token === original.token)) return;
          const source = original.folder || prior?.folder || schemeFolder;
          const sourceMembers = await listMembers(source);
          if (sourceMembers?.ok === false) return sourceMembers;
          if (!sourceMembers.some((item) => item.token === original.token)) return fail('folder-conflict', '原文档位置已改变，请先核对；未重新创建', destination);
          return runStep(`move:${original.token}:${destination.token}`, ['drive', '+move', '--file-token', original.token, '--type', original.kind === 'file' ? 'file' : 'docx', '--folder-token', destination.token, '--as', 'user'], (data) => data.ready === false ? null : original, destination);
        };
        const placedBody = await placeOriginal(prior && { ...prior.body, folder: prior.folder }, folder);
        if (placedBody?.ok === false) return placedBody;
        if (prior && !snapshot.assets?.length && !completed.has('body') && sameDocument(snapshot.markdown, prior.body.content)) {
          completed.set('body', prior.body);
          await appendReceipt(receiptPath, { event: 'receipt', operationId, step: 'body', at: now(), status: 'completed', result: prior.body });
        }
        const body = await runStep('body', prior
          ? updateArgs(prior.body, snapshot.assets?.length ? '飞书正文.md' : '完整方案.md')
          : ['docs', '+create', '--title', String(title || 'Untitled'), '--doc-format', 'markdown', '--content', snapshot.assets?.length ? '@./飞书正文.md' : '@./完整方案.md', '--parent-token', String(folder.token || folder.url), '--as', 'user'], prior ? () => prior.body : createdTarget, folder);
        if (!body?.token && !body?.url) return body?.ok === false ? body : fail('uncertain', 'body document creation was not verified', folder);

        const attachments = [];
        for (const attachment of snapshot.attachments || []) {
          const filePath = safeSnapshotPath(snapshot.directory, attachment.path);
          const bytes = await readFile(filePath);
          const expectedSha = sha(bytes);
          if (attachment.sha256 && attachment.sha256 !== expectedSha) return fail('uncertain', `attachment snapshot changed: ${attachment.path}`, folder, { attachment: attachment.path });
          const step = `attachment:${attachment.path}`;
          const isDocument = Boolean(attachment.publicationPath);
          const original = originalAttachment(attachment);
          const attachmentFolder = scope ? await getChapterFolder(attachment.chapterId || (scope !== 'full' ? scope : '')) : folder;
          if (attachmentFolder?.ok === false) return attachmentFolder;
          const placed = await placeOriginal(original, attachmentFolder);
          if (placed?.ok === false) return placed;
          if (original?.sha256 === expectedSha && (!isDocument || !snapshot.assets?.length) && !completed.has(step)) {
            completed.set(step, original);
            await appendReceipt(receiptPath, { event: 'receipt', operationId, step, at: now(), status: 'completed', result: original });
          }
          const args = isDocument
            ? original ? updateArgs(original, attachment.publicationPath) : ['docs', '+create', '--title', String(attachment.name), '--doc-format', 'markdown', '--content', `@./${attachment.publicationPath}`, '--parent-token', String(attachmentFolder.token), '--as', 'user']
            : ['drive', '+upload', '--file', `./${attachment.path}`, ...(original ? ['--file-token', String(original.token)] : ['--folder-token', String(attachmentFolder.token)]), '--name', String(attachment.name || attachment.path.split('/').at(-1)), '--as', 'user'];
          const uploaded = await runStep(step, args, original ? () => original : isDocument ? createdTarget : driveTarget, folder);
          if (uploaded?.ok === false) { gaps.push(attachment.path); return uploaded; }
          if (!uploaded?.token && !uploaded?.url) { gaps.push(attachment.path); return fail('uncertain', `attachment upload was not verified: ${attachment.path}`, folder); }
          attachments.push({ ...uploaded, folder: attachmentFolder, kind: isDocument ? 'document' : 'file', chapterId: attachment.chapterId, outputId: attachment.outputId, path: attachment.path, name: attachment.name, sha256: expectedSha, bytes: bytes.length });
        }

        verifyDirectory = await mkdtemp(join(snapshot.directory, '.feishu-verify-'));
        const verifyContent = async (expected, actual, sourcePath) => {
          try {
          const images = [];
          const marker = (index) => `CCPG_IMAGE_SLOT_${index}`;
          const expectedText = mapDocumentImages(expected, (source) => {
            const path = join(dirname(sourcePath), source).split(sep).join('/');
            const asset = snapshot.assets?.find((item) => item.path === path);
            if (!asset) throw new Error(`image snapshot unavailable: ${source}`);
            images.push(asset);
            return marker(images.length - 1);
          }).replace(/!\[[^\]]*\]\(<(CCPG_IMAGE_SLOT_\d+)>\)/g, '$1');
          const tokens = []; let index = 0;
          let actualText = mapDocumentImages(actual, (source) => { tokens.push(null); return marker(index++); })
            .replace(/!\[[^\]]*\]\(<(CCPG_IMAGE_SLOT_\d+)>\)/g, '$1');
          // Official fetch exports uploaded images as XML resource tokens, not local paths.
          actualText = actualText.replace(/<img\b[^>]*\/>/gi, (tag) => {
            const parser = new SaxesParser({ fragment: true }); let token;
            parser.on('opentag', (node) => { token = node.attributes.token; });
            parser.write(tag).close();
            tokens.push(token);
            return marker(index++);
          });
          if (!sameDocument(expectedText, actualText) || tokens.length !== images.length || tokens.some((token) => !token)) return false;
          for (const [slot, asset] of images.entries()) {
            if (signal?.aborted) return false;
            const output = relative(snapshot.directory, join(verifyDirectory, `${slot}.image`)).split(sep).join('/');
            const result = await larkUserCli.run(['docs', '+media-download', '--token', String(tokens[slot]), '--output', `./${output}`, '--as', 'user'], { timeoutMs: 120000, cwd: snapshot.directory });
            if (!result?.ok || incomplete(result.data) || sha(await readFile(join(snapshot.directory, output))) !== asset.sha256) return false;
          }
          return true;
          } catch { return false; }
        };
        const readback = await this.readResource({ url: body.token || body.url });
        if (!readback.ok || !await verifyContent(snapshot.markdown, readback.content, '完整方案.md')) return fail('uncertain', 'remote body or image positions/bytes did not verify the fixed delivery snapshot', folder, { body });
        const downloaded = [];
        for (const attachment of snapshot.attachments || []) {
          const filePath = safeSnapshotPath(snapshot.directory, attachment.path);
          const expected = await readFile(filePath);
          const remote = attachments.find((item) => item.path === attachment.path);
          if (remote.kind === 'document') {
            const readback = await this.readResource({ url: remote.token || remote.url });
            if (!readback.ok || !await verifyContent(expected.toString('utf8'), readback.content, attachment.path)) return fail('uncertain', `remote attachment image positions/bytes did not verify: ${attachment.path}`, folder);
            remote.content = readback.content; remote.revisionId = readback.metadata.revisionId;
            downloaded.push({ path: attachment.path, sha256: sha(expected), bytes: expected.length });
            continue;
          }
          const outputPath = join(verifyDirectory, `attachment-${downloaded.length}`);
          const output = `./${relative(snapshot.directory, outputPath).split(sep).join('/')}`;
          const result = await larkUserCli.run(['drive', '+download', '--file-token', String(remote.token || remote.url), '--output', output, '--as', 'user'], { timeoutMs: 120000, cwd: snapshot.directory });
          if (!result?.ok) { gaps.push(attachment.path); return fail(classifyFailure(result), errorText(result.error) || `attachment download failed: ${attachment.path}`, folder); }
          const actual = await readFile(outputPath);
          if (sha(actual) !== sha(expected) || (attachment.sha256 && sha(actual) !== attachment.sha256)) {
            gaps.push(attachment.path);
            return fail('uncertain', `downloaded attachment bytes did not verify: ${attachment.path}`, folder);
          }
          downloaded.push({ path: attachment.path, sha256: sha(actual), bytes: actual.length });
        }

        const required = new Map();
        for (const item of [{ token: body.token, folder }, ...attachments, ...[...chapterFolders.values()].map((child) => ({ token: child.token, folder: schemeFolder }))]) {
          const group = required.get(item.folder.token) || { folder: item.folder, tokens: [] };
          group.tokens.push(item.token); required.set(item.folder.token, group);
        }
        for (const group of required.values()) {
          const files = await listMembers(group.folder);
          if (files?.ok === false) return files;
          const members = new Set(files.flatMap((file) => [file.token, file.file_token, file.document_id, file.url].filter(Boolean)));
          if (group.tokens.some((token) => !members.has(token))) return fail('uncertain', 'body, attachment or chapter folder is not verified in its destination', group.folder);
        }
        const result = { ok: true, verified: true, folder, schemeFolder, layoutVersion: 2, body: { ...body, content: readback.content, revisionId: readback.metadata.revisionId }, attachments, downloaded, revision: snapshot.revision, digest: snapshot.digest, ...(scope ? { scope, contentDigest, chapters: snapshot.chapters, updated: Boolean(prior) } : {}) };
        await appendReceipt(receiptPath, { event: 'receipt', operationId, step: 'delivery', at: now(), status: 'published', result });
        return result;
      } finally {
        if (verifyDirectory) await rm(verifyDirectory, { recursive: true, force: true });
        if (lock) { await lock.close(); await rm(`${receiptPath}.lock`, { force: true }); }
        if (folderLock) { await folderLock.close(); await rm(`${folderReceiptPath}.lock`, { force: true }); }
      }
    },
  };
}
