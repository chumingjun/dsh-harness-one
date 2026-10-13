import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat, rename, writeFile } from 'node:fs/promises';
import { SessionId as NativeSessionId } from '@deepseek-ai/dsh-session';
import { defineTool as nativeDefineTool } from '@deepseek-ai/dsh-tools';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';
import { SchemeStore, createProject, registerMaterial, registerFetchedMaterial, registerIndexedMaterial, createPublicationSnapshot, createDeliverySnapshot, exportDelivery, prepareChapter, submitChapter, editChapter, confirmChapter, recoverProject, exportProject, indexMaterialDirectory, replaceChapterRules, projectSnapshot, readChapterArtifact, skipChapter } from './core.js';
import { MATERIAL_PARSER_VERSION, parseMaterialFile, renderPdfPages } from './materials.js';
import { createFeishuConnector } from './connectors.js';
import { publicationSummary, readPublications } from './publications.js';
import { collectFeishuMaterials } from './material-collection.js';
import { ccpCliStatus, prepareCcpgCli, findCcpgProjects, fetchCcpgProjectSnapshot } from './ccpg-cli.js';
import { registerSchemeSkills } from './skills.js';
import { issueCode, issueLabel, recordIssue, recoverIssues, validationReport } from './validation.js';

export const name = 'dsh-ccpg-scheme';
export const inject = ['tools', 'webServer', 'approval', 'commands', 'connection'];
export const Config = z.object({});
const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const browserBundlePath = join(dirname(fileURLToPath(import.meta.url)), 'browser.js');
const pluginVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const installedRulesVersion = JSON.parse(readFileSync(join(rulesDir, 'manifest.json'), 'utf8')).version;
const buildHash = createHash('sha256');
for (const path of [...readdirSync(dirname(fileURLToPath(import.meta.url))).filter((name) => name.endsWith('.js') && !['client.js', 'browser.js'].includes(name)).sort().map((name) => join(dirname(fileURLToPath(import.meta.url)), name)), join(rulesDir, '../skills/ccpg-scheme/SKILL.md')]) buildHash.update(path.split('/').at(-1)).update(readFileSync(path));
const validationBuild = `${pluginVersion}-${buildHash.digest('hex').slice(0, 16)}`;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
const PAGE_RENDER_FORMATS = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const PREVIEW_CHARS = 2000;
const VISUAL_BATCH_SIZE = 1;
async function verifyDeliverySnapshot(store, snapshot) {
  for (const file of snapshot.files || []) {
    const path = join(store.root, snapshot.directory, file.path);
    if (sha256(await readFile(path)) !== file.sha256) throw new Error(`publication snapshot changed: ${file.path}; refresh the preview and publish again`);
  }
}
const compactMetadata = (metadata = {}) => Object.fromEntries(Object.entries(metadata).slice(0, 32).filter(([, value]) => value == null || ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key.slice(0, 100), typeof value === 'string' ? value.slice(0, 500) : value]));
const coverageCounts = (coverage = {}) => Object.fromEntries(Object.entries(coverage).slice(0, 32).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
const materialToolResult = (material, markdown) => ({
  material: { id: material.id, name: material.name.slice(0, 200), kind: material.kind, contentPath: material.contentPath, sha256: material.sha256, parseStatus: material.parseStatus, metadata: compactMetadata(material.metadata), metadataPath: '.ccpg-scheme/state.json', coverageCounts: coverageCounts(material.metadata?.coverage), imageCount: material.metadata?.imagePaths?.length || 0 },
  preview: String(markdown).slice(0, PREVIEW_CHARS),
  characters: String(markdown).length,
});
const diagnosticId = (value) => /^[a-zA-Z0-9:/._-]{1,100}$/.test(String(value ?? '')) ? String(value) : '';
const reportToolResult = (result) => ({ ...result, issues: result.issues.slice(-20), totalIssues: result.issues.length });
const diagnosticState = (root) => {
  try {
    const state = JSON.parse(readFileSync(join(root, '.ccpg-scheme', 'state.json'), 'utf8'));
    return { projectId: state.projectId, rulesVersion: state.manifest?.version };
  } catch { return {}; }
};
const readDiagnostics = (root, limit = 20) => {
  try {
    return readFileSync(join(root, '.ccpg-scheme', 'diagnostics.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch { return []; }
};

const json = (res, status, value) => { res.statusCode = status; res.setHeader?.('content-type', 'application/json; charset=utf-8'); res.end?.(JSON.stringify(value)); return value; };
const send = (res, status, type, value) => { res.statusCode = status; res.setHeader?.('content-type', type); res.end?.(value); return value; };
const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
const getSession = (ctx, sid) => { if (!sid) throw new Error('sessionId is required'); const session = ctx.get?.('sessions')?.get?.(NativeSessionId(String(sid))); const cwd = session?.header?.cwd; if (!cwd) throw new Error('session cwd unavailable'); return cwd; };
const body = async (req) => { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('request body too large'); } return JSON.parse(raw || '{}'); };
const execSessionId = (exec) => exec?.agent?.session?.id || exec?.sessionId || exec?.session?.id;

function tool(def) { return nativeDefineTool({ ...def, output: def.output || textOutput }); }

const resultsInitializers = [];
class SchemeResultsService extends TypertRemoteService {
  constructor(ctx, readResults) {
    super(ctx, 'ccpgSchemeResults');
    this.readResults = readResults;
    for (const initialize of resultsInitializers) initialize.call(this);
  }
  read(payload, signal) { return this.readResults(payload, signal); }
}
// Apply the official Remote decorator in this plain-JavaScript plugin.
Remote(SchemeResultsService.prototype.read, { kind: 'method', name: 'read', static: false, private: false, addInitializer(fn) { resultsInitializers.push(fn); } });

export function apply(ctx) {
  if (ctx.inject) ctx.inject(['skills'], registerSchemeSkills);
  else if (ctx.skills?.registerProvider) registerSchemeSkills(ctx);
  const projects = new Map();
  const sessionRoots = new Map();
  const attempts = new Map();
  const revokedAttempts = new Set();
  const turnSignals = new WeakMap();
  const callSignals = new Map();
  const imageReads = new Map();
  const requestFailures = new WeakMap();
  const agentPositions = new WeakMap();
  const streamPositions = new WeakMap();
  const validationWarnings = new Map();
  const validationWarning = (root) => {
    const message = 'CCPG 问题记录未保存；请在会话请求重新生成问题报告。';
    if (root) validationWarnings.set(root, message);
    console.warn(message);
  };
  const observedStore = (agent) => {
    try {
      const root = resolve(getSession(ctx, agent?.session?.id));
      if (!existsSync(join(root, '.ccpg-scheme/state.json'))) return null;
      return SchemeStore.load(root);
    } catch { return null; }
  };
  const observe = async (agent, callback) => {
    const store = observedStore(agent);
    if (!store) return;
    try { const result = await callback(store); if (result) validationWarnings.delete(store.root); return true; } catch { validationWarning(store.root); return false; }
  };
  const positionOf = ({ agent, turn, step }) => {
    if (!agentPositions.has(agent)) agentPositions.set(agent, randomUUID());
    return `${agent?.session?.id}:${agentPositions.get(agent)}:${turn}:${step}`;
  };
  ctx.on?.('agent/request-error', async (payload, next) => {
    if (!payload.signal?.aborted) {
      const position = positionOf(payload);
      const code = issueCode(payload.failure);
      if (!requestFailures.has(payload.agent)) requestFailures.set(payload.agent, new Set());
      const failures = requestFailures.get(payload.agent);
      const saved = await observe(payload.agent, (store) => recordIssue(store, { source: 'runtime', operation: 'model-request', code: code === 'OPERATION_FAILURE' ? 'SERVICE_FAILURE' : code, position, build: validationBuild }));
      if (saved) failures.add(position);
      if (failures.size > 1024) failures.delete(failures.values().next().value);
    }
    return next();
  });
  ctx.on?.('agent/error', (payload) => {
    const position = positionOf(payload);
    if (requestFailures.get(payload.agent)?.has(position)) return;
    return observe(payload.agent, (store) => recordIssue(store, { source: 'runtime', operation: 'model-request', code: issueCode(payload.error), position, build: validationBuild }));
  });
  ctx.on?.('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      if (!streamPositions.has(agent)) streamPositions.set(agent, new Map());
      streamPositions.get(agent).set(frame.attemptId, positionOf({ agent, turn: frame.turn, step: frame.step }));
    } else if (frame.type === 'end') {
      const position = streamPositions.get(agent)?.get(frame.attemptId);
      streamPositions.get(agent)?.delete(frame.attemptId);
      if (position && requestFailures.get(agent)?.has(position) && frame.outcome?.kind === 'committed' && frame.outcome.eventType === 'assistant/message') {
        return observe(agent, (store) => recoverIssues(store, { source: 'runtime', operation: 'model-request', position, build: validationBuild }));
      }
    }
  });
  ctx.on?.('agent/turn-stopping', ({ agent }) => observe(agent, validationReport));
  ctx.on?.('agent/status', ({ agent, status }) => status === 'idle' ? observe(agent, validationReport) : undefined);
  const loopback = (req) => {
    const remote = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    return !remote || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  };
  const clearAttempt = (root) => { attempts.get(root)?.detach(); attempts.delete(root); };
  const bindAttempt = (store, token, signal) => {
    clearAttempt(store.root);
    if (!signal) return;
    const revoke = () => {
      revokedAttempts.add(token.attemptId);
      try {
        store.reload();
        if (store.state.chapters[token.chapterId]?.token?.attemptId === token.attemptId) store.commit(store.state.revision, (state) => { state.chapters[token.chapterId] = { ...state.chapters[token.chapterId], status: 'interrupted', interrupted: true, token: null }; });
      } catch { /* The in-memory revocation also rejects late submissions when the state lock is busy. */ }
      clearAttempt(store.root);
    };
    attempts.set(store.root, { token, revoke, detach: () => signal.removeEventListener('abort', revoke) });
    signal.addEventListener('abort', revoke, { once: true });
    if (signal.aborted) revoke();
  };
  const rebindSessionAttempt = (agent, signal) => {
    if (!agent || !signal) return;
    const sessionId = String(agent.session?.id || agent.id || '');
    for (const [root, attempt] of [...attempts]) {
      if (String(attempt.token.sessionId || '') !== sessionId) continue;
      const store = projects.get(root) || SchemeStore.load(root);
      store.reload();
      const current = store.state.chapters[attempt.token.chapterId];
      if (current?.status === 'prepared' && current.token?.attemptId === attempt.token.attemptId) bindAttempt(store, attempt.token, signal);
      else clearAttempt(root);
    }
  };
  const rememberSessionRoot = (sid, root) => {
    if (!sid) return;
    const key = String(sid);
    if (!sessionRoots.has(key)) sessionRoots.set(key, new Set());
    sessionRoots.get(key).add(root);
  };
  const recoverSessionRoots = async (sid) => {
    const key = String(sid?.id || sid || '');
    const roots = sessionRoots.get(key);
    if (!roots) return;
    for (const root of roots) {
      try {
        const store = projects.get(root) || SchemeStore.load(root);
        projects.set(root, store);
        store.reload();
        if (Object.values(store.state.chapters).some((chapter) => ['prepared', 'running'].includes(chapter.status) && String(chapter.token?.sessionId || '') === key)) {
          await recoverProject(store);
          clearAttempt(root);
        }
      } catch {}
    }
    sessionRoots.delete(key);
    imageReads.delete(key);
  };
  const projectRoot = (cwd, projectId) => {
    if (!PROJECT_ID.test(String(projectId || ''))) throw new Error('unsafe project id');
    const root = resolve(cwd);
    const statePath = join(root, '.ccpg-scheme', 'state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (state.projectId !== projectId) throw new Error('session workspace does not match project id');
      return root;
    }
    throw new Error('project-required: Initialize or select the current scheme workspace first.');
  };
  const currentProject = (cwd) => {
    const root = resolve(cwd); const statePath = join(root, '.ccpg-scheme', 'state.json');
    if (!existsSync(statePath)) throw new Error('project-required: Initialize or select the current scheme workspace first.');
    return { root, state: JSON.parse(readFileSync(statePath, 'utf8')) };
  };
  if (ctx.provide) new SchemeResultsService(ctx, async (payload, signal) => {
    if (signal?.aborted) throw new Error('results read cancelled');
    if (!payload || !['status', 'artifact', 'export'].includes(payload.action)) throw new Error('unsupported results read action');
    if (!payload.sessionId) throw new Error('sessionId is required');
    const sid = NativeSessionId(String(payload.sessionId));
    const header = ctx.get('sessions')?.get?.(sid)?.header || (await ctx.get('sessionPersistence')?.stat?.(sid, { signal }))?.header;
    const cwd = header?.cwd;
    if (!cwd) throw new Error('session cwd unavailable');
    const root = payload.projectId ? projectRoot(cwd, payload.projectId) : currentProject(cwd).root;
    const store = projects.get(root) || SchemeStore.load(root); projects.set(root, store); store.reload();
    const result = payload.action === 'status'
      ? { ...projectSnapshot(store), projectCwd: store.root, publications: await publicationSummary(store.root), diagnostics: { path: '.ccpg-scheme/diagnostics.jsonl', recent: readDiagnostics(store.root) } }
      : payload.action === 'artifact' ? await readChapterArtifact(store, payload.chapterId) : await exportDelivery(store);
    if (signal?.aborted) throw new Error('results read cancelled');
    return JSON.parse(JSON.stringify(result));
  });
  const sourceRoot = (cwd, sourceDirectory) => {
    const value = String(sourceDirectory || ''); if (!value || isAbsolute(value)) throw new Error('sourceDirectory must be session-relative');
    const root = resolve(cwd); const target = resolve(root, value); const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('unsafe sourceDirectory');
    let cursor = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('source path is a symlink');
    }
    return target;
  };
  const projectRelative = (root, path) => relative(realpathSync(root), path);
  const visualProgressPath = (store, materialId) => join(store.root, '.ccpg-scheme', 'visual', `${materialId}.json`);
  const readVisualProgress = async (store, material) => {
    try {
      const progress = JSON.parse(await readFile(visualProgressPath(store, material.id), 'utf8'));
      if (progress.sourceSha256 !== material.metadata.sourceSha256 || typeof progress.entries !== 'object' || Array.isArray(progress.entries)) throw new Error('visual progress does not match source');
      return progress;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { schemaVersion: 1, materialId: material.id, sourceSha256: material.metadata.sourceSha256, entries: {} };
    }
  };
  const writeVisualProgress = async (store, progress) => {
    const path = visualProgressPath(store, progress.materialId); await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(progress, null, 2)}\n`, { flag: 'wx' }); await rename(temp, path);
  };
  const pendingVisualPaths = async (store, material, progress) => {
    const expected = material.metadata.imagePaths || [];
    if (material.metadata.coverage?.method !== 'text-layer') return expected.filter((path) => !progress.entries[path] || progress.entries[path].unresolved?.length).slice(0, VISUAL_BATCH_SIZE);
    const pageCount = material.metadata.coverage.pages;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('visual PDF page count unavailable');
    const visualPages = material.metadata.coverage.visualPages;
    if (!Array.isArray(visualPages) || new Set(visualPages).size !== visualPages.length || visualPages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) throw new Error('visual PDF page selection unavailable; parse the material again');
    const completedPages = new Set(Object.values(progress.entries).filter((entry) => !entry.unresolved?.length).map((entry) => entry.page).filter(Number.isSafeInteger));
    const pages = [...visualPages].sort((a, b) => a - b).filter((page) => !completedPages.has(page)).slice(0, VISUAL_BATCH_SIZE);
    if (!pages.length) return [];
    const source = sourceRoot(store.root, material.metadata.sourcePath);
    const rendered = await renderPdfPages({ inputPath: source, outputRoot: join(store.root, 'materials', 'parsed', 'page-renders'), pages, maxPages: VISUAL_BATCH_SIZE, maxBytes: MAX_MATERIAL_BYTES, dpi: 144 });
    return rendered.images.map((path) => projectRelative(store.root, path));
  };
  const visualWorkCount = (material) => material.metadata.coverage?.method === 'text-layer' ? material.metadata.coverage.visualPages.length : material.metadata.imagePaths?.length || 0;
  const completedVisualWorkCount = (material, progress) => Object.entries(progress.entries).filter(([path, entry]) => !entry.unresolved?.length && (material.metadata.coverage?.method === 'text-layer' ? material.metadata.coverage.visualPages.includes(entry.page) : material.metadata.imagePaths?.includes(path))).length;
  const verifiedVisualMaterial = async (store, prior) => {
    const derived = Object.values(store.state.materials).find((material) => material.metadata?.derivedFrom === prior.id && material.metadata.sourceSha256 === prior.metadata.sourceSha256 && material.parseStatus === 'complete');
    if (derived) {
      if (sha256(await readFile(sourceRoot(store.root, derived.contentPath))) !== derived.sha256) throw new Error('completed material changed');
      for (const receipt of derived.metadata.visualReads || []) if (sha256(await readFile(sourceRoot(store.root, receipt.path))) !== receipt.sha256) throw new Error('visual progress image changed');
    }
    return derived;
  };
  const parseProjectMaterial = async (store, sourcePath) => {
    const manifest = JSON.parse(readFileSync(sourceRoot(store.root, '.ccpg-scheme/manifest.json'), 'utf8'));
    const bundledChapter = manifest.chapters.find((chapter) => String(sourcePath).startsWith(`.dsh/${dirname(chapter.skill)}/`));
    const currentChapter = [...manifest.chapters].sort((a, b) => a.order - b.order).find((chapter) => {
      const state = store.state.chapters[chapter.id];
      return state.status !== 'skipped' && !(state.artifactId && !state.stale && !state.pendingConfirmations && ['submitted', 'confirmed'].includes(state.status));
    });
    if (bundledChapter && currentChapter && bundledChapter.order > currentChapter.order) throw new Error(`finish current chapter before reading later bundled knowledge: ${currentChapter.id}`);
    const parsed = await parseMaterialFile({ inputPath: sourceRoot(store.root, sourcePath), outputRoot: join(store.root, 'materials', 'parsed'), maxBytes: MAX_MATERIAL_BYTES });
    const text = await readFile(parsed.markdownPath, 'utf8');
    const prior = await registerMaterial(store, { name: parsed.name, text, parseStatus: parsed.status, metadata: { source: 'project-file', sourcePath, sourceSha256: parsed.sha256, parserVersion: parsed.parserVersion, coverage: parsed.coverage, imagePaths: parsed.images.map((path) => projectRelative(store.root, path)), parsedPath: projectRelative(store.root, parsed.markdownPath) } });
    const material = prior.parseStatus === 'complete' ? prior : await verifiedVisualMaterial(store, prior) || prior;
    return { material, markdown: material === prior ? text : await readFile(sourceRoot(store.root, material.contentPath), 'utf8'), parsed: { ...parsed, status: material.parseStatus, markdownPath: material === prior ? parsed.markdownPath : sourceRoot(store.root, material.contentPath) } };
  };
  const readVisualBatch = async (args, exec) => {
    const store = resolveStore(args, exec); let prior = store.state.materials[args.materialId];
    if (!prior?.metadata?.sourcePath || !['complete', 'needs-review', 'needs-vision'].includes(prior.parseStatus)) throw new Error('material does not need visual completion');
    const source = sourceRoot(store.root, prior.metadata.sourcePath);
    if (sha256(await readFile(source)) !== prior.metadata.sourceSha256) throw new Error('visual source changed');
    const derived = await verifiedVisualMaterial(store, prior);
    if (prior.metadata.parserVersion === MATERIAL_PARSER_VERSION && (derived || prior.parseStatus === 'complete')) return { materialId: derived?.id || prior.id, complete: true, remaining: 0, imagePaths: [] };
    if (prior.metadata.parserVersion !== MATERIAL_PARSER_VERSION) {
      const parsed = await parseMaterialFile({ inputPath: source, outputRoot: join(store.root, 'materials', 'parsed'), maxBytes: MAX_MATERIAL_BYTES });
      const markdown = await readFile(parsed.markdownPath, 'utf8');
      const previous = prior;
      prior = await registerMaterial(store, { name: parsed.name, text: markdown, parseStatus: parsed.status, metadata: { source: 'project-file', sourcePath: prior.metadata.sourcePath, sourceSha256: parsed.sha256, parserVersion: parsed.parserVersion, coverage: parsed.coverage, imagePaths: parsed.images.map((path) => projectRelative(store.root, path)), parsedPath: projectRelative(store.root, parsed.markdownPath), upgradedFrom: args.materialId } });
      if (prior.id !== previous.id) await writeVisualProgress(store, { ...await readVisualProgress(store, previous), materialId: prior.id });
    }
    if (prior.parseStatus === 'complete') return { materialId: prior.id, complete: true, remaining: 0, imagePaths: [] };
    if (derived) return { materialId: derived.id, complete: true, remaining: 0, imagePaths: [] };
    const progress = await readVisualProgress(store, prior);
    const imagePaths = await pendingVisualPaths(store, prior, progress);
    const unresolved = [...new Set([...(prior.metadata.coverage?.unsupportedParts || []).map((part) => `Unverified Office part: ${part}`), ...Object.values(progress.entries).flatMap((entry) => entry.unresolved || [])])];
    const completed = completedVisualWorkCount(prior, progress);
    return { materialId: prior.id, complete: false, imagePaths, batchSize: imagePaths.length, remaining: Math.max(0, visualWorkCount(prior) - completed), unresolved };
  };
  const currentUserLarkCli = () => { try { return ctx.get?.('ccpgLarkUserCli') || ctx.ccpgLarkUserCli; } catch { return ctx.ccpgLarkUserCli; } };
  const appendDiagnostic = async (root, operation, args, error) => {
    if (!root) return;
    try {
      const directory = join(root, '.ccpg-scheme');
      const file = join(directory, 'diagnostics.jsonl');
      await mkdir(directory, { recursive: true });
      try { if ((await stat(file)).size > 1024 * 1024) { await rm(`${file}.1`, { force: true }); await rename(file, `${file}.1`); } } catch {}
      const state = diagnosticState(root);
      const code = issueCode(error);
      await appendFile(file, `${JSON.stringify({
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        level: 'error',
        source: 'dsh-ccpg-scheme',
        pluginVersion,
        rulesVersion: state.rulesVersion || installedRulesVersion,
        projectId: diagnosticId(args?.projectId ?? state.projectId),
        chapterId: diagnosticId(args?.chapterId ?? args?.token?.chapterId),
        operation: diagnosticId(operation),
        code,
        message: issueLabel(code),
      })}\n`);
      if (existsSync(join(root, '.ccpg-scheme/state.json'))) await recordIssue(SchemeStore.load(root), {
        source: code === 'INPUT_GAP' ? 'gap' : 'plugin', operation, code,
        chapterId: args?.chapterId || args?.token?.chapterId, build: validationBuild,
      });
    } catch { validationWarning(root); }
  };
  const diagnosticRoot = (exec) => { try { return resolve(getSession(ctx, execSessionId(exec))); } catch { return null; } };
  const resolveStore = (args, exec) => {
    const sid = execSessionId(exec);
    const root = projectRoot(getSession(ctx, sid), args.projectId);
    let store = projects.get(root);
    if (!store) { store = SchemeStore.load(root); projects.set(root, store); }
    else store.reload();
    rememberSessionRoot(sid, root);
    return store;
  };
  ctx.on?.('agent/pre-step', async ({ agent, signal }, next) => { if (agent) { turnSignals.set(agent, signal); rebindSessionAttempt(agent, signal); } return next(); });
  ctx.on?.('tools/pre-execute', async (exec, next) => { if (exec.name === 'chapter_prepare') callSignals.set(exec.token, exec.signal); return next(); });
  ctx.on?.('tools/result', (exec, result) => {
    callSignals.delete(exec.token);
    if (!['read_image', 'material_visual_read'].includes(exec.name) || exec.name === 'read_image' && exec.parent !== undefined || result.isError || exec.signal?.aborted || !result.value?.image?.attachmentId || !result.content?.some((item) => item.type === 'image' && item.attachment?.attachmentId === result.value.image.attachmentId)) return;
    try {
      const sid = String(execSessionId(exec)); const cwd = getSession(ctx, sid);
      const path = realpathSync(resolve(cwd, result.value.path)); sourceRoot(cwd, relative(realpathSync(cwd), path));
      if (!imageReads.has(sid)) imageReads.set(sid, new Map());
      const reads = imageReads.get(sid);
      reads.set(path, { path: relative(realpathSync(cwd), path), sha256: sha256(readFileSync(path)), attachmentId: result.value.image.attachmentId, callId: exec.callId, readAt: new Date().toISOString() });
      if (reads.size > 512) reads.delete(reads.keys().next().value);
    } catch { /* Out-of-workspace image reads are not material evidence. */ }
  });
  ctx.on?.('dispose', () => { for (const attempt of attempts.values()) attempt.revoke(); imageReads.clear(); callSignals.clear(); });
  const publishScheme = async (args, exec, human = false) => {
    const approval = ctx.approval; const agent = exec?.agent;
    if (args.targetMode === 'update' && (!approval?.request || !agent)) throw new Error('native user approval unavailable; Feishu document update is disabled');
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200) throw new Error('invalid Feishu publication title');
    const target = { mode: args.targetMode, parentToken: args.parentToken, doc: args.doc, revisionId: args.revisionId, sha256: args.sha256 };
    if (!['create', 'update'].includes(target.mode) || target.mode === 'create' && target.doc || target.mode === 'update' && (!target.doc || !Number.isSafeInteger(target.revisionId) || !target.sha256)) throw new Error('invalid Feishu publication target');
    const larkUserCli = currentUserLarkCli();
    if (!larkUserCli?.run) throw new Error('current-user Feishu CLI service unavailable');
    const store = resolveStore(args, exec);
    if (args.revision !== undefined && args.revision !== store.state.revision) throw new Error('publication revision conflict; update the delivery preview');
    if (args.chapterId !== undefined) {
      if (target.mode !== 'create') throw new Error('chapter publication requires create mode');
      if (!store.state.chapters[args.chapterId]) throw new Error(`unknown chapter: ${args.chapterId}`);
      if (args.artifactRevision !== undefined && args.artifactRevision !== store.state.chapters[args.chapterId].revision) throw new Error('publication artifact revision conflict; update the chapter preview');
    }
    const publicationRevision = store.state.revision;
    const delivery = target.mode === 'create' ? await createDeliverySnapshot(store, { requireComplete: true, chapterId: args.chapterId }) : null;
    const markdown = delivery?.markdown || await exportProject(store, { requireComplete: true });
    const digest = sha256(markdown);
    const previousOperation = delivery && (await readPublications(store.root)).filter((item) => item.scope === (args.chapterId || 'full')).findLast((item) => item.result?.verified)?.operationId;
    const operationId = sha256(JSON.stringify({ projectId: store.state.projectId, chapterId: args.chapterId, title: args.title, target, digest, deliveryDigest: delivery?.digest, revision: delivery?.revision || store.state.revision, previousOperation, layoutVersion: 2 }));
    const snapshot = delivery
      ? { ...delivery, relativePath: delivery.directory, receiptPath: join(store.root, `.ccpg-scheme/publications/${operationId}.ndjson`) }
      : await createPublicationSnapshot(store, { operationId, markdown });
    if (delivery) await mkdir(dirname(snapshot.receiptPath), { recursive: true });
    const destination = target.mode === 'create' ? `parent folder ${target.parentToken || '(root)'}` : `document ${target.doc} at revision ${target.revisionId} (${target.sha256 || 'no base hash'})`;
    // Requested creation is authorized by the user command; overwriting a remote document still requires approval.
    if (target.mode === 'update') {
      const outcome = await approval.request({ agent, toolName: 'scheme_publish', reason: `Publish CCPG scheme "${args.title}" to Feishu ${destination}. Fixed snapshot: ${snapshot.relativePath}; ${Buffer.byteLength(markdown)} bytes; SHA-256 ${digest}.`, signal: exec?.signal });
      if (outcome !== 'allowed-once') throw new Error(`Feishu publishing not approved (${outcome || 'unavailable'})`);
    }
    if (exec?.signal?.aborted) throw new Error('publishing cancelled');
    if (store.reload().revision !== publicationRevision) throw new Error('publication revision conflict; update the preview and publish again');
    if (delivery) {
      await verifyDeliverySnapshot(store, snapshot);
      return createFeishuConnector({ larkUserCli }).publishDelivery({
        snapshot: { ...snapshot, directory: join(store.root, snapshot.directory) }, title: args.title, folderTitle: `${store.state.projectId} 方案`, target, confirmed: true, receiptPath: snapshot.receiptPath, operationId, signal: exec?.signal,
        scope: args.chapterId || 'full', projectRoot: store.root, chapterDefinitions: JSON.parse(readFileSync(sourceRoot(store.root, '.ccpg-scheme/manifest.json'), 'utf8')).chapters,
        authorizeUpdate: async (previous) => {
          if (!human) {
            if (!approval?.request || !agent) throw new Error('native user approval unavailable; Feishu document update is disabled');
            const outcome = await approval.request({ agent, toolName: 'scheme_publish', reason: `Update CCPG scheme "${args.title}" in original document ${previous.body.token}. Fixed snapshot: ${snapshot.relativePath}; SHA-256 ${digest}.`, signal: exec?.signal });
            if (outcome !== 'allowed-once') throw new Error(`Feishu publishing not approved (${outcome || 'unavailable'})`);
          }
          if (exec?.signal?.aborted) throw new Error('publishing cancelled');
          if (store.reload().revision !== publicationRevision) throw new Error('publication revision conflict; update the preview and publish again');
          await verifyDeliverySnapshot(store, snapshot);
        },
      });
    }
    if (sha256(await readFile(snapshot.artifactPath)) !== digest) throw new Error('approved publication snapshot changed; publish again to request approval');
    if (exec?.signal?.aborted) throw new Error('publishing cancelled');
    return createFeishuConnector({ larkUserCli }).publishDocument({ artifactPath: snapshot.artifactPath, title: args.title, target, confirmed: true, receiptPath: snapshot.receiptPath, operationId });
  };
  const registerHumanCommand = () => {
    if (!ctx.commands?.register) return undefined;
    return ctx.commands.register({
      name: 'ccpg-scheme',
      description: 'Edit or confirm a CCPG scheme result in the current session workspace.',
      input: { hint: '{"action":"edit|confirm|skip|export|publish",...}', attachments: false },
      recordInput: false,
      async handler(invocation) {
        try {
          if (invocation.signal?.aborted) throw new Error('command cancelled');
          if (String(invocation.rawInput || '').length > 1_000_000) throw new Error('command input too large');
          const args = JSON.parse(String(invocation.rawInput || '{}'));
          if (!['edit', 'confirm', 'skip', 'export', 'publish'].includes(args.action)) throw new Error('unsupported human action');
          const exec = { agent: invocation.agent, signal: invocation.signal, sessionId: execSessionId({ agent: invocation.agent }) };
          const store = resolveStore(args, exec);
          if (invocation.signal?.aborted) throw new Error('command cancelled');
          let result;
          if (args.action === 'edit') result = await editChapter(store, { ...args, userReview: true, signal: invocation.signal });
          else if (args.action === 'confirm') result = await confirmChapter(store, { ...args, signal: invocation.signal });
          else if (args.action === 'skip') result = await skipChapter(store, { ...args, signal: invocation.signal });
          else if (args.action === 'publish') {
            if (!Number.isSafeInteger(args.revision)) throw new Error('publication revision is required');
            if (args.chapterId !== undefined && !Number.isSafeInteger(args.artifactRevision)) throw new Error('publication artifact revision is required');
            result = await publishScheme({ ...args, targetMode: 'create', doc: undefined, revisionId: undefined, sha256: undefined }, exec, true);
          }
          else {
            if (args.revision !== undefined && args.revision !== store.state.revision) throw new Error('delivery revision conflict; update the delivery preview');
            if (args.format !== undefined && args.format !== 'docx') throw new Error('unsupported delivery format');
            result = await createDeliverySnapshot(store, { requireComplete: false, word: args.format === 'docx' });
          }
          await observe(invocation.agent, async (current) => {
            for (const source of ['plugin', 'gap']) await recoverIssues(current, { source, operation: `human:${args.action}`, chapterId: args.chapterId || '', build: validationBuild });
          });
          return { kind: 'success', text: JSON.stringify({ action: args.action, result }) };
        } catch (error) {
          let action = 'unknown';
          try { action = JSON.parse(String(invocation.rawInput || '{}')).action || action; } catch {}
          await appendDiagnostic(diagnosticRoot({ agent: invocation.agent }), `human:${action}`, invocation, error);
          return { kind: 'error', text: String(error?.message || error) };
        }
      },
    });
  };
  const humanCommandDisposer = registerHumanCommand();
  ctx.on?.('dispose', () => humanCommandDisposer?.());
  const register = (def) => ctx.tools?.register?.(tool({ ...def, async execute(args, exec) {
    try {
      const result = await def.execute(args, exec);
      if (!['scheme_validation_report', 'scheme_feedback', 'ccpg_cli_status', 'ccpg_cli_setup'].includes(def.name)) {
        await observe(exec?.agent || { session: { id: execSessionId(exec) } }, async (store) => {
          await recoverIssues(store, { source: 'plugin', operation: `tool:${def.name}`, chapterId: args.chapterId || args.token?.chapterId || '', build: validationBuild });
          await recoverIssues(store, { source: 'gap', operation: `tool:${def.name}`, chapterId: args.chapterId || args.token?.chapterId || '', build: validationBuild });
          if (def.name === 'chapter_submit') await validationReport(store);
        });
      }
      return def.output || typeof result === 'string' ? result : JSON.stringify(result);
    }
    catch (error) { await appendDiagnostic(diagnosticRoot(exec), `tool:${def.name}`, args, error); throw error; }
  } }));
  ctx.tools?.guard?.((exec) => {
    if (exec?.name !== 'chapter_submit') return undefined;
    const sid = execSessionId(exec);
    const tokenSessionId = exec.arguments?.token?.sessionId;
    if (!sid || !tokenSessionId || String(sid) !== String(tokenSessionId)) {
      const reason = 'chapter_submit must run in the same native DSH session that prepared the chapter';
      void appendDiagnostic(diagnosticRoot(exec), 'tool-guard:chapter_submit', exec.arguments, new Error(reason));
      return reason;
    }
    return undefined;
  });
  ctx.on?.('session/disposed', (session) => recoverSessionRoots(session));
  ctx.on?.('agent/disposed', async ({ agent }) => { await observe(agent, validationReport); await recoverSessionRoots(agent?.session); });
  register({ name: 'ccpg_cli_status', description: 'Check whether the standard CCPG CLI is installed, configured, and ready for user authorization.', parameters: {}, async execute() { return ccpCliStatus(); } });
  register({ name: 'ccpg_cli_setup', description: 'Prepare CCPG CLI when the user asks: install or update it, initialize configuration, then return the user authorization step. Do not use for ordinary scheme generation unless CCPG data is needed.', parameters: { install: { type: 'boolean' } }, async execute(args) { return prepareCcpgCli({ install: args.install !== false }); } });
  const saveCcpgRead = async (store, result, name, signal) => {
    if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
    if (signal?.aborted) throw new Error('CCPG CLI read cancelled');
    const text = JSON.stringify(result.snapshot, null, 2);
    const material = await registerFetchedMaterial(store, { name, text, snapshot: result.snapshot, parseStatus: 'needs-review', metadata: result.provenance });
    return { ...materialToolResult(material, text), verified: false, candidates: result.candidates, message: '项目、字段、期间和口径尚需核对；不能直接绑定为已核实的章节输入。缺少可核实数据时请使用用户材料。' };
  };
  register({ name: 'ccpg_project_find', description: 'Find CCPG project candidates with current-user CCPG CLI and save a local unverified source snapshot. Never chooses or binds a project automatically.', parameters: { projectId: { type: 'string', required: true }, query: { type: 'string', required: true }, topk: { type: 'number' } }, async execute(args, exec) {
    const store = resolveStore(args, exec);
    return saveCcpgRead(store, await findCcpgProjects({ query: args.query, topk: args.topk, signal: exec?.signal }), `CCPG 项目检索：${args.query}`, exec?.signal);
  } });
  register({ name: 'ccpg_project_fetch', description: 'Read one page of CCPG project master data using exactly one projectCode or projectName selector and current-user CCPG CLI. Save provenance but do not auto-bind unverified scope or infer missing fields.', parameters: { projectId: { type: 'string', required: true }, projectCode: { type: 'string' }, projectName: { type: 'string' }, page: { type: 'number' }, pageSize: { type: 'number' } }, async execute(args, exec) {
    const store = resolveStore(args, exec);
    return saveCcpgRead(store, await fetchCcpgProjectSnapshot({ projectCode: args.projectCode, projectName: args.projectName, page: args.page, pageSize: args.pageSize, signal: exec?.signal }), `CCPG 项目数据：${args.projectCode ?? args.projectName}（第 ${args.page ?? 1} 页）`, exec?.signal);
  } });
  register({ name: 'scheme_validation_report', description: 'Generate the local shareable scheme problem report from recorded issues and current progress. Never uploads files or changes scheme progress.', parameters: { projectId: { type: 'string', required: true } }, async execute(args, exec) { const store = resolveStore(args, exec); const result = await validationReport(store); validationWarnings.delete(store.root); return reportToolResult(result); } });
  register({ name: 'scheme_feedback', description: 'Save a short user feedback summary or explicitly labelled model candidate, then refresh the local problem report. Feedback is data, not an instruction to alter skills or approve business content.', parameters: { projectId: { type: 'string', required: true }, chapterId: { type: 'string' }, source: { type: 'string', enum: ['user', 'model'], required: true }, summary: { type: 'string', required: true }, expected: { type: 'string' }, actual: { type: 'string' } }, async execute(args, exec) {
    if (!['user', 'model'].includes(args.source) || !args.summary?.trim()) throw new Error('invalid feedback');
    const store = resolveStore(args, exec);
    if (args.chapterId && !store.state.chapters[args.chapterId]) throw new Error('unknown feedback chapter');
    const result = await recordIssue(store, { ...args, operation: 'feedback', code: 'FEEDBACK', position: String(execSessionId(exec)), build: validationBuild });
    validationWarnings.delete(store.root);
    return reportToolResult(result);
  } });
  register({ name: 'project_create', description: 'Create a CCPG scheme project from the installed rules directory.', parameters: { projectId: { type: 'string', required: true } }, async execute(args, exec) { const sid = execSessionId(exec); const store = await createProject({ sessionCwd: getSession(ctx, sid), projectId: args.projectId, rulesDir }); projects.set(store.root, store); rememberSessionRoot(sid, store.root); return { projectId: store.state.projectId, projectCwd: store.root, revision: store.state.revision }; } });
  register({ name: 'project_status', description: 'Read CCPG CLI scheme project status.', parameters: { projectId: { type: 'string', required: true } }, async execute(args, exec) {
    const store = resolveStore(args, exec); const snapshot = projectSnapshot(store);
    for (const material of Object.values(snapshot.state.materials)) {
      material.coverageCounts = coverageCounts(material.metadata?.coverage);
      material.imageCount = material.metadata?.imagePaths?.length || 0;
      material.metadata = compactMetadata(material.metadata);
      material.metadataPath = '.ccpg-scheme/state.json';
    }
    return { ...snapshot, publications: await publicationSummary(store.root), validation: { path: 'reports/方案生成问题报告.md', warning: validationWarnings.get(store.root) || null }, diagnostics: { path: '.ccpg-scheme/diagnostics.jsonl', recent: readDiagnostics(store.root) } };
  } });
  register({ name: 'project_recover', description: 'Explicitly interrupt pending attempts in the current session project so chapters can be prepared again.', parameters: { projectId: { type: 'string', required: true } }, async execute(args, exec) { const store = resolveStore(args, exec); if (exec?.signal?.aborted) throw new Error('recovery cancelled'); await recoverProject(store); clearAttempt(store.root); return { projectId: store.state.projectId, revision: store.state.revision, status: 'recovered' }; } });
  register({ name: 'chapter_prepare', description: 'Prepare one ready chapter and return its native generation prompt.', parameters: { projectId: { type: 'string', required: true }, chapterId: { type: 'string', required: true }, inputBindings: { type: 'object', additionalProperties: true }, inputDecisions: { type: 'object', additionalProperties: true } }, async execute(args, exec) {
    const store = resolveStore(args, exec); const signal = (exec?.agent && turnSignals.get(exec.agent)) || callSignals.get(exec?.token) || exec?.signal;
    if (signal?.aborted) throw new Error('preparation cancelled');
    const result = await prepareChapter(store, { ...args, sessionId: execSessionId(exec) }); bindAttempt(store, result.token, signal);
    if (signal?.aborted) throw new Error('preparation cancelled');
    return result;
  } });
  register({ name: 'chapter_submit', description: 'Commit a complete chapter with evidence, attachments, and confirmations. Prefer bodyPath for a saved Markdown draft; provide exactly one of bodyPath or body. Attachments require outputId from chapter_prepare.outputs, a readable file name, and exactly one content, contentPath, filePath or base64. Use filePath for original image/binary files; place images with standard inline Markdown references, never replace them with prose.', parameters: { projectId: { type: 'string', required: true }, token: { type: 'object', additionalProperties: true, required: true }, body: { type: 'string' }, bodyPath: { type: 'string', description: 'Project-relative Markdown file under materials/notes; submit saved content without repeating it.' }, summary: { type: 'string' }, contextRefs: { type: 'array', items: { type: 'object', additionalProperties: true } }, evidence: { type: 'array', items: { type: 'object', properties: { source: { type: 'string', required: true, description: 'Registered material or artifact ID, never a path or prose citation.' }, location: { type: 'string' }, claim: { type: 'string' } }, additionalProperties: true } }, attachments: { type: 'array', items: { type: 'object', properties: { outputId: { type: 'string', required: true, description: 'Exact id of a declared attachment output returned by chapter_prepare, e.g. 4.2.1.' }, name: { type: 'string', required: true, description: 'Readable file name, including extension; no path separators.' }, content: { type: 'string' }, contentPath: { type: 'string', description: 'Saved UTF-8 md/txt/csv/json file under materials/notes; snapshotted on submission.' }, filePath: { type: 'string', description: 'Original local file relative to the scheme project under materials/, outputs/ or .dsh/skills/. Snapshots exact bytes without putting base64 in model arguments.' }, base64: { type: 'string' } }, additionalProperties: false } }, confirmations: { type: 'array', items: { type: 'object', additionalProperties: true } } }, async execute(args, exec) { if (revokedAttempts.has(args.token?.attemptId)) throw new Error('cancelled preparation token'); const store = resolveStore(args, exec); const result = await submitChapter(store, { ...args, sessionId: execSessionId(exec), signal: exec?.signal }); clearAttempt(store.root); return result; } });
  register({ name: 'chapter_edit', description: 'Edit a committed chapter using revision CAS and stale descendants.', parameters: { projectId: { type: 'string', required: true }, chapterId: { type: 'string', required: true }, revision: { type: 'number', required: true }, artifactRevision: { type: 'number' }, body: { type: 'string', required: true }, reviewItems: { type: 'array', items: { type: 'object', additionalProperties: true } } }, async execute(args, exec) { return editChapter(resolveStore(args, exec), { ...args, userReview: false, signal: exec?.signal }); } });
  register({ name: 'material_parse', description: 'Parse an authorized project-relative material into reusable Markdown with source provenance.', parameters: { projectId: { type: 'string', required: true }, sourcePath: { type: 'string', required: true } }, async execute(args, exec) {
    const store = resolveStore(args, exec); const { material, markdown, parsed } = await parseProjectMaterial(store, args.sourcePath);
    return { ...materialToolResult(material, markdown), parse: { status: parsed.status, reused: parsed.reused, parserVersion: parsed.parserVersion, sha256: parsed.sha256, markdownPath: projectRelative(store.root, parsed.markdownPath), metadataPath: projectRelative(store.root, join(dirname(sourceRoot(store.root, material.metadata.parsedPath)), 'parse.json')), coverageCounts: coverageCounts(parsed.coverage), imageCount: parsed.images.length, images: parsed.images.slice(0, 8).map((path) => projectRelative(store.root, path)) } };
  } });
  register({ name: 'material_complete', description: 'Save one document-level interpretation from native file/Office or multimodal capabilities. Use for needs-review or scanned sources after reading the original and saving decoded Markdown in the workspace. No image tool or child session is required. Preserve exact extracted text, describe reviewed content, and list any unreadable gaps.', parameters: { projectId: { type: 'string', required: true }, materialId: { type: 'string', required: true }, sourceSha256: { type: 'string', required: true }, markdownPath: { type: 'string', required: true }, review: { type: 'string', required: true }, unresolved: { type: 'array', items: { type: 'string' }, required: true } }, async execute(args, exec) {
    const store = resolveStore(args, exec); const prior = store.state.materials[args.materialId];
    if (!prior?.metadata?.sourcePath || !['needs-review', 'needs-vision', 'complete'].includes(prior.parseStatus)) throw new Error('material source is unavailable');
    const original = sourceRoot(store.root, prior.metadata.sourcePath);
    if (lstatSync(original).isSymbolicLink() || !realpathSync(original).startsWith(`${realpathSync(store.root)}${sep}`)) throw new Error('material source is a symlink or escapes workspace');
    if (args.sourceSha256 !== prior.metadata.sourceSha256 || sha256(await readFile(original)) !== args.sourceSha256) throw new Error('material source changed');
    if (typeof args.review !== 'string' || !args.review.trim() || args.review.length > 2000 || !Array.isArray(args.unresolved) || args.unresolved.some((value) => typeof value !== 'string' || value.length > 2000) || args.unresolved.length > 512) throw new Error('document review and explicit unresolved gaps are required');
    const path = sourceRoot(store.root, args.markdownPath);
    const realPath = realpathSync(path); sourceRoot(store.root, projectRelative(store.root, realPath));
    if (!realPath.startsWith(`${realpathSync(store.root)}${sep}`) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || extname(path).toLowerCase() !== '.md' || lstatSync(path).size > MAX_MATERIAL_BYTES) throw new Error('decoded Markdown must be a regular project file within the size limit');
    const decoded = await readFile(path, 'utf8');
    if (!decoded.trim()) throw new Error('decoded Markdown is empty');
    const parsed = await readFile(sourceRoot(store.root, prior.contentPath), 'utf8');
    if (sha256(parsed) !== prior.sha256) throw new Error('parsed material changed');
    const markdown = prior.metadata.coverage?.method === 'image' ? decoded : `${parsed}\n\n# Document interpretation\n\n${decoded}`;
    if (Buffer.byteLength(markdown) > MAX_MATERIAL_BYTES) throw new Error('decoded material is too large');
    if (exec?.signal?.aborted) throw new Error('material completion cancelled');
    const material = await registerMaterial(store, { name: prior.name, text: markdown, parseStatus: args.unresolved.length ? 'needs-review' : 'complete', metadata: { ...prior.metadata, derivedFrom: prior.id, documentReview: args.review, decodedPath: args.markdownPath, coverage: { method: 'native-document-review', sourceCoverage: prior.metadata.coverage, unresolved: [...args.unresolved], visualVerified: false } } });
    return { ...materialToolResult(material, markdown), complete: !args.unresolved.length };
  } });
  register({ name: 'material_render_pages', description: 'Render selected pages from a project-relative PDF into managed images.', parameters: { projectId: { type: 'string', required: true }, sourcePath: { type: 'string', required: true }, pages: { type: 'array', items: { type: 'number' }, required: true } }, async execute(args, exec) {
    if (!Array.isArray(args.pages) || !args.pages.length || args.pages.length > 32) throw new Error('pages must select 1 to 32 PDF pages');
    const store = resolveStore(args, exec); const inputPath = sourceRoot(store.root, args.sourcePath);
    if (!PAGE_RENDER_FORMATS.has(extname(inputPath).toLowerCase())) throw new Error('page rendering requires PDF or Office source');
    const rendered = await renderPdfPages({ inputPath, outputRoot: join(store.root, 'materials', 'parsed', 'page-renders'), pages: args.pages, maxPages: 32, maxBytes: MAX_MATERIAL_BYTES, dpi: 144 });
    return { ...rendered, images: rendered.images.map((path) => projectRelative(store.root, path)), sourcePath: args.sourcePath };
  } });
  register({ name: 'feishu_collect_materials', description: 'When the user supplies an actual Feishu spreadsheet material list for this scheme, automatically download every referenced file into the current workspace using current-user lark-cli. Do not process example links. No per-file confirmation. Reuse verified local downloads and resume pending export tickets; parse originals with material_parse next.', parameters: { projectId: { type: 'string', required: true }, url: { type: 'string', required: true }, sheetId: { type: 'string' }, sheetName: { type: 'string' }, range: { type: 'string' } }, async execute(args, exec) {
    const store = resolveStore(args, exec); const larkUserCli = currentUserLarkCli();
    if (!larkUserCli?.run) throw new Error('current-user Feishu CLI service unavailable');
    const result = await collectFeishuMaterials({ ...args, root: store.root, larkUserCli, signal: exec?.signal });
    for (const file of result.files) if (file.status === 'downloaded') {
      if (exec?.signal?.aborted) throw new Error('material collection cancelled');
      const material = await registerMaterial(store, { name: file.title, metadata: { source: 'feishu-file', url: args.url, sourcePath: file.path, sourceSha256: file.sha256, collectionIndexPath: result.indexPath } });
      file.materialId = material.id;
    }
    return { ...result, files: result.files.slice(0, 100), filesTruncated: result.files.length > 100, ignored: result.ignored.slice(0, 100), ignoredCount: result.ignored.length, unlinked: result.unlinked.slice(0, 100), unlinkedCount: result.unlinked.length };
  } });
  register({ name: 'feishu_read', description: 'Read and snapshot a Feishu document using the current user lark-cli identity.', parameters: { projectId: { type: 'string', required: true }, url: { type: 'string', required: true }, type: { type: 'string' }, scope: { type: 'string' }, sheetId: { type: 'string' }, sheetName: { type: 'string' }, range: { type: 'string' } }, async execute(args, exec) {
    const store = resolveStore(args, exec); const larkUserCli = currentUserLarkCli();
    if (!larkUserCli?.run) throw new Error('current-user Feishu CLI service unavailable');
    const result = await createFeishuConnector({ larkUserCli }).readResource(args);
    if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
    const material = await registerFetchedMaterial(store, { name: result.metadata.resourceId || result.metadata.url, text: result.content, metadata: result.metadata, snapshot: result.snapshot });
    return materialToolResult(material, result.content);
  } });
  register({ name: 'scheme_publish', description: 'Use the current user Feishu CLI to create a cloud delivery from a fixed scheme or chapter snapshot when requested. Creation needs no second confirmation; overwriting an existing document requires native approval.', parameters: { projectId: { type: 'string', required: true }, title: { type: 'string', required: true }, targetMode: { type: 'string', required: true }, chapterId: { type: 'string' }, revision: { type: 'number' }, artifactRevision: { type: 'number' }, parentToken: { type: 'string' }, doc: { type: 'string' }, revisionId: { type: 'number' }, sha256: { type: 'string' } }, execute: publishScheme });

  ctx.webServer?.register?.({ kind: 'prefix', path: '/ccpg-scheme/api', handler: async (req, res) => {
    try {
      const admission = ctx.connection?.admit?.(req);
      if (!admission?.peer) return json(res, admission?.rejection || 403, { code: 'browser-auth-required', error: 'Native DSH browser authentication is required.' });
      const url = new URL(req.url, 'http://ccpg.local'); const sid = url.searchParams.get('sessionId') || req.headers?.['x-ccpg-session']; if (!sid) return json(res, 409, { code: 'session-required', error: 'sessionId is required' });
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { code: 'method-not-allowed', error: 'GET or POST required' });
      const remote = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
      if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return json(res, 403, { code: 'loopback-only', error: 'loopback access required' });
      const origin = req.headers?.origin;
      if (origin && new URL(origin).host !== req.headers?.host) return json(res, 403, { code: 'origin-rejected', error: 'same-origin request required' });
      if (req.method !== 'GET' && req.headers?.['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { code: 'json-required', error: 'application/json required' });
      const payload = req.method === 'GET' ? {} : await body(req); const projectId = payload.projectId || url.searchParams.get('projectId');
      const sessionCwd = getSession(ctx, sid);
      const current = projectId ? null : currentProject(sessionCwd);
      if (projectId && !url.pathname.endsWith('/create')) projectRoot(sessionCwd, projectId);
      const storeRoot = current?.root || resolve(sessionCwd);
      if (req.method === 'GET' && url.pathname.endsWith('/browser-url')) {
        const target = new URL('/ccpg-scheme/results', `http://${req.headers.host}`);
        target.searchParams.set('sessionId', sid);
        if (projectId) target.searchParams.set('projectId', projectId);
        return json(res, 200, { url: ctx.connection.authenticatedUrl(target.href) });
      }
      if (req.method === 'GET' && url.pathname.endsWith('/artifact')) {
        const chapterId = url.searchParams.get('chapterId');
        const store = projects.get(storeRoot) || SchemeStore.load(storeRoot); projects.set(storeRoot, store);
        return json(res, 200, await readChapterArtifact(store, chapterId));
      }
      if (req.method === 'GET' && url.pathname === '/ccpg-scheme/api') { const store = projects.get(storeRoot) || SchemeStore.load(storeRoot); projects.set(storeRoot, store); return json(res, 200, { ...projectSnapshot(store), projectCwd: store.root, publications: await publicationSummary(store.root), diagnostics: { path: '.ccpg-scheme/diagnostics.jsonl', recent: readDiagnostics(store.root) } }); }
      if (req.method === 'GET') return json(res, 404, { code: 'not-found', error: 'unknown endpoint' });
      if (url.pathname.endsWith('/create')) { const store = await createProject({ sessionCwd, projectId, rulesDir }); projects.set(store.root, store); return json(res, 201, store.state); }
      const store = projects.get(storeRoot) || SchemeStore.load(storeRoot); projects.set(storeRoot, store); let result;
      if (url.pathname.endsWith('/materials')) result = payload.sourceDirectory && payload.relativePath ? await registerIndexedMaterial(store, { ...payload, sourceDir: sourceRoot(sessionCwd, payload.sourceDirectory) }) : await registerMaterial(store, payload);
      else if (url.pathname.endsWith('/material-parse')) {
        const { material, markdown, parsed } = await parseProjectMaterial(store, payload.sourcePath);
        result = { markdown, parse: { ...parsed, markdownPath: projectRelative(store.root, parsed.markdownPath), images: parsed.images.map((path) => projectRelative(store.root, path)) }, material };
      }
      else if (url.pathname.endsWith('/material-render-pages')) {
        if (!Array.isArray(payload.pages) || !payload.pages.length || payload.pages.length > 32) throw new Error('pages must select 1 to 32 PDF pages');
        const inputPath = sourceRoot(store.root, payload.sourcePath);
        if (!PAGE_RENDER_FORMATS.has(extname(inputPath).toLowerCase())) throw new Error('page rendering requires PDF or Office source');
        const rendered = await renderPdfPages({ inputPath, outputRoot: join(store.root, 'materials', 'parsed', 'page-renders'), pages: payload.pages, maxPages: 32, maxBytes: MAX_MATERIAL_BYTES, dpi: 144 });
        result = { ...rendered, images: rendered.images.map((path) => projectRelative(store.root, path)), sourcePath: payload.sourcePath };
      }
      else if (url.pathname.endsWith('/feishu-read')) {
        const larkUserCli = currentUserLarkCli();
        if (!larkUserCli?.run) throw new Error('current-user Feishu CLI service unavailable');
        const fetched = await createFeishuConnector({ larkUserCli }).readResource(payload);
        if (!fetched.ok) throw new Error(`${fetched.code}: ${fetched.error}`);
        const material = await registerFetchedMaterial(store, { name: fetched.metadata.resourceId || fetched.metadata.url, text: fetched.content, metadata: fetched.metadata, snapshot: fetched.snapshot });
        result = { material, content: fetched.content };
      }
      else if (url.pathname.endsWith('/prepare')) result = await prepareChapter(store, payload);
      else if (url.pathname.endsWith('/submit')) result = await submitChapter(store, payload);
      else if (url.pathname.endsWith('/edit') || url.pathname.endsWith('/confirm') || url.pathname.endsWith('/skip')) return json(res, 403, { code: 'user-action-required', error: 'This mutation requires a verified DSH user action channel; HTTP sessionId/origin is not sufficient.' });
      else if (url.pathname.endsWith('/recover')) result = await recoverProject(store);
      else if (url.pathname.endsWith('/export')) result = await exportDelivery(store);
      else if (url.pathname.endsWith('/index-materials')) result = await indexMaterialDirectory(sourceRoot(sessionCwd, payload.sourceDirectory), payload.knownInputNames || [], payload.limits);
      else if (url.pathname.endsWith('/replace-rules')) result = await replaceChapterRules(store, payload).then(() => projectSnapshot(store));
      else return json(res, 404, { code: 'not-found', error: 'unknown endpoint' });
      return json(res, 200, result);
    } catch (error) {
      const message = String(error.message || error);
      let root = null; const diagnosticArgs = {}; let operation = 'http:unknown';
      try {
        const url = new URL(req.url, 'http://ccpg.local');
        const sid = url.searchParams.get('sessionId') || req.headers?.['x-ccpg-session'];
        root = resolve(getSession(ctx, sid));
        diagnosticArgs.projectId = url.searchParams.get('projectId');
        operation = `http:${req.method}:${url.pathname}`;
      } catch {}
      await appendDiagnostic(root, operation, diagnosticArgs, error);
      return json(res, message.includes('project-required') || message.includes('revision') ? 409 : 400, { code: message.includes('project-required') ? 'project-required' : 'scheme-error', error: message });
    }
  } });

  const browserHtml = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>方案成果</title></head><body><div id="ccpg-scheme-browser"></div><script src="/ccpg-scheme/browser.js"></script></body></html>';
  const authorizeBrowser = (req, res) => {
    if (!loopback(req)) { send(res, 403, 'text/plain; charset=utf-8', 'loopback access required'); return false; }
    const url = new URL(req.url, 'http://ccpg.local');
    const clean = new URL(url.pathname + url.search, `http://${req.headers.host || 'localhost'}`);
    clean.searchParams.delete('token');
    const tokens = url.searchParams.getAll('token');
    if (!tokens.length) {
      const admission = ctx.connection?.admit?.(req);
      if (!admission?.peer) { send(res, admission?.rejection || 403, 'text/plain; charset=utf-8', 'browser authentication required'); return false; }
      return ctx.connection.authorizeIndex({ ...req, method: req.method, headers: req.headers, url: '/' }, res);
    }
    const authUrl = new URL('/', 'http://ccpg.local');
    for (const token of tokens) authUrl.searchParams.append('token', token);
    const wrapped = {
      writeHead(status, headers = {}) { res.writeHead(status, { ...headers, location: status === 303 ? clean.pathname + clean.search : headers.location }); },
      end(value) { res.end(value); },
    };
    return ctx.connection.authorizeIndex({ ...req, method: req.method, headers: req.headers, url: authUrl.pathname + authUrl.search }, wrapped);
  };
  ctx.webServer?.register?.({ kind: 'exact', path: '/ccpg-scheme/results', handler(req, res) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'GET required');
    if (!authorizeBrowser(req, res)) return undefined;
    res.setHeader?.('cache-control', 'no-store');
    res.setHeader?.('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    return send(res, 200, 'text/html; charset=utf-8', browserHtml);
  } });
  ctx.webServer?.register?.({ kind: 'exact', path: '/ccpg-scheme/browser.js', handler(req, res) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'GET required');
    if (!loopback(req)) return send(res, 403, 'text/plain; charset=utf-8', 'loopback access required');
    const admission = ctx.connection?.admit?.(req);
    if (!admission?.peer) return send(res, admission?.rejection || 403, 'text/plain; charset=utf-8', 'browser authentication required');
    return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(browserBundlePath, 'utf8'));
  } });
}

export { SchemeStore };
