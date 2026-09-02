import { parseTemplate } from './template-parser.js';
import { resolveTypedExpression } from './typed-expression.js';
import { toJsonSafe, normalizeExecutionResult } from './output-contract.js';

export const MAX_SUBWORKFLOW_DEPTH = 3;
export const MAX_CHILD_RUNS_PER_ROOT = 16;

export class SubworkflowError extends Error {
  constructor(message, code = 'SUBWORKFLOW_ERROR') {
    super(message);
    this.name = 'SubworkflowError';
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function expressionTemplate(value) {
  const source = String(value || '').trim();
  if (!source) throw new SubworkflowError('子工作流输入引用不能为空', 'SUBWORKFLOW_INPUT_EXPRESSION');
  return source.includes('{{') ? source : `{{${source}}}`;
}

export function resolveSubworkflowValue(value, ctx, render) {
  if (isObject(value) && typeof value.$ref === 'string') {
    try { return resolveTypedExpression(expressionTemplate(value.$ref), ctx); }
    catch (error) {
      const wrapped = new SubworkflowError(error.message, 'SUBWORKFLOW_INPUT_MISSING');
      wrapped.cause = error;
      throw wrapped;
    }
  }
  if (typeof value === 'string') {
    if (value.trim() === '$upstream') return render('{{$upstream}}', { implicitUpstream: true }).text;
    const parsed = parseTemplate(value);
    if (parsed.tokens.length === 1 && parsed.tokens[0].type === 'variable') {
      try { return resolveTypedExpression(value, ctx); }
      catch (error) {
        const wrapped = new SubworkflowError(error.message, 'SUBWORKFLOW_INPUT_MISSING');
        wrapped.cause = error;
        throw wrapped;
      }
    }
    return render(value, { implicitUpstream: false }).text;
  }
  if (Array.isArray(value)) return value.map((item) => resolveSubworkflowValue(item, ctx, render));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSubworkflowValue(item, ctx, render)]));
  return value;
}

export function resolveSubworkflowInputs(data, ctx, render) {
  const map = isObject(data?.inputMap) ? data.inputMap : {};
  const triggerSource = map.triggerInput === undefined ? '$upstream' : map.triggerInput;
  const triggerInput = resolveSubworkflowValue(triggerSource, ctx, render);
  const runInputsSource = map.runInputs === undefined ? {} : map.runInputs;
  const runInputs = resolveSubworkflowValue(runInputsSource, ctx, render);
  if (!isObject(runInputs)) throw new SubworkflowError('子工作流 runInputs 必须是对象', 'SUBWORKFLOW_INVALID_INPUT');
  return { triggerInput, runInputs: toJsonSafe(runInputs, '$.runInputs') };
}

function outputNodeIds(run) {
  return (run.graph?.nodes || []).filter((node) => (node.type || node.data?.nodeType) === 'output').map((node) => node.id);
}

export function selectWorkflowResult(run) {
  const outputs = run?.outputs || {};
  const structured = run?.structuredOutputs || {};
  const states = run?.nodeStates || {};
  const ids = outputNodeIds(run);
  const candidates = ids.length ? ids : [...(run?.nodeOrder || []), ...Object.keys(states)];
  const selected = candidates.filter((id) => states[id]?.status === 'success' && Object.prototype.hasOwnProperty.call(outputs, id));
  const idsToUse = ids.length ? selected : selected.slice(-1);
  const text = idsToUse.map((id) => String(outputs[id] ?? '')).filter(Boolean).join('\n\n');
  const firstId = idsToUse.at(-1);
  const envelope = firstId && structured[firstId]
    ? structured[firstId]
    : normalizeExecutionResult(text).structuredOutput;
  const artifacts = idsToUse.flatMap((id) => Array.isArray(states[id]?.artifacts) ? states[id].artifacts : []);
  return {
    output: text,
    structuredOutput: envelope,
    artifacts: [...new Set(artifacts)],
    sourceNodeIds: idsToUse,
  };
}

