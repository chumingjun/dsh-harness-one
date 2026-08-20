import { useEffect, useMemo, useRef, useState } from 'react';

export const DEFAULT_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', description: '智能体的主要结果' },
  },
  required: ['result'],
  additionalProperties: false,
};

const FIELD_TYPES = [
  ['string', '文本'],
  ['number', '数字'],
  ['boolean', '布尔'],
  ['object', '对象'],
  ['array', '数组'],
  ['enum', '枚举'],
];

export function AgentSchemaEditor({ mode = 'text', value, onModeChange, onChange }) {
  const schema = useMemo(() => normalizeSchema(value), [value]);
  const [editorMode, setEditorMode] = useState('visual');
  const [jsonText, setJsonText] = useState(() => JSON.stringify(schema, null, 2));
  const [jsonError, setJsonError] = useState('');
  const emittedSchemaRef = useRef(null);

  useEffect(() => {
    if (emittedSchemaRef.current === value) {
      emittedSchemaRef.current = null;
      return;
    }
    setJsonText(JSON.stringify(schema, null, 2));
    setJsonError('');
  }, [schema, value]);

  const emitChange = (next) => {
    emittedSchemaRef.current = next;
    onChange?.(next);
  };
  const updateSchema = (next) => {
    setJsonText(JSON.stringify(next, null, 2));
    setJsonError('');
    emitChange(next);
  };
  const updateJson = (text) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Schema 必须是 JSON 对象');
      setJsonError('');
      emitChange(parsed);
    } catch (error) {
      setJsonError(error.message);
    }
  };

  return (
    <div className="agent-schema-editor">
      <label className="field">
        <span className="field-label">输出模式</span>
        <select value={mode} onChange={(event) => onModeChange?.(event.target.value)}>
          <option value="text">文本</option>
          <option value="structured">结构化 JSON</option>
        </select>
      </label>

      {mode === 'structured' && <div className="schema-config">
      <div className="schema-mode-tabs" role="tablist" aria-label="Schema 编辑模式">
        <button type="button" role="tab" aria-selected={editorMode === 'visual'}
          className={editorMode === 'visual' ? 'schema-tab schema-tab-on' : 'schema-tab'}
          onClick={() => setEditorMode('visual')}>可视化</button>
        <button type="button" role="tab" aria-selected={editorMode === 'json'}
          className={editorMode === 'json' ? 'schema-tab schema-tab-on' : 'schema-tab'}
          onClick={() => setEditorMode('json')}>高级 JSON</button>
      </div>

      {editorMode === 'visual' ? (
        <ObjectFields schema={schema} onChange={updateSchema} root />
      ) : (
        <div className="schema-json-editor">
          <textarea rows={14} spellCheck="false" value={jsonText} onChange={(event) => updateJson(event.target.value)} />
          {jsonError && <p className="panel-error">JSON 无效：{jsonError}</p>}
        </div>
      )}
      </div>}
    </div>
  );
}

function ObjectFields({ schema, onChange, root = false }) {
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const entries = Object.entries(properties);

  const updateField = (oldName, nextName, nextField, isRequired) => {
    const nextProperties = {};
    for (const [name, field] of entries) {
      if (name === oldName) nextProperties[nextName] = nextField;
      else nextProperties[name] = field;
    }
    const nextRequired = [...required].filter((name) => name !== oldName);
    if (isRequired && nextName) nextRequired.push(nextName);
    onChange({
      ...schema,
      type: 'object',
      properties: nextProperties,
      required: [...new Set(nextRequired)],
      additionalProperties: false,
    });
  };

  const addField = () => {
    const name = uniqueFieldName(properties, 'field');
    onChange({
      ...schema,
      type: 'object',
      properties: { ...properties, [name]: { type: 'string' } },
      required: schema.required || [],
      additionalProperties: false,
    });
  };

  const removeField = (name) => {
    const nextProperties = { ...properties };
    delete nextProperties[name];
    onChange({
      ...schema,
      properties: nextProperties,
      required: [...required].filter((item) => item !== name),
    });
  };

  return (
    <div className={root ? 'schema-object schema-root' : 'schema-object'}>
      {entries.length === 0 && <p className="sec-hint">暂无字段，添加后模型必须按字段返回 JSON。</p>}
      {entries.map(([name, field]) => (
        <SchemaField key={name} name={name} schema={field} required={required.has(name)}
          onChange={(nextName, nextField, nextRequired) => updateField(name, nextName, nextField, nextRequired)}
          onRemove={() => removeField(name)} />
      ))}
      <button type="button" className="btn btn-sm schema-add" onClick={addField}>+ 添加字段</button>
    </div>
  );
}

