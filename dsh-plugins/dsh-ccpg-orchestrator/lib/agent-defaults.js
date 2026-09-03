// agent 节点默认值存储：用户在 dsh 设置面板「Workflow One」里配置的兜底
// 渠道/模型/思考级别。语义是「节点没显式配置时的第二顺位」——优先级链为
// 节点自身 data > 本文件 > dsh 全局模型选择（agentDefaultModel.currentSelection）。
//
// 存放位置与飞书凭据同为 dsh 用户级（~/.dsh/plugin-data/.../state/），不进
// 工作区 .workflow-one/：它是跨工作区的用户偏好，且设置面板没有会话工作区上下文。

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_FIELD_LENGTH = 200;
const ALLOWED_KEYS = new Set(['provider', 'model', 'reasoningEffort', 'nodeTimeoutSec', 'modelTimeoutSec']);
// 超时字段：正整数秒，0/空 = 不设置（回退内置默认 500s / 300s）。上限 86400（一天）防呆。
const TIMEOUT_KEYS = new Set(['nodeTimeoutSec', 'modelTimeoutSec']);
const MAX_TIMEOUT_SEC = 86400;

export class AgentDefaultsError extends Error {
  constructor(message, { code = 'invalid-agent-defaults', status = 400 } = {}) {
    super(message);
    this.name = 'AgentDefaultsError';
    this.code = code;
    this.status = status;
  }
}

const fail = (message, options) => {
  throw new AgentDefaultsError(message, options);
};

export const agentDefaultsFile = () => join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'plugin-data', 'dsh-ccpg-orchestrator', 'state', 'agent-defaults.json',
);

export const EMPTY_AGENT_DEFAULTS = Object.freeze({
  provider: '', model: '', reasoningEffort: '',
  nodeTimeoutSec: 0, modelTimeoutSec: 0,
});

/** 输入整形：三个字符串字段 + 两个超时（秒，0 = 不设置）。 */
export function normalizeAgentDefaults(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) fail('请求体必须是对象');
  for (const key of Object.keys(source)) {
    if (!ALLOWED_KEYS.has(key)) fail(`不支持的字段 ${key}`);
  }
  const result = { ...EMPTY_AGENT_DEFAULTS };
  for (const key of ALLOWED_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (TIMEOUT_KEYS.has(key)) {
      const num = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) fail(`${key} 必须是不小于 0 的整数（秒）`);
      if (num > MAX_TIMEOUT_SEC) fail(`${key} 不能超过 ${MAX_TIMEOUT_SEC} 秒`);
      result[key] = num;
      continue;
    }
    if (typeof value !== 'string') fail(`${key} 必须是字符串`);
    const trimmed = value.trim();
    if (trimmed.length > MAX_FIELD_LENGTH) fail(`${key} 最长 ${MAX_FIELD_LENGTH} 个的字符`);
    result[key] = trimmed;
  }
  // 依赖关系：model 依附 provider，思考级别依附具体模型；超时独立无依赖
  if (result.model && !result.provider) fail('设置默认模型前必须先选默认渠道');
  if (result.reasoningEffort && !result.model) fail('设置默认思考级别前必须先选默认渠道和模型');
  return result;
}

/**
 * 对照 dsh LLM 目录校验：渠道/模型必须真实存在，思考级别必须是该模型支持的档位。
 * llm 形状 = ctx.llm（listProviders/listModels/resolveModelInfo）。目录查询失败
 * 原样抛出（路由层转 500），语义校验失败抛 AgentDefaultsError（400）。
 */
