// 用户级 pi 准入开关（dsh 设置面板「Workflow One · 本地执行底座」）。
// 与部署级 config.enablePiRuntime 组成双源门禁（OR）：YAML 保留兼容，页面开关即时生效。
// 单独文件而非并入 agent-defaults.json：后者 PUT 是整体替换且由 AgentDefaultsCard 独占写入，
// 两卡共写会互相覆盖（评审 §18 取证）。存放与 agent-defaults 同为 dsh 用户级，不进工作区。

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const runtimeSettingsFile = () => join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'plugin-data', 'dsh-ccpg-orchestrator', 'state', 'runtime-settings.json',
);

export const EMPTY_RUNTIME_SETTINGS = Object.freeze({ enablePiRuntime: false });

/** 只收普通对象且恰含布尔 enablePiRuntime；数组/缺字段/额外字段/非布尔一律拒绝。 */
export function normalizeRuntimeSettings(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('请求体必须是对象');
  }
  const keys = Object.keys(source);
  if (keys.length !== 1 || keys[0] !== 'enablePiRuntime' || typeof source.enablePiRuntime !== 'boolean') {
    throw new TypeError('仅接受 { enablePiRuntime: boolean }');
  }
  return { enablePiRuntime: source.enablePiRuntime };
}

export class RuntimeSettingsStore {
  constructor(filePath = runtimeSettingsFile()) {
    this.filePath = filePath;
  }

  /** 缺文件/损坏都回退禁用：授权配置读不出时绝不能默认放行。 */
  read() {
    if (!existsSync(this.filePath)) return { ...EMPTY_RUNTIME_SETTINGS };
    try {
      const doc = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return { enablePiRuntime: doc?.enablePiRuntime === true };
    } catch {
      return { ...EMPTY_RUNTIME_SETTINGS };
    }
  }

  write(source) {
    const normalized = normalizeRuntimeSettings(source);
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
