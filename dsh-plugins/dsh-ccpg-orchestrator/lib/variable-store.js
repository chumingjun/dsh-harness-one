import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const GLOBAL_VARIABLE_DOCUMENT_VERSION = 1;
export const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ALLOWED_VARIABLE_TYPES = new Set(['string', 'number', 'boolean', 'json', 'string[]']);
export const FORBIDDEN_VARIABLE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const ALLOWED_DEFINITION_KEYS = new Set([
  'id', 'key', 'label', 'type', 'description', 'value', 'defaultValue', 'required', 'revision',
]);
const SENSITIVE_KEYS = new Set(['secret', 'sensitive', 'isSecret', 'isSensitive']);
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_COLLECTION_ITEMS = 1000;
const MAX_DEPTH = 20;

export class VariableStoreError extends Error {
  constructor(message, { code = 'invalid-variable', status = 400 } = {}) {
    super(message);
    this.name = 'VariableStoreError';
    this.code = code;
    this.status = status;
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message, options) {
  throw new VariableStoreError(message, options);
}

function assertJsonSafe(value, path = 'value', depth = 0, state = { items: 0 }) {
  if (depth > MAX_DEPTH) fail(`${path} 嵌套层级超过 ${MAX_DEPTH}`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} 必须是有限数字`);
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) fail(`${path} 字符串超过 ${MAX_STRING_BYTES} 字节`);
    return;
  }
  if (Array.isArray(value)) {
    state.items += value.length;
    if (state.items > MAX_COLLECTION_ITEMS) fail(`${path} 项目数超过 ${MAX_COLLECTION_ITEMS}`);
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`, depth + 1, state));
    return;
  }
  if (!isObject(value)) fail(`${path} 必须是 JSON 可安全序列化的值`);
  const keys = Object.keys(value);
  state.items += keys.length;
  if (state.items > MAX_COLLECTION_ITEMS) fail(`${path} 字段数超过 ${MAX_COLLECTION_ITEMS}`);
  for (const key of keys) {
    if (FORBIDDEN_VARIABLE_KEYS.has(key)) fail(`${path} 包含不安全字段 ${key}`);
    assertJsonSafe(value[key], `${path}.${key}`, depth + 1, state);
  }
}

function assertTypedValue(type, value, path) {
  assertJsonSafe(value, path);
  if (type === 'string' && typeof value !== 'string') fail(`${path} 必须是 string`);
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail(`${path} 必须是 number`);
  if (type === 'boolean' && typeof value !== 'boolean') fail(`${path} 必须是 boolean`);
  if (type === 'string[]' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) fail(`${path} 必须是 string[]`);
}

