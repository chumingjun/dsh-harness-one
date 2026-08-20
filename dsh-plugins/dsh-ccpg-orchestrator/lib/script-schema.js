import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

function parseSchema(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      throw new Error(`JSON Schema 文本无效：${error.message}`);
    }
  }
  throw new Error('输出 Schema 必须是 JSON 对象');
}

function formatErrors(errors = []) {
  return errors.map((error) => {
    const path = error.instancePath || '/';
    if (error.keyword === 'required') return `${path} 缺少必填字段 ${error.params.missingProperty}`;
    if (error.keyword === 'additionalProperties') return `${path} 不允许字段 ${error.params.additionalProperty}`;
    return `${path} ${error.message || error.keyword}`;
  });
}

export function getScriptOutputSchema(value) {
  const schema = parseSchema(value);
  if (!schema) return null;
  if (!ajv.validateSchema(schema)) throw new Error(`JSON Schema 定义无效：${formatErrors(ajv.errors).join('；')}`);
  try { ajv.compile(schema); }
  catch (error) { throw new Error(`JSON Schema 无法编译：${error.message}`); }
  return schema;
}

export function validateScriptOutput(value, schemaValue) {
  const schema = getScriptOutputSchema(schemaValue);
  if (!schema) return null;
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`脚本 JSON 输出校验失败：${formatErrors(validate.errors).join('；')}`);
  return schema;
}
