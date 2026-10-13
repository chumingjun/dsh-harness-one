import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkedPath, acquireProjectLock, releaseProjectLock } from './core.js';

const queues = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const issueFile = '.ccpg-scheme/validation/issues.json';
const reportFile = 'reports/方案生成问题报告.md';
const labels = { plugin: '插件故障', runtime: '原生运行故障', gap: '材料或业务缺口', user: '用户反馈', model: '模型候选' };
const codes = {
  CONTEXT_LIMIT: '模型上下文超过限制', SERVICE_FAILURE: '模型服务请求失败',
  INPUT_GAP: '材料、来源或必需输出尚不完整', PERMISSION: '登录或访问权限不足',
  VERSION_CONFLICT: '成果或输入版本已变化', PARSE_FAILURE: '文档解析失败',
  OPERATION_FAILURE: '插件操作失败', FEEDBACK: '待分析反馈',
};
export function issueCode(error) {
  const message = String(error?.message || error?.code || error || '');
  if (/cancel|abort/i.test(message) || error?.name === 'AbortError') return 'CANCELLED';
  if (/context|preflight_compress|window|IMAGE_OFFLOAD/i.test(message)) return 'CONTEXT_LIMIT';
  if (/required|incomplete|missing|not ready|blocker|pending confirmation/i.test(message)) return 'INPUT_GAP';
  if (/permission|unauthorized|forbidden|login|403|401/i.test(message)) return 'PERMISSION';
  if (/conflict|stale|changed|token/i.test(message)) return 'VERSION_CONFLICT';
  if (/pdf|worker|DOMMatrix|parse/i.test(message)) return 'PARSE_FAILURE';
  return 'OPERATION_FAILURE';
}
export const issueLabel = (code) => codes[code] || codes.OPERATION_FAILURE;
export function safeFeedback(value) {
  return String(value || '').slice(0, 4000)
    .replace(/-----BEGIN[\s\S]*?-----END[^\n]*-----/g, '[已隐藏密钥]')
    .replace(/\b(?:bearer\s+\S+|(?:token|password|passwd|secret|api[-_ ]?key)\s*[:=]\s*["']?\S+)/gi, '[已隐藏凭据]')
    .replace(/\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]+/g, '[已隐藏凭据]')
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.\w+|(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s]+/gi, '[已隐藏地址]')
    .replace(/[\r\n|<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}
function atomic(root, relativePath, text) {
  const path = checkedPath(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, text, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
function load(root) {
  const path = checkedPath(root, issueFile);
  if (!existsSync(path)) return { schemaVersion: 1, issues: [] };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.issues)) throw new Error('invalid saved issue report');
  return data;
}
function queued(store, callback) {
  const previous = queues.get(store.root) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => {
    const lock = checkedPath(store.root, '.ccpg-scheme/validation/recording.lock');
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    // Reporting must never acquire the business state lock or invalidate a chapter attempt.
    const lease = acquireProjectLock(store.root, '.ccpg-scheme/validation/recording.lock');
    try { return callback(JSON.parse(readFileSync(checkedPath(store.root, '.ccpg-scheme/state.json'), 'utf8'))); }
    finally { releaseProjectLock(lease); }
  });
  queues.set(store.root, pending);
  void pending.finally(() => { if (queues.get(store.root) === pending) queues.delete(store.root); }).catch(() => {});
  return pending;
}
function report(store, state, data) {
  const checks = { unGenerated: [], requiredInputs: [], unresolvedDecisions: [], unavailableBindings: [], missingOutputs: [], invalidEvidence: [], unavailableArtifacts: [] };
  const manifest = JSON.parse(readFileSync(checkedPath(store.root, '.ccpg-scheme/manifest.json'), 'utf8'));
  for (const definition of manifest.chapters) {
    const chapter = state.chapters[definition.id];
    if (!chapter?.artifactId) checks.unGenerated.push(definition.id);
    for (const input of definition.inputs || []) {
      const required = input.required === true || chapter?.decisions?.[input.id] === 'required';
      const material = state.materials[chapter?.bindings?.[input.id]];
      if (input.required === 'unknown' && !['required', 'not_required'].includes(chapter?.decisions?.[input.id])) checks.unresolvedDecisions.push(`${definition.id}/${input.id}`);
      if (required && !material) checks.requiredInputs.push(`${definition.id}/${input.id}`);
      if (chapter?.bindings?.[input.id] && (!material || material.parseStatus !== 'complete')) checks.unavailableBindings.push(`${definition.id}/${input.id}`);
    }
    if (!chapter?.artifactId) continue;
    try {
      const artifact = state.artifacts[chapter.artifactId];
      if (!artifact || !existsSync(checkedPath(store.root, `${artifact.path}/body.md`))) throw new Error('artifact unavailable');
      const attachments = JSON.parse(readFileSync(checkedPath(store.root, `${artifact.path}/attachments.json`), 'utf8'));
      const evidence = JSON.parse(readFileSync(checkedPath(store.root, `${artifact.path}/evidence.json`), 'utf8'));
      for (const output of definition.outputs || []) if (output.kind === 'attachment' && !attachments.some((item) => item.outputId === output.id)) checks.missingOutputs.push(`${definition.id}/${output.id}`);
      for (const item of evidence) if (item.source && !state.materials[item.source] && !state.artifacts[item.source]) checks.invalidEvidence.push(definition.id);
    } catch { checks.unavailableArtifacts.push(definition.id); }
  }
  const generated = Object.values(state.chapters).filter((item) => item.artifactId).length;
  const stale = Object.values(state.chapters).filter((item) => item.stale).length;
  const pending = Object.values(state.chapters).filter((item) => item.pendingConfirmations).length;
  const confirmed = Object.values(state.chapters).filter((item) => item.confirmed && !item.stale).length;
  const materials = Object.values(state.materials);
  const scope = new Set(data.issues.map((item) => `${item.build} / ${item.rulesVersion}`));
  const lines = ['# 方案生成问题报告', '', `生成时间：${new Date().toISOString()}`, `项目 revision：${state.revision}`,
    `固定规则：${safeFeedback(state.manifest?.version)}；规则与技能指纹：${state.rulesFingerprint || '未采集'}`,
    '构建标识范围：scheme lib/*.js 与全局 SKILL.md；指纹仅用于版本定位。',
    ...[...scope].map((value) => `- ${value}`), '',
    `已生成：${generated}；未生成：${Object.keys(state.chapters).length - generated}；需更新：${stale}；待核对：${pending}；已人工确认：${confirmed}`,
    `已登记材料：${materials.length}；解析未完成：${materials.filter((item) => item.parseStatus !== 'complete').length}`,
    '实际模型用量：未采集。结构统计不能证明正文业务正确或规则全部遵守。', '',
    '## 结构检查', '',
    `必需输入未绑定：${checks.requiredInputs.join('、') || '无'}；必填口径未确认：${checks.unresolvedDecisions.join('、') || '无'}`,
    `已绑定来源未完成：${checks.unavailableBindings.join('、') || '无'}；附件输出缺失：${checks.missingOutputs.join('、') || '无'}`,
    `证据引用未登记：${[...new Set(checks.invalidEvidence)].join('、') || '无'}；成果文件不可读：${checks.unavailableArtifacts.join('、') || '无'}`,
    '检查只读取定义与成果元数据，不核验正文语义或重新解析材料；未生成章节的输入缺口不是插件故障。', '',
    '## 问题记录', '', ...(data.issues.length ? [] : ['尚未记录问题；不代表已经完成全案验收。'])];
  for (const item of data.issues) lines.push(
    `- ${labels[item.source]} · ${item.chapterId || '未定位章节'} · ${item.code} · ${item.status === 'recovered' ? '已恢复' : '待处理'} · ${item.count} 次`,
    `  ${codes[item.code] || codes.OPERATION_FAILURE}；操作 ${item.operation}；首次 ${item.firstAt}；最近 ${item.lastAt}`,
    `  版本 ${item.build} / ${item.rulesVersion}；章节成果版本 ${item.artifactRevision ?? '未定位'}；定位 ${item.position || '未采集'}`,
    ...(item.summary ? [`  反馈：${safeFeedback(item.summary)}；期望：${safeFeedback(item.expected)}；实际：${safeFeedback(item.actual)}`] : []),
    ...(item.recoveredAt ? [`  恢复证据：${item.recoveredAt} ${item.recovery || '同一操作成功'}`] : []));
  lines.push('', '默认只保存在本地，不自动上报；不包含正文、材料原件、全量会话或原始异常响应。', '');
  atomic(store.root, reportFile, lines.join('\n'));
  return { path: reportFile, issues: data.issues, checks, open: data.issues.filter((item) => item.status === 'open').length };
}
export function recordIssue(store, event) {
  return queued(store, (state) => {
    const data = load(store.root);
    if (event.code === 'CANCELLED') return report(store, state, data);
    if (!labels[event.source]) throw new Error('invalid issue source');
    const chapterId = state.chapters[event.chapterId] ? event.chapterId : '';
    const code = codes[event.code] ? event.code : ['user', 'model'].includes(event.source) ? 'FEEDBACK' : 'OPERATION_FAILURE';
    const operation = /^[a-zA-Z0-9:/._-]{1,120}$/.test(event.operation || '') ? event.operation : 'feedback';
    const build = /^[a-zA-Z0-9._-]{1,100}$/.test(event.build || '') ? event.build : 'unknown';
    const summary = ['user', 'model'].includes(event.source) ? safeFeedback(event.summary) : '';
    const rulesVersion = safeFeedback(state.manifest?.version);
    const key = hash(JSON.stringify([event.source, chapterId, operation, code, build, rulesVersion, summary]));
    let item = data.issues.find((entry) => entry.id === key);
    if (!item) {
      item = { id: key, source: event.source, chapterId, operation, code, build, rulesVersion, summary,
        expected: summary ? safeFeedback(event.expected) : '', actual: summary ? safeFeedback(event.actual) : '',
        firstAt: new Date().toISOString(), count: 0, recoveries: 0 };
      data.issues.push(item);
    }
    item.count++; item.lastAt = new Date().toISOString(); item.status = 'open';
    item.position = event.position ? hash(String(event.position)).slice(0, 16) : '';
    item.artifactRevision = state.chapters[chapterId]?.revision;
    atomic(store.root, issueFile, `${JSON.stringify(data, null, 2)}\n`);
    return report(store, state, data);
  });
}
export function recoverIssues(store, { source, operation, chapterId, position, build }) {
  return queued(store, (state) => {
    const data = load(store.root);
    let changed = false;
    for (const item of data.issues) if (item.status === 'open' && item.source === source && item.operation === operation
      && (chapterId === undefined || item.chapterId === chapterId) && (build === undefined || item.build === build)
      && (position === undefined || item.position === hash(String(position)).slice(0, 16))) {
      item.status = 'recovered'; item.recoveredAt = new Date().toISOString(); item.recoveries++;
      item.recovery = source === 'runtime' ? '同一步模型响应已持久化' : '同一插件操作成功';
      changed = true;
    }
    if (!changed) return;
    atomic(store.root, issueFile, `${JSON.stringify(data, null, 2)}\n`);
    return report(store, state, data);
  });
}
export function validationReport(store) {
  return queued(store, (state) => report(store, state, load(store.root)));
}
