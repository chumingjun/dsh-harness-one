// 定时任务面板：列表（下次触发/触发统计/启停/立即运行/删除）+ 创建/编辑表单
// （cron 预设 + 实时预览下 3 次触发 + 重叠策略）。风格对齐 VariableCenter 的 Modal。
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from './api.js';
import { Modal } from './ui.jsx';
import { CRON_PRESETS, describeCron, presetOfCron } from './schedule-center.js';

function formatNext(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function validateRunInputsJson(text) {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: '运行参数必须是 JSON 对象（如 {"env": "prod"}）' };
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: `JSON 格式错误：${e.message}` };
  }
}

function ScheduleForm({ workflows, initial, onSubmit, onCancel, submitting }) {
  const [workflowId, setWorkflowId] = useState(initial?.workflowId || (workflows[0]?.id || ''));
  const [cron, setCron] = useState(initial?.cron || CRON_PRESETS[0].cron);
  const [input, setInput] = useState(initial?.input || '');
  const [runInputsText, setRunInputsText] = useState(initial?.runInputs && Object.keys(initial.runInputs).length ? JSON.stringify(initial.runInputs, null, 2) : '');
  const [overlap, setOverlap] = useState(initial?.overlap || 'skip');
  const [preview, setPreview] = useState({ state: 'idle' }); // idle | loading | ok | error
  const preset = presetOfCron(cron);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!cron.trim()) { setPreview({ state: 'idle' }); return undefined; }
    setPreview({ state: 'loading' });
    debounceRef.current = setTimeout(() => {
      fetch(apiUrl('/schedule/preview'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron }),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then(({ ok, data }) => setPreview(ok ? { state: 'ok', times: data.times || [] } : { state: 'error', error: data.error || 'cron 表达式无效' }))
        .catch(() => setPreview({ state: 'error', error: '预览请求失败' }));
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [cron]);

  const runInputsCheck = validateRunInputsJson(runInputsText);
  const cronValid = preview.state === 'ok';
  const canSubmit = workflowId && cron.trim() && cronValid && runInputsCheck.ok && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      workflowId,
      cron: cron.trim(),
      input,
      runInputs: runInputsCheck.value,
      overlap,
    });
  };

  return (
    <div className="sch-form">
      <section className="panel-sec">
        <h4>工作流 <span className="sec-hint">定时任务按保存后的最新画布内容运行</span></h4>
        <select className="sch-input" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} disabled={Boolean(initial?.workflowId)}>
          {workflows.map((wf) => <option key={wf.id} value={wf.id}>{wf.name}</option>)}
        </select>
      </section>
      <section className="panel-sec">
        <h4>触发时间</h4>
        <div className="sch-presets">
          {CRON_PRESETS.map((p) => (
            <button key={p.key} type="button" className={`chip ${preset?.key === p.key ? 'chip-on' : ''}`} onClick={() => setCron(p.cron)}>{p.label}</button>
          ))}
          <button type="button" className={`chip ${preset === null ? 'chip-on' : ''}`} onClick={() => setCron('')}>自定义</button>
        </div>
        <input
          className={`sch-input ${preview.state === 'error' ? 'sch-input-err' : ''}`}
          placeholder="cron 表达式（分 时 日 月 周，如 30 8 * * *）"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
        />
        {preview.state === 'error' && <p className="sch-err">{preview.error}</p>}
        {preview.state === 'loading' && <p className="sec-hint">校验中…</p>}
        {preview.state === 'ok' && (
          <p className="sch-preview">
            <strong>{describeCron(cron) || '自定义周期'}</strong>
            接下来：{preview.times.map((t) => formatNext(t)).join('、')}
          </p>
        )}
      </section>
      <section className="panel-sec">
        <h4>触发输入 <span className="sec-hint">可选，模板里用 {'{{$trigger}}'} 引用</span></h4>
        <textarea className="sch-input sch-textarea" rows={2} placeholder="如：执行今日巡检" value={input} onChange={(e) => setInput(e.target.value)} />
      </section>
      <section className="panel-sec">
        <h4>运行参数 <span className="sec-hint">可选 JSON 对象，对应工作流输入 Schema 的入参</span></h4>
        <textarea
          className={`sch-input sch-textarea ${!runInputsCheck.ok ? 'sch-input-err' : ''}`}
          rows={2}
          placeholder='{"env": "prod"}'
          value={runInputsText}
          onChange={(e) => setRunInputsText(e.target.value)}
        />
        {!runInputsCheck.ok && <p className="sch-err">{runInputsCheck.error}</p>}
      </section>
      <section className="panel-sec">
        <h4>重叠策略 <span className="sec-hint">到点时上一轮还没跑完怎么办</span></h4>
        <div className="sch-overlap">
          <label className={`sch-radio ${overlap === 'skip' ? 'sch-radio-on' : ''}`}>
            <input type="radio" name="sch-overlap" checked={overlap === 'skip'} onChange={() => setOverlap('skip')} />
            <span><strong>跳过本轮（推荐巡检）</strong><em>不重复执行、不重复推送，结束后下个周期照常</em></span>
          </label>
          <label className={`sch-radio ${overlap === 'parallel' ? 'sch-radio-on' : ''}`}>
            <input type="radio" name="sch-overlap" checked={overlap === 'parallel'} onChange={() => setOverlap('parallel')} />
            <span><strong>并行新开一轮</strong><em>与上一轮同时运行，互不干扰（消耗双份资源）</em></span>
          </label>
        </div>
      </section>
      <div className="sch-form-actions">
        <button className="btn" onClick={onCancel} disabled={submitting}>取消</button>
        <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
          {submitting ? '保存中…' : initial?.key ? '保存修改' : '创建任务'}
        </button>
      </div>
    </div>
  );
}

