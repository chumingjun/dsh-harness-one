// Univer Viewer 渲染器：.univer 文件内嵌 dsh-univer-office 的 Viewer 页面。
// 纯 URL 集成——不 import univer-office 的任何值，只拼它的 Gateway URL；
// 协议三步：/univer-api/status 发现 Gateway → /wf1/api/univer/resolve 换绝对路径
// → Gateway /uf/<key>/worktrees 选 worktree 后 iframe 打开。
// 纯函数（fileKey/pickWorktree/resolveEndpoint）在 ../univer-core.js，单测直覆盖。
import { useEffect, useMemo, useState } from 'react';
import { fileKeyOf, pickWorktree, resolveEndpointOf } from '../univer-core.js';

async function fetchJson(url, signal) {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function buildViewerUrl(resolveUrl, signal) {
  const resolved = await fetchJson(resolveUrl, signal);
  // /univer-api/status 是 dsh 宿主同源路由（univer-office 注册）；Gateway 端口
  // 被占会逐次递增，所以每次现查不缓存。
  const status = await fetchJson('/univer-api/status', signal);
  const gateway = String(status?.gateway || '').replace(/\/$/, '');
  if (!gateway) throw new Error('univer-office Gateway 未运行');
  const fileKey = fileKeyOf(resolved.file);
  if (!fileKey) throw new Error('文件路径编码失败');
  const listing = await fetchJson(`${gateway}/uf/${fileKey}/worktrees`, signal);
  const worktree = pickWorktree(listing?.worktrees);
  const params = new URLSearchParams({ file: fileKey, mode: 'embedded' });
  if (worktree) params.set('worktree', worktree);
  return `${gateway}/?${params.toString()}`;
}

export default function UniverRenderer({ document }) {
  const resolveUrl = useMemo(() => resolveEndpointOf(document.downloadUrl), [document.downloadUrl]);
  const [state, setState] = useState({ loading: true, error: '', url: '' });

  useEffect(() => {
    if (!resolveUrl) {
      setState({ loading: false, error: '预览地址缺少产物定位信息，无法打开 Univer Viewer。', url: '' });
      return undefined;
    }
    const controller = new AbortController();
    setState({ loading: true, error: '', url: '' });
    buildViewerUrl(resolveUrl, controller.signal).then((url) => {
      if (!controller.signal.aborted) setState({ loading: false, error: '', url });
    }).catch((reason) => {
      if (controller.signal.aborted || reason?.name === 'AbortError') return;
      const missing = reason?.status === 404;
      setState({
        loading: false,
        error: missing
          ? '未安装 dsh-univer-office 插件，无法预览 .univer 文件；请下载后用 Univer 打开。'
          : `Univer 预览不可用：${reason?.message || reason}`,
        url: '',
      });
    });
    return () => controller.abort();
  }, [resolveUrl]);

  if (loading) return <div className="dsh-doc-preview-message">正在连接 Univer Viewer…</div>;
  if (error) return <div className="dsh-doc-preview-message is-error">{error}</div>;
  return <iframe className="dsh-doc-preview-frame" src={state.url} title={`预览 ${document.name}`} />;
}
