import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const directory = 'materials/input/飞书材料';
const indexPath = 'materials/fetched/飞书材料清单.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const incomplete = (data) => data?.has_more === true || data?.truncated === true || data?.complete === false;
const columnNumber = (column) => [...column].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
const readableName = (value) => [...String(value || '未命名材料').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').trim()].slice(0, 100).join('') || '未命名材料';

function resourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)
    || !/^\/(?:wiki|docx|doc|sheets|slides|base|file|drive\/file)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error('unsupported Feishu resource URL');
  return url;
}

async function workspacePath(root, path, makeDirectory = false) {
  let current = root;
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('unsafe material path');
    current = join(current, part);
    if (makeDirectory) await mkdir(current, { recursive: true });
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('unsafe symlink in material path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const rel = relative(root, resolve(current));
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('unsafe material path');
  return current;
}

function references(snapshot, origin, listUrl, sheetId) {
  const records = new Map(); const ignored = []; const unlinked = [];
  for (const range of snapshot.ranges) {
    if (incomplete(range) || !Array.isArray(range.row_indices) || !Array.isArray(range.col_indices) || !Array.isArray(range.cells)) throw new Error('incomplete cell locations');
    for (const [i, row] of range.cells.entries()) for (const [j, cell] of row.entries()) {
      const use = { listUrl, sheetId, row: range.row_indices[i], column: range.col_indices[j] };
      if (!Number.isInteger(use.row) || !use.column) throw new Error('incomplete cell locations');
      const add = (source, title, mentionType) => {
        try {
          const parsed = resourceUrl(source);
          if (`${parsed.origin}${parsed.pathname}` === `${new URL(listUrl).origin}${new URL(listUrl).pathname}`) return;
          source = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
          const item = records.get(source) || { source, title: title || cell.value || '', mentionType, uses: [] };
          if (!item.uses.some((value) => value.row === use.row && value.column === use.column)) item.uses.push(use);
          records.set(source, item);
        } catch { ignored.push({ ...use, reason: 'unsupported-link' }); }
      };
      const rich = cell.rich_text || [];
      for (const part of rich) {
        if (part.link) add(part.link, part.text);
        else if (part.mention_token) add(`${origin}/${part.mention_type === 12 ? 'file' : 'wiki'}/${part.mention_token}`, part.text, part.mention_type);
      }
      for (const text of [cell.value, cell.formula]) if (typeof text === 'string') {
        for (const match of text.matchAll(/https:\/\/[^\s"'<>）)]+/g)) add(match[0].replace(/[，,。;；]+$/, ''), rich.length ? '' : cell.value);
      }
      if (!rich.length && typeof cell.value === 'string' && /\.(pdf|docx?|xlsx?|pptx?|zip|png|jpe?g)\s*$/i.test(cell.value) && !cell.value.includes('://')) unlinked.push({ ...use, title: cell.value, reason: 'file-name-without-link' });
    }
  }
  return { records: [...records.values()], ignored, unlinked };
}

export async function collectFeishuMaterials({ root, url, sheetId, sheetName, range, larkUserCli, signal } = {}) {
  const locator = resourceUrl(url);
  if (!/^\/(?:sheets|wiki)\//.test(locator.pathname)) throw new Error('material list must be a Feishu spreadsheet');
  if (sheetId && sheetName) throw new Error('choose exactly one sheetId or sheetName');
  sheetId ||= sheetName ? undefined : locator.searchParams.get('sheet') || undefined;
  root = await realpath(root);
  const destination = await workspacePath(root, directory, true);
  await workspacePath(root, 'materials/fetched', true);
  await workspacePath(root, '.ccpg-scheme', true);
  const indexFile = await workspacePath(root, indexPath);
  const lockPath = await workspacePath(root, '.ccpg-scheme/material-collection.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('material collection lock invalid; contact support');
    try { process.kill(pid, 0); throw new Error('material collection already running'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    await rm(lockPath);
    lock = await open(lockPath, 'wx', 0o600);
  }
  let stage;
  const cancelled = () => { if (signal?.aborted) throw new Error('material collection cancelled; resume from the saved list'); };
  try {
    await lock.writeFile(String(process.pid));
    stage = await mkdtemp(join(root, '.ccpg-scheme', 'material-collection-'));
    const cli = async (args) => {
      cancelled();
      const result = await larkUserCli.run([...args, '--as', 'user'], { cwd: stage, timeoutMs: 120000 });
      cancelled();
      if (!result.ok) {
        const error = new Error('Feishu CLI could not acquire this resource');
        error.code = /permission|forbidden|scope|authoriz|1069902|99991679/i.test(JSON.stringify(result.error)) ? 'permission-denied' : 'cli-error';
        if (/not_configured|not_authenticated|token_expired|not logged|login required/i.test(JSON.stringify(result.error))) error.code = 'authentication-required';
        error.notWiki = /document is not in wiki/i.test(JSON.stringify(result.error));
        if (/rate.?limit|too many requests?|99991400/i.test(JSON.stringify(result.error))) error.code = 'rate-limited';
        throw error;
      }
      return result.data;
    };
    const fromFile = async (args, filename) => {
      const receipt = await cli([...args, '--output-path', `./${filename}`]);
      if (incomplete(receipt)) throw new Error('incomplete or truncated Feishu list');
      return JSON.parse(await readFile(join(stage, filename), 'utf8'));
    };
    const selection = sheetId ? ['--sheet-id', String(sheetId)] : sheetName ? ['--sheet-name', String(sheetName)] : [];
    const table = await fromFile(['sheets', '+table-get', '--url', locator.href, ...selection, ...(range ? ['--range', String(range)] : [])], 'table.json');
    if (incomplete(table) || !table.sheets?.length || table.sheets.some(incomplete)) throw new Error('incomplete or truncated Feishu list');
    let index;
    try { index = JSON.parse(await readFile(indexFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; index = { schemaVersion: 1, records: [], sources: [] }; }
    if (index.schemaVersion !== 1 || !Array.isArray(index.records) || !Array.isArray(index.sources)) throw new Error('invalid saved material list');
    const save = async () => {
      const temporary = join(stage, 'index.json');
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, indexFile);
    };
    const collected = []; const ignored = []; const unlinked = [];
    let revision = table.revision;
    for (const [number, sheet] of table.sheets.entries()) {
      const bounds = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(sheet.range).split('!').at(-1));
      if (!bounds || Number(bounds[2]) < 1 || Number(bounds[2]) > Number(bounds[4]) || columnNumber(bounds[1]) > columnNumber(bounds[3])) throw new Error('Feishu list used range missing');
      const selected = sheetId ? ['--sheet-id', String(sheetId)] : ['--sheet-name', String(sheetName || sheet.name)];
      if (!selected[1]) throw new Error('Feishu list sheet identity missing');
      const snapshots = [];
      for (let start = Number(bounds[2]); start <= Number(bounds[4]); start += 200) {
        const end = Math.min(start + 199, Number(bounds[4]));
        const target = `${bounds[1]}${start}:${bounds[3]}${end}`;
        const snapshot = await fromFile(['sheets', '+cells-get', '--url', locator.href, ...selected, '--range', target, '--include', 'value,formula'], `cells-${number}-${start}.json`);
        if (incomplete(snapshot) || !snapshot.ranges?.length || snapshot.ranges.some(incomplete)) throw new Error('incomplete or truncated Feishu list cells');
        if (revision !== undefined && snapshot.revision !== revision) throw new Error('Feishu list changed while collecting; read it again');
        revision = snapshot.revision;
        const returned = snapshot.ranges[0];
        const columns = columnNumber(bounds[3]) - columnNumber(bounds[1]) + 1;
        if (snapshot.ranges.length !== 1 || returned.actual_range !== target
          || returned.row_indices?.length !== end - start + 1 || returned.row_indices.some((row, i) => row !== start + i)
          || returned.col_indices?.length !== columns || returned.col_indices.some((column, i) => !/^[A-Z]+$/.test(column) || columnNumber(column) !== columnNumber(bounds[1]) + i)
          || !Array.isArray(returned.cells) || returned.cells.length !== end - start + 1 || returned.cells.some((row) => !Array.isArray(row) || row.length !== columns)) throw new Error('incomplete Feishu list cell coverage');
        const found = references(snapshot, locator.origin, locator.href, selected[1]);
        collected.push(...found.records); ignored.push(...found.ignored); unlinked.push(...found.unlinked);
        snapshots.push(snapshot);
      }
      const source = { url: locator.href, sheet: selected[1], revision, fetchedAt: new Date().toISOString(), snapshots };
      const prior = index.sources.findIndex((value) => value.url === source.url && value.sheet === source.sheet);
      if (prior < 0) index.sources.push(source); else index.sources[prior] = source;
    }
    // A resource may occur in multiple cells/windows and under both Wiki and direct links.
    const current = new Set();
    for (const item of collected) {
      cancelled();
      let record = index.records.find((value) => value.sources?.includes(item.source));
      if (record && (record.token || current.has(record))) {
        for (const use of item.uses) if (!record.uses.some((value) => JSON.stringify(value) === JSON.stringify(use))) record.uses.push(use);
        current.add(record);
        continue;
      }
      if (record) index.records.splice(index.records.indexOf(record), 1);
      try {
        let info;
        try { info = await cli(['drive', '+inspect', '--url', item.source]); }
        catch (error) {
          // Document mentions can contain a direct token even when displayed as a Wiki mention.
          if (![3, 16, 22].includes(item.mentionType) || !error.notWiki) throw error;
          info = await cli(['drive', '+inspect', '--url', item.source.split('/').at(-1), '--type', item.mentionType === 3 ? 'sheet' : 'docx']);
        }
        if (!/^[A-Za-z0-9_-]+$/.test(info.token || '')) throw new Error('invalid Feishu resource identifier');
        record = index.records.find((value) => value.type === info.type && value.token === info.token);
        if (record) { record.sources.push(item.source); record.uses.push(...item.uses); }
        else { record = { type: info.type, token: info.token, title: info.title || item.title || '未命名材料', sources: [item.source], uses: item.uses, status: 'pending' }; index.records.push(record); }
      } catch (error) {
        cancelled();
        if (error.code === 'rate-limited') throw error;
        record = { title: item.title, sources: [item.source], uses: item.uses, status: 'failed', code: error.code || 'resource-unavailable' };
        index.records.push(record);
      }
      current.add(record);
    }
    index.ignored = ignored; index.unlinked = unlinked;
    await save();
    for (const record of current) {
      cancelled();
      if (record.status === 'failed' && !record.token) continue;
      if (record.status === 'downloaded' && record.path) {
        const file = await workspacePath(root, record.path);
        try { if (digest(await readFile(file)) === record.sha256) continue; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      try {
        const extension = { doc: '.docx', docx: '.docx', sheet: '.xlsx', bitable: '.xlsx', slides: '.pptx', file: extname(readableName(record.title)) || '.bin' }[record.type];
        if (!extension) throw new Error('unsupported Feishu resource type');
        const base = readableName(record.title).replace(/\.(docx?|xlsx?|pptx?)$/i, '');
        let filename = `${base}${record.type === 'file' ? '' : extension}`;
        if (record.type === 'file') filename = readableName(record.title) + (extname(readableName(record.title)) ? '' : extension);
        let ordinal = 1;
        const stem = filename.slice(0, -extension.length);
        while (await lstat(join(destination, filename)).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) filename = `${stem} (${++ordinal})${extension}`;
        if (record.type === 'file') await cli(['drive', '+download', '--file-token', record.token, '--output', `./${filename}`]);
        else {
          let receipt;
          if (record.ticket) {
            receipt = await cli(['drive', '+task_result', '--scenario', 'export', '--ticket', record.ticket, '--file-token', record.token]);
            if (receipt.ready === true && !receipt.failed && receipt.file_token) await cli(['drive', '+export-download', '--file-token', receipt.file_token, '--file-name', filename, '--output-dir', '.']);
          } else receipt = await cli(['drive', '+export', '--token', record.token, '--doc-type', record.type, '--file-extension', extension.slice(1), '--file-name', filename, '--output-dir', '.']);
          if (receipt.failed) throw new Error('Feishu export failed');
          if (receipt.ready === false || receipt.timed_out) {
            if (!receipt.ticket && !record.ticket) throw new Error('Feishu export has no resume ticket');
            record.ticket = receipt.ticket || record.ticket; record.status = 'pending'; await save(); continue;
          }
        }
        const staged = await workspacePath(stage, filename);
        const bytes = await readFile(staged);
        if (!(await lstat(staged)).isFile() || !bytes.length || /^\s*(<!doctype html|<html)/i.test(bytes.subarray(0, 100).toString())) throw new Error('download is empty or a login page');
        if (['.docx', '.xlsx', '.pptx'].includes(extension.toLowerCase()) && bytes.subarray(0, 2).toString() !== 'PK') throw new Error('download has invalid Office signature');
        if (extension.toLowerCase() === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('download has invalid PDF signature');
        await copyFile(staged, join(destination, filename), constants.COPYFILE_EXCL);
        Object.assign(record, { path: `${directory}/${filename}`, sha256: digest(bytes), bytes: bytes.length, status: 'downloaded', fetchedAt: new Date().toISOString() });
        delete record.ticket; delete record.code;
      } catch (error) {
        cancelled();
        record.status = 'failed'; record.code = error.code || 'download-failed';
        if (error.code === 'rate-limited') { await save(); throw error; }
      }
      await save();
    }
    const records = [...current];
    const failed = records.filter((value) => value.status === 'failed').length;
    const pending = records.filter((value) => value.status === 'pending').length;
    return { directory, indexPath, total: records.length, downloaded: records.filter((value) => value.status === 'downloaded').length, failed, pending, complete: !failed && !pending && !ignored.length && !unlinked.length, ignored, unlinked, files: records.map(({ title, path, status, code, sha256 }) => ({ title: String(title || '').slice(0, 200), path, status, code, sha256 })) };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await lock.close(); await rm(lockPath);
  }
}
