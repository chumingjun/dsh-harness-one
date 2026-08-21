// 模板变量 v2：canonical 语法使用 {{node["id"].text|data|meta}}，并兼容旧标签/ID/.json/@ 语法。
import { parseExpression, parseTemplate, safePickPath, TEMPLATE_VAR_RE } from './template-parser.js';

export const VAR_RE = TEMPLATE_VAR_RE;

function valueToText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function matchNode(key, upstreamSet, labels) {
  for (const id of upstreamSet) if ((labels.get(id) || '') === key) return id;
  for (const id of upstreamSet) if (id === key) return id;
  for (const id of upstreamSet) {
    if ((labels.get(id) || '').toLowerCase() === String(key).toLowerCase()) return id;
  }
  return null;
}

function upstreamText(ctx, used) {
  const parts = [];
  for (const id of ctx.incomingIds || []) {
    const out = ctx.outputs?.get(id);
    if (out === undefined || out === null || out === '') continue;
    used.add(id);
    parts.push(`── 来自 [${ctx.labels?.get(id) || id}] ──\n${out}`);
  }
  return parts.join('\n\n');
}

const META_ALLOWLIST = ['status', 'chars', 'durationMs', 'model', 'runtime', 'turns', 'usage', 'writeback', 'toleratedError'];

function safeNodeMeta(id, ctx) {
  const state = ctx.nodeStates?.get?.(id) ?? ctx.nodeStates?.[id] ?? {};
  const meta = {};
  for (const key of META_ALLOWLIST) if (state[key] !== undefined) meta[key] = state[key];
  return meta;
}

function nodeEnvelope(id, ctx) {
  const structured = ctx.structuredOutputs?.get(id);
  const text = String(ctx.outputs?.get(id) ?? '');
  return {
    text,
    data: structured?.value ?? extractJson(text),
    meta: safeNodeMeta(id, ctx),
  };
}

function isNodeAvailable(id, ctx) {
  const state = ctx.nodeStates?.get?.(id) ?? ctx.nodeStates?.[id];
  return !state || state.status === 'success';
}

function applyFilters(value, expression, missing) {
  let current = value;
  for (const filter of expression.filters || []) {
    if (filter.name === 'default' && (current === undefined || current === null)) current = filter.value;
  }
  if (current === undefined || current === null) return expression.optional ? '' : missing;
  return valueToText(current);
}

function scopedValues(scope, ctx) {
  if (scope === 'global') return ctx.globalVariables;
  if (scope === 'workflow') return ctx.workflowVariables;
  return ctx.runInputs;
}

function resolveExpression(expression, ctx, used) {
  if (expression.errors?.length) return { missing: true, value: `{{${expression.raw}}}` };
  if (expression.kind === 'builtin') {
    const value = expression.builtin === '$trigger' ? (ctx.triggerInput ?? '') : upstreamText(ctx, used);
    return { value: applyFilters(value, expression, `{{${expression.raw}}}`) };
  }
  if (expression.kind === 'scoped') {
    const root = scopedValues(expression.scope, ctx);
    let value = safePickPath(root, [expression.key]);
    if (expression.path?.length) value = safePickPath(value, expression.path);
    const missing = value === undefined || value === null;
    return { missing, value: applyFilters(value, expression, `{{${expression.raw}}}`) };
  }

  const upstreamSet = new Set(ctx.incomingIds || []);
  const id = expression.syntax === 'canonical'
    ? (upstreamSet.has(expression.nodeId) ? expression.nodeId : null)
    : matchNode(expression.nodeKey, upstreamSet, ctx.labels || new Map());
  if (id == null || !isNodeAvailable(id, ctx)) {
    return {
      missing: true,
      dropSegment: expression.filters?.some((f) => f.name === 'optional' && f.legacy),
      value: applyFilters(undefined, expression, `{{${expression.raw}}}`),
    };
  }

  used.add(id);
  const envelope = nodeEnvelope(id, ctx);
  let value = envelope[expression.channel || 'text'];
  if (expression.syntax === 'legacy-json') {
    value = envelope.data?.json ?? envelope.data ?? extractJson(envelope.text);
  }
  if (expression.path?.length) value = safePickPath(value, expression.path);
  const missing = value === undefined || value === null;
  return {
    missing,
    dropSegment: missing && expression.filters?.some((f) => f.name === 'optional' && f.legacy),
    value: applyFilters(value, expression, `{{${expression.raw}}}`),
  };
}

