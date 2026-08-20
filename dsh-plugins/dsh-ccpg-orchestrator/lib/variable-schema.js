import { safeNodeStateMeta } from './output-contract.js';

const objectSchema = (properties, description = '') => ({ type: 'object', description, properties });
const arraySchema = (items, description = '') => ({ type: 'array', description, items });
const field = (type, description, extra = {}) => ({ type, description, ...extra });

const STATIC_DATA_SCHEMAS = {
  http: objectSchema({
    status: field('number', 'HTTP 状态码'), ok: field('boolean', '是否为 2xx 响应'),
    headers: objectSchema({}, '已过滤敏感字段的响应头'), body: field('string', '响应体文本'),
    json: field('any', '解析后的 JSON 响应体'), url: field('string', '最终请求 URL'),
    method: field('string', 'HTTP 方法'), truncated: field('boolean', '响应是否被截断'),
  }),
  condition: objectSchema({
    branch: field('string', '命中的分支', { enum: ['true', 'false'] }), source: field('string', '判定文本'),
    include: arraySchema(field('string', '包含关键词'), '包含关键词'), exclude: arraySchema(field('string', '排除关键词'), '排除关键词'),
  }),
  input: objectSchema({
    text: field('string', '输入节点配置文本'), triggerInput: field('string', '本次触发输入'), upstreamText: field('string', '直接上游拼接文本'),
  }),
  approval: objectSchema({
    decision: field('string', '审批决定', { enum: ['approve', 'reject'] }), by: field('string', '审批人'),
    comment: field('string', '审批意见'), note: field('string', '审批说明'), content: field('string', '审批内容'),
  }),
};

const META_SCHEMA = objectSchema({
  status: field('string', '节点执行状态'), chars: field('number', '文本输出字符数'), durationMs: field('number', '执行耗时（毫秒）'),
  model: field('string', '使用的模型'), runtime: field('string', '执行运行时'), turns: field('number', '智能体轮数'),
  usage: objectSchema({}, 'Token 用量'), writeback: field('any', '输出写回结果'), approvedBy: field('string', '审批人'),
  approvalComment: field('string', '审批意见'), toleratedError: field('string', '容错继续的错误'),
});

function inferType(value, fallback = 'any') {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value !== undefined) return typeof value === 'object' ? 'object' : typeof value;
  if (Array.isArray(fallback)) return fallback.join('|');
  return fallback || 'any';
}

export function appendCanonicalPath(token, key) {
  if (typeof key === 'number' || /^\d+$/.test(String(key))) return `${token}[${Number(key)}]`;
  const value = String(key);
  return /^[A-Za-z_$][\w$]*$/.test(value) ? `${token}.${value}` : `${token}[${JSON.stringify(value)}]`;
}

function item({ id, label, token, type, description = '', recentValue, hasValue, children = [], nodeId, source = 'node', enumValues }) {
  return {
    id, label, token, type, description, recentValue, hasValue, children, nodeId, source,
    ...(enumValues?.length ? { enum: enumValues } : {}),
  };
}

function parseAgentSchema(node) {
  if (node.type !== 'agent' || node.data?.outputMode !== 'structured') return null;
  let schema = node.data?.outputSchema;
  if (typeof schema === 'string') { try { schema = JSON.parse(schema); } catch { return null; } }
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
}

function schemaType(schema, value) {
  const declared = Array.isArray(schema?.type) ? schema.type.find((type) => type !== 'null') : schema?.type;
  return inferType(value, declared || (schema?.properties ? 'object' : schema?.items ? 'array' : 'any'));
}

