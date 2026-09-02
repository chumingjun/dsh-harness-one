import { useMemo, useState } from 'react';
import { Modal } from './ui.jsx';
import { fieldKey, initialRunInputValues, schemaFields, serializeRunInputValues } from './workflow-run-inputs.js';

function displayValue(value, type) {
  if (value === undefined || value === null) return '';
  if (type === 'object' || type === 'json' || type === 'array') return JSON.stringify(value, null, 2);
  if (type === 'string[]') return Array.isArray(value) ? value.join('\n') : String(value);
  return String(value);
}

export function RunWorkflowModal({ workflow, onClose, onStart }) {
  const fields = useMemo(() => schemaFields(workflow?.inputSchema), [workflow]);
  const [triggerInput, setTriggerInput] = useState('');
  const [values, setValues] = useState(() => initialRunInputValues(workflow?.inputSchema));
  const [rawJson, setRawJson] = useState('{}');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setField = (field, value) => setValues((current) => ({ ...current, [fieldKey(field)]: value }));
  const submit = async () => {
    let runInputs;
    try {
      if (fields.length) runInputs = serializeRunInputValues(workflow.inputSchema, values);
      else {
        runInputs = rawJson.trim() ? JSON.parse(rawJson) : {};
        if (!runInputs || typeof runInputs !== 'object' || Array.isArray(runInputs)) throw new Error('运行参数必须是 JSON 对象');
      }
    } catch (e) {
      setError(e.message || '运行参数不正确');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onStart({ triggerInput, runInputs });
      onClose();
    } catch (e) {
      setError(e.message || '启动失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`启动「${workflow?.name || '工作流'}」`} onClose={busy ? undefined : onClose} className="run-workflow-modal" footer={(
      <>
        <button className="btn" disabled={busy} onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? '启动中…' : '▶ 启动'}</button>
      </>
    )}>
      <div className="run-workflow-form">
        <p className="modal-message">{workflow?.nodeCount ?? workflow?.graph?.nodes?.length ?? 0} 个节点 · 本次启动不会切换当前画布。</p>
        <label className="run-workflow-field"><span>触发输入 <em>可选</em></span><textarea rows={3} value={triggerInput} onChange={(e) => setTriggerInput(e.target.value)} placeholder="传给输入节点的文本" /></label>
        {fields.length > 0 ? fields.map((field) => {
          const key = fieldKey(field);
          const type = String(field.type || 'string').toLowerCase();
          const value = values[key];
          const label = field.label || key;
          if (Array.isArray(field.enum)) return <label className="run-workflow-field" key={key}><span>{label}{field.required && <b> *</b>}</span><select value={value ?? ''} onChange={(e) => setField(field, e.target.value)}><option value="">请选择</option>{field.enum.map((item) => <option key={item} value={item}>{item}</option>)}</select>{field.description && <small>{field.description}</small>}</label>;
          if (type === 'boolean') return <label className="run-workflow-check" key={key}><input type="checkbox" checked={value === true || value === 'true'} onChange={(e) => setField(field, e.target.checked)} /><span>{label}{field.required && <b> *</b>}</span>{field.description && <small>{field.description}</small>}</label>;
          const complex = type === 'object' || type === 'json' || type === 'array';
          return <label className="run-workflow-field" key={key}><span>{label}{field.required && <b> *</b>}</span>{complex || type === 'string[]' ? <textarea rows={complex ? 5 : 3} value={displayValue(value, type)} onChange={(e) => setField(field, e.target.value)} placeholder={complex ? 'JSON' : '每行一个值'} /> : <input type={type === 'number' ? 'number' : 'text'} value={displayValue(value, type)} onChange={(e) => setField(field, e.target.value)} />}{field.description && <small>{field.description}</small>}</label>;
        }) : <label className="run-workflow-field"><span>运行参数 <em>JSON，可选</em></span><textarea className="run-workflow-json" rows={8} value={rawJson} onChange={(e) => setRawJson(e.target.value)} placeholder={'{\n  "key": "value"\n}'} /></label>}
        {error && <div className="run-workflow-error">{error}</div>}
      </div>
    </Modal>
  );
}
