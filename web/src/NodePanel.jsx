// 右侧属性面板 v5：分区折叠 + 字段网格 + 统一控件样式。
// 真实类型在 data.nodeType（画布节点统一是 propertyNode）。
// 设计规范：每节点 3-5 个分区；分区可折叠（高级项默认收起）；字段一律 label 上、控件下；emoji 不做图标。

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, FlaskConical, Plus, Trash2, X } from 'lucide-react';
import { apiUrl } from './api.js';
import { TemplateEditor } from './TemplateEditor.jsx';
import { ScriptCodeEditor } from './ScriptCodeEditor.jsx';
import {
  formatScriptConstant,
  normalizeScriptInputs,
  parseScriptConstant,
  validateScriptInputs,
} from './script-parameters.js';
import { buildFallbackSchema, describeVariables } from './variables.js';
import { buildVariableScopeSnapshot } from './variable-scope.js';
import { AgentSchemaEditor, DEFAULT_AGENT_SCHEMA } from './AgentSchemaEditor.jsx';
import { ArtifactLinks } from './ArtifactPreview.jsx';
import MarkdownDocument from './MarkdownDocument.jsx';
import { Modal } from './ui.jsx';

const TOOL_LABELS = {
  read_file: '读附件',
  web_fetch: '抓网页',
  feishu_doc_read: '读飞书文档',
  feishu_doc_write: '写飞书文档',
};

const TYPE_TEXT = { input: '输入', agent: '智能体', output: '输出', condition: '条件', http: 'HTTP', script: '脚本', notify: '消息通知', note: '注释' };

/** 面板实时活动区的跳秒计时：每秒重渲染（仅运行中挂载） */
function useElapsedTick(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

function formatElapsed(startedAt) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 可折叠分区：open 受控（非受控时 defaultOpen 兜底），标题 + 提示 + 计数徽标 */
function Section({ title, hint, count, defaultOpen = true, open, onToggle, children }) {
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  const isOpen = open !== undefined ? open : selfOpen;
  const toggle = () => (onToggle ? onToggle() : setSelfOpen((v) => !v));
  return (
    <section className={`panel-sec ${isOpen ? '' : 'sec-closed'}`}>
      <button type="button" className="sec-head" onClick={toggle} aria-expanded={isOpen}>
        <ChevronRight size={13} className={`sec-caret ${isOpen ? 'sec-caret-open' : ''}`} />
        <span className="sec-title">{title}</span>
        {hint && <span className="sec-hint">{hint}</span>}
        {count ? <span className="sec-count">{count}</span> : null}
      </button>
      {isOpen && <div className="sec-body">{children}</div>}
    </section>
  );
}

/** 字段行：label 在上、控件在下（表单规范：可见标签，不靠 placeholder） */
function Field({ label, hint, children, wide }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">{label}{hint && <em className="field-hint">{hint}</em>}</span>
      {children}
    </label>
  );
}

function ScriptParameterRow({ input, index, error, templateProps, onChange, onRemove }) {
  const expressionMode = Object.prototype.hasOwnProperty.call(input, 'expression');
  const [constantText, setConstantText] = useState(() => formatScriptConstant(input.value));
  const [constantError, setConstantError] = useState('');

  useEffect(() => {
    if (!expressionMode) setConstantText(formatScriptConstant(input.value));
  }, [expressionMode, input.value]);

  const changeMode = (nextMode) => {
    setConstantError('');
    onChange(nextMode === 'expression'
      ? { name: input.name, expression: '' }
      : { name: input.name, value: null });
  };
  const changeConstant = (text) => {
    setConstantText(text);
    const parsed = parseScriptConstant(text);
    setConstantError(parsed.ok ? '' : parsed.error);
    if (parsed.ok) onChange({ name: input.name, value: parsed.value });
  };

  return (
    <div className="script-param-row">
      <div className="script-param-head">
        <input aria-label={`参数 ${index + 1} 名称`} value={input.name}
          onChange={(event) => onChange({ ...input, name: event.target.value })} placeholder="parameterName" />
        <div className="script-param-mode" role="group" aria-label={`参数 ${index + 1} 值模式`}>
          <button type="button" className={expressionMode ? 'script-mode-on' : ''} onClick={() => changeMode('expression')}>表达式</button>
          <button type="button" className={!expressionMode ? 'script-mode-on' : ''} onClick={() => changeMode('constant')}>常量</button>
        </div>
        <button type="button" className="btn-icon script-param-remove" title="删除参数" aria-label={`删除参数 ${index + 1}`} onClick={onRemove}><Trash2 size={14} /></button>
      </div>
      {error && <p className="script-param-error">{error}</p>}
      {expressionMode ? (
        <TemplateEditor
          {...templateProps}
          label="参数值" hint="从变量工作台插入规范表达式"
          rows={1}
          value={input.expression}
          onChange={(expression) => onChange({ name: input.name, expression })}
          placeholder={'{{node["input"].data}}'}
          compact
          singleLine
        />
      ) : (
        <Field label="参数值" hint="JSON，保留字符串/数字/布尔/对象/数组/null" wide>
          <textarea rows={3} spellCheck="false" className="script-json-input" value={constantText}
            onChange={(event) => changeConstant(event.target.value)} />
          {constantError && <span className="script-param-error">JSON 无效：{constantError}</span>}
        </Field>
      )}
    </div>
  );
}