export async function validateAgentDefaults(defaults, llm) {
  if (!defaults.provider) return defaults;
  const providers = await llm.listProviders();
  if (!providers.some((p) => p.id === defaults.provider)) fail(`渠道不存在：${defaults.provider}`);
  if (!defaults.model) return defaults;
  const models = await llm.listModels(defaults.provider);
  if (!models.some((m) => m.id === defaults.model)) fail(`渠道 ${defaults.provider} 下不存在模型：${defaults.model}`);
  if (!defaults.reasoningEffort) return defaults;
  let info;
  try {
    info = await llm.resolveModelInfo(defaults.provider, defaults.model);
  } catch {
    // 元数据解析失败不代表配置错误（adapter 可能没实现），放行档位
    return defaults;
  }
  const efforts = info?.reasoning?.efforts || [];
  if (!efforts.length) fail(`模型 ${defaults.model} 不支持思考级别设置`);
  if (!efforts.some((e) => e.id === defaults.reasoningEffort)) {
    fail(`模型 ${defaults.model} 不支持思考级别 ${defaults.reasoningEffort}（可选：${efforts.map((e) => e.id).join(', ')}）`);
  }
  return defaults;
}

export class AgentDefaultsStore {
  constructor(filePath = agentDefaultsFile()) {
    this.filePath = filePath;
  }

  /** 缺文件/损坏都回退空默认值：偏好配置不该阻塞运行。 */
  read() {
    if (!existsSync(this.filePath)) return { ...EMPTY_AGENT_DEFAULTS };
    try {
      const doc = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ...EMPTY_AGENT_DEFAULTS };
      const { version: _version, ...defaults } = doc; // version 是信封字段，不是配置项
      return normalizeAgentDefaults(defaults);
    } catch {
      return { ...EMPTY_AGENT_DEFAULTS };
    }
  }

  write(defaults) {
    const normalized = normalizeAgentDefaults(defaults);
    const data = `${JSON.stringify({ version: 1, ...normalized }, null, 2)}\n`;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      try { unlinkSync(tmp); } catch { /* no temp file */ }
      throw error;
    }
    return normalized;
  }
}

/**
 * 节点未显式配置时的完整解析链：节点 data > 本默认值 > dsh 全局选择。
 * 配套约束：默认模型只在默认渠道生效（跨渠道不错配）；dsh 全局模型只在
 * 最终渠道恰为 dsh 全局渠道时继承。返回 { provider, model, reasoningEffort }，
 * 任一字段 undefined 表示「该层没有提供，由调用方继续解析」。
 */
export function resolveAgentModelSelection({ node = {}, defaults = EMPTY_AGENT_DEFAULTS, dshSelection = {} } = {}) {
  const sel = dshSelection || {};
  const provider = node.channel || defaults.provider || sel.provider || undefined;
  let model = node.model || undefined;
  if (!model && !node.channel && defaults.provider) model = defaults.model || undefined;
  if (!model && provider && provider === sel.provider) model = sel.model || undefined;
  const reasoningEffort = node.reasoningEffort
    || (provider && provider === defaults.provider && model && model === defaults.model ? defaults.reasoningEffort : undefined)
    || (provider === sel.provider && model === sel.model ? sel.reasoningEffort : undefined)
    || undefined;
  return { provider, model, reasoningEffort };
}

/**
 * 节点未显式配置时的超时解析（秒）：节点 data > Workflow One 默认值 > 内置默认。
 * 覆盖 agent 节点的两个旋钮——nodeTimeoutSec（节点总生命周期，内置 500s）与
 * modelTimeoutSec（单次模型请求，内置 300s）。返回有效秒数，永不 undefined。
 */
export const DEFAULT_NODE_TIMEOUT_SEC = 500;
export const DEFAULT_MODEL_TIMEOUT_SEC = 300;

export function resolveAgentTimeouts({ node = {}, defaults = EMPTY_AGENT_DEFAULTS } = {}) {
  const nodeTimeoutSec = Number(node.timeoutSec) > 0
    ? Number(node.timeoutSec)
    : (defaults.nodeTimeoutSec > 0 ? defaults.nodeTimeoutSec : DEFAULT_NODE_TIMEOUT_SEC);
  const modelTimeoutSec = Number(node.modelTimeoutSec) > 0
    ? Number(node.modelTimeoutSec)
    : (defaults.modelTimeoutSec > 0 ? defaults.modelTimeoutSec : DEFAULT_MODEL_TIMEOUT_SEC);
  return { nodeTimeoutSec, modelTimeoutSec };
}
