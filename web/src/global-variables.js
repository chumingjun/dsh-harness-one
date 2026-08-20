import { apiUrl } from './api.js';

export const GLOBAL_VARIABLE_TYPES = [
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔值' },
  { value: 'json', label: 'JSON' },
  { value: 'string[]', label: '文本数组' },
];

export const EMPTY_GLOBAL_VARIABLE_DRAFT = {
  key: '',
  label: '',
  type: 'string',
  description: '',
  valueText: '',
};

export class GlobalVariableApiError extends Error {
  constructor(message, { status = 0, code = 'request-failed', payload } = {}) {
    super(message);
    this.name = 'GlobalVariableApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export function variableToken(key, scope = 'global') {
  const prefix = scope === 'workflow' ? 'vars.workflow' : scope === 'input' ? 'inputs' : 'vars.global';
  return `${prefix}[${JSON.stringify(String(key))}]`;
}

export function valueToEditorText(type, value) {
  if (value === undefined || value === null) return '';
  if (type === 'json') return JSON.stringify(value, null, 2);
  if (type === 'string[]') return Array.isArray(value) ? value.join('\n') : '';
  return String(value);
}

export function variableToDraft(variable) {
  const value = Object.prototype.hasOwnProperty.call(variable || {}, 'value')
    ? variable.value
    : variable?.defaultValue;
  return {
    key: variable?.key || '',
    label: variable?.label || '',
    type: variable?.type || 'string',
    description: variable?.description || '',
    valueText: valueToEditorText(variable?.type, value),
  };
}

export function parseEditorValue(type, text) {
  if (type === 'string') return String(text ?? '');
  if (type === 'number') {
    const source = String(text ?? '').trim();
    if (!source) throw new Error('请输入数字');
    const value = Number(source);
    if (!Number.isFinite(value)) throw new Error('必须是有限数字');
    return value;
  }
  if (type === 'boolean') {
    if (text === true || text === 'true') return true;
    if (text === false || text === 'false') return false;
    throw new Error('请选择 true 或 false');
  }
  if (type === 'json') {
    const source = String(text ?? '').trim();
    if (!source) throw new Error('请输入有效 JSON');
    try { return JSON.parse(source); }
    catch (error) { throw new Error(`JSON 格式错误：${error.message}`); }
  }
  if (type === 'string[]') {
    return String(text ?? '').split('\n').map((item) => item.trim()).filter(Boolean);
  }
  throw new Error(`不支持的变量类型：${type}`);
}

export function draftToVariable(draft) {
  const key = String(draft?.key || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
    throw new Error('Key 需以字母或下划线开头，只能包含字母、数字和下划线');
  }
  return {
    key,
    label: String(draft?.label || '').trim(),
    type: draft?.type || 'string',
    description: String(draft?.description || '').trim(),
    value: parseEditorValue(draft?.type || 'string', draft?.valueText),
  };
}

async function request(path, options) {
  const response = await fetch(apiUrl(path), options);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text || '{}'); }
  catch { payload = { error: `接口返回了非 JSON 内容（HTTP ${response.status}）` }; }
  if (!response.ok) {
    throw new GlobalVariableApiError(payload.error || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      code: payload.code,
      payload,
    });
  }
  return payload;
}

export function loadGlobalVariables() {
  return request('/global-variables');
}

export function createGlobalVariable(variable, expectedRevision) {
  return request('/global-variables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision, variable }),
  });
}

export function updateGlobalVariable(id, changes, expectedRevision) {
  return request('/global-variables', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, expectedRevision, changes }),
  });
}

export function deleteGlobalVariable(id, expectedRevision) {
  return request('/global-variables', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, expectedRevision }),
  });
}
