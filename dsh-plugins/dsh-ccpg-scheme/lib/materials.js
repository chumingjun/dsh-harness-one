import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix, relative, resolve, sep } from 'node:path';
import { SaxesParser } from 'saxes';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { PNG } from 'pngjs';

export const MATERIAL_PARSER_VERSION = '6';
const PARSER_VERSION = MATERIAL_PARSER_VERSION;
const RENDER_CACHE_VERSION = '1';
const DEFAULT_RENDER_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_RENDER_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_RENDER_METADATA_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_RENDERER_VERSION = '3.0.0';
let pdfLibrary;
const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 512,
  maxEntryBytes: 25 * 1024 * 1024,
  maxBytes: 100 * 1024 * 1024,
  maxCompressedBytes: 100 * 1024 * 1024,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
};
const localName = (name) => String(name || '').split(':').at(-1);
const attr = (tag, name) => {
  const wanted = localName(name);
  const value = Object.entries(tag.attributes || {}).find(([key]) => localName(key) === wanted)?.[1];
  return typeof value === 'string' ? value : value?.value ?? '';
};

function assertNoSymlinkAncestors(inputPath) {
  const absolute = resolve(inputPath);
  let current = absolute.startsWith(sep) ? sep : '';
  for (const [index, part] of absolute.split(sep).filter(Boolean).entries()) {
    current = current === sep ? join(current, part) : join(current, part);
    try {
      if (index > 0 && lstatSync(current).isSymbolicLink()) throw new Error(`symlink path is not allowed: ${inputPath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function assertRegularFile(path, label) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${label} symlink is not allowed`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
}

function validateRelativeFile(root, value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`invalid ${label}`);
  const target = resolve(root, value);
  if (!inside(root, target)) throw new Error(`unsafe ${label}`);
  assertNoSymlinkAncestors(target);
  assertRegularFile(target, label);
  return target;
}

function assertPng(bytes, label) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error(`invalid ${label}`);
}

function xmlText(xml, format) {
  const parser = new SaxesParser({ xmlns: true });
  let text = ''; const tags = [];
  parser.on('doctype', () => { throw new Error('DOCTYPE is not allowed in Office XML'); });
  parser.on('opentag', (tag) => { tags.push(tag.local); });
  parser.on('text', (value) => { if (tags.at(-1) === 't') text += value; });
  parser.on('closetag', (tag) => {
    tags.pop();
    if (tag.local === 'p') text += '\n';
    if (format === 'docx' && tag.local === 'tc') text += ' | ';
    if (format === 'docx' && tag.local === 'tr') text += '\n';
  });
  parser.write(xml).close();
  return text.trim();
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipString(bytes, offset, length) {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString('utf8');
}

function zipEntries(bytes, limits = {}) {
  const config = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.byteLength - 0xffff - 22);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= start; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('invalid Office archive: end of central directory missing');
  const count = view.getUint16(eocd + 10, true);
  const centralBytes = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) throw new Error('Office ZIP64 archives are unavailable');
  if (count > config.maxEntries) throw new Error('Office archive entry limit exceeded');
  if (centralOffset + centralBytes > eocd || centralOffset + centralBytes > bytes.byteLength) throw new Error('invalid Office archive central directory');
  const entries = new Map(); let offset = centralOffset; let totalBytes = 0; let totalCompressed = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error('invalid Office archive central entry');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) throw new Error('invalid Office archive central entry length');
    const name = zipString(bytes, offset + 46, nameLength);
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('unsafe Office archive path');
    if (flags & 1) throw new Error('encrypted Office archives are unavailable');
    if (uncompressedSize > config.maxEntryBytes) throw new Error('Office archive entry byte limit exceeded');
    totalBytes += uncompressedSize; totalCompressed += compressedSize;
    if (totalBytes > config.maxBytes) throw new Error('Office archive uncompressed byte limit exceeded');
    if (totalCompressed > config.maxCompressedBytes) throw new Error('Office archive compressed byte limit exceeded');
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('invalid Office archive local entry');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new Error('invalid Office archive entry data');
    entries.set(name, { name, method, crc, compressedSize, uncompressedSize, dataStart });
    offset = end;
  }
  return { entries, limits: config };
}

