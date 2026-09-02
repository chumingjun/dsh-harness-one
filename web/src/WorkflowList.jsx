// 工作流列表页：管理工作流，并提供运行状态、启动、取消和运行详情入口。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, Play, Square, Upload } from 'lucide-react';
import { apiUrl } from './api.js';
import { createWorkflowDocument } from './workflow-serialization.js';
import { workflowCards } from './workflow-list-state.js';
import { RunWorkflowModal } from './RunWorkflowModal.jsx';
import { useToast, PromptModal, ConfirmModal } from './ui.jsx';

const STATUS_LABEL = { running: '运行中', success: '成功', error: '失败', canceled: '已取消', interrupted: '异常中断' };
const STATUS_CLASS = { running: 'running', success: 'success', error: 'error', canceled: 'canceled', interrupted: 'error' };

function runTime(run) {
  if (!run?.startedAt) return '';
  if (run.live) return `开始于 ${new Date(run.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  if (run.durationMs != null) return `${(run.durationMs / 1000).toFixed(1)}s`;
  return new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false });
}

export function WorkflowList({ currentId, onOpen, onNew, runs = [], onStartRun, onCancelRun, onInspectRun, onRefresh }) {
  const toast = useToast();
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState({});
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(null);
  const [runWorkflow, setRunWorkflow] = useState(null);
  const importRef = useRef(null);

  const load = async () => {
    try {
      const res = await fetch(apiUrl('/workflows'));
      if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
      const data = await res.json();
      setList(data.workflows || []);
    } catch (error) { toast(error.message || '工作流列表加载失败', 'error'); }
  };
  useEffect(() => { load(); }, []);

  const cards = useMemo(() => workflowCards(list, runs), [list, runs]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((wf) => wf.name.toLowerCase().includes(q) || wf.id.toLowerCase().includes(q));
  }, [cards, query]);

  const refresh = () => { load(); onRefresh?.(); };
  const setActionBusy = (key, value) => setRowBusy((current) => ({ ...current, [key]: value }));

  const openRun = async (wf) => {
    setActionBusy(`${wf.id}:run`, true);
    try {
      const res = await fetch(apiUrl(`/workflows/detail?id=${encodeURIComponent(wf.id)}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '无法读取工作流');
      setRunWorkflow(data);
    } catch (error) { toast(error.message || '无法读取工作流', 'error'); }
    finally { setActionBusy(`${wf.id}:run`, false); }
  };

  const start = async (input) => {
    if (!runWorkflow) return;
    await onStartRun?.(runWorkflow, input);
    refresh();
  };

  const askCancel = (wf, run) => setModal({ type: 'confirm', title: '取消运行', message: `取消「${wf.name}」的运行？\n${run.runId} · ${runTime(run)}`, danger: true, confirmText: '取消运行', onConfirm: async () => {
    setModal(null);
    const key = `${wf.id}:${run.runId}`;
    setActionBusy(key, true);
    try { await onCancelRun?.(run.runId); refresh(); }
    catch (error) { toast(error.message || '取消失败', 'error'); }
    finally { setActionBusy(key, false); }
  } });

  const createNew = () => setModal({ type: 'prompt', title: '新建工作流', initial: '新工作流', confirmText: '创建', onConfirm: async (name) => {
    setModal(null); setBusy(true);
    try {
      const res = await fetch(apiUrl('/workflows'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ...createWorkflowDocument() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '创建失败');
      refresh(); onNew?.(data);
    } catch (error) { toast(error.message || '创建失败', 'error'); }
    finally { setBusy(false); }
  } });

  const rename = (wf) => setModal({ type: 'prompt', title: '重命名工作流', initial: wf.name, confirmText: '重命名', onConfirm: async (name) => {
    setModal(null);
    const res = await fetch(apiUrl(`/workflows/detail?id=${encodeURIComponent(wf.id)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!res.ok) toast('重命名失败', 'error'); else refresh();
  } });

  const remove = (wf) => setModal({ type: 'confirm', title: '删除工作流', message: `删除「${wf.name}」？不可恢复。`, danger: true, confirmText: '删除', onConfirm: async () => {
    setModal(null);
    const res = await fetch(apiUrl(`/workflows/detail?id=${encodeURIComponent(wf.id)}`), { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) toast(data.error || '删除失败', 'error'); else { toast(`已删除「${wf.name}」`, 'warn'); refresh(); }
  } });

  const duplicate = async (wf) => {
    const res = await fetch(apiUrl('/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: wf.id }) });
    if (res.ok) { toast('已创建副本', 'success'); refresh(); } else toast('复制失败', 'error');
  };

  const exportWf = async (wf) => {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/workflows/transfer?id=${encodeURIComponent(wf.id)}`));
      if (!res.ok) { const out = await res.json().catch(() => ({})); throw new Error(out.error || `请求失败（HTTP ${res.status}）`); }
      if (!res.headers.get('content-type')?.includes('application/json')) throw new Error('服务返回的不是工作流 JSON');
      const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = `${wf.name}.workflow-one.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
      toast(`已导出「${wf.name}」`, 'success');
    } catch (error) { toast(`导出失败：${error.message}`, 'error'); }
    finally { setBusy(false); }
  };

  const importWf = async (e) => {
    const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
    setBusy(true);
    try {
      const text = await file.text(); let data; try { data = JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON'); }
      const res = await fetch(apiUrl('/workflows/transfer'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const out = await res.json(); if (!res.ok) throw new Error(out.error || '导入失败');
      toast(`已导入「${out.name}」${out.warnings ? `（${out.warnings} 条警告）` : ''}`, 'success'); refresh(); await onOpen?.(out);
    } catch (error) { toast(`导入失败：${error.message}`, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="wf-list-page">
      <div className="wf-list-head"><h3>我的工作流 <span className="sec-hint">{list.length} 个</span></h3><input className="wf-search" placeholder="搜索名称或 ID…" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="btn btn-sm" disabled={busy} onClick={() => importRef.current?.click()}><Upload size={14} aria-hidden="true" />导入</button><input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={importWf} /><button className="btn btn-primary btn-sm" disabled={busy} onClick={createNew}>＋ 新建</button></div>
      {list.length === 0 && <p className="panel-empty">还没有工作流。点「新建」创建一个，或在画布保存。</p>}
      {list.length > 0 && filtered.length === 0 && <p className="panel-empty">没有匹配「{query}」的工作流。</p>}
      <div className="wf-cards">{filtered.map((wf) => <div key={wf.id} className={`wf-card ${wf.id === currentId ? 'wf-card-current' : ''}`}>
        <div className="wf-card-main" onClick={() => onOpen(wf)} title="打开到画布编辑"><div className="wf-card-name">{wf.name}</div><div className="wf-card-meta">🤖 {wf.agentCount} 智能体 · {wf.nodeCount} 节点 <span className="sec-hint"> · {new Date(wf.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span></div></div>
        <div className="wf-card-runtime">
          {wf.liveRuns?.length ? <>{wf.liveRuns.map((run) => <div className="wf-live-run" key={run.runId}><span className="wf-run-status running">LIVE · {run.progress?.done ?? 0}/{run.progress?.total ?? wf.nodeCount}</span><span className="wf-run-current">{run.currentNodes?.map((node) => node.label).join('、') || '准备中'}</span><span className="wf-run-time">{runTime(run)}</span><button className="btn-icon" title="查看运行" aria-label={`查看运行 ${run.runId}`} disabled={rowBusy[`${wf.id}:${run.runId}`]} onClick={() => onInspectRun?.(wf, run.runId)}><Eye size={14} /></button><button className="btn-icon wf-cancel-btn" title="取消运行" aria-label={`取消运行 ${run.runId}`} disabled={rowBusy[`${wf.id}:${run.runId}`]} onClick={() => askCancel(wf, run)}><Square size={13} /></button></div>)}</> : <div className="wf-run-empty">{wf.lastRun ? <><span className={`wf-run-status ${STATUS_CLASS[wf.lastRun.status] || ''}`}>{STATUS_LABEL[wf.lastRun.status] || wf.lastRun.status}</span><span className="wf-run-time">{runTime(wf.lastRun)}</span><button className="btn-icon" title="查看最近运行" aria-label="查看最近运行" onClick={() => onInspectRun?.(wf, wf.lastRun.runId)}><Eye size={14} /></button></> : <span className="sec-hint">尚未运行</span>}</div>}
        </div>
        <div className="wf-card-actions"><button className="btn btn-primary btn-sm" disabled={rowBusy[`${wf.id}:run`]} onClick={() => openRun(wf)}><Play size={13} />启动</button><button className="btn-icon" title="打开" onClick={() => onOpen(wf)}>↗</button><button className="btn-icon" title="复制副本" onClick={() => duplicate(wf)}>⧉</button><button className="btn-icon" title="导出工作流" aria-label={`导出「${wf.name}」`} disabled={busy} onClick={() => exportWf(wf)}><Download size={15} aria-hidden="true" /></button><button className="btn-icon" title="重命名" onClick={() => rename(wf)}>✏️</button><button className="btn-icon" title="删除" onClick={() => remove(wf)}>🗑</button></div>
      </div>)}</div>
      {modal?.type === 'prompt' && <PromptModal title={modal.title} initial={modal.initial} confirmText={modal.confirmText} onCancel={() => setModal(null)} onConfirm={modal.onConfirm} />}
      {modal?.type === 'confirm' && <ConfirmModal title={modal.title} message={modal.message} danger={modal.danger} confirmText={modal.confirmText} onCancel={() => setModal(null)} onConfirm={modal.onConfirm} />}
      {runWorkflow && <RunWorkflowModal workflow={runWorkflow} onClose={() => setRunWorkflow(null)} onStart={start} />}
    </div>
  );
}