function SchemaField({ name, schema, required, onChange, onRemove }) {
  const [nameDraft, setNameDraft] = useState(name);
  const displayType = schema.enum ? 'enum' : schema.type || 'string';
  const itemType = schema.items?.enum ? 'enum' : schema.items?.type || 'string';
  const emit = (patch) => onChange(name, { ...schema, ...patch }, required);
  const commitName = () => {
    const nextName = nameDraft.trim() || name;
    setNameDraft(nextName);
    if (nextName !== name) onChange(nextName, schema, required);
  };

  const changeType = (type) => {
    let next;
    if (type === 'enum') next = { type: 'string', enum: ['option_a', 'option_b'] };
    else if (type === 'object') next = { type: 'object', properties: {}, required: [], additionalProperties: false };
    else if (type === 'array') next = { type: 'array', items: { type: 'string' } };
    else next = { type };
    if (schema.description) next.description = schema.description;
    onChange(name, next, required);
  };

  const changeArrayItemType = (type) => {
    let items;
    if (type === 'enum') items = { type: 'string', enum: ['option_a', 'option_b'] };
    else if (type === 'object') items = { type: 'object', properties: {}, required: [], additionalProperties: false };
    else items = { type };
    emit({ items });
  };

  return (
    <div className="schema-field-row">
      <div className="schema-field-main">
        <input aria-label="字段名" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)}
          onBlur={commitName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        <select aria-label={`${name} 类型`} value={displayType} onChange={(event) => changeType(event.target.value)}>
          {FIELD_TYPES.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
        <label className="schema-required">
          <input type="checkbox" checked={required} onChange={(event) => onChange(name, schema, event.target.checked)} />
          <span>必填</span>
        </label>
        <button type="button" className="btn-icon schema-remove" title="删除字段" aria-label={`删除字段 ${name}`} onClick={onRemove}>×</button>
      </div>
      <input className="schema-description" aria-label={`${name} 描述`} placeholder="字段描述"
        value={schema.description || ''} onChange={(event) => emit({ description: event.target.value || undefined })} />

      {displayType === 'enum' && (
        <input aria-label={`${name} 枚举值`} placeholder="枚举值，逗号分隔"
          value={(schema.enum || []).join(', ')}
          onChange={(event) => emit({ type: 'string', enum: splitEnum(event.target.value) })} />
      )}

      {displayType === 'object' && (
        <ObjectFields schema={schema} onChange={(next) => onChange(name, next, required)} />
      )}

      {displayType === 'array' && (
        <div className="schema-array-items">
          <span className="field-label">数组元素</span>
          <select value={itemType} onChange={(event) => changeArrayItemType(event.target.value)}>
            {FIELD_TYPES.filter(([type]) => type !== 'array').map(([type, label]) => <option key={type} value={type}>{label}</option>)}
          </select>
          {itemType === 'enum' && (
            <input placeholder="枚举值，逗号分隔" value={(schema.items?.enum || []).join(', ')}
              onChange={(event) => emit({ items: { type: 'string', enum: splitEnum(event.target.value) } })} />
          )}
          {itemType === 'object' && (
            <ObjectFields schema={schema.items || { type: 'object' }}
              onChange={(items) => emit({ items })} />
          )}
        </div>
      )}
    </div>
  );
}

function normalizeSchema(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 使用默认 Schema */ }
  }
  return DEFAULT_AGENT_SCHEMA;
}

function uniqueFieldName(properties, prefix) {
  let index = Object.keys(properties).length + 1;
  let name = `${prefix}_${index}`;
  while (properties[name]) {
    index += 1;
    name = `${prefix}_${index}`;
  }
  return name;
}

function splitEnum(value) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}
