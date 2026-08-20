import { parseExpression, parseTemplate, safePickPath } from './template-parser.js';
import { extractJson, validateTemplate } from './template.js';
import { toJsonSafe } from './output-contract.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PARAMETER_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function typedError(message, code = 'SCRIPT_INPUT_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function matchLegacyNode(key, incomingIds, labels) {
  for (const id of incomingIds) if (id === key) return id;
  for (const id of incomingIds) if ((labels.get(id) || '') === key) return id;
  for (const id of incomingIds) if ((labels.get(id) || '').toLowerCase() === String(key).toLowerCase()) return id;
  return null;
}

function nodeEnvelope(id, ctx) {
  const structured = ctx.structuredOutputs?.get(id);
  const text = String(ctx.outputs?.get(id) ?? '');
  const state = ctx.nodeStates?.get?.(id) ?? ctx.nodeStates?.[id] ?? {};
  const meta = {};
  for (const key of ['status', 'chars', 'durationMs', 'model', 'runtime', 'turns', 'usage', 'writeback', 'approvedBy', 'approvalComment', 'toleratedError']) {
    if (state[key] !== undefined) meta[key] = state[key];
  }
  return { text, data: structured?.value ?? extractJson(text), meta };
}

function resolveRoot(expression, ctx) {
  if (expression.kind === 'builtin') {
    if (expression.builtin === '$trigger') return ctx.triggerInput ?? '';
    return (ctx.incomingIds || []).map((id) => ctx.outputs?.get(id)).filter((value) => value !== undefined && value !== null && value !== '').join('\n\n');
  }
  if (expression.kind === 'scoped') {
    const root = expression.scope === 'global' ? ctx.globalVariables
      : expression.scope === 'workflow' ? ctx.workflowVariables : ctx.runInputs;
    return safePickPath(root, [expression.key]);
  }
  const incomingIds = ctx.incomingIds || [];
  const id = expression.syntax === 'canonical'
    ? (incomingIds.includes(expression.nodeId) ? expression.nodeId : null)
    : matchLegacyNode(expression.nodeKey, incomingIds, ctx.labels || new Map());
  if (!id) return undefined;
  const state = ctx.nodeStates?.get?.(id) ?? ctx.nodeStates?.[id];
  if (state && state.status !== 'success') return undefined;
  const envelope = nodeEnvelope(id, ctx);
  if (expression.syntax === 'legacy-json') return envelope.data?.json ?? envelope.data ?? extractJson(envelope.text);
  return envelope[expression.channel || 'text'];
}

export function resolveTypedExpression(template, ctx = {}) {
  const parsed = parseTemplate(String(template ?? ''));
  if (parsed.tokens.length !== 1 || parsed.tokens[0].type !== 'variable') {
    throw typedError('脚本参数表达式必须是一个完整变量，例如 {{node["source"].data.items}}', 'SCRIPT_INPUT_EXPRESSION');
  }
  const expression = parseExpression(parsed.tokens[0].expression.raw);
  if (expression.errors?.length) throw typedError(expression.errors.join('；'), 'SCRIPT_INPUT_EXPRESSION');
  let value = resolveRoot(expression, ctx);
  if (expression.path?.length) value = safePickPath(value, expression.path);
  for (const filter of expression.filters || []) {
    if (filter.name === 'default' && (value === undefined || value === null)) value = filter.value;
  }
  if (value === undefined) {
    if (expression.optional) return null;
    throw typedError(`脚本参数引用没有值：{{${expression.raw}}}`, 'SCRIPT_INPUT_MISSING');
  }
  return toJsonSafe(value, '$.parameter');
}

export function validateScriptParameterName(name) {
  const value = String(name || '').trim();
  if (!PARAMETER_NAME_RE.test(value)) return '参数名必须是合法 JavaScript 标识符';
  if (FORBIDDEN_KEYS.has(value)) return '参数名不安全';
  return null;
}

export function resolveScriptInputs(entries, ctx = {}) {
  const input = Object.create(null);
  const seen = new Set();
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const name = String(entry?.name || '').trim();
    const issue = validateScriptParameterName(name);
    if (issue) throw typedError(`脚本参数 ${index + 1}：${issue}`, 'SCRIPT_INPUT_NAME');
    if (seen.has(name)) throw typedError(`脚本参数名重复：${name}`, 'SCRIPT_INPUT_DUPLICATE');
    seen.add(name);
    const value = typeof entry?.expression === 'string' && entry.expression.trim()
      ? resolveTypedExpression(entry.expression, ctx)
      : toJsonSafe(entry?.value, `$.inputs.${name}`);
    Object.defineProperty(input, name, { value, enumerable: true, writable: false, configurable: false });
  }
  return input;
}

export function lintScriptInputs(entries, context = {}) {
  const issues = [];
  const seen = new Set();
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const name = String(entry?.name || '').trim();
    const issue = validateScriptParameterName(name);
    if (issue) issues.push({ level: 'error', message: `脚本参数 ${index + 1}：${issue}` });
    else if (seen.has(name)) issues.push({ level: 'error', message: `脚本参数名重复：${name}` });
    seen.add(name);
    if (typeof entry?.expression === 'string' && entry.expression.trim()) {
      const checked = validateTemplate(entry.expression, context);
      const parsed = parseTemplate(entry.expression);
      if (parsed.tokens.length !== 1 || parsed.tokens[0].type !== 'variable') {
        issues.push({ level: 'error', message: `脚本参数「${name || index + 1}」必须使用完整变量表达式` });
      }
      for (const templateIssue of checked.issues || []) {
        if (templateIssue.level === 'info') continue;
        issues.push({ level: templateIssue.level, message: `脚本参数「${name || index + 1}」：${templateIssue.message}` });
      }
    } else {
      try { toJsonSafe(entry?.value, `$.inputs[${index}].value`); }
      catch (error) { issues.push({ level: 'error', message: `脚本参数「${name || index + 1}」常量无效：${error.message}` }); }
    }
  }
  return issues;
}