function normalizeText(value, field, maxLength) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${field} 必须是字符串`);
  if (value.length > maxLength) fail(`${field} 最长 ${maxLength} 个字符`);
  return value;
}

function rejectSensitiveDeclaration(source) {
  for (const key of SENSITIVE_KEYS) {
    if (hasOwn(source, key)) fail(`不支持敏感变量字段 ${key}`, { code: 'sensitive-variable-rejected' });
  }
  const type = String(source.type || '').toLowerCase();
  if (type === 'secret' || type === 'credential' || type === 'credentials') {
    fail(`不支持敏感变量类型 ${source.type}`, { code: 'sensitive-variable-rejected' });
  }
}

function normalizeDefinition(source, { partial = false } = {}) {
  if (!isObject(source)) fail('变量定义必须是对象');
  rejectSensitiveDeclaration(source);
  for (const key of Object.keys(source)) {
    if (!ALLOWED_DEFINITION_KEYS.has(key)) fail(`变量定义不支持字段 ${key}`);
  }

  const result = {};
  if (!partial || hasOwn(source, 'key')) {
    if (typeof source.key !== 'string' || !VARIABLE_KEY_RE.test(source.key) || FORBIDDEN_VARIABLE_KEYS.has(source.key)) {
      fail('key 必须是安全的 ASCII 标识符（字母或下划线开头，最长 64）', { code: 'invalid-variable-key' });
    }
    result.key = source.key;
  }
  if (!partial || hasOwn(source, 'type')) {
    if (!ALLOWED_VARIABLE_TYPES.has(source.type)) fail(`type 仅支持 ${[...ALLOWED_VARIABLE_TYPES].join(', ')}`);
    result.type = source.type;
  }
  if (hasOwn(source, 'id')) {
    if (typeof source.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(source.id)) fail('id 格式无效');
    result.id = source.id;
  }
  if (hasOwn(source, 'label')) result.label = normalizeText(source.label, 'label', 120);
  if (hasOwn(source, 'description')) result.description = normalizeText(source.description, 'description', 1000);
  if (hasOwn(source, 'required')) {
    if (typeof source.required !== 'boolean') fail('required 必须是 boolean');
    result.required = source.required;
  }
  if (hasOwn(source, 'revision')) {
    if (!Number.isInteger(source.revision) || source.revision < 0) fail('revision 必须是非负整数');
    result.revision = source.revision;
  }
  const type = result.type || source.type;
  for (const field of ['value', 'defaultValue']) {
    if (!hasOwn(source, field)) continue;
    assertTypedValue(type, source[field], field);
    result[field] = structuredClone(source[field]);
  }
  return result;
}

function normalizeDocument(value) {
  if (!isObject(value)) fail('全局变量文件必须是对象', { code: 'invalid-variable-document', status: 500 });
  const revision = value.revision === undefined ? 0 : value.revision;
  if (!Number.isInteger(revision) || revision < 0 || !Array.isArray(value.variables)) {
    fail('全局变量文件格式无效', { code: 'invalid-variable-document', status: 500 });
  }
  const variables = value.variables.map((entry) => {
    const normalized = normalizeDefinition(entry);
    if (!normalized.id) fail('全局变量文件缺少变量 id', { code: 'invalid-variable-document', status: 500 });
    return normalized;
  });
  const keys = new Set();
  const ids = new Set();
  for (const entry of variables) {
    if (keys.has(entry.key) || ids.has(entry.id)) fail('全局变量文件包含重复 id/key', { code: 'invalid-variable-document', status: 500 });
    keys.add(entry.key); ids.add(entry.id);
  }
  return { version: GLOBAL_VARIABLE_DOCUMENT_VERSION, revision, variables };
}

function cloneDocument(document) {
  return structuredClone(document);
}

export class GlobalVariableStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read() {
    if (!existsSync(this.filePath)) return { version: GLOBAL_VARIABLE_DOCUMENT_VERSION, revision: 0, variables: [] };
    const raw = readFileSync(this.filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) fail('全局变量文件过大', { code: 'invalid-variable-document', status: 500 });
    try { return cloneDocument(normalizeDocument(JSON.parse(raw))); }
    catch (error) {
      if (error instanceof VariableStoreError) throw error;
      fail('全局变量文件不是有效 JSON', { code: 'invalid-variable-document', status: 500 });
    }
  }

  add(source, { expectedRevision } = {}) {
    const document = this.read();
    this.assertRevision(document, expectedRevision);
    const definition = normalizeDefinition(source);
    if (document.variables.some((entry) => entry.key === definition.key)) fail(`变量 key 已存在：${definition.key}`, { code: 'duplicate-variable-key', status: 409 });
    if (definition.id && document.variables.some((entry) => entry.id === definition.id)) fail(`变量 id 已存在：${definition.id}`, { code: 'duplicate-variable-id', status: 409 });
    const revision = document.revision + 1;
    const variable = { ...definition, id: definition.id || `var_${randomUUID()}`, revision };
    const next = { version: GLOBAL_VARIABLE_DOCUMENT_VERSION, revision, variables: [...document.variables, variable] };
    this.write(next);
    return { document: cloneDocument(next), variable: structuredClone(variable) };
  }

  update(selector, changes, { expectedRevision } = {}) {
    const document = this.read();
    this.assertRevision(document, expectedRevision);
    const index = this.findIndex(document, selector);
    if (index < 0) fail('全局变量不存在', { code: 'variable-not-found', status: 404 });
    const patch = normalizeDefinition(changes, { partial: true });
    delete patch.id;
    delete patch.revision;
    if (hasOwn(patch, 'key') && patch.key !== document.variables[index].key) {
      fail('变量 key 不可直接修改，请使用引用重构操作', { code: 'variable-key-immutable', status: 409 });
    }
    const revision = document.revision + 1;
    const variable = { ...document.variables[index], ...patch, revision };
    if (patch.type && patch.type !== document.variables[index].type) {
      if (!hasOwn(patch, 'value')) delete variable.value;
      if (!hasOwn(patch, 'defaultValue')) delete variable.defaultValue;
    }
    for (const field of ['value', 'defaultValue']) {
      if (hasOwn(variable, field)) assertTypedValue(variable.type, variable[field], field);
    }
    if (document.variables.some((entry, i) => i !== index && entry.key === variable.key)) fail(`变量 key 已存在：${variable.key}`, { code: 'duplicate-variable-key', status: 409 });
    const variables = [...document.variables]; variables[index] = variable;
    const next = { version: GLOBAL_VARIABLE_DOCUMENT_VERSION, revision, variables };
    this.write(next);
    return { document: cloneDocument(next), variable: structuredClone(variable) };
  }

  delete(selector, { expectedRevision } = {}) {
    const document = this.read();
    this.assertRevision(document, expectedRevision);
    const index = this.findIndex(document, selector);
    if (index < 0) fail('全局变量不存在', { code: 'variable-not-found', status: 404 });
    const [variable] = document.variables.splice(index, 1);
    const next = { version: GLOBAL_VARIABLE_DOCUMENT_VERSION, revision: document.revision + 1, variables: document.variables };
    this.write(next);
    return { document: cloneDocument(next), variable: structuredClone(variable) };
  }

  findIndex(document, selector) {
    if (!isObject(selector) || (!selector.id && !selector.key)) fail('需要 id 或 key');
    return document.variables.findIndex((entry) => (selector.id && entry.id === selector.id) || (selector.key && entry.key === selector.key));
  }

  assertRevision(document, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null) return;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('expectedRevision 必须是非负整数');
    if (expectedRevision !== document.revision) {
      fail(`变量文档版本冲突：当前 ${document.revision}，请求 ${expectedRevision}`, { code: 'revision-conflict', status: 409 });
    }
  }

  write(document) {
    const normalized = normalizeDocument(document);
    const data = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(data, 'utf8') > MAX_DOCUMENT_BYTES) fail('全局变量文件超过大小上限');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      try { unlinkSync(tmp); } catch { /* no temp file */ }
      throw error;
    }
  }
}

export function variableDefinitionsToValues(definitions) {
  const values = Object.create(null);
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (!isObject(definition) || typeof definition.key !== 'string' || FORBIDDEN_VARIABLE_KEYS.has(definition.key)) continue;
    rejectSensitiveDeclaration(definition);
    if (hasOwn(definition, 'value')) values[definition.key] = structuredClone(definition.value);
    else if (hasOwn(definition, 'defaultValue')) values[definition.key] = structuredClone(definition.defaultValue);
  }
  return values;
}

export function assertNonSensitiveVariableDefinitions(definitions, name = '变量定义') {
  if (!Array.isArray(definitions)) fail(`${name}必须是数组`);
  const keys = new Set();
  const ids = new Set();
  for (const definition of definitions) {
    if (!isObject(definition)) fail(`${name}中的每一项都必须是对象`);
    rejectSensitiveDeclaration(definition);
    for (const key of Object.keys(definition)) {
      if (!ALLOWED_DEFINITION_KEYS.has(key)) fail(`${name}不支持字段 ${key}`);
    }
    assertJsonSafe(definition, name);
    if (typeof definition.key !== 'string' || !VARIABLE_KEY_RE.test(definition.key) || FORBIDDEN_VARIABLE_KEYS.has(definition.key)) {
      fail(`${name}中的 key 必须是安全的 ASCII 标识符`, { code: 'invalid-variable-key' });
    }
    if (!ALLOWED_VARIABLE_TYPES.has(definition.type)) {
      fail(`${name}中的 type 仅支持 ${[...ALLOWED_VARIABLE_TYPES].join(', ')}`);
    }
    if (keys.has(definition.key)) fail(`${name}包含重复 key：${definition.key}`, { code: 'duplicate-variable-key', status: 409 });
    keys.add(definition.key);
    if (definition.id !== undefined) {
      if (typeof definition.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(definition.id)) fail(`${name}中的 id 格式无效`);
      if (ids.has(definition.id)) fail(`${name}包含重复 id：${definition.id}`, { code: 'duplicate-variable-id', status: 409 });
      ids.add(definition.id);
    }
    for (const field of ['value', 'defaultValue']) {
      if (hasOwn(definition, field)) assertTypedValue(definition.type, definition[field], `${name}.${definition.key}.${field}`);
    }
  }
  return definitions;
}

export function assertSafeContextObject(value, name = 'context') {
  if (value === undefined) return {};
  if (!isObject(value)) fail(`${name} 必须是对象`);
  assertJsonSafe(value, name);
  return structuredClone(value);
}
