export const TEMPLATE_VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function splitFilters(source) {
  const parts = [];
  let quote = null; let escaped = false; let depth = 0; let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '|' && depth === 0) { parts.push(source.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function parseLiteral(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      if (s.startsWith('"')) return JSON.parse(s);
      return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    } catch { return s.slice(1, -1); }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parsePath(source) {
  const path = [];
  let rest = source;
  while (rest) {
    let m = rest.match(/^\.([A-Za-z_$][\w$]*|\d+)/);
    if (m) { path.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]); rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^\[(\d+)\]/);
    if (m) { path.push(Number(m[1])); rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^\[\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\]/);
    if (m) { path.push(parseLiteral(m[1])); rest = rest.slice(m[0].length); continue; }
    return { path, error: `无法解析路径片段：${rest}` };
  }
  if (path.some((key) => FORBIDDEN_PATH_KEYS.has(String(key)))) return { path, error: '路径包含不安全字段' };
  return { path };
}

function parseScopedExpression(source) {
  const match = source.match(/^(vars\.(global|workflow)|inputs)\s*\[\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\](.*)$/s);
  if (!match) return null;
  const key = parseLiteral(match[3]);
  const parsedPath = parsePath(match[4] || '');
  return {
    scope: match[1] === 'inputs' ? 'input' : match[2],
    key,
    path: parsedPath.path,
    error: parsedPath.error,
  };
}

export function parseExpression(rawExpression) {
  const raw = String(rawExpression ?? '').trim();
  const filterParts = splitFilters(raw);
  let source = filterParts.shift() || '';
  const filters = [];
  const errors = [];
  for (const part of filterParts) {
    let m = part.match(/^default\s*\((.*)\)$/s);
    if (m) { filters.push({ name: 'default', value: parseLiteral(m[1]) }); continue; }
    m = part.match(/^optional(?:\s*\(\s*\))?$/);
    if (m) { filters.push({ name: 'optional' }); continue; }
    errors.push(`未知过滤器：${part}`);
  }

  let legacyOptional = false;
  if (source.startsWith('@')) { legacyOptional = true; source = source.slice(1).trim(); }
  if (legacyOptional) filters.push({ name: 'optional', legacy: true });

  if (source === '$trigger' || source === '$upstream') {
    return { raw, kind: 'builtin', builtin: source, filters, optional: filters.some((f) => f.name === 'optional'), errors };
  }

  const scoped = parseScopedExpression(source);
  if (scoped) {
    if (scoped.error) errors.push(scoped.error);
    if (typeof scoped.key !== 'string' || !scoped.key) errors.push('变量 key 必须是非空字符串');
    if (FORBIDDEN_PATH_KEYS.has(String(scoped.key))) errors.push('变量 key 不安全');
    return {
      raw, kind: 'scoped', scope: scoped.scope, key: scoped.key, path: scoped.path,
      filters, optional: filters.some((f) => f.name === 'optional'), errors,
    };
  }

  const canonical = source.match(/^node\s*\[\s*(["'])(.*?)\1\s*\]\s*\.(text|data|meta)(.*)$/s);
  if (canonical) {
    const parsedPath = parsePath(canonical[4] || '');
    if (parsedPath.error) errors.push(parsedPath.error);
    return {
      raw, kind: 'node', syntax: 'canonical', nodeId: canonical[2], channel: canonical[3],
      path: parsedPath.path, filters, optional: filters.some((f) => f.name === 'optional'), errors,
    };
  }

  const jsonMatch = source.match(/^(.*?)\.json(?:\.(.*))?$/s);
  if (jsonMatch) {
    const legacyPath = jsonMatch[2] ? jsonMatch[2].replace(/\[(\d+)\]/g, '.$1') : '';
    const parsedPath = parsePath(legacyPath ? `.${legacyPath}` : '');
    if (parsedPath.error) errors.push(parsedPath.error);
    return {
      raw, kind: 'node', syntax: 'legacy-json', nodeKey: jsonMatch[1], channel: 'data',
      path: parsedPath.path, filters, optional: filters.some((f) => f.name === 'optional'), errors,
    };
  }

  if (!source) errors.push('变量表达式为空');
  return {
    raw, kind: 'node', syntax: 'legacy', nodeKey: source, channel: 'text', path: [], filters,
    optional: filters.some((f) => f.name === 'optional'), errors,
  };
}

export function parseTemplate(template) {
  const source = String(template ?? '');
  const tokens = [];
  const references = [];
  let cursor = 0; let match;
  const re = new RegExp(TEMPLATE_VAR_RE.source, 'g');
  while ((match = re.exec(source))) {
    if (match.index > cursor) tokens.push({ type: 'text', value: source.slice(cursor, match.index) });
    const expression = parseExpression(match[1]);
    const token = { type: 'variable', raw: match[0], expression, start: match.index, end: re.lastIndex };
    tokens.push(token);
    references.push(token);
    cursor = re.lastIndex;
  }
  if (cursor < source.length) tokens.push({ type: 'text', value: source.slice(cursor) });
  return { source, tokens, references, hasVariables: references.length > 0 };
}

export function safePickPath(value, path) {
  let current = value;
  for (const key of path || []) {
    if (FORBIDDEN_PATH_KEYS.has(String(key)) || current == null || (typeof current !== 'object' && !Array.isArray(current))) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}
