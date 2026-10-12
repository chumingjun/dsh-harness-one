import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseMaterialFile } from '../lib/materials.js';
import { readableName, resourceDirectory } from './resource-names.mjs';

const [snapshotDir, outputDir, group] = process.argv.slice(2);
if (!snapshotDir || !outputDir || !['project', 'rules'].includes(group)) {
  throw new Error('usage: node download-source-resources.mjs <snapshot-dir> <output-dir> project|rules');
}
const read = (name) => JSON.parse(fs.readFileSync(path.join(snapshotDir, name), 'utf8'));
const cells = read(group === 'project' ? 'project-material-cells.json' : 'cells.json');
if (cells.has_more || cells.ranges.some((range) => range.truncated)) throw new Error('source cells are incomplete');
const main = read('table.json').sheets.find((sheet) => sheet.name === '项目质量计划输入输出材料清单');
const revisions = [cells.revision, read('structure.json').data.revision, read('workbook-info.json').data.revision];
if (!revisions.every((revision) => revision === revisions[0])) throw new Error('source revision mismatch');
const records = new Map();
const unlinked = [];
const templateTokens = new Set();
if (group === 'project') {
  for (const range of read('cells.json').ranges) for (const [i, row] of range.cells.entries()) {
    for (const [j, cell] of row.entries()) if (['D', 'J'].includes(range.col_indices[j])) {
      for (const ref of cell.rich_text ?? []) if (ref.mention_token) templateTokens.add(ref.mention_token);
    }
  }
}
for (const range of cells.ranges) for (const [i, row] of range.cells.entries()) {
  const rowNumber = range.row_indices[i];
  if (rowNumber === 1) continue;
  const sourceRow = main.data[rowNumber - 2];
  for (const [j, cell] of row.entries()) {
    const column = range.col_indices[j];
    if (group === 'rules' && !['D', 'E', 'F', 'J'].includes(column)) continue;
    if (group === 'rules' && column === 'F' && sourceRow?.[6] !== '知识库引用') continue;
    const refs = (cell.rich_text ?? []).filter((ref) => ref.mention_token || ref.link);
    if (!refs.length && group === 'project' && cell.value?.trim() && cell.value.trim() !== '/') {
      unlinked.push({ row: rowNumber, value: cell.value, reason: 'no downloadable reference' });
    }
    for (const ref of refs) {
      const source = ref.link ?? `https://ccpg1987.feishu.cn/wiki/${ref.mention_token}`;
      const url = new URL(source);
      if (url.protocol !== 'https:' || url.hostname !== 'ccpg1987.feishu.cn' || url.username || url.password
        || !/^\/(wiki|docx|doc|sheets|file|drive\/file)\//.test(url.pathname)) {
        throw new Error(`unsupported source URL at row ${rowNumber}`);
      }
      const key = ref.mention_token ?? source;
      const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
      const record = records.get(key) ?? {
        id, title: ref.text?.trim() || cell.value, source,
        mentionToken: ref.mention_token ?? null, mentionType: ref.mention_type ?? null,
        group, uses: [], status: 'pending', distributable: null,
      };
      record.uses.push({
        row: rowNumber, column, input: sourceRow?.[5] ?? null,
        role: group === 'project'
          ? (templateTokens.has(ref.mention_token) || /填写模板|【XX项目】/.test(ref.text ?? '') ? 'template-pointer' : 'project-material')
          : ({ D: 'output-template', E: 'reference-example', F: 'knowledge', J: 'collection-template' })[column],
      });
      records.set(key, record);
    }
  }
}
fs.mkdirSync(outputDir, { recursive: true });
const indexPath = path.join(outputDir, 'index.json');
const previous = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : null;
if (previous && previous.sourceRevision !== cells.revision) throw new Error('output belongs to another source revision');
const cli = (args) => {
  try {
    const result = JSON.parse(execFileSync('lark-cli', [...args, '--as', 'user', '--format', 'json'], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    if (!result.ok || result.identity !== 'user') throw new Error('CLI did not return a user success receipt');
    return result.data;
  } catch (error) {
    if (error.stderr) {
      try {
        const detail = JSON.parse(String(error.stderr)).error;
        throw new Error(`${detail.type}/${detail.subtype}: ${detail.message}`);
      } catch (parsed) {
        if (parsed instanceof SyntaxError) throw new Error('CLI failed without a structured error');
        throw parsed;
      }
    }
    throw error;
  }
};
const save = () => fs.writeFileSync(indexPath, JSON.stringify({
  schemaVersion: 1, group, sourceWorkbook: 'MJ8ashBmrh67GMtoMRQcIbxJn7f', sourceSheet: '0gVCWf',
  sourceRevision: cells.revision, fetchedAt: new Date().toISOString(),
  distribution: 'Local source review or project rehearsal only; not part of the plugin package.',
  records: [...records.values()], unlinked,
}, null, 2) + '\n');
let completed = 0;
for (const [key, record] of records) {
  const cached = previous?.records.find((item) => item.id === record.id);
  if (cached?.status === 'skipped' || cached?.status === 'failed' && /authorization|permission_denied|missing_scope/i.test(cached.error ?? '')) {
    Object.assign(record, cached, { uses: record.uses });
    continue;
  }
  if (cached?.status === 'downloaded' && cached.original) {
    const file = path.join(outputDir, cached.original);
    if (fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === cached.sha256) {
      Object.assign(record, cached, { uses: record.uses });
      completed += 1;
      continue;
    }
  }
  const roles = record.uses.map((use) => use.role);
  const category = group === 'project' ? 'files'
    : ['knowledge', 'output-template', 'collection-template', 'reference-example'].find((role) => roles.includes(role));
  const dir = path.join(outputDir, resourceDirectory(record, [...records.values()]));
  fs.mkdirSync(dir, { recursive: true });
  try {
    let info;
    // Mentions in this workbook can wrap Wiki nodes regardless of display type.
    if (record.mentionToken && record.mentionType !== 12) {
      try {
        info = cli(['drive', '+inspect', '--url', record.mentionToken, '--type', 'wiki']);
      } catch (error) {
        if (!/document is not in wiki/i.test(error.message) || ![3, 22, 16].includes(record.mentionType)) throw error;
        info = cli(['drive', '+inspect', '--url', record.mentionToken, '--type', record.mentionType === 3 ? 'sheet' : 'docx']);
      }
    } else if (record.mentionType === 12) {
      info = { type: 'file', token: record.mentionToken };
    } else {
      const url = new URL(record.source);
      info = { type: url.pathname.split('/')[1] === 'sheets' ? 'sheet' : url.pathname.split('/')[1], token: url.pathname.split('/').at(-1) };
    }
    record.resolved = info;
    const titleExtension = path.extname(record.title).slice(1).toLowerCase();
    const extension = { docx: 'docx', doc: 'docx', sheet: 'xlsx', file: /^[a-z0-9]{1,8}$/.test(titleExtension) ? titleExtension : 'bin' }[info.type];
    if (!extension) throw new Error(`unsupported resource type: ${info.type}`);
    const filename = `${readableName(record.title.replace(new RegExp(`\\.${extension}$`, 'i'), ''))}.${extension}`;
    const original = path.join(dir, filename);
    if (info.type === 'file') {
      cli(['drive', '+download', '--file-token', info.token, '--output', original, '--overwrite']);
    } else {
      const receipt = cli(['drive', '+export', '--token', info.token, '--doc-type', info.type,
        '--file-extension', extension, '--file-name', filename, '--output-dir', dir, '--overwrite']);
      if (receipt.ready === false || receipt.timed_out) throw new Error(`export pending; ticket ${receipt.ticket ?? 'unavailable'}`);
    }
    const bytes = fs.readFileSync(original);
    if (!bytes.length || /^\s*(<!doctype html|<html)/i.test(bytes.subarray(0, 100).toString())) throw new Error('download is empty or an HTML login page');
    if (['docx', 'xlsx'].includes(extension) && bytes.subarray(0, 2).toString() !== 'PK') throw new Error('invalid Office file signature');
    if (extension === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('invalid PDF signature');
    record.original = path.relative(outputDir, original);
    record.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    record.bytes = bytes.length;
    record.status = 'downloaded';
    record.fetchedAt = new Date().toISOString();
    try {
      const parsed = await parseMaterialFile({ inputPath: original, outputRoot: path.join(dir, 'parsed') });
      record.parsed = { path: path.relative(outputDir, parsed.markdownPath), status: parsed.status, sha256: parsed.markdownSha256, coverage: parsed.coverage };
    } catch (error) {
      record.parseError = error.message;
    }
    completed += 1;
    console.log(`${group} ${completed}/${records.size} downloaded ${record.title}`);
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    console.log(`${group} failed ${record.title}: ${record.error}`);
    if (/rate.?limit|too many|99991400/i.test(record.error)) { save(); throw error; }
  }
  save();
}
save();
console.log(JSON.stringify({
  group, total: records.size, downloaded: completed,
  failed: [...records.values()].filter((record) => record.status === 'failed').length,
  skipped: [...records.values()].filter((record) => record.status === 'skipped').length,
  unlinked: unlinked.length, indexPath,
}));