function inflateEntry(bytes, entry, limits) {
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let output;
  if (entry.method === 0) output = Buffer.from(compressed);
  else if (entry.method === 8) output = inflateRawSync(compressed, { maxOutputLength: limits.maxEntryBytes });
  else throw new Error(`unsupported Office compression method: ${entry.method}`);
  if (output.length !== entry.uncompressedSize || output.length > limits.maxEntryBytes) throw new Error('Office archive entry size mismatch');
  if (crc32(output) !== entry.crc) throw new Error('Office archive CRC mismatch');
  return output;
}

function parseXml(xml, handlers = {}) {
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => { throw new Error('DOCTYPE is not allowed in Office XML'); });
  if (handlers.opentag) parser.on('opentag', handlers.opentag);
  if (handlers.text) parser.on('text', handlers.text);
  if (handlers.closetag) parser.on('closetag', handlers.closetag);
  parser.write(xml).close();
  return handlers.result?.();
}

function parseSharedStrings(xml) {
  const values = []; let active = false; let value = '';
  parseXml(xml, {
    opentag(tag) { if (localName(tag.name) === 'si') { active = true; value = ''; } },
    text(text) { if (active) value += text; },
    closetag(tag) { if (localName(tag.name) === 'si') { values.push(value); active = false; } },
    result: () => values,
  });
  return values;
}

function parseSheet(xml, sharedStrings) {
  const rows = []; const merges = []; let row; let current; let textTarget = null;
  parseXml(xml, {
    opentag(tag) {
      const name = localName(tag.name);
      if (name === 'row') { row = { ref: attr(tag, 'r'), cells: [] }; rows.push(row); }
      else if (name === 'c') { current = { ref: attr(tag, 'r'), type: attr(tag, 't'), formula: '', value: '', inline: '' }; row?.cells.push(current); }
      else if (name === 'f' || name === 'v' || name === 't') textTarget = name;
      else if (name === 'mergeCell') merges.push(attr(tag, 'ref'));
    },
    text(text) {
      if (!current || !textTarget) return;
      if (textTarget === 't') current.inline += text;
      else current[textTarget === 'f' ? 'formula' : 'value'] += text;
    },
    closetag(tag) {
      const name = localName(tag.name);
      if (name === 'f' || name === 'v' || name === 't') textTarget = null;
      else if (name === 'c' && current) {
        if (current.type === 's' && current.value !== '') current.display = sharedStrings[Number(current.value)] ?? `[Missing shared string ${current.value}]`;
        else if (current.type === 'inlineStr') current.display = current.inline;
        else current.display = current.value;
        current = null;
      } else if (name === 'row') row = null;
    },
    result: () => ({ rows, merges }),
  });
  return { rows, merges };
}

function parseWorkbookSheets(xml) {
  const sheets = [];
  parseXml(xml, { opentag(tag) { if (localName(tag.name) === 'sheet') sheets.push({ name: attr(tag, 'name'), id: attr(tag, 'id') }); } });
  return sheets;
}

function parseRelationships(xml) {
  const relationships = new Map();
  parseXml(xml, { opentag(tag) { if (localName(tag.name) === 'Relationship') relationships.set(attr(tag, 'Id'), attr(tag, 'Target')); } });
  return relationships;
}

