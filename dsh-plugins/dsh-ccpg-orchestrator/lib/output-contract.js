export const RUN_SCHEMA_VERSION = 2;
export const OUTPUT_ENVELOPE_VERSION = 1;

const RESERVED_RESULT_KEYS = new Set([
  'output', 'text', 'data', 'meta', 'structuredOutput', 'structuredOutputs', 'schemaVersion',
  'status', 'chars', 'durationMs', 'error',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

export class OutputContractError extends Error {
  constructor(message, path = '$') {
    super(`${message}（${path}）`);
    this.name = 'OutputContractError';
    this.path = path;
  }
}

export function toJsonSafe(value, path = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OutputContractError('JSON 数据包含非有限数', path);
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    throw new OutputContractError(`JSON 数据包含不可序列化的 ${typeof value}`, path);
  }
  if (typeof value !== 'object') throw new OutputContractError('JSON 数据类型不受支持', path);
  if (seen.has(value)) throw new OutputContractError('JSON 数据包含循环引用', path);
  seen.add(value);
  try {
    if (value instanceof Date) {
      const iso = value.toISOString();
      if (!iso) throw new OutputContractError('日期无法序列化', path);
      return iso;
    }
    if (Array.isArray(value)) return value.map((item, index) => toJsonSafe(item, `${path}[${index}]`, seen));
    const out = {};
    for (const key of Object.keys(value)) out[key] = toJsonSafe(value[key], `${path}.${key}`, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

export function isOutputEnvelope(value) {
  return isObject(value)
    && value.version === OUTPUT_ENVELOPE_VERSION
    && (value.type === 'text' || value.type === 'json')
    && Object.prototype.hasOwnProperty.call(value, 'value');
}

export function createOutputEnvelope(value, options = {}) {
  const type = options.type || (typeof value === 'string' ? 'text' : 'json');
  const schema = options.schema === undefined ? undefined : toJsonSafe(options.schema, '$.schema');
  return {
    version: OUTPUT_ENVELOPE_VERSION,
    type: type === 'json' ? 'json' : 'text',
    ...(options.mediaType ? { mediaType: String(options.mediaType) } : {}),
    value: type === 'json' ? toJsonSafe(value, '$.value') : asText(value),
    ...(schema !== undefined ? { schema } : {}),
  };
}

function resultEnvelope(result, output) {
  if (!isObject(result)) return null;
  if (isOutputEnvelope(result.structuredOutput)) {
    return {
      envelope: createOutputEnvelope(result.structuredOutput.value, result.structuredOutput),
      explicit: true,
    };
  }
  if (isOutputEnvelope(result.output)) {
    return { envelope: createOutputEnvelope(result.output.value, result.output), explicit: true };
  }
  if (Object.prototype.hasOwnProperty.call(result, 'data')) {
    return { envelope: createOutputEnvelope(result.data, { type: 'json', schema: result.schema }), explicit: true };
  }
  if (Object.prototype.hasOwnProperty.call(result, 'text')) {
    return { envelope: createOutputEnvelope(result.text, { type: 'text' }), explicit: true };
  }
  return { envelope: createOutputEnvelope(output, { type: 'text' }), explicit: false };
}

export function normalizeExecutionResult(result, defaults = {}) {
  if (typeof result === 'string' || result == null) {
    const output = asText(result ?? defaults.output ?? '');
    return { output, structuredOutput: createOutputEnvelope(output), extra: {}, explicitEnvelope: false };
  }
  if (!isObject(result)) return normalizeExecutionResult(asText(result), defaults);

  const outputValue = isOutputEnvelope(result.output)
    ? (result.text ?? defaults.output ?? result.output.value)
    : (result.output ?? result.text ?? defaults.output ?? '');
  const output = asText(outputValue);
  const found = resultEnvelope(result, output);
  const extra = {};
  for (const [key, value] of Object.entries(result)) {
    if (!RESERVED_RESULT_KEYS.has(key)) extra[key] = value;
  }
  if (isObject(result.meta)) {
    for (const [key, value] of Object.entries(result.meta)) if (!RESERVED_RESULT_KEYS.has(key)) extra[key] = value;
  }
  return { output, structuredOutput: found.envelope, extra, explicitEnvelope: found.explicit };
}

export function mergeExecutionResults(baseResult, patchResult) {
  const base = baseResult?.structuredOutput ? baseResult : normalizeExecutionResult(baseResult);
  if (patchResult == null) return base;
  const patch = normalizeExecutionResult(patchResult, { output: base.output });
  let structuredOutput = patch.explicitEnvelope ? patch.structuredOutput : base.structuredOutput;
  if (!patch.explicitEnvelope && structuredOutput.type === 'text') {
    structuredOutput = createOutputEnvelope(patch.output, {
      type: 'text', mediaType: structuredOutput.mediaType, schema: structuredOutput.schema,
    });
  }
  return {
    output: patch.output,
    structuredOutput,
    extra: { ...base.extra, ...patch.extra },
    explicitEnvelope: base.explicitEnvelope || patch.explicitEnvelope,
  };
}

const NODE_META_ALLOWLIST = ['status', 'chars', 'durationMs', 'model', 'runtime', 'turns', 'usage', 'writeback', 'approvedBy', 'approvalComment', 'toleratedError'];

export function safeNodeStateMeta(state = {}) {
  return Object.fromEntries(NODE_META_ALLOWLIST.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
}

export function describeNodeOutput(node) {
  const type = node?.type || 'unknown';
  const nodeId = node?.id || '';
  const token = (channel) => `node[${JSON.stringify(nodeId)}].${channel}`;
  const base = {
    nodeId,
    label: node?.data?.label || nodeId,
    type,
    runSchemaVersion: RUN_SCHEMA_VERSION,
    envelopeVersion: OUTPUT_ENVELOPE_VERSION,
    variables: [
      { channel: 'text', token: token('text'), type: 'string', description: '节点的人类可读输出' },
      { channel: 'data', token: token('data'), type: 'any', description: '结构化 envelope 的 value' },
      { channel: 'meta', token: token('meta'), type: 'object', description: '节点运行状态的安全字段' },
    ],
  };
  const data = base.variables[1];
  if (type === 'http') data.fields = ['status', 'ok', 'headers', 'body', 'json'];
  else if (type === 'condition') data.fields = ['branch', 'source', 'include', 'exclude'];
  else if (type === 'input') data.fields = ['text', 'triggerInput', 'upstreamText'];
  else if (type === 'approval') data.fields = ['decision', 'by', 'comment', 'note', 'content'];
  return base;
}
