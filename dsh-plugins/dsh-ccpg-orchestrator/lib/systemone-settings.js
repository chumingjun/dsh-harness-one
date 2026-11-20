// System One 用户级设置：服务地址/模型，空 = 跟随部署 Config 默认。
// 与 agent-defaults 同语义：dsh 用户级 state（跨工作区共享——模型地址是机器级事实），
// 原子写，缺失/损坏回退空。URL 只存在于这个受信任管理面——节点 data/导入图/助手补丁
// 依旧没有地址字段（不可信图数据碰不到 SSRF 面）。
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_URL_LENGTH = 500;
const MAX_MODEL_LENGTH = 200;
const ALLOWED_KEYS = new Set(['url', 'model']);

export class SystemOneSettingsError extends Error {
  constructor(message, { code = 'invalid-systemone-settings', status = 400 } = {}) {
    super(message);
    this.name = 'SystemOneSettingsError';
    this.code = code;
    this.status = status;
  }
}

const fail = (message) => { throw new SystemOneSettingsError(message); };

export const EMPTY_SYSTEMONE_SETTINGS = Object.freeze({ url: '', model: '' });

export const systemoneSettingsFile = () => join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'plugin-data', 'dsh-ccpg-orchestrator', 'state', 'systemone-settings.json',
);

/** URL 校验：空 = 跟随部署（null）；必须可解析且 http(s)。设置归一化与测试端点共用。 */
export function systemoneUrlIssue(url) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return '服务地址不是合法 URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '服务地址必须是 http(s)://';
  return null;
}

export function normalizeSystemOneSettings(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) fail('请求体必须是对象');
  for (const key of Object.keys(source)) {
    if (!ALLOWED_KEYS.has(key)) fail(`不支持的字段 ${key}`);
  }
  const result = { ...EMPTY_SYSTEMONE_SETTINGS };
  for (const key of ALLOWED_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') fail(`${key} 必须是字符串`);
    const trimmed = value.trim();
    const max = key === 'url' ? MAX_URL_LENGTH : MAX_MODEL_LENGTH;
    if (trimmed.length > max) fail(`${key} 最长 ${max} 个字符`);
    result[key] = trimmed;
  }
  const issue = systemoneUrlIssue(result.url);
  if (issue) fail(issue);
  return result;
}

/** 合并链：用户设置（非空字段）> 部署 Config。orch.systemone 永远存合并后的 effective。 */
export function resolveSystemOneSettings(settings, config) {
  return {
    url: settings.url || config.systemoneUrl,
    model: settings.model || config.systemoneModel,
  };
}

export class SystemOneSettingsStore {
  constructor(filePath = systemoneSettingsFile()) {
    this.filePath = filePath;
  }

  /** 缺文件/损坏都回退空默认：偏好配置不该阻塞启动与运行。 */
  read() {
    if (!existsSync(this.filePath)) return { ...EMPTY_SYSTEMONE_SETTINGS };
    try {
      const doc = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ...EMPTY_SYSTEMONE_SETTINGS };
      const { version: _version, ...settings } = doc; // version 是信封字段，不是配置项
      return normalizeSystemOneSettings(settings);
    } catch {
      return { ...EMPTY_SYSTEMONE_SETTINGS };
    }
  }

  write(settings) {
    const normalized = normalizeSystemOneSettings(settings);
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