function decorativeOfficeImages(bytes, zip) {
  const decorative = new Set(); const content = new Set();
  for (const [name, entry] of zip.entries) {
    if (!/^(word|xl)\/.*\.(xml|vml)$/i.test(name)) continue;
    const relsPath = posix.join(posix.dirname(name), '_rels', `${posix.basename(name)}.rels`);
    const relsEntry = zip.entries.get(relsPath);
    if (!relsEntry) continue;
    const relationships = parseRelationships(inflateEntry(bytes, relsEntry, zip.limits).toString('utf8'));
    const stack = [];
    parseXml(inflateEntry(bytes, entry, zip.limits).toString('utf8'), {
      opentag(tag) {
        const local = localName(tag.name);
        const background = stack.at(-1)?.background
          || /^word\/header\d+\.xml$/i.test(name) && local === 'shape' && /^WordPictureWatermark\d+$/i.test(attr(tag, 'id'))
          || /^xl\/worksheets\/[^/]+\.xml$/i.test(name) && stack.at(-1)?.local === 'worksheet' && local === 'picture';
        stack.push({ local, background });
        for (const key of ['r:id', 'r:embed', 'r:link', 'o:relid']) {
          const id = tag.attributes?.[key];
          const target = relationships.get(typeof id === 'string' ? id : id?.value);
          if (!target) continue;
          const path = target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(name), target);
          if (/^(word|xl)\/media\/[^/]+$/i.test(path)) (background ? decorative : content).add(path);
        }
      },
      closetag() { stack.pop(); },
    });
  }
  // A watermark reused in body content still needs interpretation.
  return [...decorative].filter((path) => !content.has(path));
}

function worksheetMarkdown(name, sheet) {
  const lines = [`## ${name}`, ''];
  for (const row of sheet.rows) {
    lines.push(`### Row ${row.ref || ''}`.trim());
    for (const value of row.cells) {
      const suffix = value.formula ? `; formula: ${value.formula}; stored value: ${value.value || '[blank]'}` : '';
      lines.push(`- ${value.ref}: ${value.display || '[blank]'}${suffix}`);
    }
    if (!row.cells.length) lines.push('- [blank row]');
    lines.push('');
  }
  if (sheet.merges.length) lines.push(`Merged ranges: ${sheet.merges.join(', ')}`, '');
  return lines.join('\n').trim();
}

