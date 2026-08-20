// 飞书应用凭据存储：多套凭据落 data/credentials.json（0600），供画布配置与按节点选择。
// secrets 只在写接口出现；读接口一律掩码（cli_xxxx****）。
// 调用方共享同一个存储文件（orchestrator 与 tools 插件各自实例化，路径一致）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRED_FILE = join(__dirname, '..', 'data', 'credentials.json');

function load() {
  try {
    const d = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    if (Array.isArray(d.feishu)) return d;
  } catch { /* 首次或损坏 → 空 */ }
  return { feishu: [] };
}

function save(doc) {
  mkdirSync(dirname(CRED_FILE), { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

const mask = (s) => (s ? `${String(s).slice(0, 6)}****${String(s).slice(-4)}` : '');

/** 列表（掩码） */
export function listFeishuCreds() {
  return load().feishu.map(({ id, name, appId, createdAt, isDefault }) => ({
    id, name, appIdMasked: mask(appId), createdAt, isDefault: Boolean(isDefault),
  }));
}

/** 新增 {name, appId, appSecret, isDefault?} → 摘要 */
export function addFeishuCred({ name, appId, appSecret, isDefault }) {
  if (!appId || !appSecret) throw new Error('需要 appId 和 appSecret');
  const doc = load();
  const id = `fc_${randomUUID().slice(0, 8)}`;
  const entry = {
    id,
    name: String(name || `飞书应用 ${doc.feishu.length + 1}`).slice(0, 40),
    appId: String(appId),
    appSecret: String(appSecret),
    createdAt: new Date().toISOString(),
    isDefault: Boolean(isDefault) || doc.feishu.length === 0,
  };
  if (entry.isDefault) doc.feishu.forEach((c) => { c.isDefault = false; });
  doc.feishu.push(entry);
  save(doc);
  const { appSecret: _s, ...safe } = entry;
  return { ...safe, appIdMasked: mask(entry.appId) };
}

/** 删除 */
export function removeFeishuCred(id) {
  const doc = load();
  const before = doc.feishu.length;
  doc.feishu = doc.feishu.filter((c) => c.id !== id);
  if (doc.feishu.length === before) return false;
  if (!doc.feishu.some((c) => c.isDefault) && doc.feishu.length) doc.feishu[0].isDefault = true;
  save(doc);
  return true;
}

/** 设默认 */
export function setDefaultFeishuCred(id) {
  const doc = load();
  const hit = doc.feishu.find((c) => c.id === id);
  if (!hit) return false;
  doc.feishu.forEach((c) => { c.isDefault = c.id === id; });
  save(doc);
  return true;
}

/** 取原始凭据（仅后端内部用）：优先指定 id，否则默认/第一个；不匹配返回 null */
export function getFeishuCred(id) {
  const list = load().feishu;
  if (!list.length) return null;
  return list.find((c) => c.id === id) || list.find((c) => c.isDefault) || list[0];
}

/** 是否存在任何一套可用凭据 */
export function hasAnyFeishuCred() {
  return load().feishu.length > 0;
}

/** 环境变量兜底（老用法）：画布里没配时回落 env */
export function getFeishuCredOrEnv(id) {
  const cred = getFeishuCred(id);
  if (cred) return { appId: cred.appId, appSecret: cred.appSecret, source: 'canvas', id: cred.id };
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return { appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, source: 'env' };
  }
  return null;
}
