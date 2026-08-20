export function parseJsonResponseText(text, { status = 0, contentType = '', url = '' } = {}) {
  const source = String(text ?? '').trim();
  if (!source) throw new Error(`试运行接口返回空响应${status ? `（HTTP ${status}）` : ''}`);
  try { return JSON.parse(source); } catch {
    const looksHtml = /^(?:<!doctype\s+html|<html\b)/i.test(source) || contentType.includes('text/html');
    if (looksHtml) {
      throw new Error(`试运行接口返回了网页而不是 JSON${status ? `（HTTP ${status}）` : ''}：${url || '请刷新页面后重试'}`);
    }
    throw new Error(`试运行接口返回无效 JSON${status ? `（HTTP ${status}）` : ''}`);
  }
}