export function renderTemplate(template, ctx = {}) {
  const parsed = parseTemplate(template);
  const missing = [];
  const used = new Set();
  const renderSegment = (segment) => {
    let drop = false;
    const text = segment.replace(VAR_RE, (full, raw) => {
      const expression = parseExpression(raw);
      const resolved = resolveExpression(expression, ctx, used);
      if (resolved.missing) missing.push(expression.raw);
      if (resolved.dropSegment) drop = true;
      return resolved.value;
    });
    return drop ? null : text;
  };

  let text = parsed.source.split(/\n\n+/).map(renderSegment).filter((part) => part !== null).join('\n\n');
  if (ctx.implicitUpstream !== false && !parsed.hasVariables && (ctx.incomingIds || []).length > 0) {
    const upstream = upstreamText(ctx, used);
    text = text && upstream ? `${text}\n\n${upstream}` : (text || upstream);
  }

  return {
    text,
    missing: [...new Set(missing)],
    used: [...used],
    references: parsed.references.map((ref) => ref.expression),
    schemaVersion: 2,
  };
}

function declaredKeys(definitions, values, supplied) {
  if (!supplied) return null;
  const keys = new Set(Object.keys(values || {}));
  const list = Array.isArray(definitions) ? definitions : Array.isArray(definitions?.fields) ? definitions.fields : [];
  for (const definition of list) if (definition && typeof definition.key === 'string') keys.add(definition.key);
  return keys;
}

export function validateTemplate(template, context = {}) {
  const parsed = parseTemplate(template);
  const issues = [];
  const nodes = new Map((context.nodes || []).map((node) => [node.id, node]));
  const incoming = new Set(context.incomingIds || nodes.keys());
  const scopedDeclarations = {
    global: declaredKeys(context.globalVariableDefinitions, context.globalVariables,
      Object.prototype.hasOwnProperty.call(context, 'globalVariableDefinitions') || Object.prototype.hasOwnProperty.call(context, 'globalVariables')),
    workflow: declaredKeys(context.workflowVariableDefinitions, context.workflowVariables,
      Object.prototype.hasOwnProperty.call(context, 'workflowVariableDefinitions') || Object.prototype.hasOwnProperty.call(context, 'workflowVariables')),
    input: declaredKeys(context.inputSchema, context.runInputs,
      Object.prototype.hasOwnProperty.call(context, 'inputSchema') || Object.prototype.hasOwnProperty.call(context, 'runInputs')),
  };
  const labelIds = new Map();
  for (const node of nodes.values()) {
    const label = node.data?.label || node.id;
    labelIds.set(label, [...(labelIds.get(label) || []), node.id]);
  }

  for (const ref of parsed.references) {
    const expression = ref.expression;
    for (const message of expression.errors || []) {
      issues.push({ level: 'error', code: 'invalid-expression', message, expression: expression.raw, start: ref.start });
    }
    if (expression.kind === 'scoped') {
      const declarations = scopedDeclarations[expression.scope];
      if (declarations && !declarations.has(expression.key)) {
        const codes = {
          global: 'unknown-global-variable',
          workflow: 'unknown-workflow-variable',
          input: 'unknown-run-input',
        };
        const labels = { global: '实例变量', workflow: '工作流变量', input: '运行输入' };
        issues.push({
          level: 'error', code: codes[expression.scope],
          message: `${labels[expression.scope]}未声明：${expression.key}`,
          expression: expression.raw, start: ref.start,
        });
      }
      continue;
    }
    if (expression.kind !== 'node') continue;
    let id = expression.nodeId;
    if (expression.syntax !== 'canonical') {
      const candidates = nodes.has(expression.nodeKey) ? [expression.nodeKey] : (labelIds.get(expression.nodeKey) || []);
      if (candidates.length > 1) {
        issues.push({ level: 'warn', code: 'ambiguous-legacy-reference', message: `旧变量「${expression.nodeKey}」匹配多个节点，请改用 node["id"]`, expression: expression.raw, start: ref.start });
      }
      [id] = candidates;
      issues.push({ level: 'info', code: 'legacy-syntax', message: `建议将 {{${expression.raw}}} 升级为 canonical 变量语法`, expression: expression.raw, start: ref.start });
    }
    if (!id || !nodes.has(id)) {
      const level = expression.syntax === 'canonical' ? 'error' : (expression.optional ? 'info' : 'warn');
      issues.push({ level, code: 'unknown-node', message: `变量引用没有该节点：${id || expression.nodeKey}`, expression: expression.raw, start: ref.start });
    } else if (!incoming.has(id)) {
      issues.push({ level: 'error', code: 'not-upstream', message: `变量只能引用直接上游节点：${id}`, expression: expression.raw, start: ref.start });
    }
  }

  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    issues,
    references: parsed.references.map((ref) => ref.expression),
    schemaVersion: 2,
  };
}

export function extractJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { /* continue */ }
  for (let start = 0; start < s.length; start++) {
    if (s[start] !== '{' && s[start] !== '[') continue;
    const stack = [];
    let inString = false; let escaped = false;
    for (let i = start; i < s.length; i++) {
      const char = s[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && inString) { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}

export function pickPath(value, path) {
  const normalized = String(path || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/^\./, '')
    .split('.')
    .filter(Boolean)
    .map((part) => /^\d+$/.test(part) ? Number(part) : part);
  return safePickPath(value, normalized);
}