export function ScheduleCenter({ currentWorkflowId, onRan, onClose, toast }) {
  const [schedules, setSchedules] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [mode, setMode] = useState('list'); // list | create | edit
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    try {
      const [schRes, wfRes] = await Promise.all([
        fetch(apiUrl('/schedule')).then((r) => r.json()),
        fetch(apiUrl('/workflows')).then((r) => r.json()),
      ]);
      setSchedules(schRes.schedules || []);
      setWorkflows(wfRes.workflows || []);
    } catch { /* 面板保持现状 */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (name, fn) => {
    if (busy) return;
    setBusy(name);
    try { await fn(); } finally { setBusy(''); }
  };

  const createOrUpdate = async (payload) => {
    await act('save', async () => {
      const isEdit = Boolean(editing?.key);
      const res = await fetch(apiUrl('/schedule'), {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isEdit ? { key: editing.key, ...payload } : payload),
      });
      const data = await res.json();
      if (!res.ok) { toast(`保存失败：${data.error}`, 'error'); return; }
      toast(isEdit ? '已保存修改' : '定时任务已创建', 'success');
      setMode('list');
      setEditing(null);
      load();
    });
  };

  const runNow = (row) => act(`run:${row.key}`, async () => {
    const res = await fetch(apiUrl('/schedule/run'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: row.key }),
    });
    const data = await res.json();
    if (!res.ok) { toast(`立即运行失败：${data.error}`, 'error'); return; }
    toast('已触发运行，可在底部运行面板切换查看', 'success');
    onRan?.();
    load();
  });

  const toggleEnabled = (row) => act(`toggle:${row.key}`, async () => {
    const res = await fetch(apiUrl('/schedule'), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: row.key, enabled: !row.enabled }),
    });
    if (!res.ok) { toast('操作失败', 'error'); return; }
    toast(row.enabled ? '已停用，到点不再触发' : '已启用', 'info');
    load();
  });

  const doDelete = (key) => act(`del:${key}`, async () => {
    const res = await fetch(apiUrl(`/schedule?key=${encodeURIComponent(key)}`), { method: 'DELETE' });
    if (!res.ok) { toast('删除失败', 'error'); return; }
    toast('已删除', 'info');
    setConfirmDelete(null);
    load();
  });

  const startCreate = () => {
    // 预选当前打开的工作流（仅当它已保存）；草稿或未命中则用列表第一项兜底
    setEditing(currentWorkflowId && workflows.some((wf) => wf.id === currentWorkflowId)
      ? { workflowId: currentWorkflowId }
      : null);
    setMode('create');
  };

  return (
    <Modal title={mode === 'list' ? '定时任务' : mode === 'create' ? '新建定时任务' : '编辑定时任务'} onClose={mode === 'list' ? onClose : () => { setMode('list'); setEditing(null); }}>
      {mode !== 'list' ? (
        <ScheduleForm
          workflows={workflows}
          initial={editing}
          submitting={busy === 'save'}
          onSubmit={createOrUpdate}
          onCancel={() => { setMode('list'); setEditing(null); }}
        />
      ) : (
        <div className="sch-list">
          {!workflows.length && (
            <p className="panel-note">还没有已保存的工作流。先在画布保存一个工作流，再来创建定时任务。</p>
          )}
          {workflows.length > 0 && !schedules.length && (
            <div className="sch-empty">
              <p className="panel-note">还没有定时任务。三步开始：</p>
              <p className="sec-hint">1. 画布右上保存工作流 → 2. 点「新建定时任务」选周期 → 3. 到点自动运行，结果可在底部运行面板查看</p>
            </div>
          )}
          {schedules.length > 0 && (
            <div className="sch-rows">
              {schedules.map((row) => (
                <div key={row.key} className={`sch-row ${row.enabled ? '' : 'sch-row-off'}`}>
                  <div className="sch-row-main">
                    <div className="sch-row-title">
                      <strong>{row.workflowName}</strong>
                      {!row.enabled && <span className="badge">已停用</span>}
                      {row.workflowMissing && <span className="badge badge-danger">工作流已删除</span>}
                    </div>
                    <div className="sch-row-meta">
                      <span title={row.cron}>{describeCron(row.cron) || row.cron}</span>
                      <span>下次 {formatNext(row.nextAt)}</span>
                      <span>已触发 {row.fireCount ?? 0} 次{row.skippedCount ? `（跳过 ${row.skippedCount} 次）` : ''}</span>
                      <span>{row.overlap === 'parallel' ? '重叠并行' : '重叠跳过'}</span>
                    </div>
                  </div>
                  <div className="sch-row-actions">
                    <button className="btn btn-sm" disabled={Boolean(busy) || row.workflowMissing} onClick={() => runNow(row)} title="立即运行一次（不影响定时周期）">
                      {busy === `run:${row.key}` ? '运行中…' : '立即运行'}
                    </button>
                    <button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => toggleEnabled(row)}>
                      {busy === `toggle:${row.key}` ? '…' : row.enabled ? '停用' : '启用'}
                    </button>
                    <button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => { setEditing(row); setMode('edit'); }}>编辑</button>
                    <button className="btn btn-sm btn-danger" disabled={Boolean(busy)} onClick={() => setConfirmDelete(row)}>删除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {workflows.length > 0 && (
            <div className="sch-footer">
              <button className="btn btn-primary" onClick={startCreate} disabled={Boolean(busy)}>＋ 新建定时任务</button>
            </div>
          )}
          {confirmDelete && (
            <div className="sch-confirm">
              <p>确定删除「{confirmDelete.workflowName}」的定时任务（{confirmDelete.cron}）？删除后不可恢复。</p>
              <div className="sch-form-actions">
                <button className="btn" onClick={() => setConfirmDelete(null)}>取消</button>
                <button className="btn btn-danger" disabled={busy === `del:${confirmDelete.key}`} onClick={() => doDelete(confirmDelete.key)}>
                  {busy === `del:${confirmDelete.key}` ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
