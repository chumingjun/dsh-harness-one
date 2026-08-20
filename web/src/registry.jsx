// 节点类型注册表（前端单一来源）：加一种新节点 = 在这里加一个对象。
// 图标统一内联 SVG（stroke 1.8，24 viewBox），禁 emoji（跨平台渲染不一致、无法令牌化）。

const I = (paths, extra = '') => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

const ICONS = {
  input: I('<path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>'),
  agent: I('<rect x="5" y="7" width="14" height="11" rx="3"/><circle cx="9.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M12 7V4m-4 14v1.5a1.5 1.5 0 003 0V18m2 0v1.5a1.5 1.5 0 003 0V18"/>'),
  condition: I('<path d="M6 4v6a2 2 0 002 2h8"/><path d="M18 20v-6a2 2 0 00-2-2H8"/><circle cx="6" cy="4" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="20" r="1.6" fill="currentColor" stroke="none"/>'),
  approval: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  http: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/>'),
  output: I('<path d="M12 15V3m0 0l-4 4m4-4l4 4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>'),
  note: I('<path d="M4 5h16M4 12h10M4 19h7"/>'),
};

export const NODE_REGISTRY = [
  {
    type: 'input',
    icon: ICONS.input, label: '输入', color: 'var(--type-input)',
    preset: () => ({ label: '新输入', text: '', attachments: [] }),
    summary: (d) => d.text || '未配置输入内容',
  },
  {
    type: 'agent',
    icon: ICONS.agent, label: '智能体', color: 'var(--type-agent)',
    preset: () => ({ label: '新智能体', prompt: '', tools: [] }),
    summary: (d) => `提示词：${d.prompt || '(默认助手)'}`,
    badges: (d) => [
      d.model && { text: shortModel(d.model), cls: 'badge-model' },
      d.maxRounds && { text: `↻${d.maxRounds}` },
      (d.tools || []).length > 0 && { text: '工具' },
      (d.skills || []).length > 0 && { text: `技能 ${d.skills.length}` },
    ].filter(Boolean),
  },
  {
    type: 'condition',
    icon: ICONS.condition, label: '条件', color: 'var(--type-condition)',
    preset: () => ({ label: '条件判断', include: '', exclude: '' }),
    summary: (d) => `含"${(d.include || '任意').split(/[,，]/)[0]}"→ 是`,
    badges: () => [{ text: '分流', cls: 'badge-cond' }],
  },
  {
    type: 'approval',
    icon: ICONS.approval, label: '审批', color: 'var(--type-approval)',
    preset: () => ({ label: '人工审批', note: '请确认后继续' }),
    summary: (d) => d.note || '等待人工确认',
    badges: () => [{ text: '人工卡点', cls: 'badge-approval' }],
  },
  {
    type: 'http',
    icon: ICONS.http, label: 'HTTP', color: 'var(--type-http)',
    preset: () => ({ label: 'HTTP 请求', url: '', method: 'GET', headers: '', body: '' }),
    summary: (d) => `${(d.method || 'GET')} ${(d.url || '(未配置 URL)').slice(0, 30)}`,
    badges: (d) => d.url ? [{ text: '接口' }] : [],
  },
  {
    type: 'output',
    icon: ICONS.output, label: '输出', color: 'var(--type-output)',
    preset: () => ({ label: '新输出' }),
    summary: () => '汇总上游输出',
    badges: (d) => [
      d.writeback?.type === 'feishu-new' && { text: '新建飞书文档' },
      d.writeback?.type === 'feishu-append' && { text: '追加飞书文档' },
    ].filter(Boolean),
  },
  {
    type: 'note',
    icon: ICONS.note, label: '注释', color: 'var(--type-note)',
    preset: () => ({ label: '说明', text: '' }),
    summary: (d) => d.text || '（空白说明）',
    badges: () => [{ text: '不参与运行', cls: 'badge-note' }],
  },
];

export const kindOf = (type) => NODE_REGISTRY.find((k) => k.type === type) || {
  type, icon: '', label: type, color: 'var(--type-unknown)', preset: () => ({}), summary: () => type,
};

function shortModel(m) {
  const parts = String(m).split(':');
  return parts[parts.length - 1].replace(/^glm-/, 'GLM ').slice(0, 16);
}