async function sheets(bytes, target, limits) {
  const zip = zipEntries(bytes, limits);
  const read = (name, required = false) => {
    const entry = zip.entries.get(name);
    if (!entry) {
      if (required) throw new Error(`invalid XLSX: missing ${name}`);
      return '';
    }
    return inflateEntry(bytes, entry, zip.limits).toString('utf8');
  };
  const workbook = parseWorkbookSheets(read('xl/workbook.xml', true));
  const relationships = parseRelationships(read('xl/_rels/workbook.xml.rels', true));
  const sharedXml = read('xl/sharedStrings.xml');
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const parts = []; const sourceLocations = []; const tables = []; const unsupported = []; const images = []; const imageSha256 = [];
  let hasText = false;
  for (const sheet of workbook) {
    const relationship = relationships.get(sheet.id);
    if (!relationship) throw new Error(`invalid XLSX: missing relationship for ${sheet.name}`);
    const path = relationship.startsWith('/') ? relationship.slice(1) : `xl/${relationship.replace(/^\.?\//, '')}`;
    const parsed = parseSheet(read(path, true), shared);
    hasText ||= parsed.rows.some((row) => row.cells.some((cell) => cell.display?.trim()));
    parts.push(worksheetMarkdown(sheet.name, parsed));
    for (const row of parsed.rows) for (const item of row.cells) sourceLocations.push(`${sheet.name}!${item.ref}`);
  }
  const decorativeImages = hasText ? decorativeOfficeImages(bytes, zip) : [];
  for (const [name, entry] of zip.entries) {
    if (/^xl\/tables\/[^/]+\.xml$/i.test(name)) {
      const xml = inflateEntry(bytes, entry, zip.limits).toString('utf8');
      const table = /<table\b[^>]*\bname="([^"]+)"[^>]*\bref="([^"]+)"/i.exec(xml);
      if (table) tables.push(`${table[1]} (${table[2]})`);
    }
    if (/^xl\/media\/[^/]+$/i.test(name) && !decorativeImages.includes(name)) {
      const destination = join(target, 'images', basename(name));
      await mkdir(join(target, 'images'), { recursive: true });
      const image = inflateEntry(bytes, entry, zip.limits);
      await writeFile(destination, image, { flag: 'wx' });
      images.push(destination); imageSha256.push(hash(image));
    } else if (/^xl\/(charts|drawings|comments|threadedComments|embeddings|externalLinks|pivotCache|pivotTables|customXml)\//i.test(name)) unsupported.push(name);
  }
  if (tables.length) parts.push(`## Tables\n\n${tables.map((value) => `- ${value}`).join('\n')}`);
  if (unsupported.length) parts.push(`## Unverified workbook parts\n\n${unsupported.map((value) => `- ${value}`).join('\n')}`);
  return {
    markdown: parts.join('\n\n'),
    images,
    imageSha256,
    status: !hasText ? 'needs-vision' : images.length || unsupported.length ? 'needs-review' : 'complete',
    coverage: { method: 'ooxml-structural-extraction', sheets: workbook.map(({ name }) => name), sourceLocations, mergedRanges: 'preserved-in-markdown', tables, decorativeImages, unreadImages: images.map((path) => relative(target, path)), unsupportedParts: unsupported, requiresVisual: !hasText, visualVerified: false },
  };
}

async function office(bytes, extension, target, limits) {
  const zip = zipEntries(bytes, limits);
  const names = [...zip.entries.keys()];
  const read = (name, required = false) => {
    const entry = zip.entries.get(name);
    if (!entry) {
      if (required) throw new Error(`invalid Office archive: missing ${name}`);
      return Buffer.alloc(0);
    }
    return inflateEntry(bytes, entry, zip.limits);
  };
  const parts = extension === '.docx'
    ? ['word/document.xml', ...names.filter((name) => /^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name)).sort()]
    : names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!parts.length || parts.some((name) => !zip.entries.has(name))) throw new Error('invalid Office body');
  const body = [];
  let hasText = false;
  for (const name of parts) {
    const text = xmlText(read(name, true).toString('utf8'), extension.slice(1));
    hasText ||= !!text;
    body.push(`## ${name}\n\n${text}`);
  }
  const decorativeImages = extension === '.docx' && hasText ? decorativeOfficeImages(bytes, zip) : [];
  const images = []; const imageSha256 = [];
  const mediaPrefix = extension === '.docx' ? 'word/media/' : 'ppt/media/';
  for (const name of names.filter((value) => value.startsWith(mediaPrefix) && !value.endsWith('/'))) {
    if (decorativeImages.includes(name)) continue;
    const destination = join(target, 'images', basename(name));
    await mkdir(join(target, 'images'), { recursive: true });
    const image = read(name, true);
    await writeFile(destination, image, { flag: 'wx' });
    images.push(destination); imageSha256.push(hash(image));
  }
  const unsupported = names.filter((name) => extension === '.docx'
    ? /^(word\/(charts|embeddings|drawings|comments|people|customXml|glossary|ink)|customXml\/)/i.test(name)
    : /^(ppt\/(charts|notesSlides|embeddings|drawings|comments|media|customXml)|customXml\/)/i.test(name));
  return {
    markdown: body.join('\n\n') + (unsupported.length ? `\n\n## Unverified Office parts\n\n${unsupported.map((name) => `- ${name}`).join('\n')}` : ''),
    images,
    imageSha256,
    status: !hasText ? 'needs-vision' : images.length || unsupported.length ? 'needs-review' : 'complete',
    coverage: { method: 'structural-extraction', parts, decorativeImages, unreadImages: images.map((path) => relative(target, path)), unsupportedParts: unsupported, requiresVisual: !hasText, visualVerified: false },
  };
}

const loadPdf = async (bytes) => {
  pdfLibrary ||= PDFiumLibrary.init();
  return (await pdfLibrary).loadDocument(new Uint8Array(bytes));
};

