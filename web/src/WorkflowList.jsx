// 工作流列表页：搜索 + 复制 + 导出/导入 JSON + 打开/重命名/删除（弹窗替代原生 prompt/confirm）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from './api.js';
import { createWorkflowDocument } from './workflow-serialization.js';
import { useToast, PromptModal, ConfirmModal } from './ui.jsx';

export function WorkflowList({ currentId, onOpen, onNew }) {
  const toast = useToast();
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(null);
  const importRef = useRef(null);

  const load = () => {
    fetch(apiUrl('/workflows')).then((r) => r.json()).then((d) => setList(d.workflows || [])).catch(() => {});
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((wf) => wf.name.toLowerCase().includes(q));
  }, [list, query]);

  const createNew = () => setModal({ type: 'prompt', title: '新建工作流', initial: '新工作流', confirmText: '创建', onConfirm: async (name) => {
    setModal(null);
    setBusy(true);
    const res = await fetch(apiUrl('/workflows'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...createWorkflowDocument() }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) { load(); onNew?.(data); }
    else toast(data.error || '创建失败', 'error');
  } });

  const rename = (wf) => setModal({ type: 'prompt', title: '重命名工作流', initial: wf.name, confirmText: '重命名', onConfirm: async (name) => {
    setModal(null);
    await fetch(apiUrl(`/workflows/detail?id=${encodeURIComponent(wf.id)}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    load();
  } });

  const remove = (wf) => setModal({ type: 'confirm', title: '删除工作流', message: `删除「${wf.name}」？不可恢复。`, danger: true, confirmText: '删除', onConfirm: async () => {
    setModal(null);
    await fetch(apiUrl(`/workflows/detail?id=${encodeURIComponent(wf.id)}`), { method: 'DELETE' });
    toast(`已删除「${wf.name}」`, 'warn');
    load();
  } });

  const duplicate = async (wf) => {
    const res = await fetch(apiUrl('/workflows'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: wf.id }),
    });
    if (res.ok) { toast('已创建副本', 'success'); load(); }
  };

  const exportWf = (wf) => {
    const a = document.createElement('a');
    a.href = apiUrl(`/workflows/transfer?id=${encodeURIComponent(wf.id)}`);
    a.download = `${wf.name}.workflow-one.json`;
    a.click();
  };

  const importWf = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data?.graph?.nodes) throw new Error('格式不对：需要 workflow-one 导出文件（含 graph.nodes）');
      const res = await fetch(apiUrl('/workflows/transfer'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '导入失败');
      toast(`已导入「${out.name}」${out.warnings ? `（${out.warnings} 条警告）` : ''}`, 'success');
      load();
    } catch (err) {
      toast(`导入失败：${err.message}`, 'error');
    }
  };

  return (
    <div className="wf-list-page">
      <div className="wf-list-head">
        <h3>我的工作流 <span className="sec-hint">{list.length} 个</span></h3>
        <input className="wf-search" placeholder="搜索名称…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn btn-sm" onClick={() => importRef.current?.click()}>导入</button>
        <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={importWf} />
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={createNew}>＋ 新建</button>
      </div>
      {list.length === 0 && <p className="panel-empty">还没有工作流。点「新建」创建一个，或在画布保存。</p>}
      {list.length > 0 && filtered.length === 0 && <p className="panel-empty">没有匹配「{query}」的工作流。</p>}
      <div className="wf-cards">
        {filtered.map((wf) => (
          <div key={wf.id} className={`wf-card ${wf.id === currentId ? 'wf-card-current' : ''}`}>
            <div className="wf-card-main" onClick={() => onOpen(wf)} title="打开到画布编辑">
              <div className="wf-card-name">{wf.name}</div>
              <div className="wf-card-meta">
                🤖 {wf.agentCount} 智能体 · {wf.nodeCount} 节点
                <span className="sec-hint"> · {new Date(wf.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </div>
            </div>
            <div className="wf-card-actions">
              <button className="btn-icon" title="打开" onClick={() => onOpen(wf)}>↗</button>
              <button className="btn-icon" title="复制副本" onClick={() => duplicate(wf)}>⧉</button>
              <button className="btn-icon" title="导出 JSON" onClick={() => exportWf(wf)}>⬇</button>
              <button className="btn-icon" title="重命名" onClick={() => rename(wf)}>✏️</button>
              <button className="btn-icon" title="删除" onClick={() => remove(wf)}>🗑</button>
            </div>
          </div>
        ))}
      </div>

      {modal?.type === 'prompt' && (
        <PromptModal title={modal.title} initial={modal.initial} confirmText={modal.confirmText}
          onCancel={() => setModal(null)} onConfirm={modal.onConfirm} />
      )}
      {modal?.type === 'confirm' && (
        <ConfirmModal title={modal.title} message={modal.message} danger={modal.danger} confirmText={modal.confirmText}
          onCancel={() => setModal(null)} onConfirm={modal.onConfirm} />
      )}
    </div>
  );
}