export function validateWorkflowInputs(runInputs, inputSchema = {}, { label = '工作流' } = {}) {
  if (!isObject(runInputs)) throw new SubworkflowError(`${label} runInputs 必须是对象`, 'WORKFLOW_INPUT_INVALID');
  const fields = Array.isArray(inputSchema?.fields) ? inputSchema.fields : [];
  const known = new Set();
  const output = { ...runInputs };
  for (const field of fields) {
    const key = String(field?.key ?? field?.name ?? '').trim();
    if (!key) continue;
    known.add(key);
    const has = Object.prototype.hasOwnProperty.call(output, key);
    if (!has && field.required === true && field.defaultValue === undefined) {
      throw new SubworkflowError(`${label}缺少必填输入：${key}`, 'WORKFLOW_INPUT_REQUIRED');
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
    if (!valid) throw new SubworkflowError(`${label}输入 ${key} 类型不匹配：需要 ${type}`, 'WORKFLOW_INPUT_TYPE');
    if (Array.isArray(field.enum) && !field.enum.includes(value)) {
      throw new SubworkflowError(`${label}输入 ${key} 不在允许值范围内`, 'WORKFLOW_INPUT_ENUM');
    }
  }
  for (const key of Object.keys(output)) {
    if (known.has(key)) continue;
    if (fields.length) throw new SubworkflowError(`${label}不支持输入字段：${key}`, 'WORKFLOW_INPUT_UNKNOWN');
  }
  return toJsonSafe(output, '$.runInputs');
}

export function validateSubworkflowInputs(runInputs, inputSchema = {}) {
  try {
    return validateWorkflowInputs(runInputs, inputSchema, { label: '子工作流' });
  } catch (error) {
    const code = String(error.code || '');
    if (code.startsWith('WORKFLOW_INPUT_')) error.code = code.replace(/^WORKFLOW_INPUT_/, 'SUBWORKFLOW_INPUT_');
    throw error;
  }
}

/**
 * 收集需要模板静态检查的字段：triggerInput 与 runInputs 内所有字符串叶。
 * $ref 值按运行时语义包成 {{...}} 再交给 validateTemplate，让语法错误在
 * lint 阶段就暴露（而不是运行时输入解析才炸）。
 */
export function subworkflowTemplateFields(data = {}) {
  const map = isObject(data.inputMap) ? data.inputMap : {};
  const fields = [];
  if (typeof map.triggerInput === 'string' && map.triggerInput.trim()) fields.push(map.triggerInput);
  const walk = (value) => {
    if (typeof value === 'string') { fields.push(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (isObject(value)) {
      if (typeof value.$ref === 'string') {
        try { fields.push(expressionTemplate(value.$ref)); } catch { /* 空引用由运行时校验兜底 */ }
        return;
      }
      Object.values(value).forEach(walk);
    }
  };
  if (map.runInputs !== undefined) walk(map.runInputs);
  return fields;
}

export function validateSubworkflowNode(node, lintCtx = {}) {
  const issues = [];
  const label = node?.data?.label || node?.id || '子工作流';
  const workflowId = String(node?.data?.workflowId || '').trim();
  if (!workflowId) issues.push({ level: 'error', code: 'SUBWORKFLOW_WORKFLOW_REQUIRED', message: `子工作流「${label}」未选择目标工作流` });
  if (node?.data?.waitForCompletion === false) {
    issues.push({ level: 'error', code: 'SUBWORKFLOW_ASYNC_UNSUPPORTED', message: `子工作流「${label}」首期只支持等待完成模式` });
  }
  if (Number(node?.data?.retryCount) > 0) {
    issues.push({ level: 'error', code: 'SUBWORKFLOW_RETRY_UNSUPPORTED', message: `子工作流「${label}」首期不支持重试，避免重复执行子运行` });
  }
  if (node?.data?.inputMap !== undefined && !isObject(node.data.inputMap)) {
    issues.push({ level: 'error', code: 'SUBWORKFLOW_INPUT_MAP', message: `子工作流「${label}」输入映射必须是对象` });
  }
  // 宿主经 resolveTargetWorkflow 注入库查询（engine 自身不读库）：目标不存在或
  // inputSchema 字段名错配都在画布 lint 直接报，不留到运行时。
  const canResolve = typeof lintCtx.resolveTargetWorkflow === 'function';
  const target = canResolve && workflowId ? lintCtx.resolveTargetWorkflow(workflowId) : undefined;
  if (canResolve && workflowId && !target) {
    issues.push({ level: 'error', code: 'SUBWORKFLOW_NOT_FOUND', message: `子工作流「${label}」引用的工作流不存在：${workflowId}` });
  }
  const targetInputSchema = target?.inputSchema ?? lintCtx.targetInputSchema;
  const knownFields = Array.isArray(targetInputSchema?.fields)
    ? new Set(targetInputSchema.fields.map((field) => String(field?.key ?? field?.name ?? '').trim()).filter(Boolean))
    : null;
  if (knownFields && isObject(node?.data?.inputMap?.runInputs)) {
    for (const key of Object.keys(node.data.inputMap.runInputs)) {
      if (!knownFields.has(key)) issues.push({ level: 'error', code: 'SUBWORKFLOW_INPUT_UNKNOWN', message: `子工作流「${label}」不支持输入字段：${key}` });
    }
  }
  return issues;
}