function buildChildren(schema, value, token, nodeId, state, depth) {
  if (depth >= state.maxDepth || state.count >= state.maxItems) return [];
  const isArray = schema?.type === 'array' || Array.isArray(value);
  if (isArray) {
    const values = Array.isArray(value) ? value : [];
    const indexes = values.length ? values.map((_entry, index) => index) : (schema?.items ? [0] : []);
    return indexes.slice(0, 12).map((index) => {
      state.count += 1;
      const childValue = values[index];
      const childSchema = schema?.items || {};
      const childToken = appendCanonicalPath(token, index);
      return item({
        id: `${nodeId}:${childToken}`, label: `[${index}]`, token: childToken,
        type: schemaType(childSchema, childValue), description: childSchema.description || '数组元素',
        recentValue: childValue, hasValue: index < values.length, nodeId,
        enumValues: childSchema.enum,
        children: buildChildren(childSchema, childValue, childToken, nodeId, state, depth + 1),
      });
    });
  }

  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const dynamic = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const keys = [...new Set([...Object.keys(properties), ...Object.keys(dynamic)])];
  return keys.slice(0, Math.max(0, state.maxItems - state.count)).map((key) => {
    state.count += 1;
    const childSchema = properties[key] || {};
    const childValue = dynamic[key];
    const childToken = appendCanonicalPath(token, key);
    return item({
      id: `${nodeId}:${childToken}`, label: key, token: childToken,
      type: schemaType(childSchema, childValue), description: childSchema.description || '',
      recentValue: childValue, hasValue: Object.prototype.hasOwnProperty.call(dynamic, key), nodeId,
      enumValues: childSchema.enum,
      children: buildChildren(childSchema, childValue, childToken, nodeId, state, depth + 1),
    });
  });
}

function dataSchemaFor(node) {
  return parseAgentSchema(node) || STATIC_DATA_SCHEMAS[node.type] || field('any', '节点结构化输出');
}

function declarationSchema(definition, value) {
  if (definition?.schema && typeof definition.schema === 'object') return definition.schema;
  const properties = definition?.properties && typeof definition.properties === 'object'
    ? definition.properties
    : Array.isArray(definition?.fields)
      ? Object.fromEntries(definition.fields.filter((child) => child?.key).map((child) => [child.key, declarationSchema(child)]))
      : undefined;
  const type = definition?.type === 'json' ? inferType(value, properties ? 'object' : 'any')
    : definition?.type === 'string[]' ? 'array'
      : definition?.type || inferType(value);
  return {
    type,
    description: definition?.description || '',
    ...(properties ? { properties } : {}),
    ...(type === 'array' ? { items: definition?.items ? declarationSchema(definition.items) : { type: 'string' } } : {}),
    ...(Array.isArray(definition?.enum) ? { enum: definition.enum } : {}),
  };
}

function definitionList(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.fields) ? value.fields : [];
}

function scopedVariableItems(definitions, values, scope, { maxDepth = 20, maxItems = 400 } = {}) {
  const valueObject = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const keys = [...new Set([
    ...definitionList(definitions).filter((definition) => definition?.key).map((definition) => definition.key),
    ...Object.keys(valueObject),
  ])];
  const definitionsByKey = new Map(definitionList(definitions).filter((definition) => definition?.key).map((definition) => [definition.key, definition]));
  const prefix = scope === 'global' ? 'vars.global' : scope === 'workflow' ? 'vars.workflow' : 'inputs';
  const source = scope === 'global' ? 'global-variable' : scope === 'workflow' ? 'workflow-variable' : 'run-input';
  return keys.slice(0, maxItems).map((key) => {
    const definition = definitionsByKey.get(key) || {};
    const hasValue = Object.prototype.hasOwnProperty.call(valueObject, key);
    const recentValue = valueObject[key];
    const token = `${prefix}[${JSON.stringify(String(key))}]`;
    const schema = declarationSchema(definition, recentValue);
    return item({
      id: `${source}:${String(key)}`,
      label: definition.label || String(key),
      token,
      type: schemaType(schema, recentValue),
      description: definition.description || '',
      recentValue,
      hasValue,
      source,
      enumValues: schema.enum,
      children: buildChildren(schema, recentValue, token, `${source}:${String(key)}`, { count: 0, maxDepth, maxItems }, 0),
    });
  });
}

