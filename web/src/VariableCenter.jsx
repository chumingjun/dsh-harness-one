import { useEffect, useMemo, useState } from 'react';
import {
  Braces, Check, ChevronRight, CircleAlert, Copy, Database, FileInput, Globe2, Plus, RefreshCw, Save, Trash2,
} from 'lucide-react';
import { Modal, useToast } from './ui.jsx';
import {
  createGlobalVariable,
  deleteGlobalVariable,
  draftToVariable,
  EMPTY_GLOBAL_VARIABLE_DRAFT,
  GLOBAL_VARIABLE_TYPES,
  GlobalVariableApiError,
  loadGlobalVariables,
  updateGlobalVariable,
  variableToDraft,
  variableToken,
} from './global-variables.js';

const SCOPE_META = {
  global: { label: '实例变量', hint: '跨工作流共享', icon: Globe2 },
  workflow: { label: '工作流变量', hint: '随当前工作流保存', icon: Braces },
  input: { label: '运行输入', hint: '每次运行提供', icon: FileInput },
};

export function VariableCenter({ onClose, workflowVariables = [], inputSchema = { fields: [] }, onGlobalChanged }) {
  const toast = useToast();
  const [scope, setScope] = useState('global');
  const [document, setDocument] = useState({ version: 1, revision: 0, variables: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_GLOBAL_VARIABLE_DRAFT);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = async ({ preserveSelection = true } = {}) => {
    setLoading(true);
    setError('');
    try {
      const next = await loadGlobalVariables();
      setDocument(next);
      const selected = preserveSelection ? next.variables.find((item) => item.id === selectedId) : null;
      const fallback = selected || next.variables[0] || null;
      setSelectedId(fallback?.id || null);
      setCreating(false);
      setDraft(fallback ? variableToDraft(fallback) : EMPTY_GLOBAL_VARIABLE_DRAFT);
    } catch (loadError) {
      setError(loadError.message || '加载实例变量失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load({ preserveSelection: false }); }, []);

  const globalItems = document.variables || [];
  const workflowItems = Array.isArray(workflowVariables) ? workflowVariables : [];
  const inputItems = Array.isArray(inputSchema?.fields) ? inputSchema.fields : [];
  const selected = globalItems.find((item) => item.id === selectedId) || null;
  const visibleItems = scope === 'global' ? globalItems : scope === 'workflow' ? workflowItems : inputItems;

  const counts = useMemo(() => ({
    global: globalItems.length,
    workflow: workflowItems.length,
    input: inputItems.length,
  }), [globalItems.length, inputItems.length, workflowItems.length]);

  const pickGlobal = (item) => {
    setCreating(false);
    setSelectedId(item.id);
    setDraft(variableToDraft(item));
    setError('');
  };

  const beginCreate = () => {
    setScope('global');
    setCreating(true);
    setSelectedId(null);
    setDraft(EMPTY_GLOBAL_VARIABLE_DRAFT);
    setError('');
  };

  const handleConflict = async (requestError) => {
    if (!(requestError instanceof GlobalVariableApiError) || requestError.code !== 'revision-conflict') return false;
    toast('变量已被其他操作修改，已刷新到最新版本', 'warn');
    await load({ preserveSelection: true });
    return true;
  };

  const saveGlobal = async () => {
    let variable;
    try { variable = draftToVariable(draft); }
    catch (validationError) { setError(validationError.message); return; }
    setBusy(true);
    setError('');
    try {
      const result = creating
        ? await createGlobalVariable(variable, document.revision)
        : await updateGlobalVariable(selected.id, variable, document.revision);
      setDocument({ version: result.version, revision: result.revision, variables: result.variables });
      setSelectedId(result.variable.id);
      setCreating(false);
      setDraft(variableToDraft(result.variable));
      toast(creating ? `已创建「${result.variable.label || result.variable.key}」` : '变量已保存', 'success');
      onGlobalChanged?.(result.revision);
    } catch (requestError) {
      if (!(await handleConflict(requestError))) setError(requestError.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const removeGlobal = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await deleteGlobalVariable(selected.id, document.revision);
      const next = result.variables[0] || null;
      setDocument({ version: result.version, revision: result.revision, variables: result.variables });
      setSelectedId(next?.id || null);
      setDraft(next ? variableToDraft(next) : EMPTY_GLOBAL_VARIABLE_DRAFT);
      toast(`已删除「${selected.label || selected.key}」`, 'warn');
      onGlobalChanged?.(result.revision);
    } catch (requestError) {
      if (!(await handleConflict(requestError))) setError(requestError.message || '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async (token) => {
    try {
      await navigator.clipboard.writeText(`{{${token}}}`);
      setCopied(token);
      setTimeout(() => setCopied(''), 1200);
    } catch { toast('复制失败，请手动选择引用', 'error'); }
  };

  return (
    <>
    <Modal title="变量与输入" onClose={onClose} className="variable-center-modal">
      <div className="variable-center">
        <aside className="vc-scopes" aria-label="变量作用域">
          <div className="vc-scope-title">作用域</div>
          {Object.entries(SCOPE_META).map(([key, meta]) => {
            const Icon = meta.icon;
            return (
              <button key={key} className={`vc-scope ${scope === key ? 'vc-scope-on' : ''}`} onClick={() => { setScope(key); setError(''); }}>
                <Icon size={16} />
                <span><strong>{meta.label}</strong><small>{meta.hint}</small></span>
                <b>{counts[key]}</b>
              </button>
            );
          })}
          <div className="vc-scope-note">
            <Database size={15} />
            <span>普通变量仅保存非敏感值。密钥和账号继续使用凭据管理。</span>
          </div>
        </aside>

        <section className="vc-list-pane">
          <header className="vc-pane-head">
            <div><strong>{SCOPE_META[scope].label}</strong><span>{visibleItems.length} 项</span></div>
            {scope === 'global' && (
              <button className="btn btn-primary btn-sm" onClick={beginCreate}><Plus size={14} /> 新建</button>
            )}
          </header>
          <div className="vc-list">
            {loading && <div className="vc-empty"><RefreshCw size={18} className="vc-spin" />正在加载</div>}
            {!loading && visibleItems.length === 0 && (
              <div className="vc-empty">
                <Database size={24} />
                <strong>{scope === 'global' ? '还没有实例变量' : '当前没有声明'}</strong>
                <span>{scope === 'global' ? '创建后即可在所有工作流中引用。' : '该作用域将在后续输入管理阶段开放维护。'}</span>
                {scope === 'global' && <button className="btn btn-sm" onClick={beginCreate}><Plus size={14} /> 创建第一个变量</button>}
              </div>
            )}
            {!loading && visibleItems.map((item) => {
              const token = variableToken(item.key, scope);
              const active = scope === 'global' && !creating && selectedId === item.id;
              return (
                <div key={item.id || item.key} className={`vc-variable-row ${active ? 'vc-variable-on' : ''}`}>
                  <button type="button" className="vc-variable-select" onClick={() => scope === 'global' && pickGlobal(item)}>
                    <span className="vc-variable-type">{item.type || 'any'}</span>
                    <span className="vc-variable-main">
                      <strong>{item.label || item.key}</strong>
                      <code>{token}</code>
                    </span>
                    {item.required && <span className="vc-required">必填</span>}
                    {scope === 'global' && <ChevronRight size={14} className="vc-row-arrow" />}
                  </button>
                  <button type="button" className="btn-icon vc-copy" aria-label={`复制 ${item.label || item.key}`} title="复制引用"
                    onClick={() => copyToken(token)}>
                    {copied === token ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
          {scope === 'global' && (
            <footer className="vc-list-foot">
              <span>Revision {document.revision}</span>
              <button className="btn-icon" title="刷新变量" aria-label="刷新变量" disabled={loading} onClick={() => load({ preserveSelection: true })}>
                <RefreshCw size={14} />
              </button>
            </footer>
          )}
        </section>

        <section className="vc-editor-pane">
          {scope !== 'global' ? (
            <div className="vc-readonly">
              <CircleAlert size={26} />
              <strong>{SCOPE_META[scope].label}当前只读</strong>
              <p>{scope === 'workflow' ? '这些声明随当前工作流保存。下一阶段会在这里增加新增、约束和引用重构。' : '运行输入来自工作流 Input Schema。下一阶段会在这里维护类型、默认值和必填规则。'}</p>
            </div>
          ) : (!creating && !selected) ? (
            <div className="vc-readonly"><Database size={26} /><strong>选择或创建变量</strong><p>右侧会显示类型、值和引用。</p></div>
          ) : (
            <GlobalVariableForm draft={draft} setDraft={setDraft} creating={creating} busy={busy} error={error}
              token={draft.key ? variableToken(draft.key) : ''} onSave={saveGlobal} onDelete={() => setConfirmDelete(true)} />
          )}
        </section>
      </div>
    </Modal>
    {confirmDelete && selected && (
      <Modal title="删除实例变量" onClose={() => setConfirmDelete(false)} className="vc-confirm-modal" footer={(
        <>
          <button className="btn" onClick={() => setConfirmDelete(false)}>取消</button>
          <button className="btn btn-danger" disabled={busy} onClick={async () => { setConfirmDelete(false); await removeGlobal(); }}>删除变量</button>
        </>
      )}>
        <p className="modal-message">确定删除「{selected.label || selected.key}」？已有模板引用不会自动移除，后续校验会把它标记为未知变量。</p>
      </Modal>
    )}
    </>
  );
}

function GlobalVariableForm({ draft, setDraft, creating, busy, error, token, onSave, onDelete }) {
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <div className="vc-form">
      <header className="vc-form-head">
        <div><strong>{creating ? '新建实例变量' : '编辑实例变量'}</strong><span>非敏感 · 实例级</span></div>
        {!creating && <button className="btn-icon vc-delete" title="删除变量" aria-label="删除变量" disabled={busy} onClick={onDelete}><Trash2 size={16} /></button>}
      </header>
      <div className="vc-form-body">
        <label className="vc-field"><span>Key <em>{creating ? '稳定引用标识' : '已被模板引用，不可直接修改'}</em></span><input autoFocus={creating} disabled={!creating} value={draft.key} onChange={(e) => set({ key: e.target.value.trim() })} placeholder="emergency_sla_minutes" /></label>
        <label className="vc-field"><span>显示名称</span><input value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="紧急上门时限" /></label>
        <label className="vc-field"><span>类型</span><select value={draft.type} onChange={(e) => set({ type: e.target.value, valueText: e.target.value === 'boolean' ? 'false' : '' })}>
          {GLOBAL_VARIABLE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.value}</option>)}
        </select></label>
        <ValueEditor draft={draft} set={set} />
        <label className="vc-field"><span>说明 <em>可选</em></span><textarea rows={3} value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="这个变量用于什么场景" /></label>
        <div className="vc-token-preview"><span>模板引用</span><code>{token ? `{{${token}}}` : '填写 Key 后生成'}</code></div>
        {error && <div className="vc-form-error"><CircleAlert size={14} />{error}</div>}
      </div>
      <footer className="vc-form-foot"><button className="btn btn-primary" disabled={busy} onClick={onSave}><Save size={15} />{busy ? '保存中' : '保存变量'}</button></footer>
    </div>
  );
}

function ValueEditor({ draft, set }) {
  if (draft.type === 'boolean') {
    return <label className="vc-field"><span>值</span><select value={draft.valueText} onChange={(e) => set({ valueText: e.target.value })}><option value="false">false</option><option value="true">true</option></select></label>;
  }
  if (draft.type === 'json') {
    return <label className="vc-field"><span>值 <em>JSON</em></span><textarea className="vc-code-input" rows={9} value={draft.valueText} onChange={(e) => set({ valueText: e.target.value })} placeholder={'{\n  "enabled": true\n}'} /></label>;
  }
  if (draft.type === 'string[]') {
    return <label className="vc-field"><span>值 <em>每行一项</em></span><textarea rows={7} value={draft.valueText} onChange={(e) => set({ valueText: e.target.value })} placeholder={'item-a\nitem-b'} /></label>;
  }
  return <label className="vc-field"><span>值</span><input type={draft.type === 'number' ? 'number' : 'text'} value={draft.valueText} onChange={(e) => set({ valueText: e.target.value })} placeholder={draft.type === 'number' ? '15' : '变量值'} /></label>;
}
