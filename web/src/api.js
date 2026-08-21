import { resolveApiBase } from './api-base.js';

// 共享 API base：显式注入优先；dsh 页面即使缺少注入也能从 /wf1 路径恢复。
const API_BASE = resolveApiBase({
  injected: window.__WF1_API_BASE__,
  assetBase: import.meta.env?.BASE_URL || '/',
  pathname: window.location?.pathname || '/',
});
const API = `${API_BASE}/api`;
let sessionId = null;

export function setApiSessionId(value) {
  sessionId = value ? String(value) : null;
}

export const apiUrl = (path) => {
  const raw = `${API}${path}`;
  if (!sessionId) return raw;
  const separator = raw.includes('?') ? '&' : '?';
  return `${raw}${separator}sessionId=${encodeURIComponent(sessionId)}`;
};
