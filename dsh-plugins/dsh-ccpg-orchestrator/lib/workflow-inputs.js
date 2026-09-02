// 命名工作流运行输入校验（列表启动 / 画布命名工作流运行 / 助手 workflow_run 共用）：
// 按 inputSchema.fields 校验 required、defaultValue、类型与未知字段，返回 toJsonSafe 后的运行输入。
// 空 schema 允许任意普通 JSON 对象；有字段声明时拒绝未知字段。
import { toJsonSafe } from './output-contract.js';

export class WorkflowInputError extends Error {
  constructor(message, code = 'WORKFLOW_INPUT_INVALID') {
    super(message);
    this.name = 'WorkflowInputError';
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateWorkflowInputs(runInputs, inputSchema = {}, { label = '工作流' } = {}) {
  if (!isObject(runInputs)) throw new WorkflowInputError(`${label} runInputs 必须是对象`, 'WORKFLOW_INPUT_INVALID');
  const fields = Array.isArray(inputSchema?.fields) ? inputSchema.fields : [];
  const known = new Set();
  const output = { ...runInputs };
  for (const field of fields) {
    const key = String(field?.key ?? field?.name ?? '').trim();
    if (!key) continue;
    known.add(key);
    const has = Object.prototype.hasOwnProperty.call(output, key);
    if (!has && field.required === true && field.defaultValue === undefined) {
      throw new WorkflowInputError(`${label}缺少必填输入：${key}`, 'WORKFLOW_INPUT_REQUIRED');
    }
    if (!has && field.defaultValue !== undefined) output[key] = structuredClone(field.defaultValue);
    if (!Object.prototype.hasOwnProperty.call(output, key)) continue;
    const value = output[key];
    const type = String(field.type || 'json');
    const valid = type === 'string' ? typeof value === 'string'
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'boolean' ? typeof value === 'boolean'
          : type === 'string[]' ? Array.isArray(value) && value.every((item) => typeof item === 'string')
            : type === 'object' ? isObject(value)
              : type === 'json' ? value !== undefined
                : type === 'array' ? Array.isArray(value)
                : true;
    if (!valid) throw new WorkflowInputError(`${label}输入 ${key} 类型不匹配：需要 ${type}`, 'WORKFLOW_INPUT_TYPE');
    if (Array.isArray(field.enum) && !field.enum.includes(value)) {
      throw new WorkflowInputError(`${label}输入 ${key} 不在允许值范围内`, 'WORKFLOW_INPUT_ENUM');
    }
  }
  for (const key of Object.keys(output)) {
    if (known.has(key)) continue;
    if (fields.length) throw new WorkflowInputError(`${label}不支持输入字段：${key}`, 'WORKFLOW_INPUT_UNKNOWN');
  }
  return toJsonSafe(output, '$.runInputs');
}
