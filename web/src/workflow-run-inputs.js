const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function schemaFields(inputSchema) {
  return Array.isArray(inputSchema?.fields) ? inputSchema.fields.filter((field) => field && typeof field === 'object') : [];
}

export function fieldKey(field) {
  return String(field?.key ?? field?.name ?? '').trim();
}

export function initialRunInputValues(inputSchema) {
  const values = {};
  for (const field of schemaFields(inputSchema)) {
    const key = fieldKey(field);
    if (!key || field.defaultValue === undefined) continue;
    values[key] = structuredClone(field.defaultValue);
  }
  return values;
}

function parseValue(field, value) {
  const type = String(field?.type || 'string').toLowerCase();
  if (type === 'string') return String(value ?? '');
  if (type === 'number') {
    if (value === '' || value === null || value === undefined) return undefined;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (type === 'boolean') return value === true || value === 'true';
  if (type === 'string[]') {
    if (Array.isArray(value)) return value.map(String);
    return String(value ?? '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  if (type === 'object' || type === 'json' || type === 'array') {
    if (typeof value === 'object' && value !== null) return value;
    if (!String(value ?? '').trim()) return undefined;
    try { return JSON.parse(String(value)); } catch { return undefined; }
  }
  return value;
}

export function validateRunInputValues(inputSchema, values = {}) {
  const fields = schemaFields(inputSchema);
  if (!fields.length) return { ok: true, value: isObject(values) ? values : {} };
  const output = {};
  const errors = [];
  const known = new Set();
  for (const field of fields) {
    const key = fieldKey(field);
    if (!key) continue;
    known.add(key);
    const has = Object.prototype.hasOwnProperty.call(values, key) && values[key] !== '' && values[key] !== undefined;
    if (!has) {
      if (field.required === true && field.defaultValue === undefined) errors.push(`${field.label || key}为必填项`);
      if (field.defaultValue !== undefined) output[key] = structuredClone(field.defaultValue);
      continue;
    }
    const parsed = parseValue(field, values[key]);
    const type = String(field.type || 'string').toLowerCase();
    const valid = parsed !== undefined
      && (type === 'number' ? typeof parsed === 'number'
        : type === 'boolean' ? typeof parsed === 'boolean'
          : type === 'string[]' ? Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
            : type === 'object' ? isObject(parsed)
                : type === 'json' ? parsed !== undefined

                : type === 'array' ? Array.isArray(parsed)
                  : type === 'string' ? typeof parsed === 'string' : true);
    if (!valid) {
      errors.push(`${field.label || key}格式不正确`);
      continue;
    }
    if (Array.isArray(field.enum) && !field.enum.includes(parsed)) {
      errors.push(`${field.label || key}不在允许值范围内`);
      continue;
    }
    output[key] = parsed;
  }
  for (const key of Object.keys(values)) {
    if (!known.has(key) && values[key] !== '' && values[key] !== undefined) errors.push(`不支持输入字段：${key}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: output };
}

export function serializeRunInputValues(inputSchema, values = {}) {
  const result = validateRunInputValues(inputSchema, values);
  if (!result.ok) throw new Error(result.errors.join('；'));
  return result.value;
}