export function NodePanel({ node, onChange, onDelete, onTest, onClose, availableTools = [], skills = [], feishuEnabled = false, feishuCreds = [], notificationChannels = [], llmConfig = {}, upstreamNodes = [], upstreamPreviews = {}, graph, workflowId, runId, workflowVariables, inputSchema, runInputs, triggerInput, globalVariableEpoch, progress }) {
  if (!node) return null;
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const d = node.data || {};
  const nodeType = d.nodeType || node.type;
  const notifyTargetType = d.channelConfig?.targetType || 'chat_id';
  useElapsedTick(d.runStatus === 'running');
  const set = (patch) => onChange(node.id, patch);
  const selectedTools = Array.isArray(d.tools) ? d.tools : [];
  const selectedSkills = Array.isArray(d.skills) ? d.skills : [];
  const scriptInputs = normalizeScriptInputs(d.inputs);
  const scriptInputErrors = validateScriptInputs(scriptInputs);
  const providers = Array.isArray(llmConfig.providers) ? llmConfig.providers : [];
  const effectiveProvider = d.channel || llmConfig.defaultProvider || '';
  const providerModels = providers.find((provider) => provider.id === effectiveProvider)?.models || [];
  const modelDefaultLabel = d.channel
    ? `渠道默认（${providerModels[0]?.name || providerModels[0]?.id || '未配置'}）`
    : `跟随 dsh 默认（${llmConfig.defaultModel || '未配置'}）`;

  const selectProvider = (providerId) => {
    if (!providerId) {
      set({ channel: undefined, model: undefined });
      return;
    }
    const models = providers.find((provider) => provider.id === providerId)?.models || [];
    const model = models.some((item) => item.id === d.model) ? d.model : models[0]?.id;
    set({ channel: providerId, model });
  };

  const toggleTool = (name) => {
    const next = selectedTools.includes(name) ? selectedTools.filter((t) => t !== name) : [...selectedTools, name];
    set({ tools: next });
  };

  const uploadAttachment = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const contentBase64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
    const res = await fetch(apiUrl('/attachments'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentBase64 }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '上传失败'); return; }
    set({ attachments: [...(d.attachments || []), { id: data.id, filename: data.filename, size: data.size }] });
    e.target.value = '';
  };

  const removeAttachment = (attachment) => {
    const query = attachment.id
      ? `id=${encodeURIComponent(attachment.id)}`
      : `filename=${encodeURIComponent(attachment.filename)}`;
    fetch(apiUrl(`/attachments?${query}`), { method: 'DELETE' }).catch(() => {});
    set({ attachments: (d.attachments || []).filter((item) => (
      attachment.id ? item.id !== attachment.id : item.filename !== attachment.filename
    )) });
  };

  const runtimeContext = useMemo(() => {
    const outputs = {};
    const structuredOutputs = {};
    const nodeStates = {};
    for (const upstream of upstreamNodes) {
      const preview = upstream.output ?? upstreamPreviews[upstream.id] ?? upstreamPreviews[upstream.label];
      if (preview !== undefined) outputs[upstream.id] = preview;
      if (upstream.structuredOutput !== undefined) structuredOutputs[upstream.id] = upstream.structuredOutput;
      if (upstream.nodeState) nodeStates[upstream.id] = upstream.nodeState;
    }
    return { outputs, structuredOutputs, nodeStates };
  }, [upstreamNodes, upstreamPreviews]);

  const computedVariableScope = buildVariableScopeSnapshot(graph, node.id, {
    ...runtimeContext,
    workflowId,
    runId,
    workflowVariables,
    inputSchema,
    runInputs,
    triggerInput,
    globalVariableEpoch,
  });
  const stableVariableScopeRef = useRef(computedVariableScope);
  if (stableVariableScopeRef.current.key !== computedVariableScope.key) {
    stableVariableScopeRef.current = computedVariableScope;
  }
  const variableScope = stableVariableScopeRef.current;
  const fallbackVariables = useMemo(() => buildFallbackSchema({
    graph: variableScope.graph,
    targetNodeId: node.id,
    upstreamPreviews: variableScope.outputs,
  }), [node.id, variableScope]);
  const [variableSchema, setVariableSchema] = useState(fallbackVariables);
  const variableRequestRef = useRef(0);
  const variableScopeRef = useRef(variableScope.key);

  useEffect(() => {
    const scopeChanged = variableScopeRef.current !== variableScope.key;
    variableScopeRef.current = variableScope.key;
    if (scopeChanged) setVariableSchema(fallbackVariables);

    const controller = new AbortController();
    const requestId = ++variableRequestRef.current;
    describeVariables({
      graph: variableScope.graph,
      targetNodeId: node.id,
      workflowId,
      runId,
      outputs: variableScope.outputs,
      structuredOutputs: variableScope.structuredOutputs,
      nodeStates: variableScope.nodeStates,
      triggerInput: variableScope.triggerInput,
      runInputs: variableScope.runInputs,
      workflowVariables: variableScope.workflowVariables,
      inputSchema: variableScope.inputSchema,
    }, controller.signal).then((schema) => {
      if (!controller.signal.aborted && requestId === variableRequestRef.current) setVariableSchema(schema);
    }).catch(() => {});
    return () => controller.abort();
  }, [fallbackVariables, node.id, runId, variableScope, workflowId]);

  const variableContext = useMemo(() => ({
    graph: variableScope.graph,
    targetNodeId: node.id,
    workflowId,
    runId,
    outputs: variableScope.outputs,
    structuredOutputs: variableScope.structuredOutputs,
    nodeStates: variableScope.nodeStates,
    triggerInput: variableScope.triggerInput,
    runInputs: variableScope.runInputs,
    workflowVariables: variableScope.workflowVariables,
    inputSchema: variableScope.inputSchema,
  }), [node.id, runId, variableScope, workflowId]);
  const templateProps = useMemo(() => ({
    variables: variableSchema.items,
    variableFallback: variableSchema.fallback,
    variableMessage: variableSchema.message,
    variableContext,
  }), [variableContext, variableSchema]);

  const copyOutput = async () => {
    await navigator.clipboard?.writeText(d.runOutput || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  // 输出预览弹窗：输出节点的最终产物多为 Markdown（工单/报告），按渲染视图查看
  const [previewOpen, setPreviewOpen] = useState(false);

  const runTest = async () => {
    setTesting(true);
    try { await onTest?.(node); } finally { setTesting(false); }
  };

  return (
    <aside className="panel node-panel">
      <header className="node-panel-head">
        <span className={`type-chip type-${nodeType}`}>{TYPE_TEXT[nodeType] || nodeType}</span>
        <input className="title-input" value={d.label || ''} onChange={(e) => set({ label: e.target.value })} placeholder="节点名称" />
        {nodeType !== 'notify' && <button className="btn-icon" title="试运行此节点" aria-label="试运行此节点" onClick={runTest} disabled={testing}><FlaskConical size={15} className={testing ? 'icon-working' : ''} /></button>}
        <button className="btn-icon" title="删除节点" aria-label="删除节点" onClick={() => onDelete(node.id)}><Trash2 size={15} /></button>
        <button className="btn-icon" title="关闭面板" aria-label="关闭面板" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="node-panel-scroll">
      {/* 运行中实时活动区：置顶第一屏——计时/轮次/流式预览，点开节点立刻知道它在干嘛 */}
      {d.runStatus === 'running' && (
        <div className="live-strip">
          <span className="live-strip-dot" aria-hidden="true" />
          <span className="live-strip-title">正在执行</span>
          {d.runStartedAt && <span className="live-strip-elapsed">{formatElapsed(d.runStartedAt)}</span>}
          {progress?.turns != null && <span className="live-strip-turns">第 {progress.turns} 轮{progress.maxRounds ? ` / 上限 ${progress.maxRounds}` : ''}</span>}
          {(d.livePreview || progress?.preview) && (
            <pre className="live-strip-preview">{String(d.livePreview || progress.preview).slice(-400)}</pre>
          )}
        </div>
      )}
      {nodeType === 'input' && (
        <>
          <Section title="输入内容" hint="支持 {{上游变量}}">
            <TemplateEditor
              {...templateProps}
              label="输入内容" hint="支持变量和运行上下文"
              rows={6}
              value={d.text || ''}
              onChange={(v) => set({ text: v })}
              placeholder={'报修描述…\n或直接粘贴飞书文档链接'}
            />
            {hasFeishuLink(d.text) && (
              <p className={`panel-note ${feishuEnabled ? 'note-ok' : 'note-warn'}`}>
                {feishuEnabled ? '检测到飞书链接：运行时将注入文档全文' : '检测到飞书链接：未配置凭据，运行时注入占位说明'}
              </p>
            )}
          </Section>
          <Section title="附件" hint="文本直接注入，其余供读取" count={(d.attachments || []).length || undefined} defaultOpen={false}>
            <div className="field-actions">
              <input type="file" onChange={uploadAttachment} className="file-input" />
            </div>
            {(d.attachments || []).map((a) => (
              <div key={a.id || a.filename} className="attachment-row">
                <span className="att-name">{a.filename}</span>
                <span className="att-size">{(a.size / 1024).toFixed(1)}KB</span>
                <button className="btn btn-sm" onClick={() => removeAttachment(a)}>移除</button>
              </div>
            ))}
          </Section>
        </>
      )}

      {nodeType === 'condition' && (
        <>
          <Section title="判定文本">
            <TemplateEditor
              {...templateProps}
              label="判定文本" hint="留空时取全部上游输出"
              rows={3}
              value={d.inputTemplate || ''}
              onChange={(v) => set({ inputTemplate: v })}
              placeholder="留空 = 全部上游输出"
            />
          </Section>
          <Section title="命中 / 排除" hint="关键词逗号或换行分隔">
            <Field label="命中条件" hint="任一关键词 → 走「是」" wide>
              <textarea rows={2} value={d.include || ''} onChange={(e) => set({ include: e.target.value })}
                placeholder={'紧急, 漏水, 爆管\n留空 = 默认命中'} />
            </Field>
            <Field label="排除条件" hint="任一关键词 → 走「否」" wide>
              <textarea rows={2} value={d.exclude || ''} onChange={(e) => set({ exclude: e.target.value })}
                placeholder="咨询, 无需上门" />
            </Field>
            <p className="sec-hint">命中「是」走 branch=true 连线；「否」走 false。选中连线可改分支。</p>
          </Section>
        </>
      )}

      {nodeType === 'http' && (
        <>
          <Section title="请求">
            <Field label="方法">
              <select value={d.method || 'GET'} onChange={(e) => set({ method: e.target.value })}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
            <TemplateEditor
              {...templateProps}
              label="URL" hint="支持变量"
              rows={1}
              value={d.url || ''}
              onChange={(v) => set({ url: v })}
              placeholder="https://api.example.com/x"
              compact
              singleLine
            />
            <TemplateEditor
              {...templateProps}
              label="请求头" hint="每行 Key: Value"
              rows={2}
              value={d.headers || ''}
              onChange={(v) => set({ headers: v })}
              placeholder="Authorization: Bearer token"
            />
            <TemplateEditor
              {...templateProps}
              label="请求体" hint="默认 JSON"
              rows={4}
              value={d.body || ''}
              onChange={(v) => set({ body: v })}
              placeholder={'{"query":"{{node[\\"input\\"].data}}"}'}
              mode="json"
            />
          </Section>
          <Section title="响应处理" defaultOpen={false}>
            <div className="check-stack">
              <label className="check-row">
                <input type="checkbox" checked={d.failOnError !== false} onChange={(e) => set({ failOnError: e.target.checked || undefined })} />
                <span>非 2xx 状态码算失败</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={Boolean(d.allowPrivate)} onChange={(e) => set({ allowPrivate: e.target.checked || undefined })} />
                <span>允许访问内网地址</span>
              </label>
            </div>
            <Field label="响应上限（字符）">
              <input type="number" min="1000" max="200000" value={d.maxChars ?? ''}
                onChange={(e) => set({ maxChars: e.target.value === '' ? undefined : Number(e.target.value) })}
                placeholder="65536" />
            </Field>
            <p className="sec-hint">响应会保存为结构化数据；下游从变量树选择 status、headers、body 或 json 子字段。</p>
          </Section>
        </>
      )}

      {nodeType === 'script' && (
        <>
          <Section title="输入参数" hint="命名后传入 main(input, workspace)" count={scriptInputs.length || undefined}>
            <div className="script-param-list">
              {scriptInputs.map((input, index) => (
                <ScriptParameterRow
                  key={index}
                  input={input}
                  index={index}
                  error={scriptInputErrors[index]}
                  templateProps={templateProps}
                  onChange={(nextInput) => set({ inputs: scriptInputs.map((item, itemIndex) => itemIndex === index ? nextInput : item) })}
                  onRemove={() => set({ inputs: scriptInputs.filter((_, itemIndex) => itemIndex !== index) })}
                />
              ))}
            </div>
            <button type="button" className="btn btn-sm script-param-add"
              onClick={() => set({ inputs: [...scriptInputs, { name: '', expression: '' }] })}>
              <Plus size={14} />添加参数
            </button>
          </Section>

          <Section title="JavaScript 代码" hint="按原文保存，不解析模板">
            <p className="sec-hint">入口函数 main(input, workspace)，return 值即节点输出；input 来自上方输入参数。</p>
            <ScriptCodeEditor
              value={d.code ?? 'function main(input, workspace) {\n  return input;\n}'}
              onChange={(code) => set({ code })}
            />
          </Section>

          <Section title="输出 Schema" hint="可选" defaultOpen={Boolean(d.outputSchema)}>
            <label className="check-row">
              <input type="checkbox" checked={Boolean(d.outputSchema)}
                onChange={(event) => set({ outputSchema: event.target.checked ? DEFAULT_AGENT_SCHEMA : undefined })} />
              <span>校验结构化输出</span>
            </label>
            {d.outputSchema && (
              <AgentSchemaEditor mode="structured" fixedMode value={d.outputSchema}
                onChange={(outputSchema) => set({ outputSchema })} />
            )}
          </Section>

          <Section title="脚本限制" hint="JavaScript" defaultOpen={false}>
            <Field label="执行超时（毫秒）" hint="100 - 10000">
              <input type="number" min="100" max="10000" step="100" value={d.scriptTimeoutMs ?? 1000}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  set({ scriptTimeoutMs: Math.max(100, Math.min(10000, Number.isFinite(value) ? value : 1000)) });
                }} />
            </Field>
          </Section>
        </>
      )}

      {nodeType === 'agent' && (
        <>
          <Section title="提示词">
            <TemplateEditor
              {...templateProps}
              label="系统提示词" hint="支持变量"
              rows={6}
              value={d.prompt || ''}
              onChange={(v) => set({ prompt: v })}
              placeholder="你是物业客服助手…"
              implicitUpstream={false}
            />
            <TemplateEditor
              {...templateProps}
              label="输入模板" hint="留空时注入全部上游"
              rows={4}
              value={d.inputTemplate || ''}
              onChange={(v) => set({ inputTemplate: v })}
              placeholder={'请整理以下报修信息：{{node["input"].data}}'}
            />
          </Section>

          <Section title="结构化输出" hint="Schema" defaultOpen={false}>
            <AgentSchemaEditor
              mode={d.outputMode || 'text'}
              value={d.outputSchema}
              onModeChange={(outputMode) => set({ outputMode })}
              onChange={(outputSchema) => set({ outputSchema })}
            />
          </Section>

          <Section title="工具" hint="勾选后仅这些可用" count={selectedTools.length || undefined} defaultOpen={false}>
            <div className="tool-chips">
              {availableTools.map((t) => {
                const on = selectedTools.includes(t.name);
                return (
                  <button key={t.name} className={`chip ${on ? 'chip-on' : ''}`} title={t.description} onClick={() => toggleTool(t.name)}>
                    {TOOL_LABELS[t.name] || t.name}
                  </button>
                );
              })}
            </div>
            {selectedTools.length === 0 && <p className="sec-hint">未勾选 = 全部注册工具可用</p>}
          </Section>

          {skills.length > 0 && (
            <Section title="技能" hint="dsh 技能目录，勾选后定向提示" count={selectedSkills.length || undefined} defaultOpen={false}>
              <div className="tool-chips">
                {skills.map((sk) => {
                  const on = selectedSkills.includes(sk.id) || selectedSkills.includes(sk.name);
                  return (
                    <button key={sk.id} className={`chip ${on ? 'chip-on' : ''}`} title={sk.description}
                      onClick={() => {
                        const next = on
                          ? selectedSkills.filter((x) => x !== sk.id && x !== sk.name)
                          : [...selectedSkills, sk.name];
                        set({ skills: next });
                      }}>
                      {sk.name}
                    </button>
                  );
                })}
              </div>
              {selectedSkills.length === 0 && <p className="sec-hint">未选技能：按会话默认技能目录执行</p>}
            </Section>
          )}

          <Section title="模型与轮次" hint="留空用全局默认" defaultOpen={false}>
            <div className="field-grid">
              <Field label="渠道">
                <select value={d.channel || ''} onChange={(e) => selectProvider(e.target.value)}>
                  <option value="">跟随 dsh 默认（{llmConfig.defaultProvider || '未配置'}）</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
                  ))}
                </select>
              </Field>
              <Field label="模型">
                <select value={d.model || ''} onChange={(e) => set({ model: e.target.value || undefined })} disabled={!effectiveProvider}>
                  <option value="">{modelDefaultLabel}</option>
                  {d.model && !providerModels.some((model) => model.id === d.model) && (
                    <option value={d.model}>{d.model}（目录中不可用）</option>
                  )}
                  {providerModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.name || model.id}</option>
                  ))}
                </select>
              </Field>
            </div>
            {llmConfig.failures?.length > 0 && (
              <p className="panel-note note-warn">部分 dsh 渠道的模型目录加载失败。</p>
            )}
            <div className="field-grid">
              <Field label="轮数上限">
                <input type="number" min="1" max="20" value={d.maxRounds ?? ''}
                  onChange={(e) => set({ maxRounds: e.target.value === '' ? undefined : Number(e.target.value) })}
                  placeholder={String(llmConfig.defaultMaxRounds || 6)} />
              </Field>
              <Field label="超时（秒）">
                <input type="number" min="10" max="3600" value={d.timeoutSec ?? ''}
                  onChange={(e) => set({ timeoutSec: e.target.value === '' ? undefined : Number(e.target.value) })}
                  placeholder="300" />
              </Field>
            </div>
          </Section>
        </>
      )}

      {nodeType === 'output' && (
        <>
          <Section title="输出模板" hint="留空 = 汇总全部上游">
            <TemplateEditor
              {...templateProps}
              label="输出模板" hint="留空时汇总全部上游"
              rows={3}
              value={d.inputTemplate || ''}
              onChange={(v) => set({ inputTemplate: v })}
              placeholder={'最终工单：{{node["agent"].data}}'}
            />
          </Section>
          <Section title="运行后动作" hint="结束自动执行">
            <Field label="动作">
              <select
                value={d.writeback?.type || 'none'}
                onChange={(e) => {
                  const type = e.target.value;
                  if (type === 'none') return set({ writeback: undefined });
                  if (type === 'feishu-new') return set({ writeback: { type, docTitle: d.writeback?.docTitle || '' } });
                  if (type === 'feishu-append') return set({ writeback: { type, targetToken: d.writeback?.targetToken || '' } });
                }}>
                <option value="none">仅文本输出</option>
                <option value="feishu-new">写入新建飞书文档</option>
                <option value="feishu-append">追加到指定飞书文档</option>
              </select>
            </Field>
            {d.writeback?.type === 'feishu-new' && (
              <Field label="文档标题" hint="留空自动生成" wide>
                <input placeholder="新文档标题" value={d.writeback.docTitle || ''}
                  onChange={(e) => set({ writeback: { ...d.writeback, docTitle: e.target.value } })} />
              </Field>
            )}
            {d.writeback?.type === 'feishu-append' && (
              <Field label="目标文档 token" hint="docx 链接末段" wide>
                <input placeholder="docx 文档 token" value={d.writeback.targetToken || ''}
                  onChange={(e) => set({ writeback: { ...d.writeback, targetToken: e.target.value.trim() } })} />
              </Field>
            )}
            {d.writeback?.type !== 'none' && feishuCreds.length > 0 && (
              <Field label="使用凭据">
                <select value={d.feishuCredId || ''} onChange={(e) => set({ feishuCredId: e.target.value || undefined })}>
                  <option value="">默认凭据</option>
                  {feishuCreds.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.isDefault ? '（默认）' : ''}</option>
                  ))}
                </select>
              </Field>
            )}
            {!feishuEnabled && d.writeback?.type !== 'none' && (
              <p className="panel-note note-warn">飞书未配置（右上「设置」添加应用凭据），运行时写回将跳过</p>
            )}
          </Section>
        </>
      )}

      {nodeType === 'notify' && (
        <>
          <Section title="消息渠道" hint="运行观察器，连线与否均生效">
            <div className="field-grid">
              <Field label="渠道">
                <select value={d.channel || 'feishu'} onChange={(e) => set({ channel: e.target.value, channelConfig: {} })}>
                  {(notificationChannels.length ? notificationChannels : [{ id: 'feishu', label: '飞书' }]).map((channel) => (
                    <option key={channel.id} value={channel.id}>{channel.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="通知模式">
                <select value={d.mode || 'terminal'} onChange={(e) => set({ mode: e.target.value })}>
                  <option value="terminal">仅运行结束</option>
                  <option value="each_node">每个节点完成</option>
                </select>
              </Field>
            </div>
            {(d.channel || 'feishu') === 'feishu' && (
              <>
                <Field label="接收方式">
                  <select
                    value={notifyTargetType}
                    onChange={(e) => set({ channelConfig: { ...d.channelConfig, targetType: e.target.value, targetId: '' } })}>
                    <option value="chat_id">群聊</option>
                    <option value="open_id">私聊</option>
                  </select>
                </Field>
                <Field
                  label={notifyTargetType === 'open_id' ? '用户 open_id' : '群聊 chat_id'}
                  hint={notifyTargetType === 'open_id' ? '机器人应用可用范围需包含该用户' : '机器人需已加入目标群'}
                  wide>
                  <input
                    value={d.channelConfig?.targetId || ''}
                    onChange={(e) => set({ channelConfig: { ...d.channelConfig, targetType: notifyTargetType, targetId: e.target.value.trim() } })}
                    placeholder={notifyTargetType === 'open_id' ? 'ou_xxxxxxxxxxxxxxxx' : 'oc_xxxxxxxxxxxxxxxx'} />
                </Field>
                {feishuCreds.length > 0 && (
                  <Field label="使用凭据">
                    <select
                      value={d.channelConfig?.credentialId || ''}
                      onChange={(e) => set({ channelConfig: { ...d.channelConfig, credentialId: e.target.value || undefined } })}>
                      <option value="">默认凭据</option>
                      {feishuCreds.map((credential) => (
                        <option key={credential.id} value={credential.id}>{credential.name}{credential.isDefault ? '（默认）' : ''}</option>
                      ))}
                    </select>
                  </Field>
                )}
                {!feishuEnabled && <p className="panel-note note-warn">飞书未配置（右上“设置”添加应用凭据）</p>}
              </>
            )}
          </Section>
        </>
      )}

      {nodeType === 'note' && (
        <Section title="说明内容" hint="画布便签，不参与运行">
          <Field label="内容" wide>
            <textarea rows={6} value={d.text || ''} onChange={(e) => set({ text: e.target.value })}
              placeholder="这一段流程做什么、负责人是谁、注意事项…" />
          </Field>
        </Section>
      )}

      {nodeType !== 'note' && nodeType !== 'notify' && (
        <Section title="执行容错" hint="重试 / 失败继续 / 超时" defaultOpen={false}>
          <div className={nodeType === 'script' ? '' : 'field-grid'}>
            <Field label="失败重试">
              <select value={String(d.retryCount ?? 0)} onChange={(e) => set({ retryCount: Number(e.target.value) || undefined })}>
                <option value="0">不重试</option>
                <option value="1">重试 1 次</option>
                <option value="2">重试 2 次</option>
                <option value="3">重试 3 次</option>
              </select>
            </Field>
            {nodeType !== 'script' && (
              <Field label="超时（秒）">
                <input type="number" min="5" max="3600" value={d.timeoutSec ?? ''}
                  onChange={(e) => set({ timeoutSec: e.target.value === '' ? undefined : Number(e.target.value) })}
                  placeholder="300" />
              </Field>
            )}
          </div>
          {nodeType !== 'agent' && (
            <label className="check-row">
              <input type="checkbox" checked={Boolean(d.continueOnFail)} onChange={(e) => set({ continueOnFail: e.target.checked || undefined })} />
              <span>失败后继续<em className="field-hint">下游照常执行</em></span>
            </label>
          )}
        </Section>
      )}

      <section className="panel-sec sec-result">
        {d.runStatus === 'running' && (
          <div className="live-progress">
            <div className="result-head">
              <span className="result-title">执行中</span>
              <span className="sec-hint">第 {progress?.turns || '?'} 轮{progress?.maxRounds ? ` / 上限 ${progress.maxRounds}` : ''}</span>
            </div>
            {progress?.preview && <pre className="panel-output live-out">{String(progress.preview).slice(-400)}</pre>}
          </div>
        )}
        {d.runOutput !== undefined && (
          <>
            <div className="result-head">
              <span className="result-title">{d.test ? '试运行输出' : '最近运行输出'}</span>
              <span className="sec-hint">
                {d.runtimeModel && `· ${d.runtimeModel} `}
                {d.durationMs != null && `· ${(d.durationMs / 1000).toFixed(1)}s`}
                {d.runChars > (d.runOutput || '').length ? ` （前 ${(d.runOutput || '').length}/${d.runChars} 字）` : ''}
              </span>
            </div>
            <pre className="panel-output">{d.runOutput || '(空结果)'}</pre>
            {d.runtimeStructuredOutput?.type === 'json' && (
              <details className="panel-structured" open={d.test}>
                <summary>结构化输出预览</summary>
                <pre className="panel-output">{JSON.stringify(d.runtimeStructuredOutput.value, null, 2)}</pre>
              </details>
            )}
            <div className="field-actions">
              <button className="btn btn-sm" onClick={copyOutput}>{copied ? '已复制' : '复制全文'}</button>
              <button className="btn btn-sm" onClick={() => setPreviewOpen(true)}>预览</button>
            </div>
          </>
        )}
        {previewOpen && createPortal(
          <Modal
            className="artifact-preview-modal"
            title={`输出预览 · ${d.label || node.id}`}
            onClose={() => setPreviewOpen(false)}
            footer={(
              <>
                <button className="btn" onClick={copyOutput}>{copied ? '已复制' : '复制全文'}</button>
                <button className="btn btn-primary" onClick={() => setPreviewOpen(false)}>关闭</button>
              </>
            )}
          >
            <article className="markdown-preview">
              <MarkdownDocument content={d.runOutput || '(空结果)'} />
            </article>
          </Modal>,
          document.body,
        )}
        {d.artifacts?.length > 0 && (
          <>
            <div className="result-head"><span className="result-title">工作区产物</span></div>
            <ArtifactLinks nodeLabel={d.label || node.id} runId={d.artifactsRunId} nodeId={node.id} artifacts={d.artifacts} />
          </>
        )}
        {d.runError && <p className="panel-error">错误：{d.runError}</p>}
      </section>
      </div>
    </aside>
  );
}

function hasFeishuLink(text) {
  return /https?:\/\/[a-zA-Z0-9.-]+\.feishu\.cn\//.test(text || '');
}
