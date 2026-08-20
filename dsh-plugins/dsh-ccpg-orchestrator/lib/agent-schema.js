import Ajv from 'ajv';
import { createOutputEnvelope } from './output-contract.js';

const DEFAULT_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', description: '智能体的主要结果' },
  },
  required: ['result'],
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true, strict: false });

export class StructuredOutputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StructuredOutputError';
    this.details = details;
  }
}

export function getAgentOutputConfig(data = {}) {
  const mode = data.outputMode === 'structured' ? 'structured' : 'text';
  if (mode === 'text') return { mode, schema: null };

  const schema = parseSchema(data.outputSchema ?? DEFAULT_SCHEMA);
  validateSchemaDefinition(schema);
  return { mode, schema };
}

export function structuredOutputInstruction(schema) {
  return [
    '你必须只返回一个符合以下 JSON Schema 的 JSON 值。',
    '不要使用 Markdown 代码块，不要添加解释、前后缀或额外字段。',
    '所有 required 字段都必须提供，类型必须严格匹配。',
    `JSON Schema:\n${JSON.stringify(schema, null, 2)}`,
  ].join('\n');
}

export function validateStructuredOutput(rawText, schema) {
  const extracted = extractJsonValue(rawText);
  if (!extracted.ok) {
    throw new StructuredOutputError('模型输出中未找到有效 JSON', {
      kind: 'extract',
      raw: String(rawText ?? ''),
      errors: [extracted.error],
    });
  }

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new StructuredOutputError(`JSON Schema 无法编译：${error.message}`, {
      kind: 'schema',
      errors: [String(error.message || error)],
    });
  }

  if (!validate(extracted.value)) {
    const errors = formatAjvErrors(validate.errors);
    throw new StructuredOutputError(`结构化输出校验失败：${errors.join('；')}`, {
      kind: 'validation',
      raw: String(rawText ?? ''),
      data: extracted.value,
      errors,
    });
  }

  return {
    data: extracted.value,
    raw: String(rawText ?? ''),
    json: extracted.json,
  };
}

export async function validateStructuredOutputWithRepair(rawText, schema, repair) {
  try {
    const result = validateStructuredOutput(rawText, schema);
    return { result, repaired: false };
  } catch (firstError) {
    const repairText = await repair(structuredRepairPrompt({
      schema,
      raw: firstError.details?.raw ?? rawText,
      errors: firstError.details?.errors,
    }), firstError);
    const result = validateStructuredOutput(repairText, schema);
    return { result, repaired: true };
  }
}

export function structuredRepairPrompt({ schema, raw, errors = [] }) {
  return [
    '上一条回复不是有效的结构化输出。请修复后重新返回。',
    `问题：${errors.length ? errors.join('；') : 'JSON 提取或 Schema 校验失败'}`,
    '只返回修复后的 JSON 值，不要使用 Markdown 代码块，不要解释。',
    `JSON Schema:\n${JSON.stringify(schema, null, 2)}`,
    `上一条回复：\n${String(raw ?? '').slice(0, 12000)}`,
  ].join('\n\n');
}

export function createStructuredEnvelope(result, { schema } = {}) {
  return createOutputEnvelope(result.data, {
    type: 'json',
    mediaType: 'application/json',
    schema: schema || undefined,
  });
}

export function createStructuredFailureEnvelope(error, { repaired = false } = {}) {
  const details = error instanceof StructuredOutputError ? error.details : {};
  return {
    ok: false,
    mode: 'structured',
    repaired,
    validationErrors: Array.isArray(details.errors) ? details.errors : [String(error.message || error)],
  };
}

export function readableStructuredOutput(data) {
  return JSON.stringify(data, null, 2);
}

export function extractJsonValue(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return { ok: false, error: '输出为空' };

  const direct = tryParse(text);
  if (direct.ok) return direct;

  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fences) {
    const parsed = tryParse(match[1].trim());
    if (parsed.ok) return parsed;
  }

  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== '{' && opener !== '[') continue;
    const candidate = balancedJsonSlice(text, start);
    if (!candidate) continue;
    const parsed = tryParse(candidate);
    if (parsed.ok) return parsed;
  }

  return { ok: false, error: '未找到可解析的 JSON 值' };
}

function parseSchema(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      throw new StructuredOutputError(`JSON Schema 文本无效：${error.message}`, {
        kind: 'schema',
        errors: [String(error.message || error)],
      });
    }
  }
  throw new StructuredOutputError('结构化模式需要有效的 JSON Schema 对象', {
    kind: 'schema',
    errors: ['Schema 必须是 JSON 对象'],
  });
}

function validateSchemaDefinition(schema) {
  try {
    const valid = ajv.validateSchema(schema);
    if (!valid) {
      const errors = formatAjvErrors(ajv.errors);
      throw new StructuredOutputError(`JSON Schema 定义无效：${errors.join('；')}`, {
        kind: 'schema',
        errors,
      });
    }
    ajv.compile(schema);
  } catch (error) {
    if (error instanceof StructuredOutputError) throw error;
    throw new StructuredOutputError(`JSON Schema 定义无效：${error.message}`, {
      kind: 'schema',
      errors: [String(error.message || error)],
    });
  }
}

function tryParse(json) {
  try {
    return { ok: true, value: JSON.parse(json), json };
  } catch {
    return { ok: false };
  }
}

function balancedJsonSlice(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function formatAjvErrors(errors = []) {
  return errors.map((error) => {
    const path = error.instancePath || '/';
    if (error.keyword === 'required') return `${path} 缺少必填字段 ${error.params.missingProperty}`;
    if (error.keyword === 'additionalProperties') return `${path} 不允许字段 ${error.params.additionalProperty}`;
    return `${path} ${error.message || error.keyword}`;
  });
}
