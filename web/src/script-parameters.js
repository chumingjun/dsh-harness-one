export function normalizeScriptInputs(inputs) {
  if (!Array.isArray(inputs)) return [];
  return inputs.map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    const name = typeof source.name === 'string' ? source.name : '';
    if (Object.prototype.hasOwnProperty.call(source, 'expression')) {
      return { name, expression: typeof source.expression === 'string' ? source.expression : '' };
    }
    return { name, value: Object.prototype.hasOwnProperty.call(source, 'value') ? source.value : null };
  });
}

export function validateScriptInputs(inputs) {
  const normalized = normalizeScriptInputs(inputs);
  const names = new Map();
  return normalized.map((item, index) => {
    const name = item.name.trim();
    let error = '';
    if (!name) error = '参数名不能为空';
    else if (!/^[A-Za-z_$][\w$]*$/.test(name)) error = '参数名必须是有效的 JavaScript 标识符';
    else if (['__proto__', 'prototype', 'constructor'].includes(name)) error = '参数名不安全';
    else if (names.has(name)) error = `参数名与第 ${names.get(name) + 1} 行重复`;
    else names.set(name, index);
    return error;
  });
}

export function parseScriptConstant(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function formatScriptConstant(value) {
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? 'null' : formatted;
}