async function pdf(bytes, source, target, options) {
  const document = await loadPdf(bytes);
  const parts = []; const unreadPages = []; const visualPages = [];
  try {
    for (let number = 1; number <= document.getPageCount(); number++) {
      const page = document.getPage(number - 1);
      try {
      const text = page.getText().trim();
      const readable = !!text && !text.includes('\ufffd');
      if (!readable) unreadPages.push(number);
      // PDFium 3.0's wrapper exposes no annotation iterator; use its pinned C API.
      const annotated = page.module._FPDFPage_GetAnnotCount(page.pageIdx) > 0;
      if (!readable || [...page.objects()].some((object) => object.type !== 'text') || annotated) visualPages.push(number);
      parts.push(`## Page ${number}\n\n${text || '[No readable text layer; multimodal reading required]'}`);
      } finally { page.close(); }
    }
  } finally {
    document.destroy();
  }
  let rendered = { images: [], pages: [] };
  if (options.renderPages?.length) rendered = await renderPdfPages({ inputPath: source, outputRoot: join(target, 'rendered-pages'), pages: options.renderPages, dpi: options.renderDpi });
  return {
    markdown: parts.join('\n\n'),
    images: rendered.images,
    imageSha256: await Promise.all(rendered.images.map(async (path) => hash(await readFile(path)))),
    status: unreadPages.length ? 'needs-vision' : visualPages.length ? 'needs-review' : 'complete',
    coverage: { method: 'text-layer', pages: parts.length, unreadPages, visualPages, renderedPages: rendered.pages, requiresVisual: !!unreadPages.length, visualVerified: false, visualVerification: visualPages.length ? 'pending-document-review' : 'not-required' },
  };
}

function normalizePdfPages(pages, maxPages, pageCount) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new Error('invalid PDF page limit');
  if (pages === 'all') {
    if (pageCount > maxPages) throw new Error('PDF page selection exceeds page limit');
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  if (!Array.isArray(pages) || !pages.length || pages.some((page) => !Number.isSafeInteger(page) || page < 1)) throw new Error('invalid PDF page selection');
  if (new Set(pages).size !== pages.length) throw new Error('invalid PDF page selection');
  if (pages.length > maxPages) throw new Error('PDF page selection exceeds page limit');
  if (pages.some((page) => page > pageCount)) throw new Error(`PDF page selection exceeds ${pageCount} pages`);
  return [...pages].sort((left, right) => left - right);
}