export function buildNodeVariableItem(node, { output, structuredOutput, nodeState, maxDepth = 20, maxItems = 400 } = {}) {
  const nodeId = String(node.id);
  const root = (channel) => `node[${JSON.stringify(nodeId)}].${channel}`;
  const dataValue = structuredOutput?.value;
  const metaValue = nodeState ? safeNodeStateMeta(nodeState) : undefined;
  const dataSchema = dataSchemaFor(node);
  const channels = [
    item({ id: `${nodeId}:text`, label: 'text', token: root('text'), type: 'string', description: '节点的人类可读输出', recentValue: output, hasValue: output !== undefined, nodeId }),
    item({
      id: `${nodeId}:data`, label: 'data', token: root('data'), type: schemaType(dataSchema, dataValue),
      description: dataSchema.description || '结构化输出值', recentValue: dataValue, hasValue: dataValue !== undefined, nodeId,
      children: buildChildren(dataSchema, dataValue, root('data'), nodeId, { count: 0, maxDepth, maxItems }, 0),
    }),
    item({
      id: `${nodeId}:meta`, label: 'meta', token: root('meta'), type: 'object', description: '节点运行元数据',
      recentValue: metaValue, hasValue: metaValue !== undefined, nodeId,
      children: buildChildren(META_SCHEMA, metaValue, root('meta'), nodeId, { count: 0, maxDepth, maxItems }, 0),
    }),
  ];
  return item({
    id: `node:${nodeId}`, label: node.data?.label || nodeId, token: '', type: 'node',
    description: `${node.type} 节点 ${nodeId}`, hasValue: output !== undefined || dataValue !== undefined,
    children: channels, nodeId,
  });
}

export function buildVariableSchema({
  graph, targetNodeId, run = {}, globalVariableDefinitions, workflowVariableDefinitions, inputSchema,
  globalVariables, workflowVariables, runInputs,
}) {
  const nodeMap = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const ids = targetNodeId
    ? (graph?.edges || []).filter((edge) => edge.target === targetNodeId).map((edge) => edge.source)
    : [...nodeMap.keys()];
  const nodes = ids.map((id) => nodeMap.get(id)).filter(Boolean).map((node) => buildNodeVariableItem(node, {
    output: run.outputs?.[node.id], structuredOutput: run.structuredOutputs?.[node.id], nodeState: run.nodeStates?.[node.id],
  }));
  const builtins = [
    item({ id: 'builtin:$trigger', label: '触发输入', token: '$trigger', type: 'string', description: '本次运行的触发输入', recentValue: run.triggerInput, hasValue: run.triggerInput !== undefined, source: 'builtin' }),
    item({ id: 'builtin:$upstream', label: '全部上游', token: '$upstream', type: 'string', description: '全部直接上游文本的带标签拼接', hasValue: false, source: 'builtin' }),
  ];
  const globalItems = scopedVariableItems(globalVariableDefinitions, globalVariables, 'global');
  const workflowItems = scopedVariableItems(workflowVariableDefinitions, workflowVariables, 'workflow');
  const inputItems = scopedVariableItems(inputSchema, runInputs ?? run.runInputs, 'input');
  const groups = {
    globalVariables: { id: 'group:global-variables', label: '实例变量', type: 'group', source: 'group', children: globalItems },
    workflowVariables: { id: 'group:workflow-variables', label: '工作流变量', type: 'group', source: 'group', children: workflowItems },
    runInputs: { id: 'group:run-inputs', label: '运行输入', type: 'group', source: 'group', children: inputItems },
  };
  return {
    items: [
      { id: 'group:nodes', label: '上游节点', type: 'group', source: 'group', children: nodes },
      { id: 'group:builtin', label: '运行上下文', type: 'group', source: 'group', children: builtins },
      groups.globalVariables, groups.workflowVariables, groups.runInputs,
    ],
    nodes,
    builtins,
    groups,
    globalVariables: globalItems,
    workflowVariables: workflowItems,
    runInputs: inputItems,
  };
}
