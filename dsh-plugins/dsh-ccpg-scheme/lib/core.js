import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { replaceLegacyMaterialReading } from './material-reading.js';
import { MATERIAL_PARSER_VERSION, parseMaterialFile } from './materials.js';
import { documentReview, stripGenerationNotes } from './document-review.js';
import { imageMime, mapDocumentImages } from './document-images.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX = /^[a-f0-9]{64}$/i;
const SECRET = /(^|[-_.])(secret|password|passwd|token|credential|private[-_.]?key|api[-_.]?key)([-_.]|$)/i;
const now = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const validId = (value, label = 'id') => { if (!ID.test(String(value || ''))) throw new Error(`unsafe ${label}`); return String(value); };
const cancelled = (signal) => { if (signal?.aborted) throw new Error('operation cancelled'); };
const sameJson = (left, right) => {
  try { return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))); }
  catch { return false; }
};

function safeRuleFile(root, relativePath) {
  root = realpathSync(root);
  if (!relativePath || isAbsolute(relativePath) || win32.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error('unsafe rule path');
  const path = resolve(root, relativePath);
  if (!inside(root, path) || !existsSync(path)) throw new Error(`missing rule file: ${relativePath}`);
  if (lstatSync(path).isSymbolicLink() || !inside(root, realpathSync(path))) throw new Error(`symlink rule file: ${relativePath}`);
  return path;
}

export function validateManifest(manifest, { rulesRoot } = {}) {
  if (!manifest || manifest.schemaVersion !== 1 || !ID.test(String(manifest.id || '')) || !manifest.version) throw new Error('invalid manifest');
  const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : []; const byId = new Map(); const orders = new Set();
  for (const chapter of chapters) {
    validId(chapter.id, 'chapter id'); if (byId.has(chapter.id)) throw new Error('duplicate chapter id');
    if (!Number.isSafeInteger(chapter.order) || chapter.order < 1 || orders.has(chapter.order)) throw new Error('invalid or duplicate chapter order');
    orders.add(chapter.order);
    if (!String(chapter.skill || '').startsWith('skills/')) throw new Error('unsafe skill path');
    for (const input of chapter.inputs || []) if (![true, false, 'unknown'].includes(input.required)) throw new Error('invalid required value');
    for (const output of chapter.outputs || []) if (!['body', 'attachment'].includes(output.kind)) throw new Error('invalid output kind');
    byId.set(chapter.id, chapter);
  }
  for (const chapter of chapters) for (const dep of chapter.dependencies || []) {
    if (!byId.has(dep)) throw new Error(`missing dependency: ${dep}`);
    if (dep !== chapter.id && byId.get(dep).order >= chapter.order) throw new Error(`dependency conflicts with chapter order: ${dep} -> ${chapter.id}`);
  }
  const visiting = new Set(); const visited = new Set();
  const walk = (id) => { if (visiting.has(id)) throw new Error('cycle in chapter dependencies'); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id).dependencies || []) walk(dep); visiting.delete(id); visited.add(id); };
  for (const chapter of chapters) walk(chapter.id);
  for (const resource of manifest.resources || []) {
    if (!resource?.path || !HEX.test(String(resource.sha256 || '')) || isAbsolute(resource.path) || win32.isAbsolute(resource.path) || resource.path.split(/[\\/]/).includes('..')) throw new Error('unsafe resource path or hash');
    if (rulesRoot) { const path = safeRuleFile(realpathSync(rulesRoot), resource.path); if (sha(readFileSync(path)) !== resource.sha256.toLowerCase()) throw new Error(`resource hash mismatch: ${resource.path}`); }
  }
  if (rulesRoot) { const root = realpathSync(rulesRoot); safeRuleFile(root, 'manifest.json'); safeRuleFile(root, 'AGENTS.md'); for (const chapter of chapters) safeRuleFile(root, chapter.skill); }
  return manifest;
}