async function readRenderCache(target, root, expected) {
  if (!existsSync(target)) return null;
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('render cache directory is unsafe');
  const targetRoot = realpathSync(target);
  if (!inside(root, targetRoot)) throw new Error('unsafe render cache directory');
  let record;
  try {
    const metadataPath = validateRelativeFile(targetRoot, 'render.json', 'render cache metadata');
    if (lstatSync(metadataPath).size > MAX_RENDER_METADATA_BYTES) throw new Error('render cache metadata too large');
    record = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.name === 'SyntaxError') return null;
    throw error;
  }
  if (record.cacheVersion !== RENDER_CACHE_VERSION
    || record.sourceSha256 !== expected.sourceSha256
    || record.rendererVersion !== expected.rendererVersion
    || record.dpi !== expected.dpi
    || record.pageCount !== expected.pageCount
    || JSON.stringify(record.selection) !== JSON.stringify(expected.selection)) return null;
  if (!Array.isArray(record.images) || record.images.length !== expected.selection.length) throw new Error('invalid render cache metadata');
  if (!Array.isArray(record.missingFonts) || record.missingFonts.some((font) => typeof font !== 'string')) throw new Error('invalid render cache metadata');
  const images = [];
  const pages = [];
  const paths = new Set();
  let totalBytes = 0;
  for (const item of record.images) {
    if (!item || !Number.isSafeInteger(item.page) || item.page < 1 || !Number.isSafeInteger(item.byteLength) || item.byteLength < PNG_SIGNATURE.length || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid render cache image metadata');
    let imagePath;
    try {
      imagePath = validateRelativeFile(targetRoot, item.path, 'render cache image');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (paths.has(imagePath)) throw new Error('invalid render cache image metadata');
    paths.add(imagePath);
    if (lstatSync(imagePath).size !== item.byteLength) return null;
    totalBytes += item.byteLength;
    if (totalBytes > DEFAULT_RENDER_MAX_OUTPUT_BYTES) throw new Error('render cache images too large');
    const bytes = await readFile(imagePath);
    try {
      assertPng(bytes, 'render cache image');
    } catch (error) {
      if (/^invalid render cache image$/.test(error.message)) return null;
      throw error;
    }
    if (hash(bytes) !== item.sha256) return null;
    images.push(imagePath); pages.push(item.page);
  }
  if (JSON.stringify(pages) !== JSON.stringify(expected.selection)) return null;
  return {
    pages,
    images,
    coverage: { renderer: 'pdfium-wasm', rendererVersion: expected.rendererVersion, visualVerified: false, visualVerification: 'pending-model-result', pageCount: expected.pageCount, missingFonts: record.missingFonts },
    reused: true,
  };
}

export async function renderPdfPages({ inputPath, outputRoot, pages = 'all', dpi = 144, maxPages = 32, maxBytes = DEFAULT_RENDER_MAX_BYTES } = {}) {
  assertNoSymlinkAncestors(inputPath);
  assertRegularFile(inputPath, 'source');
  const source = realpathSync(inputPath);
  const size = lstatSync(source).size;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid source byte limit');
  if (size > maxBytes) throw new Error('source file too large');
  if (!size) throw new Error('source file is empty');
  const sourceBytes = await readFile(source);
  if (sourceBytes.length > maxBytes) throw new Error('source file too large');
  if (!Number.isFinite(dpi) || dpi < 24 || dpi > 600) throw new Error('invalid PDF render dpi');
  if (extname(source).toLowerCase() !== '.pdf') {
    if (!['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(extname(source).toLowerCase())) throw new Error('page rendering requires PDF or Office source');
    return { pages: [], images: [], reused: false, sourcePath: source, coverage: { method: 'native-document', requiresDocumentRead: true, visualVerified: false }, nextAction: 'Read the original Office document with DSH native file capabilities; use material_parse and material_complete. Office page conversion is not required.' };
  }
  assertNoSymlinkAncestors(outputRoot);
  const requestedRoot = resolve(outputRoot);
  await mkdir(requestedRoot, { recursive: true });
  const rootInfo = lstatSync(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('render output root must be a directory without symlinks');
  const root = realpathSync(requestedRoot);
  let document; let stage;
  try {
    document = await loadPdf(sourceBytes);
    const pageCount = document.getPageCount();
    const selection = normalizePdfPages(pages, maxPages, pageCount);
    const expected = { sourceSha256: hash(sourceBytes), selection, dpi, rendererVersion: PDF_RENDERER_VERSION, pageCount };
    const cacheKey = hash(Buffer.from(JSON.stringify({ sourceSha256: expected.sourceSha256, selection, dpi, rendererVersion: PDF_RENDERER_VERSION })));
    const target = join(root, `pdf-${cacheKey}`);
    if (!inside(root, target)) throw new Error('unsafe render cache destination');
    const cached = await readRenderCache(target, root, expected);
    if (cached) return cached;
    stage = `${target}.${randomUUID()}.tmp`;
    await mkdir(stage);
    const stageRoot = realpathSync(stage);
    const imageRecords = []; let outputBytes = 0;
    for (const number of selection) {
      const page = document.getPage(number - 1);
      try {
        const size = page.getOriginalSize(); const scale = dpi / 72;
        const pixels = Math.floor(size.originalWidth * scale) * Math.floor(size.originalHeight * scale);
        if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > 32 * 1024 * 1024) throw new Error('PDF render pixel limit exceeded');
        const result = await page.render({ scale, render: async ({ width, height, data }) => PNG.sync.write({ width, height, data: Buffer.from(data) }) });
        const bytes = Buffer.from(result.data);
        outputBytes += bytes.length;
        if (outputBytes > DEFAULT_RENDER_MAX_OUTPUT_BYTES) throw new Error('PDF render output byte limit exceeded');
        assertPng(bytes, 'rendered image');
        const name = `page-${number}.png`;
        await writeFile(join(stageRoot, name), bytes, { flag: 'wx' });
        imageRecords.push({ path: name, page: number, byteLength: bytes.length, sha256: hash(bytes) });
      } finally { page.close(); }
    }
    if (hash(await readFile(source)) !== expected.sourceSha256) throw new Error('PDF source changed during rendering');
    const missingFonts = [];
    const coverage = { renderer: 'pdfium-wasm', rendererVersion: PDF_RENDERER_VERSION, visualVerified: false, visualVerification: 'pending-model-result', pageCount, missingFonts };
    const record = { cacheVersion: RENDER_CACHE_VERSION, ...expected, images: imageRecords, missingFonts };
    await writeFile(join(stageRoot, 'render.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
    if (existsSync(target)) {
      const concurrent = await readRenderCache(target, root, expected);
      if (concurrent) {
        await rm(stage, { recursive: true, force: true });
        return concurrent;
      }
      await rm(target, { recursive: true });
    }
    await rename(stage, target);
    return {
      pages: imageRecords.map(({ page }) => page),
      images: imageRecords.map(({ path }) => join(target, path)),
      coverage,
      reused: false,
    };
  } finally {
    document?.destroy();
    if (stage && existsSync(stage)) await rm(stage, { recursive: true, force: true });
  }
}

async function legacy(source, extension, target, limits) {
  if (extension === '.xls') {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(await readFile(source), { type: 'buffer' });
    const markdown = workbook.SheetNames.map((name) => `## ${name}\n\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n\n');
    return { markdown, images: [], imageSha256: [], status: 'needs-review', coverage: { method: 'legacy-spreadsheet', requiresDocumentRead: true, visualVerified: false } };
  }
  return { markdown: '[Legacy Office original requires DSH native document interpretation; no system converter is installed.]', images: [], imageSha256: [], status: 'needs-review', coverage: { method: 'native-document', requiresDocumentRead: true, visualVerified: false } };
}

async function readCache(target, root, digest) {
  if (!existsSync(target)) return null;
  if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error('parse destination symlink is not allowed');
  const targetRoot = realpathSync(target);
  if (!inside(root, targetRoot)) throw new Error('unsafe parse destination');
  try {
    const parsePath = validateRelativeFile(targetRoot, 'parse.json', 'cache metadata');
    const contentPath = validateRelativeFile(targetRoot, 'content.md', 'cache content');
    const record = JSON.parse(await readFile(parsePath, 'utf8'));
    if (record.sha256 !== digest || record.parserVersion !== PARSER_VERSION || hash(await readFile(contentPath)) !== record.markdownSha256) return null;
    const imageHashes = Array.isArray(record.imageSha256) ? record.imageSha256 : [];
    const imagePaths = Array.isArray(record.images) ? record.images : [];
    if (imagePaths.length !== imageHashes.length) return null;
    const images = [];
    for (let index = 0; index < imagePaths.length; index++) {
      const imagePath = validateRelativeFile(targetRoot, imagePaths[index], 'cache image');
      if (hash(await readFile(imagePath)) !== imageHashes[index]) return null;
      images.push(imagePath);
    }
    return { ...record, markdownPath: contentPath, images, reused: true };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.name === 'SyntaxError' || /unsafe|invalid cache|cache metadata|cache content|cache image/.test(error.message)) return null;
    throw error;
  }
}

export async function parseMaterialFile({
  inputPath,
  outputRoot,
  maxBytes = 25 * 1024 * 1024,
  maxArchiveEntries,
  maxArchiveEntryBytes,
  maxArchiveBytes,
  maxArchiveCompressedBytes,
  archiveLimits,
  renderPages,
  renderDpi,
} = {}) {
  assertNoSymlinkAncestors(inputPath);
  assertRegularFile(inputPath, 'source');
  const source = realpathSync(inputPath);
  const size = lstatSync(source).size;
  if (size > maxBytes) throw new Error('source file too large');
  if (!size) throw new Error('source file is empty');
  const bytes = await readFile(source);
  const digest = hash(bytes);
  assertNoSymlinkAncestors(outputRoot);
  const requestedRoot = resolve(outputRoot);
  await mkdir(requestedRoot, { recursive: true });
  if (lstatSync(requestedRoot).isSymbolicLink()) throw new Error('output directory symlink is not allowed');
  const root = realpathSync(requestedRoot);
  const target = join(root, `${digest}-${PARSER_VERSION}`);
  if (!inside(root, target)) throw new Error('unsafe parse destination');
  const cached = await readCache(target, root, digest);
  if (cached) return cached;
  const stage = `${target}.${randomUUID()}.tmp`;
  await mkdir(stage);
  const limits = {
    ...DEFAULT_ARCHIVE_LIMITS,
    ...(archiveLimits || {}),
    ...(maxArchiveEntries === undefined ? {} : { maxEntries: maxArchiveEntries }),
    ...(maxArchiveEntryBytes === undefined ? {} : { maxEntryBytes: maxArchiveEntryBytes }),
    ...(maxArchiveBytes === undefined ? {} : { maxBytes: maxArchiveBytes }),
    ...(maxArchiveCompressedBytes === undefined ? {} : { maxCompressedBytes: maxArchiveCompressedBytes }),
  };
  try {
    const extension = extname(source).toLowerCase();
    let result;
    if (['.txt', '.md', '.csv', '.json', '.yaml', '.yml'].includes(extension)) result = { markdown: bytes.toString('utf8'), images: [], imageSha256: [], status: 'complete', coverage: { method: 'source-text', bytes: size } };
    else if (extension === '.pdf') result = await pdf(bytes, source, stage, { renderPages, renderDpi });
    else if (['.docx', '.pptx'].includes(extension)) result = await office(bytes, extension, stage, limits);
    else if (extension === '.xlsx') result = await sheets(bytes, stage, limits);
    else if (['.doc', '.ppt', '.xls'].includes(extension)) result = await legacy(source, extension, stage, limits);
    else if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
      const image = join(stage, 'images', basename(source));
      await mkdir(join(stage, 'images'), { recursive: true });
      await writeFile(image, bytes, { flag: 'wx' });
      result = { markdown: '[Image requires multimodal interpretation]', images: [image], imageSha256: [digest], status: 'needs-vision', coverage: { method: 'image', unreadImages: [basename(source)], requiresVisual: true, visualVerified: false } };
    } else throw new Error(`unsupported material format: ${extension}`);
    if (!result.markdown.trim()) throw new Error('empty parsed content');
    const record = {
      schemaVersion: 1,
      sha256: digest,
      parserVersion: PARSER_VERSION,
      name: basename(source),
      status: result.status,
      coverage: result.coverage,
      images: result.images.map((path) => relative(stage, path)),
      imageSha256: result.imageSha256 || [],
      markdownSha256: hash(result.markdown),
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(stage, 'content.md'), result.markdown, { flag: 'wx' });
    await writeFile(join(stage, 'parse.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('parse destination symlink is not allowed');
    if (existsSync(target)) await rm(target, { recursive: true });
    await rename(stage, target);
    return { ...record, markdownPath: join(target, 'content.md'), images: record.images.map((path) => join(target, path)), reused: false };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
