// Univer Viewer 集成纯函数：与 renderers/univer.jsx 共享，保持零 JSX 依赖，
// 让 node --test 直接覆盖（渲染器本体只做 hooks 编排与 iframe 渲染）。

// downloadUrl 形如 <base>/api/artifact?run=&node=&file=（runArtifact/legacyArtifact 构造），
// resolve 端点与它同基址，仅把路径段 /artifact 换成 /univer/resolve。
export function resolveEndpointOf(downloadUrl) {
  const raw = String(downloadUrl || '');
  const qIndex = raw.indexOf('?');
  if (qIndex < 0) return '';
  const path = raw.slice(0, qIndex);
  if (!/\/artifact$/.test(path)) return '';
  return `${path.slice(0, path.length - '/artifact'.length)}/univer/resolve${raw.slice(qIndex)}`;
}

// Viewer 的 fileKeyOf：utf8 → base64url（gateway-app 与 host 两侧一致）。
export function fileKeyOf(absolutePath) {
  try {
    return Buffer.from(String(absolutePath), 'utf8').toString('base64url');
  } catch {
    return '';
  }
}

// worktree 选择：draft 里 createdAt 最新优先；没有 draft 取最新一个；
// 完全没有 worktree 返回 null（空文件主线直接开）。
export function pickWorktree(worktrees) {
  const list = (Array.isArray(worktrees) ? worktrees : []).filter((w) => w && w.worktreeId);
  if (!list.length) return null;
  const byTime = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  const drafts = list.filter((w) => w.status === 'draft').sort(byTime);
  return (drafts[0] || list.slice().sort(byTime)[0]).worktreeId;
}
