import { assertNonSensitiveVariableDefinitions } from './variable-store.js';

export const WORKFLOW_SCHEMA_VERSION = 3;
export const WORKFLOW_EXPORT_VERSION = 3;

const emptyGraph = () => ({ nodes: [], edges: [] });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeInputSchema = (value) => ({
  ...(isObject(value) ? value : {}),
  fields: Array.isArray(value?.fields) ? value.fields : [],
});

const normalizeDependencies = (value) => ({
  ...(isObject(value) ? value : {}),
  globalVariables: Array.isArray(value?.globalVariables) ? value.globalVariables : [],
  credentials: Array.isArray(value?.credentials) ? value.credentials : [],
});

function assertSupportedSchemaVersion(value) {
  if (value === undefined || value === null) return;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0 || version > WORKFLOW_SCHEMA_VERSION) {
    throw new Error(`不支持的工作流文档版本：${value}`);
  }
}

// Pure, in-memory migration. Callers decide when to persist, so reading a legacy
// file never rewrites it as a side effect.
export function normalizeWorkflowDocument(value) {
  const source = isObject(value) ? value : {};
  assertSupportedSchemaVersion(source.schemaVersion);
  const variables = Array.isArray(source.variables) ? source.variables : [];
  assertNonSensitiveVariableDefinitions(variables, '工作流变量定义');
  return {
    ...source,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    graph: isObject(source.graph) ? source.graph : emptyGraph(),
    variables,
    inputSchema: normalizeInputSchema(source.inputSchema),
    dependencies: normalizeDependencies(source.dependencies),
  };
}

const CREDENTIAL_DECLARATION_KEYS = ['key', 'logicalKey', 'name', 'type', 'provider', 'required', 'description'];
const ATTACHMENT_DECLARATION_KEYS = ['name', 'displayName', 'type', 'mimeType', 'mediaType', 'size', 'required', 'description'];
const CREDENTIAL_CONTEXT_KEY = /^(?:credential|credentials)$/i;
const CREDENTIAL_BINDING_KEY = /(?:credential|cred)(?:Id|Ids|Ref|Refs|Value|Values)$/i;
const ATTACHMENT_STORAGE_KEY = /(?:attachment|asset|storage)(?:Id|Ids|Ref|Refs|Path|Paths|Url|Urls|Content|Contents|Filename|Filenames)$/i;

function pickDeclaration(value, keys) {
  if (!isObject(value)) return null;
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function sanitizeCredentialDeclarations(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    const declaration = typeof value === 'string' ? { key: value } : pickDeclaration(value, CREDENTIAL_DECLARATION_KEYS);
    return declaration ? { ...declaration, unresolved: true } : null;
  }).filter(Boolean);
}

function sanitizeAttachmentDeclarations(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => pickDeclaration(value, ATTACHMENT_DECLARATION_KEYS)).filter(Boolean);
}

function sanitizeTransferValue(value, parentKey = '') {
  if (Array.isArray(value)) {
    if (/attachments/i.test(parentKey)) return sanitizeAttachmentDeclarations(value);
    return value.map((item) => sanitizeTransferValue(item, parentKey));
  }
  if (!isObject(value)) return value;
  const bindingSource = String(value.source || value.kind || value.bindingType || '').toLowerCase();
  if (bindingSource === 'credential') {
    const declaration = pickDeclaration(value, CREDENTIAL_DECLARATION_KEYS) || {};
    return {
      ...(value.source !== undefined ? { source: 'credential' } : {}),
      ...(value.kind !== undefined ? { kind: 'credential' } : {}),
      ...(value.bindingType !== undefined ? { bindingType: 'credential' } : {}),
      ...declaration,
      unresolved: true,
    };
  }
  if (bindingSource === 'attachment' || bindingSource === 'attachments') {
    const declaration = pickDeclaration(value, ATTACHMENT_DECLARATION_KEYS) || {};
    return {
      ...(value.source !== undefined ? { source: value.source } : {}),
      ...(value.kind !== undefined ? { kind: value.kind } : {}),
      ...(value.bindingType !== undefined ? { bindingType: value.bindingType } : {}),
      ...declaration,
      unresolved: true,
    };
  }
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (CREDENTIAL_BINDING_KEY.test(key) || ATTACHMENT_STORAGE_KEY.test(key)) return [];
    if (CREDENTIAL_CONTEXT_KEY.test(key)) {
      const declarations = Array.isArray(child) ? sanitizeCredentialDeclarations(child) : sanitizeCredentialDeclarations([child]);
      return [[key, Array.isArray(child) ? declarations : (declarations[0] || null)]];
    }
    if (/attachments/i.test(key) && Array.isArray(child)) return [[key, sanitizeAttachmentDeclarations(child)]];
    return [[key, sanitizeTransferValue(child, key)]];
  }));
}

function sanitizeGraphForTransfer(graph) {
  return isObject(graph) ? sanitizeTransferValue(graph) : graph;
}

export function createWorkflowExportManifest(value, { exportedAt = new Date().toISOString() } = {}) {
  const workflow = normalizeWorkflowDocument(value);
  return {
    kind: 'workflow-one',
    version: WORKFLOW_EXPORT_VERSION,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: workflow.name,
    exportedAt,
    graph: sanitizeGraphForTransfer(workflow.graph),
    variables: workflow.variables,
    inputSchema: workflow.inputSchema,
    dependencies: {
      ...workflow.dependencies,
      credentials: sanitizeCredentialDeclarations(workflow.dependencies.credentials),
    },
  };
}

export function importWorkflowDocument(value, { id, updatedAt = new Date().toISOString(), defaultName = '导入的工作流' } = {}) {
  if (!isObject(value)) throw new Error('导入内容必须是 JSON 对象');
  if (value.kind && value.kind !== 'workflow-one') throw new Error('不是 workflow-one 导出文件');
  assertSupportedSchemaVersion(value.schemaVersion);
  const version = value.version === undefined ? 1 : Number(value.version);
  if (!Number.isInteger(version) || version < 1 || version > WORKFLOW_EXPORT_VERSION) {
    throw new Error(`不支持的 workflow-one 导出版本：${value.version}`);
  }

  const graph = isObject(value.graph) ? value.graph
    : Array.isArray(value.nodes) ? value
      : null;
  if (!graph || !Array.isArray(graph.nodes)) {
    throw new Error('缺少 graph.nodes（需要导出文件原样 JSON）');
  }

  return normalizeWorkflowDocument({
    ...(id ? { id } : {}),
    name: String(value.name || defaultName),
    updatedAt,
    graph,
    variables: version >= 3 ? value.variables : [],
    inputSchema: version >= 3 ? value.inputSchema : undefined,
    dependencies: version >= 3 ? value.dependencies : undefined,
  });
}