export function checkedPath(root, relativePath) {
  if (typeof relativePath !== 'string' || isAbsolute(relativePath) || win32.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error('unsafe project path');
  const logicalRoot = resolve(root); const realRoot = existsSync(logicalRoot) ? realpathSync(logicalRoot) : logicalRoot; const path = resolve(logicalRoot, relativePath);
  if (!inside(logicalRoot, path)) throw new Error('unsafe project path');
  const rel = relative(logicalRoot, path);
  let cursor = logicalRoot;
  for (const part of rel ? rel.split(sep) : []) {
    if (!part) continue;
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('project path is a symlink');
    if (!inside(realRoot, realpathSync(cursor))) throw new Error('project path escapes root');
  }
  return path;
}

function atomicJson(path, value) { if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('project path is a symlink'); const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); renameSync(temp, path); }
function removeManaged(root, relativePath) { try { rmSync(checkedPath(root, relativePath), { recursive: true, force: true }); } catch {} }
export function acquireProjectLock(root, relativePath = '.ccpg-scheme/state.lock') {
  const lock = checkedPath(root, relativePath); let fd;
  try { fd = openSync(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    try { if (!pid) throw new Error('invalid lock'); process.kill(pid, 0); throw new Error('project is locked by another writer'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; unlinkSync(lock); fd = openSync(lock, 'wx'); }
  }
  writeFileSync(fd, String(process.pid));
  return { lock, fd };
}
export function releaseProjectLock({ lock, fd }) { if (fd !== undefined) { closeSync(fd); try { unlinkSync(lock); } catch {} } }

export class SchemeStore {
  constructor(root, state) { this.root = root; this.state = state; }
  static load(root) { root = resolve(root); return new SchemeStore(root, JSON.parse(readFileSync(checkedPath(root, '.ccpg-scheme/state.json'), 'utf8'))); }
  reload() {
    this.state = JSON.parse(readFileSync(checkedPath(this.root, '.ccpg-scheme/state.json'), 'utf8'));
    const indexPath = checkedPath(this.root, '.ccpg-scheme/index.json');
    const expected = buildIndex(this.state);
    try { if (JSON.stringify(JSON.parse(readFileSync(indexPath, 'utf8'))) !== JSON.stringify(expected)) throw new Error('stale index'); }
    catch { atomicJson(indexPath, expected); }
    return this.state;
  }
  save(state = this.state) { atomicJson(checkedPath(this.root, '.ccpg-scheme/state.json'), state); }
  async withLock(callback) {
    const lease = acquireProjectLock(this.root);
    try { return await callback(JSON.parse(readFileSync(checkedPath(this.root, '.ccpg-scheme/state.json'), 'utf8'))); }
    finally { releaseProjectLock(lease); }
  }
  commit(expectedRevision, mutate) {
    let lease;
    try {
      lease = acquireProjectLock(this.root);
      const disk = JSON.parse(readFileSync(checkedPath(this.root, '.ccpg-scheme/state.json'), 'utf8')); if (disk.revision !== expectedRevision) throw new Error(`revision conflict: expected ${expectedRevision}, current ${disk.revision}`); const next = structuredClone(disk); mutate(next); next.revision++; next.updatedAt = now(); this.save(next); this.state = next; try { atomicJson(checkedPath(this.root, '.ccpg-scheme/index.json'), buildIndex(next)); } catch {} return next;
    }
    catch (error) { throw error; }
    finally { if (lease) releaseProjectLock(lease); }
  }
}

export function updateMaterialReadingInstructions(store) {
  const lease = acquireProjectLock(store.root);
  let instructionPath; let oldText; let temp; let replaced = false;
  try {
    store.reload();
    const manifest = projectManifest(store);
    assertRules(store, manifest, store.state.rulesFingerprint, { mark: false });
    if (Object.values(store.state.chapters).some((chapter) => ['prepared', 'running'].includes(chapter.status))) throw new Error('project is active');
    instructionPath = checkedPath(store.root, 'AGENTS.md');
    oldText = readFileSync(instructionPath, 'utf8');
    const replacement = replaceLegacyMaterialReading(oldText);
    if (!replacement.changed) return false;
    temp = `${instructionPath}.${randomUUID()}.tmp`;
    writeFileSync(temp, replacement.text, { flag: 'wx' });
    renameSync(temp, instructionPath);
    replaced = true;
    const next = structuredClone(store.state);
    next.rulesFingerprint = rulesFingerprint(store.root, manifest);
    next.revision++; next.updatedAt = now();
    store.save(next);
    store.state = next;
    try { atomicJson(checkedPath(store.root, '.ccpg-scheme/index.json'), buildIndex(next)); } catch {}
    return true;
  } catch (error) {
    try { if (temp && existsSync(temp)) unlinkSync(temp); } catch {}
    if (replaced) {
      writeFileSync(temp, oldText, { flag: 'wx' });
      renameSync(temp, instructionPath);
    }
    throw error;
  } finally { releaseProjectLock(lease); }
}

function projectManifest(store) { return JSON.parse(readFileSync(checkedPath(store.root, '.ccpg-scheme/manifest.json'), 'utf8')); }
function rulePaths(manifest) { return ['.ccpg-scheme/manifest.json', 'AGENTS.md', ...manifest.chapters.map((c) => `.dsh/${c.skill}`), ...(manifest.resources || []).map((r) => `.dsh/${r.path}`)]; }
function rulesFingerprint(root, manifest) { const digest = createHash('sha256'); for (const name of rulePaths(manifest).sort()) digest.update(name).update('\0').update(readFileSync(safeRuleFile(root, name))).update('\0'); return digest.digest('hex'); }
function materialFingerprint(state, bindings = {}, root) {
  return sha(JSON.stringify(Object.values(bindings).sort().map((id) => {
    const item = state.materials[id];
    if (!item) return [id, null];
    if (!materialComplete(item)) throw new Error(`material incomplete: ${id}`);
    if (root && item.metadata?.source === 'project-file') {
      try {
        if (sha(readFileSync(checkedPath(root, item.metadata.sourcePath))) !== item.metadata.sourceSha256) throw new Error('original changed');
      } catch {
        throw new Error(`material external-changed: ${id}`);
      }
    }
    if (root && item.contentPath) {
      const actual = sha(readFileSync(checkedPath(root, item.contentPath)));
      if (actual !== item.sha256) throw new Error(`material external-changed: ${id}`);
      return [id, actual, item.version];
    }
    return [id, item.sha256, item.version];
  })));
}
function markMaterialExternalChanged(store, materialId) {
  const manifest = projectManifest(store);
  store.commit(store.state.revision, (s) => {
    for (const [id, chapter] of Object.entries(s.chapters)) {
      const definition = manifest.chapters.find((item) => item.id === id);
      const chapterBindings = chapter.token?.bindings || chapter.bindings || {};
      if ((definition?.inputs || []).some((input) => chapterBindings[input.id] === materialId)) {
        delete s.confirmations[id];
        s.chapters[id] = { ...chapter, stale: true, confirmed: false, status: 'external-changed', token: null };
        for (const descendant of descendants(manifest, id)) {
          delete s.confirmations[descendant];
          s.chapters[descendant] = { ...s.chapters[descendant], stale: true, confirmed: false, status: 'stale' };
        }
      }
    }
  });
}
function artifactFingerprint(store, artifact) {
  if (!artifact?.files) return null;
  return Object.entries(artifact.files).sort().map(([key, file]) => {
    const content = readFileSync(checkedPath(store.root, `${artifact.path}/${file.path}`), 'utf8');
    return [key, file.path, sha(content), file.sha256];
  });
}
function upstreamFingerprint(state, chapter, store) {
  return sha(JSON.stringify((chapter.dependencies || []).map((id) => {
    const chapterState = state.chapters[id]; const artifact = state.artifacts[chapterState?.artifactId];
    return [id, chapterState?.artifactId, chapterState?.revision, store && artifact ? artifactFingerprint(store, artifact) : artifact?.files];
  })));
}
function markRulesExternalChanged(store) {
  const manifest = projectManifest(store);
  store.commit(store.state.revision, (s) => {
    for (const id of Object.keys(s.chapters)) {
      delete s.confirmations[id];
      s.chapters[id] = { ...s.chapters[id], stale: Boolean(s.chapters[id].artifactId) || s.chapters[id].stale, confirmed: false, status: s.chapters[id].artifactId ? 'stale' : s.chapters[id].status, token: null };
    }
  });
}
function assertRules(store, manifest, expected = store.state.rulesFingerprint, { mark = true } = {}) {
  if (rulesFingerprint(store.root, manifest) !== expected) {
    if (mark) markRulesExternalChanged(store);
    throw new Error('rules changed or integrity check failed');
  }
}
function assertMaterialFingerprint(store, state, bindings, { mark = true } = {}) {
  try { return materialFingerprint(state, bindings, store.root); }
  catch (error) {
    const match = String(error.message || '').match(/material external-changed: ([A-Za-z0-9._-]+)/);
    if (mark && match) { store.reload(); markMaterialExternalChanged(store, match[1]); }
    throw error;
  }
}
function verifyChapterMaterials(store, chapterId) {
  const bindings = store.state.chapters[chapterId]?.bindings;
  if (!bindings) return;
  assertMaterialFingerprint(store, store.state, bindings);
}
function buildIndex(state) {
  return {
    schemaVersion: 1, revision: state.revision, projectId: state.projectId, rulesVersion: state.manifest.version,
    materials: Object.fromEntries(Object.entries(state.materials).map(([id, item]) => [id, { name: item.name, kind: item.kind, sha256: item.sha256, version: item.version, contentPath: item.contentPath, parseStatus: item.parseStatus }])),
    chapters: Object.fromEntries(Object.entries(state.chapters).map(([id, item]) => [id, { status: item.status, stale: item.stale, revision: item.revision, artifactId: item.artifactId, dependencies: item.dependencies, pendingConfirmations: item.pendingConfirmations }])),
  };
}

async function copyRules(rulesDir, root, manifest) {
  const source = await realpath(rulesDir); validateManifest(manifest, { rulesRoot: source });
  await cp(join(source, 'AGENTS.md'), join(root, 'AGENTS.md')); await writeFile(join(root, '.ccpg-scheme', 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const chapter of manifest.chapters) { const target = join(root, '.dsh', chapter.skill); await mkdir(dirname(target), { recursive: true }); await cp(safeRuleFile(source, chapter.skill), target); }
  for (const resource of manifest.resources || []) { const target = join(root, '.dsh', resource.path); await mkdir(dirname(target), { recursive: true }); await cp(safeRuleFile(source, resource.path), target); }
}

export async function createProject({ sessionCwd, projectId, rulesDir }) {
  projectId = validId(projectId, 'project id'); const root = resolve(sessionCwd);
  if ((await readdir(root)).length) throw new Error('scheme workspace must be an empty dedicated directory');
  const manifest = JSON.parse(await readFile(join(rulesDir, 'manifest.json'), 'utf8')); validateManifest(manifest, { rulesRoot: rulesDir });
  for (const dir of ['.ccpg-scheme', '.dsh', '.ccpg-scheme/rule-versions', 'materials/input', 'materials/raw', 'materials/fetched', 'materials/parsed', 'materials/notes', 'outputs/chapters', 'outputs/final']) await mkdir(join(root, dir), { recursive: true });
  try {
    try { execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' }); }
    catch (error) { throw new Error(`cannot create independent native project root: ${error.message}`); }
    await copyRules(rulesDir, root, manifest);
    const state = { schemaVersion: 1, projectId, manifest: { id: manifest.id, version: manifest.version }, revision: 1, createdAt: now(), updatedAt: now(), materials: {}, chapters: {}, artifacts: {}, confirmations: {} };
    for (const chapter of manifest.chapters) state.chapters[chapter.id] = { status: 'pending', confirmed: false, stale: false, revision: 0, dependencies: chapter.dependencies || [] };
    state.rulesFingerprint = rulesFingerprint(root, manifest); const store = new SchemeStore(root, state); store.save();
    atomicJson(join(root, '.ccpg-scheme', 'workspace.json'), { schemaVersion: 1, projectId, createdAt: state.createdAt, rulesVersion: manifest.version, rulesFingerprint: state.rulesFingerprint });
    atomicJson(join(root, '.ccpg-scheme', 'index.json'), buildIndex(state));
    atomicJson(join(root, '.ccpg-scheme', 'publications.json'), { schemaVersion: 1, items: [] });
    return store;
  } catch (error) { throw error; }
}

export async function registerMaterial(store, input) {
  store.reload(); if (!input?.name || (input.text == null && !input.metadata)) throw new Error('material content or acquisition metadata required');
  const value = input.text == null ? JSON.stringify(input.metadata) : String(input.text); const digest = sha(value); const identity = input.metadata?.sourcePath || input.metadata?.url || input.name; const id = `mat-${sha(`${identity}\0${digest}${input.metadata?.sourceSha256 ? `\0${input.metadata.sourceSha256}` : ''}`).slice(0, 16)}`;
  const contentPath = input.text == null ? undefined : `materials/raw/${id}.md`;
  if (contentPath && existsSync(checkedPath(store.root, contentPath)) && sha(readFileSync(checkedPath(store.root, contentPath))) !== digest) throw new Error('saved material content changed');
  if (contentPath && !existsSync(checkedPath(store.root, contentPath))) await writeFile(checkedPath(store.root, contentPath), String(input.text), { flag: 'wx' });
  const parseStatus = input.text == null ? 'pending' : input.parseStatus || 'available';
  if (!['pending', 'available', 'complete', 'needs-review', 'needs-vision'].includes(parseStatus)) throw new Error('invalid material parse status');
  const material = { id, name: String(input.name), kind: input.text == null ? 'acquisition' : 'text', contentPath, metadata: input.metadata, sha256: digest, version: 1, parseStatus, createdAt: now() };
  store.commit(store.state.revision, (s) => { s.materials[id] ||= material; if (input.parseStatus) { s.materials[id].parseStatus = parseStatus; s.materials[id].metadata = input.metadata; } }); return store.state.materials[id];
}

export async function registerFetchedMaterial(store, { name, text, metadata, snapshot, parseStatus } = {}) {
  if (typeof text !== 'string' || !snapshot) throw new Error('fetched material content and snapshot required');
  const identity = metadata?.sourcePath || metadata?.url || name;
  const id = `mat-${sha(`${identity}\0${sha(text)}${metadata?.sourceSha256 ? `\0${metadata.sourceSha256}` : ''}`).slice(0, 16)}`;
  const snapshotPath = `materials/fetched/${id}.json`;
  const path = checkedPath(store.root, snapshotPath);
  await mkdir(dirname(path), { recursive: true });
  if (!existsSync(path)) await writeFile(path, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
  return registerMaterial(store, { name, text, parseStatus, metadata: { ...metadata, snapshotPath } });
}

export async function createPublicationSnapshot(store, { operationId, markdown } = {}) {
  validId(operationId, 'publication operation id');
  if (typeof markdown !== 'string') throw new Error('publication markdown required');
  const artifactPath = `outputs/final/publications/${operationId}.md`;
  const receiptPath = `.ccpg-scheme/publications/${operationId}.ndjson`;
  const artifact = checkedPath(store.root, artifactPath);
  const receipt = checkedPath(store.root, receiptPath);
  await mkdir(dirname(artifact), { recursive: true });
  await mkdir(dirname(receipt), { recursive: true });
  try { await writeFile(artifact, markdown, { flag: 'wx', mode: 0o400 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (sha(await readFile(artifact)) !== sha(markdown)) throw new Error('publication snapshot changed');
  }
  await chmod(artifact, 0o400);
  return { artifactPath: artifact, receiptPath: receipt, relativePath: artifactPath };
}

function chapterDef(store, id) { const manifest = projectManifest(store); const chapter = manifest.chapters.find((item) => item.id === id); if (!chapter) throw new Error('unknown chapter'); return { manifest, chapter }; }
function descendants(manifest, id) { const out = new Set(); for (let changed = true; changed;) { changed = false; for (const chapter of manifest.chapters) if ((chapter.dependencies || []).some((dep) => dep === id || out.has(dep)) && !out.has(chapter.id)) { out.add(chapter.id); changed = true; } } return out; }
function materialComplete(material) {
  const coverage = material.metadata?.coverage || {};
  return material.kind === 'text' && ['available', 'complete'].includes(material.parseStatus)
    && !['unreadImages', 'unreadPages', 'unsupportedParts', 'unresolved'].some((key) => coverage[key]?.length)
    && (coverage.visualVerified === true || coverage.method !== 'image'
      && (coverage.method !== 'text-layer' || Array.isArray(coverage.visualPages) && !coverage.visualPages.length));
}
function checkInputs(chapter, bindings, decisions, materials) { for (const input of chapter.inputs || []) { if (input.required === 'unknown' && !['required', 'not_required'].includes(decisions?.[input.id])) throw new Error(`required decision missing: ${input.id}`); const required = input.required === true || decisions?.[input.id] === 'required'; if (required && !bindings?.[input.id]) throw new Error(`required input missing: ${input.id}`); const material = materials[bindings?.[input.id]]; if (bindings?.[input.id] && !material) throw new Error(`unknown material: ${bindings[input.id]}`); if (material && !materialComplete(material)) throw new Error(`input not acquired or incomplete: ${input.id}`); } }

function hasPendingReview(store, definition, current = store.state.chapters[definition.id]) {
  if (!current?.artifactId || current.stale || !['submitted', 'confirmed'].includes(current.status)) return Boolean(current?.pendingConfirmations);
  verifyArtifactFiles(store, definition.id);
  if (current.confirmed) return false;
  if ((definition.confirmations || []).some(item => item.required === true)) return true;
  const artifact = store.state.artifacts[current.artifactId];
  const review = documentReview({
    body: readFileSync(checkedPath(store.root, `${artifact.path}/body.md`), 'utf8'),
    confirmations: JSON.parse(readFileSync(checkedPath(store.root, `${artifact.path}/confirmations.json`), 'utf8')),
  });
  return review.items.some(item => item.required !== false && !['confirmed', 'not_required'].includes(item.status));
}

export async function prepareChapter(store, { chapterId, inputBindings = {}, inputDecisions = {}, sessionId } = {}) {
  store.reload(); const { manifest, chapter } = chapterDef(store, chapterId); assertRules(store, manifest);
  if (!Object.keys(store.state.materials).length) {
    const pending = await indexMaterialDirectory(join(store.root, 'materials', 'input'));
    if (pending.length) throw new Error(`source materials are present but not registered; register relevant materials before chapter preparation (${pending.length} files detected)`);
  }
  if ((chapter.blockers || []).some((blocker) => blocker && blocker.unresolved !== false)) throw new Error(`unresolved blocker: ${chapterId}`);
  if (Object.values(store.state.chapters).some((item) => ['prepared', 'running'].includes(item.status))) throw new Error('another chapter is already prepared');
  const current = store.state.chapters[chapterId]; if (current.confirmed && !current.stale) throw new Error('chapter already confirmed');
  for (const dep of chapter.dependencies || []) { const upstream = store.state.chapters[dep]; const upstreamDef = manifest.chapters.find((item) => item.id === dep); if (!['submitted', 'confirmed'].includes(upstream?.status) || upstream.stale) throw new Error(`dependency not ready: ${dep}`); if (hasPendingReview(store, upstreamDef)) throw new Error(`pending confirmation: ${dep}`); }
  const firstIncomplete = [...manifest.chapters].sort((a, b) => a.order - b.order).find((item) => {
    const state = store.state.chapters[item.id];
    return state?.status !== 'skipped' && !(state?.artifactId && !state.stale && !hasPendingReview(store, item) && ['submitted', 'confirmed'].includes(state.status));
  });
  if (firstIncomplete && firstIncomplete.id !== chapterId) throw new Error(`natural order blocked by: ${firstIncomplete.id}`);
  inputBindings = { ...current.bindings, ...inputBindings };
  inputDecisions = { ...current.decisions, ...inputDecisions };
  for (const ref of chapter.references || []) {
    const ids = (ref.inputIds || []).filter((id) => (chapter.inputs || []).some((input) => input.id === id) && !inputBindings[id]);
    if (!ref.roles?.includes('knowledge') || !ids.length || !ref.original) continue;
    const sourcePath = `.dsh/${join(dirname(chapter.skill), ref.original)}`;
    const original = checkedPath(store.root, sourcePath);
    const sourceSha256 = sha(readFileSync(original));
    let material = Object.values(store.state.materials).filter((item) => item.metadata?.sourcePath === sourcePath && item.metadata.sourceSha256 === sourceSha256 && item.metadata.parserVersion === MATERIAL_PARSER_VERSION).sort((a, b) => Number(materialComplete(b)) - Number(materialComplete(a)))[0];
    if (!material) {
      const parsed = await parseMaterialFile({ inputPath: original, outputRoot: join(store.root, 'materials', 'parsed'), maxBytes: 25 * 1024 * 1024 });
      material = await registerMaterial(store, { name: parsed.name, text: await readFile(parsed.markdownPath, 'utf8'), parseStatus: parsed.status, metadata: { source: 'project-file', sourcePath, sourceSha256: parsed.sha256, parserVersion: parsed.parserVersion, coverage: parsed.coverage, imagePaths: parsed.images.map((path) => relative(store.root, path)), parsedPath: relative(store.root, parsed.markdownPath) } });
    }
    for (const id of ids) inputBindings[id] = material.id;
    if (!materialComplete(material)) throw new Error(`bundled knowledge needs document review: ${ids.join(', ')}; materialId=${material.id}; original=${sourcePath}; parsed=${material.contentPath}. Read the relevant original content and save its document-level interpretation with material_complete; do not ask the user to upload bundled knowledge.`);
  }
  checkInputs(chapter, inputBindings, inputDecisions, store.state.materials);
  for (const dep of chapter.dependencies || []) verifyArtifactFiles(store, dep);
  const token = { projectId: store.state.projectId, chapterId, attemptId: randomUUID(), sessionId: sessionId == null ? undefined : String(sessionId), rulesFingerprint: store.state.rulesFingerprint, materialsFingerprint: assertMaterialFingerprint(store, store.state, inputBindings), upstreamFingerprint: upstreamFingerprint(store.state, chapter, store), chapterRevision: current.revision, bindings: structuredClone(inputBindings), decisions: structuredClone(inputDecisions), issuedAt: now() };
  store.commit(store.state.revision, (s) => { s.chapters[chapterId] = { ...s.chapters[chapterId], status: 'prepared', stale: false, bindings: structuredClone(inputBindings), token, preparedAt: now() }; });
  const skillName = validId(String(basename(dirname(chapter.skill))), 'skill name');
  const skillPath = `.dsh/${chapter.skill}`;
  const draftPath = `materials/notes/${chapterId}-draft.md`;
  return {
    token,
    projectCwd: store.root,
    draftPath,
    outputs: structuredClone(chapter.outputs || []),
    skillName,
    skillPath,
    skillSource: 'project-dsh',
    prompt: `请在当前同一个 DSH 原生会话中确认 cwd=${store.root}，通过 DSH 原生 SkillRegistry 加载项目技能 ${skillPath}（技能名 ${skillName}），并按 AGENTS.md 和该技能生成章节 ${chapter.title}。按小节及时保存正文到 ${draftPath}，核对完整后调用 chapter_submit，使用 bodyPath 提交已保存正文，无需再次输出整篇。附件使用 outputs 中 kind=attachment 的 id 作为 outputId，name 使用可读文件名，文字放 content/contentPath，图片或其他原件用 filePath；正文指定位置的图片使用标准 Markdown 图片引用，不用文字描述替代原图。证据 source 使用已登记的材料或成果 ID。`,
  };
}

async function persistArtifact(store, artifact) {
  const images = { ...(artifact.images || {}) };
  let imageBytes = 0;
  const snapshotImage = (source) => {
    if (!images[source]) images[source] = Object.entries(images).find(([saved]) => decodeURIComponent(saved) === decodeURIComponent(source))?.[1];
    if (!images[source]) {
      let bytes; let name;
      if (source.startsWith('data:')) {
        const match = source.match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) throw new Error('invalid inline image');
        bytes = Buffer.from(match[2], 'base64'); name = `正文图片-${Object.keys(images).length + 1}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
      } else {
        if (/^[a-z][a-z\d+.-]*:/i.test(source)) throw new Error('image must reference a local saved original; remote URLs are not fetched during submission');
        const attachment = artifact.attachments.find((item) => item.name === source || item.sourcePath === source);
        if (attachment?.base64) { bytes = Buffer.from(attachment.base64, 'base64'); name = attachment.name; }
        else {
          const path = projectOutputFile(store, decodeURIComponent(source.replace(/^@\.?\//, '').replace(/^\.\//, '')));
          bytes = readFileSync(path); name = basename(path);
        }
      }
      images[source] = { name, mime: imageMime(bytes), base64: bytes.toString('base64') };
    }
    imageBytes += Buffer.from(images[source].base64, 'base64').length;
    if (imageBytes > 25 * 1024 * 1024) throw new Error('inline images exceed 25 MiB; use smaller display images');
    return source;
  };
  const used = new Set();
  const collect = (text) => {
    const prose = String(text || '').replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[^\n]*(?:\n|$)/gm, '');
    if (/<img\b/i.test(prose) || /!\[(?:\\.|[^\]\\])*\](?!\()/.test(prose)) throw new Error('use standard inline Markdown images: ![description](<local-file-path>)');
    return mapDocumentImages(text, (source) => { if (!used.has(source)) { snapshotImage(source); used.add(source); } return source; });
  };
  collect(artifact.body);
  for (const item of artifact.attachments) if (/\.(md|markdown)$/i.test(item.name) && typeof item.content === 'string') collect(item.content);
  artifact.images = Object.fromEntries([...used].map((source) => [source, images[source]]));
  validId(artifact.id, 'artifact id');
  const rootRel = `outputs/chapters/${validId(artifact.chapterId, 'chapter id')}/${artifact.id}`;
  const target = checkedPath(store.root, rootRel); await mkdir(target, { recursive: true });
  const files = {
    body: { path: 'body.md', content: artifact.body },
    summary: { path: 'summary.md', content: artifact.summary || '' },
    evidence: { path: 'evidence.json', content: JSON.stringify(artifact.evidence, null, 2) },
    attachments: { path: 'attachments.json', content: JSON.stringify(artifact.attachments, null, 2) },
    confirmations: { path: 'confirmations.json', content: JSON.stringify(artifact.confirmations, null, 2) },
    contextRefs: { path: 'context-refs.json', content: JSON.stringify(artifact.contextRefs || [], null, 2) },
    images: { path: 'images.json', content: JSON.stringify(artifact.images, null, 2) },
  };
  try { for (const file of Object.values(files)) await writeFile(checkedPath(store.root, `${rootRel}/${file.path}`), file.content, { flag: 'wx' }); }
  catch (error) { removeManaged(store.root, rootRel); throw error; }
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, { path: file.path, sha256: sha(file.content) }]));
}

function projectOutputFile(store, value) {
  if (typeof value !== 'string' || !/^(materials\/|outputs\/|\.dsh\/skills\/)/.test(value) || value.split(/[\\/]/).some((part) => SECRET.test(part))) throw new Error('unsafe output file path');
  const path = checkedPath(store.root, value); const info = lstatSync(path);
  if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error('output file must be a regular file within 25 MiB');
  return path;
}

function validateEvidence(state, evidence) {
  for (const item of evidence || []) if (item?.source && !state.materials[item.source] && !state.artifacts[item.source]) throw new Error(`evidence source must be a registered material or artifact id: ${item.source}`);
}

function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  const outputs = new Set(); let bytes = 0;
  for (const item of attachments) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || /[\\/\x00-\x1f]/.test(item.name) || ['.', '..'].includes(item.name)) throw new Error('unsafe attachment name');
    validId(item.outputId, 'attachment output id');
    if (outputs.has(item.outputId)) throw new Error('duplicate attachment output');
    outputs.add(item.outputId);
    const text = typeof item.content === 'string'; const binary = typeof item.base64 === 'string';
    if (text === binary) throw new Error('attachment must contain exactly one content or base64 value');
    if (binary && (Buffer.from(item.base64, 'base64').toString('base64') !== item.base64 || !item.base64)) throw new Error('invalid attachment base64');
    if (/\.(png|jpe?g|gif|webp)$/i.test(item.name)) {
      if (!binary) throw new Error('image attachment requires original bytes, not a text interpretation');
      const mime = imageMime(Buffer.from(item.base64, 'base64'));
      if (mime !== `image/${item.name.match(/\.(png|jpe?g|gif|webp)$/i)[1].toLowerCase().replace(/^jpe?g$/, 'jpeg')}`) throw new Error('image attachment extension does not match original bytes');
    }
    const size = text ? Buffer.byteLength(item.content) : Buffer.from(item.base64, 'base64').length;
    bytes += size;
    if (!size || bytes > 25 * 1024 * 1024) throw new Error('attachment content empty or too large');
  }
}

export async function submitChapter(store, { token, body, bodyPath, evidence = [], attachments = [], confirmations = [], summary = '', contextRefs = [], sessionId, signal }) {
  cancelled(signal);
  store.reload(); if (!token?.chapterId || token.projectId !== store.state.projectId) throw new Error('invalid preparation token');
  if (token.sessionId && String(sessionId || '') !== String(token.sessionId)) throw new Error('stale preparation token: native session mismatch');
  const { manifest, chapter } = chapterDef(store, token.chapterId); const current = store.state.chapters[token.chapterId];
  if (!current?.token) throw new Error('stale preparation token: no active preparation');
  if (!sameJson(current.token, token)) throw new Error('stale preparation token: preparation state changed');
  assertRules(store, manifest, token.rulesFingerprint);
  if (token.materialsFingerprint !== assertMaterialFingerprint(store, store.state, token.bindings) || token.upstreamFingerprint !== upstreamFingerprint(store.state, chapter, store)) { store.reload(); throw new Error('prepared inputs or upstream changed'); }
  checkInputs(chapter, token.bindings, token.decisions, store.state.materials);
  if (bodyPath != null) {
    if (body != null) throw new Error('provide exactly one body or bodyPath');
    if (typeof bodyPath !== 'string' || !/^materials\/notes\/.+\.md$/u.test(bodyPath)) throw new Error('unsafe draft path');
    const path = checkedPath(store.root, bodyPath); const info = lstatSync(path);
    if (!info.isFile()) throw new Error('draft must be a regular file');
    if (info.size > 2 * 1024 * 1024) throw new Error('draft is too large');
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  }
  if (typeof body !== 'string' || !body.trim()) throw new Error('body is required');
  validateEvidence(store.state, evidence);
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  attachments = attachments.map((item) => {
    if (item?.filePath != null) {
      if (item.content != null || item.contentPath != null || item.base64 != null) throw new Error('attachment must contain exactly one content, contentPath, filePath or base64 value');
      const bytes = readFileSync(projectOutputFile(store, item.filePath));
      const { filePath, ...attachment } = item;
      if (/\.(md|markdown)$/i.test(item.name || '')) return { ...attachment, sourcePath: filePath, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
      return { ...attachment, sourcePath: filePath, base64: bytes.toString('base64') };
    }
    if (item?.contentPath == null) return item && typeof item === 'object' ? { ...item } : item;
    if (item.content != null || item.base64 != null) throw new Error('attachment must contain exactly one content, contentPath or base64 value');
    if (typeof item.contentPath !== 'string' || !/^materials\/notes\/.+\.(md|txt|csv|json)$/u.test(item.contentPath) || item.contentPath.split(/[\\/]/).includes('..')) throw new Error('unsafe attachment draft path');
    const path = checkedPath(store.root, item.contentPath); const info = lstatSync(path);
    if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error('attachment draft must be a regular file within the size limit');
    const { contentPath: _path, ...attachment } = item;
    return { ...attachment, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)) };
  });
  for (const item of attachments) if (typeof item?.content === 'string' && /\.(md|markdown)$/i.test(item.name || '')) item.content = stripGenerationNotes(item.content);
  validateAttachments(attachments);
  for (const output of chapter.outputs || []) if (output.kind === 'attachment' && !attachments.some((item) => item?.outputId === output.id && item?.name && (typeof item.content === 'string' || typeof item.base64 === 'string'))) throw new Error(`attachment output required: ${output.id}`);
  const expectedRevision = store.state.revision;
  const review = documentReview({ body, confirmations });
  const artifactConfirmations = structuredClone(review.items).map((item) => ({ ...item, status: item?.required === false ? (item.status || 'not_required') : 'pending' }));
  const artifact = { id: `art-${randomUUID()}`, chapterId: token.chapterId, body: review.body, summary: String(summary || ''), evidence: structuredClone(evidence), attachments: structuredClone(attachments), confirmations: artifactConfirmations, contextRefs: structuredClone(contextRefs), createdAt: now() }; const files = await persistArtifact(store, artifact);
  const pendingConfirmations = (chapter.confirmations || []).some((item) => item.required === true) || artifactConfirmations.some((item) => item?.required !== false);
  try { cancelled(signal); store.commit(expectedRevision, (s) => {
    const active = s.chapters[token.chapterId];
    if (!active?.token || active.status !== 'prepared') throw new Error('stale preparation token: preparation revoked');
    if (!sameJson(active.token, token)) throw new Error('stale preparation token: preparation state changed');
    if (token.materialsFingerprint !== assertMaterialFingerprint(store, s, token.bindings, { mark: false }) || token.upstreamFingerprint !== upstreamFingerprint(s, chapter, store)) throw new Error('prepared inputs or upstream changed');
    checkInputs(chapter, token.bindings, token.decisions, s.materials);
    delete s.confirmations[token.chapterId];
    if (active.artifactId) for (const id of descendants(manifest, token.chapterId)) { delete s.confirmations[id]; s.chapters[id] = { ...s.chapters[id], stale: true, confirmed: false, pendingConfirmations: false, status: 'stale', token: null }; }
    s.artifacts[artifact.id] = { id: artifact.id, chapterId: token.chapterId, createdAt: artifact.createdAt, path: `outputs/chapters/${token.chapterId}/${artifact.id}`, files }; s.chapters[token.chapterId] = { ...active, status: 'submitted', artifactId: artifact.id, revision: active.revision + 1, pendingConfirmations, confirmed: false, bindings: structuredClone(token.bindings), decisions: structuredClone(token.decisions), token: null };
  }); }
  catch (error) { removeManaged(store.root, `outputs/chapters/${token.chapterId}/${artifact.id}`); throw error; }
  return { status: 'submitted', artifactId: artifact.id, revision: store.state.revision };
}

export async function skipChapter(store, { chapterId, revision, reason, signal }) {
  cancelled(signal);
  store.reload(); validId(chapterId, 'chapter id'); if (!String(reason || '').trim()) throw new Error('skip reason is required');
  const { manifest, chapter } = chapterDef(store, chapterId); if (revision !== store.state.revision) throw new Error('revision conflict');
  const firstIncomplete = [...manifest.chapters].sort((a, b) => a.order - b.order).find((item) => {
    const state = store.state.chapters[item.id];
    return state?.status !== 'skipped' && !(state?.artifactId && !state.stale && !hasPendingReview(store, item) && ['submitted', 'confirmed'].includes(state.status));
  });
  if (firstIncomplete && firstIncomplete.id !== chapterId) throw new Error(`natural order blocked by: ${firstIncomplete.id}`);
  store.commit(revision, (s) => { cancelled(signal); s.chapters[chapter.id] = { ...s.chapters[chapter.id], status: 'skipped', skipReason: String(reason), skippedAt: now(), token: null }; });
  return store.state.chapters[chapter.id];
}

export async function confirmChapter(store, { chapterId, revision, artifactRevision, signal }) {
  cancelled(signal);
  store.reload(); const { manifest } = chapterDef(store, chapterId); assertRules(store, manifest);
  const chapter = store.state.chapters[chapterId];
  if (!chapter || chapter.status !== 'submitted' || revision !== store.state.revision || (artifactRevision != null && artifactRevision !== chapter.revision)) throw new Error('chapter not ready for confirmation or revision conflict');
  verifyChapterMaterials(store, chapterId);
  verifyArtifactFiles(store, chapterId);
  const record = { chapterId, artifactId: chapter.artifactId, artifactRevision: chapter.revision, confirmedAt: now() };
  store.commit(revision, (s) => { cancelled(signal); s.confirmations[chapterId] = record; s.chapters[chapterId].confirmed = true; s.chapters[chapterId].pendingConfirmations = false; s.chapters[chapterId].status = 'confirmed'; });
  return store.state.chapters[chapterId];
}

export async function editChapter(store, { chapterId, revision, artifactRevision, body, summary, attachmentOutputId, reviewItems = [], userReview = false, signal }) {
  cancelled(signal);
  if (typeof body !== 'string' || !body.trim()) throw new Error('body is required');
  store.reload(); const { manifest, chapter: definition } = chapterDef(store, chapterId); assertRules(store, manifest);
  const chapter = store.state.chapters[chapterId]; if (revision !== store.state.revision || (artifactRevision != null && artifactRevision !== chapter.revision)) throw new Error('revision conflict'); if (!chapter.artifactId) throw new Error('no committed artifact');
  verifyChapterMaterials(store, chapterId);
  verifyArtifactFiles(store, chapterId);
  const priorArtifact = store.state.artifacts[chapter.artifactId];
  const prior = priorArtifact.path;
  const artifact = { id: `art-${randomUUID()}`, chapterId, body: String(body), summary: summary == null ? String(body) : String(summary), evidence: JSON.parse(readFileSync(checkedPath(store.root, `${prior}/evidence.json`))), attachments: JSON.parse(readFileSync(checkedPath(store.root, `${prior}/attachments.json`))), confirmations: JSON.parse(readFileSync(checkedPath(store.root, `${prior}/confirmations.json`))), contextRefs: JSON.parse(readFileSync(checkedPath(store.root, `${prior}/context-refs.json`))), createdAt: now() }; const stale = descendants(manifest, chapterId);
  if (priorArtifact.files.images) artifact.images = JSON.parse(readFileSync(checkedPath(store.root, `${prior}/${priorArtifact.files.images.path}`)));
  if (attachmentOutputId != null) {
    const attachment = artifact.attachments.find((item) => item.outputId === attachmentOutputId);
    if (!attachment || typeof attachment.content !== 'string') throw new Error('text attachment unavailable');
    attachment.content = body;
    artifact.body = readFileSync(checkedPath(store.root, `${prior}/body.md`), 'utf8');
    artifact.summary = readFileSync(checkedPath(store.root, `${prior}/summary.md`), 'utf8');
    validateAttachments(artifact.attachments);
  }
  const review = documentReview({
    body: artifact.body,
    confirmations: attachmentOutputId == null
      ? [...artifact.confirmations, ...(Array.isArray(reviewItems) ? reviewItems.map(item => userReview ? item : { ...item, status: artifact.confirmations.find(prior => prior.id === item.id)?.status || 'pending' }) : [])]
      : artifact.confirmations,
  });
  artifact.body = review.body;
  artifact.confirmations = review.items;
  for (const item of artifact.attachments) if (typeof item.content === 'string' && /\.(md|markdown)$/i.test(item.name || '')) item.content = stripGenerationNotes(item.content);
  const files = await persistArtifact(store, artifact);
  const pendingConfirmations = (definition.confirmations || []).some((item) => item.required === true) || artifact.confirmations.some((item) => item?.required !== false && !['confirmed', 'not_required'].includes(item.status));
  try { cancelled(signal); store.commit(revision, (s) => { cancelled(signal); s.artifacts[artifact.id] = { id: artifact.id, chapterId, createdAt: artifact.createdAt, priorId: chapter.artifactId, path: `outputs/chapters/${chapterId}/${artifact.id}`, files }; delete s.confirmations[chapterId]; s.chapters[chapterId] = { ...s.chapters[chapterId], confirmed: false, pendingConfirmations, status: 'submitted', artifactId: artifact.id, revision: s.chapters[chapterId].revision + 1 }; for (const id of stale) { delete s.confirmations[id]; s.chapters[id] = { ...s.chapters[id], stale: true, confirmed: false, pendingConfirmations: false, status: 'stale', token: null }; } }); }
  catch (error) { removeManaged(store.root, `outputs/chapters/${chapterId}/${artifact.id}`); throw error; }
  return store.state.artifacts[artifact.id];
}

export async function recoverProject(store) { store.reload(); store.commit(store.state.revision, (s) => { for (const chapter of Object.values(s.chapters)) if (['prepared', 'running'].includes(chapter.status)) { chapter.status = 'interrupted'; chapter.interrupted = true; chapter.token = null; } }); return store.state; }

function markArtifactExternalChanged(store, chapterId) {
  const manifest = projectManifest(store);
  if (store.state.chapters[chapterId]?.status !== 'external-changed') {
    store.commit(store.state.revision, (s) => {
      delete s.confirmations[chapterId];
      s.chapters[chapterId] = { ...s.chapters[chapterId], stale: true, confirmed: false, status: 'external-changed' };
      for (const id of descendants(manifest, chapterId)) { delete s.confirmations[id]; s.chapters[id] = { ...s.chapters[id], stale: true, confirmed: false, status: 'stale' }; }
    });
  }
}

function verifyArtifactFiles(store, chapterId) {
  const current = store.state.chapters[chapterId]; const artifact = store.state.artifacts[current?.artifactId];
  if (current?.status === 'external-changed') throw new Error(`artifact external-changed: ${chapterId}`);
  if (!artifact?.files) return;
  for (const file of Object.values(artifact.files)) {
    let content;
    try { content = readFileSync(checkedPath(store.root, `${artifact.path}/${file.path}`), 'utf8'); }
    catch { markArtifactExternalChanged(store, chapterId); throw new Error(`artifact external-changed: ${chapterId}`); }
    if (sha(content) !== file.sha256) { markArtifactExternalChanged(store, chapterId); throw new Error(`artifact external-changed: ${chapterId}`); }
  }
}

export async function exportProject(store, { requireComplete = false, chapterId } = {}) {
  store.reload(); const manifest = projectManifest(store); assertRules(store, manifest);
  const chapters = chapterId === undefined ? manifest.chapters : [chapterDef(store, chapterId).chapter];
  if (requireComplete) {
    const incomplete = chapters.filter((chapter) => {
      const state = store.state.chapters[chapter.id];
      return !state?.artifactId || state.stale || hasPendingReview(store, chapter) || !['submitted', 'confirmed'].includes(state.status)
        || (chapter.confirmations || []).some((item) => item.required === true) && !state.confirmed;
    });
    if (incomplete.length) throw new Error(`incomplete chapters: ${incomplete.map((chapter) => chapter.id).join(', ')}`);
  }
  const parts = [];
  for (const chapter of [...chapters].sort((a, b) => a.order - b.order)) {
    const state = store.state.chapters[chapter.id];
    if (!state?.artifactId) continue;
    verifyChapterMaterials(store, chapter.id);
    if (state.status === 'external-changed') throw new Error(`chapter output external-changed: ${chapter.id}`);
    if (state.stale) continue;
    verifyArtifactFiles(store, chapter.id);
    const artifact = store.state.artifacts[state.artifactId];
    const body = await readFile(checkedPath(store.root, `${artifact.path}/body.md`), 'utf8');
    const review = documentReview({ body, confirmed: state.confirmed, confirmations: JSON.parse(await readFile(checkedPath(store.root, `${artifact.path}/confirmations.json`), 'utf8')) });
    if (requireComplete && review.items.some((item) => !['confirmed', 'not_required'].includes(item.status))) throw new Error(`pending confirmation items: ${chapter.id}`);
    parts.push(/^\s*#\s+\S/.test(review.body) ? review.body : `# ${chapter.code || chapter.order} ${chapter.title}\n\n${review.body}`);
  }
  return `${parts.join('\n\n')}\n`;
}

const deliveryName = (value) => String(value).replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 160) || '文件';

export async function exportDelivery(store, { requireComplete = false, chapterId } = {}) {
  await exportProject(store, { requireComplete, chapterId });
  const revision = store.state.revision; const manifest = projectManifest(store);
  const selectedChapters = chapterId === undefined ? manifest.chapters : [chapterDef(store, chapterId).chapter];
  const attachments = []; const incomplete = []; const chapters = []; const assets = []; const parts = [];
  for (const chapter of [...selectedChapters].sort((a, b) => a.order - b.order)) {
    const current = store.state.chapters[chapter.id];
    const pendingReview = hasPendingReview(store, chapter);
    if (!current?.artifactId || current.stale || pendingReview || !['submitted', 'confirmed'].includes(current.status)) {
      incomplete.push({ chapterId: chapter.id, code: chapter.code || chapter.order, title: chapter.title, status: current?.stale ? 'stale' : pendingReview ? 'pending-confirmation' : current?.status || 'pending' });
    }
    if (!current?.artifactId || current.stale) continue;
    const artifact = await readChapterArtifact(store, chapter.id);
    const imagePaths = {};
    const savedImages = store.state.artifacts[current.artifactId].files.images ? JSON.parse(await readFile(checkedPath(store.root, `${store.state.artifacts[current.artifactId].path}/images.json`), 'utf8')) : {};
    for (const [source, data] of Object.entries(artifact.images || {})) {
      const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
      const saved = savedImages[source];
      const path = `图片/${chapter.id}/${Object.keys(imagePaths).length + 1}-${deliveryName(saved.name)}`;
      imagePaths[source] = path;
      assets.push({ path, name: saved.name, base64: bytes.toString('base64'), sha256: sha(bytes), bytes: bytes.length, mime: saved.mime });
    }
    const portable = (text) => mapDocumentImages(text, (source) => imagePaths[source]);
    const body = portable(documentReview({ ...artifact, confirmed: current.confirmed }).body);
    parts.push(/^\s*#\s+\S/.test(body) ? body : `# ${chapter.code || chapter.order} ${chapter.title}\n\n${body}`);
    if (documentReview({ ...artifact, confirmed: current.confirmed }).items.some((item) => !['confirmed', 'not_required'].includes(item.status)) && !incomplete.some((item) => item.chapterId === chapter.id)) incomplete.push({ chapterId: chapter.id, code: chapter.code || chapter.order, title: chapter.title, status: 'pending-confirmation' });
    validateAttachments(artifact.attachments);
    for (const output of chapter.outputs || []) if (output.kind === 'attachment' && !artifact.attachments.some((item) => item.outputId === output.id)) throw new Error(`attachment output required: ${output.id}`);
    chapters.push({ chapterId: chapter.id, artifactId: current.artifactId, revision: current.revision });
    for (const [index, item] of artifact.attachments.entries()) {
      const bytes = typeof item.content === 'string' ? Buffer.from(item.content) : Buffer.from(item.base64, 'base64');
      const path = `附件/${deliveryName(`${chapter.code || chapter.order} ${chapter.title}`)}/${index + 1}-${deliveryName(item.name)}`;
      const content = typeof item.content === 'string' && /\.(md|markdown)$/i.test(item.name) ? mapDocumentImages(item.content, (source) => imagePaths[source] ? relative(dirname(path), imagePaths[source]).split(sep).join('/') : undefined) : item.content;
      const exportedBytes = typeof content === 'string' ? Buffer.from(content) : bytes;
      attachments.push({ ...item, ...(content != null ? { content } : {}), chapterId: chapter.id, path, sha256: sha(exportedBytes), bytes: exportedBytes.length });
    }
  }
  store.reload();
  if (store.state.revision !== revision) throw new Error('project changed during delivery; export again');
  return { projectId: store.state.projectId, ...(chapterId === undefined ? {} : { chapterId }), revision, markdown: `${parts.join('\n\n')}\n`, assets, attachments, chapters, incomplete, complete: incomplete.length === 0 };
}

export async function createDeliverySnapshot(store, { requireComplete = true, chapterId, word = false } = {}) {
  const delivery = await exportDelivery(store, { requireComplete, chapterId });
  const files = new Map([['完整方案.md', Buffer.from(delivery.markdown)]]);
  if (word) {
    const { createWordDocument } = await import('./word.js');
    files.set('完整方案.docx', await createWordDocument(delivery));
  }
  for (const [index, attachment] of delivery.attachments.entries()) {
    files.set(attachment.path, typeof attachment.content === 'string' ? Buffer.from(attachment.content) : Buffer.from(attachment.base64, 'base64'));
    if (/\.(md|markdown)$/i.test(attachment.name) && typeof attachment.content === 'string') {
      let hasImages = false;
      const content = mapDocumentImages(attachment.content, (source) => {
        hasImages = true;
        const path = join(dirname(attachment.path), source).split(sep).join('/');
        if (!delivery.assets.some((item) => item.path === path)) throw new Error('attachment image snapshot unavailable');
        return `@./${path}`;
      });
      if (hasImages) { attachment.publicationPath = `飞书附件/${index + 1}-${deliveryName(attachment.name)}`; files.set(attachment.publicationPath, Buffer.from(content)); }
    }
  }
  for (const asset of delivery.assets) files.set(asset.path, Buffer.from(asset.base64, 'base64'));
  if (delivery.assets.length) files.set('飞书正文.md', Buffer.from(mapDocumentImages(delivery.markdown, (source) => `@./${source}`)));
  store.reload();
  if (store.state.revision !== delivery.revision) throw new Error('project changed during delivery; export again');
  const manifest = { projectId: delivery.projectId, ...(chapterId === undefined ? {} : { chapterId }), revision: delivery.revision, complete: delivery.complete, incomplete: delivery.incomplete, chapters: delivery.chapters, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) };
  const digest = sha(JSON.stringify(manifest));
  const directory = `${chapterId === undefined ? 'outputs/final' : `outputs/delivery/${chapterId}`}/revision-${delivery.revision}-${digest.slice(0, 12)}`;
  files.set('交付清单.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const target = checkedPath(store.root, directory);
  if (existsSync(target)) {
    for (const [path, bytes] of files) if (sha(await readFile(checkedPath(store.root, `${directory}/${path}`))) !== sha(bytes)) throw new Error('delivery snapshot externally changed');
  } else {
    const staging = `${directory}.${randomUUID()}.tmp`;
    try {
      for (const [path, bytes] of files) {
        const file = checkedPath(store.root, `${staging}/${path}`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      }
      await rename(checkedPath(store.root, staging), target);
    } catch (error) { removeManaged(store.root, staging); throw error; }
  }
  store.reload();
  if (store.state.revision !== delivery.revision) throw new Error('project changed during delivery; export again');
  return { ...delivery, directory, artifactPath: checkedPath(store.root, `${directory}/完整方案.md`), ...(word ? { wordPath: checkedPath(store.root, `${directory}/完整方案.docx`), base64: files.get('完整方案.docx').toString('base64') } : {}), digest, files: manifest.files };
}

export async function readChapterArtifact(store, chapterId) {
  store.reload(); validId(chapterId, 'chapter id');
  const { manifest, chapter } = chapterDef(store, chapterId); const current = store.state.chapters[chapterId];
  if (!current?.artifactId) throw new Error('chapter artifact unavailable');
  const artifact = store.state.artifacts[current.artifactId];
  if (!artifact || artifact.chapterId !== chapterId) throw new Error('chapter artifact unavailable');
  verifyChapterMaterials(store, chapterId);
  verifyArtifactFiles(store, chapterId);
  const root = join(store.root, 'outputs', 'chapters', chapterId, validId(current.artifactId, 'artifact id'));
  const review = documentReview({
    body: await readFile(join(root, 'body.md'), 'utf8'),
    confirmations: JSON.parse(await readFile(join(root, 'confirmations.json'), 'utf8')),
    confirmed: current.confirmed,
  });
  const attachments = JSON.parse(await readFile(join(root, 'attachments.json'), 'utf8'));
  for (const item of attachments) if (typeof item.content === 'string' && /\.(md|markdown)$/i.test(item.name || '')) item.content = stripGenerationNotes(item.content);
  return {
    chapterId, title: chapter.title, status: current.status, stale: Boolean(current.stale),
    revision: current.revision, artifactId: current.artifactId,
    body: review.body,
    evidence: JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8')),
    attachments,
    confirmations: review.items,
    images: artifact.files.images ? Object.fromEntries(Object.entries(JSON.parse(await readFile(join(root, artifact.files.images.path), 'utf8'))).map(([source, item]) => [source, `data:${item.mime};base64,${item.base64}`])) : {},
  };
}

export function projectSnapshot(store) {
  const state = structuredClone(store.reload());
  const manifest = projectManifest(store);
  for (const chapter of manifest.chapters) state.chapters[chapter.id].pendingConfirmations = hasPendingReview(store, chapter);
  for (const material of Object.values(state.materials)) delete material.text;
  return { manifest, state };
}

export async function indexMaterialDirectory(sourceDir, knownInputNames = [], { maxFileBytes = 25 * 1024 * 1024, maxFiles = 1000 } = {}) {
  const root = await realpath(sourceDir); const found = []; const seen = new Set();
  const allowed = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.pdf', '.docx', '.xlsx']);
  const visit = async (dir) => { for (const entry of await readdir(dir, { withFileTypes: true })) { if (entry.name.startsWith('.') || SECRET.test(entry.name) || entry.isSymbolicLink()) continue; const path = join(dir, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile() && allowed.has(extname(entry.name).toLowerCase())) { if (found.length >= maxFiles) throw new Error('source directory has too many files'); const info = await stat(path); if (info.size > maxFileBytes) throw new Error(`source file too large: ${entry.name}`); const content = await readFile(path); const digest = sha(content); if (seen.has(digest)) continue; seen.add(digest); const stem = basename(entry.name).replace(/\.[^.]+$/, '').toLowerCase(); found.push({ relativePath: relative(root, path), name: entry.name, sha256: digest, size: content.length, candidates: knownInputNames.filter((name) => stem.includes(String(name).toLowerCase())) }); } } };
  await visit(root); return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function registerIndexedMaterial(store, { sourceDir, relativePath, name, maxFileBytes = 25 * 1024 * 1024 }) {
  const root = await realpath(sourceDir); const segments = String(relativePath || '').split(/[\\/]/);
  if (!relativePath || segments.some((part) => !part || part === '..' || part.startsWith('.') || SECRET.test(part))) throw new Error('unsafe or secret material path');
  const path = resolve(root, relativePath); if (!inside(root, path) || !existsSync(path) || lstatSync(path).isSymbolicLink() || !inside(root, await realpath(path))) throw new Error('unsafe material path');
  const allowed = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml']); if (!allowed.has(extname(path).toLowerCase())) throw new Error('material type requires an external acquisition adapter');
  const info = await stat(path); if (info.size > maxFileBytes) throw new Error('source file too large');
  return registerMaterial(store, { name: name || basename(path), text: await readFile(path, 'utf8'), metadata: { relativePath } });
}

const interfaceOf = (chapter) => JSON.stringify({ order: chapter.order, dependencies: chapter.dependencies || [], inputs: chapter.inputs || [], outputs: chapter.outputs || [], confirmations: chapter.confirmations || [] });
export async function replaceChapterRules(store, { chapterId, replacementDir, updateProjectInstructions = false }) {
  const source = await realpath(replacementDir);
  const replacement = JSON.parse(await readFile(safeRuleFile(source, 'manifest.json'), 'utf8'));
  validateManifest(replacement, { rulesRoot: source });
  const nextChapter = replacement.chapters.find((item) => item.id === chapterId);
  if (!nextChapter) throw new Error('chapter interface or resources are incompatible');
  const skillBytes = await readFile(safeRuleFile(source, nextChapter.skill));
  const instructionBytes = updateProjectInstructions ? await readFile(safeRuleFile(source, 'AGENTS.md')) : null;
  const version = validId(replacement.version, 'rule version');
  const versionRel = `.ccpg-scheme/rule-versions/${version}`;
  const versionChapterRel = `${versionRel}/${chapterId}`;
  let createdVersion = false;
  let createdChapterSnapshot = false;
  try {
    await store.withLock(async (disk) => {
      store.state = disk;
      const current = projectManifest(store);
      assertRules(store, current, disk.rulesFingerprint, { mark: false });
      if (Object.values(disk.chapters).some((chapter) => ['prepared', 'running'].includes(chapter.status))) throw new Error('project is active');
      const oldChapter = current.chapters.find((item) => item.id === chapterId);
      const missingOutputs = (oldChapter?.blockers || []).filter((item) => item.code === 'OUTPUT_DEFINITION_MISSING');
      const fillsMissingBody = oldChapter && !disk.chapters[chapterId]?.artifactId
        && !oldChapter.outputs?.length && missingOutputs.length > 0
        && nextChapter.outputs?.length === 1 && nextChapter.outputs[0].kind === 'body'
        && nextChapter.outputDefinitionSource?.kind === 'internal-supplement'
        && sameJson((oldChapter.blockers || []).filter((item) => item.code !== 'OUTPUT_DEFINITION_MISSING'), nextChapter.blockers || [])
        && interfaceOf({ ...oldChapter, outputs: nextChapter.outputs }) === interfaceOf(nextChapter);
      if (current.id !== replacement.id || !oldChapter || oldChapter.skill !== nextChapter.skill || (!fillsMissingBody && interfaceOf(oldChapter) !== interfaceOf(nextChapter)) || JSON.stringify(current.resources || []) !== JSON.stringify(replacement.resources || [])) throw new Error('chapter interface or resources are incompatible');
      const activeSkillRel = `.dsh/${nextChapter.skill}`;
      const manifestRel = '.ccpg-scheme/manifest.json';
      const activeSkill = checkedPath(store.root, activeSkillRel);
      const manifestPath = checkedPath(store.root, manifestRel);
      const oldSkill = readFileSync(activeSkill);
      const oldManifest = readFileSync(manifestPath);
      const instructionPath = checkedPath(store.root, 'AGENTS.md');
      const oldInstructions = readFileSync(instructionPath);
      const instructionsChanged = instructionBytes && !instructionBytes.equals(oldInstructions);
      const versionDir = checkedPath(store.root, versionRel);
      const versionChapterDir = checkedPath(store.root, versionChapterRel);
      if (existsSync(versionChapterDir)) throw new Error(`rule version already exists: ${version}/${chapterId}`);
      const versionExisted = existsSync(versionDir);
      await mkdir(versionChapterDir, { recursive: true });
      createdVersion = !versionExisted;
      createdChapterSnapshot = true;
      const versionSkill = checkedPath(store.root, `${versionChapterRel}/SKILL.md`);
      const tempSkillRel = `${activeSkillRel}.${randomUUID()}.tmp`;
      const tempManifestRel = `${manifestRel}.${randomUUID()}.tmp`;
      const tempInstructionRel = `AGENTS.md.${randomUUID()}.tmp`;
      const tempSkill = checkedPath(store.root, tempSkillRel);
      const tempManifest = checkedPath(store.root, tempManifestRel);
      const tempInstructions = checkedPath(store.root, tempInstructionRel);
      let skillReplaced = false;
      let manifestReplaced = false;
      let instructionsReplaced = false;
      try {
        await writeFile(versionSkill, skillBytes, { flag: 'wx' });
        const nextManifest = structuredClone(current);
        nextManifest.version = replacement.version;
        nextManifest.chapters = current.chapters.map((item) => item.id === chapterId ? (fillsMissingBody ? structuredClone(nextChapter) : { ...item, skill: nextChapter.skill }) : item);
        if (fillsMissingBody) nextManifest.blockers = (current.blockers || []).filter((item) => !missingOutputs.some((missing) => sameJson(item, missing)));
        await writeFile(tempSkill, skillBytes, { flag: 'wx' });
        await writeFile(tempManifest, JSON.stringify(nextManifest, null, 2), { flag: 'wx' });
        if (instructionsChanged) await writeFile(tempInstructions, instructionBytes, { flag: 'wx' });
        await rename(tempSkill, activeSkill);
        skillReplaced = true;
        await rename(tempManifest, manifestPath);
        manifestReplaced = true;
        if (instructionsChanged) { await rename(tempInstructions, instructionPath); instructionsReplaced = true; }
        const fingerprint = rulesFingerprint(store.root, nextManifest);
        const nextState = structuredClone(disk);
        nextState.manifest.version = nextManifest.version;
        nextState.rulesFingerprint = fingerprint;
        for (const id of instructionsChanged ? nextManifest.chapters.map((item) => item.id) : [chapterId, ...descendants(nextManifest, chapterId)]) {
          delete nextState.confirmations[id];
          const previous = nextState.chapters[id];
          nextState.chapters[id] = { ...previous, stale: Boolean(previous.artifactId) || previous.stale, confirmed: false, status: previous.artifactId ? 'stale' : previous.status, pendingConfirmations: false, token: null };
        }
        nextState.revision++;
        nextState.updatedAt = now();
        store.save(nextState);
        store.state = nextState;
        try { atomicJson(checkedPath(store.root, '.ccpg-scheme/index.json'), buildIndex(nextState)); } catch {}
      } catch (error) {
        try { if (skillReplaced) { const rollbackRel = `${activeSkillRel}.${randomUUID()}.rollback`; const rollback = checkedPath(store.root, rollbackRel); await writeFile(rollback, oldSkill, { flag: 'wx' }); await rename(rollback, activeSkill); } } catch {}
        try { if (manifestReplaced) { const rollbackRel = `${manifestRel}.${randomUUID()}.rollback`; const rollback = checkedPath(store.root, rollbackRel); await writeFile(rollback, oldManifest, { flag: 'wx' }); await rename(rollback, manifestPath); } } catch {}
        try { if (instructionsReplaced) { const rollbackRel = `AGENTS.md.${randomUUID()}.rollback`; const rollback = checkedPath(store.root, rollbackRel); await writeFile(rollback, oldInstructions, { flag: 'wx' }); await rename(rollback, instructionPath); } } catch {}
        removeManaged(store.root, tempSkillRel);
        removeManaged(store.root, tempManifestRel);
        removeManaged(store.root, tempInstructionRel);
        throw error;
      }
    });
  } catch (error) {
    if (createdChapterSnapshot) removeManaged(store.root, versionChapterRel);
    if (createdVersion) removeManaged(store.root, versionRel);
    throw error;
  }
}
