// 节点类型注册表（前端单一来源）：加一种新节点 = 在这里加一个对象。
// 图标统一内联 SVG（stroke 1.8，24 viewBox），禁 emoji（跨平台渲染不一致、无法令牌化）。

const I = (paths, extra = '') => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

const ICONS = {
  input: I('<path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>'),
  agent: I('<rect x="5" y="7" width="14" height="11" rx="3"/><circle cx="9.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M12 7V4m-4 14v1.5a1.5 1.5 0 003 0V18m2 0v1.5a1.5 1.5 0 003 0V18"/>'),
  condition: I('<path d="M6 4v6a2 2 0 002 2h8"/><path d="M18 20v-6a2 2 0 00-2-2H8"/><circle cx="6" cy="4" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="20" r="1.6" fill="currentColor" stroke="none"/>'),
  http: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/>'),
  systemone: I('<path d="M4.5 19a9 9 0 1 1 15 0"/><path d="M12 14l3.5-3.5"/><circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none"/>'),
  script: I('<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>'),
  output: I('<path d="M12 15V3m0 0l-4 4m4-4l4 4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>'),
  notify: I('<path d="M10.3 21a2 2 0 003.4 0"/><path d="M4 17h16c-1.5-1.6-2-3.2-2-7a6 6 0 00-12 0c0 3.8-.5 5.4-2 7z"/>'),
  note: I('<path d="M4 5h16M4 12h10M4 19h7"/>'),
  subworkflow: I('<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5M16 13l2 2-2 2"/>'),
};

// 外部 runtime 图标：节点头部与徽标共用，便于在画布上一眼区分执行底座。
// 终端符 = codex，星芒 = claude code，π = pi。禁 emoji（跨平台渲染不一致）。
export const RUNTIME_ICONS = {
  codex: I('<path d="M5 7l5 5-5 5"/><path d="M13 17h6"/>'),
  claude: I('<path d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3L6.3 17.7"/>'),
  pi: I('<path d="M5 7h14"/><path d="M9 7v10"/><path d="M15 7v7a3 3 0 003 3"/>'),
};

export const runtimeIconOf = (data) => {
  const id = String(data?.runtime || 'dsh');
  return id !== 'dsh' ? (RUNTIME_ICONS[id] || null) : null;
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
    // 外部 runtime 在节点头部类型图标旁再挂一个底座图标，画布扫一眼即可区分
    headExtra: (d) => runtimeIconOf(d),
    preset: () => ({ label: '新智能体', prompt: '', tools: [] }),
    summary: (d) => `提示词：${d.prompt || '(默认助手)'}`,
    badges: (d) => {
      // 外部 runtime 用自带工具/技能，且轮数无法在线限制——这些 dsh 专属徽标不显示，
      // 免得画布上看着像生效了。模型徽标改读配置字段 externalModel（不是瞬态 runtimeModel）。
      const external = Boolean(d.runtime && d.runtime !== 'dsh');
      const model = external ? d.externalModel : d.model;
      return [
        external && { icon: RUNTIME_ICONS[d.runtime], text: d.runtime, cls: 'badge-runtime', title: `执行底座：${d.runtime}` },
        model && { text: shortModel(model), cls: 'badge-model', title: `模型：${model}` },
        !external && d.maxRounds && { text: `↻${d.maxRounds}` },
        !external && (d.tools || []).length > 0 && { text: '工具' },
        !external && (d.skills || []).length > 0 && { text: `技能 ${d.skills.length}` },
        external && d.requireArtifact && { text: '需产物', title: '本次必须产出新的非空文件' },
      ].filter(Boolean);
    },
  },
  {
    type: 'condition',
    icon: ICONS.condition, label: '条件', color: 'var(--type-condition)',
    preset: () => ({ label: '条件判断', include: '', exclude: '' }),
    summary: (d) => `含"${(d.include || '任意').split(/[,，]/)[0]}"→ 是`,
    badges: () => [{ text: '分流', cls: 'badge-cond' }],
  },
  {
    type: 'http',
    icon: ICONS.http, label: 'HTTP', color: 'var(--type-http)',
    preset: () => ({ label: 'HTTP 请求', url: '', method: 'GET', headers: '', body: '' }),
    summary: (d) => `${(d.method || 'GET')} ${(d.url || '(未配置 URL)').slice(0, 30)}`,
    badges: (d) => d.url ? [{ text: '接口' }] : [],
  },
  {
    type: 'systemone',
    icon: ICONS.systemone, label: '轻判断', color: 'var(--type-systemone)',
    preset: () => ({ label: '轻判断', mode: 'noul', state: '', statement: '', instructions: '', options: [], levels: [] }),
    summary: (d) => {
      const mode = d.mode || 'noul';
      if (mode === 'choice') return `分类 · ${(d.options || []).length} 选项`;
      if (mode === 'score') return `评分 · ${(d.levels || []).length} 档`;
      return `是否 · ${d.statement || '未配置语句'}`;
    },
    badges: (d) => {
      const mode = d.mode || 'noul';
      return [
        { text: mode === 'choice' ? '分类' : mode === 'score' ? '评分' : '是否', cls: 'badge-cond' },
        mode === 'choice' && (d.options || []).length > 0 && { text: `${d.options.length} 选项` },
        mode === 'score' && (d.levels || []).length > 0 && { text: `${d.levels.length} 档` },
      ].filter(Boolean);
    },
  },
  {
    type: 'script',
    icon: ICONS.script, label: '脚本', color: 'var(--type-script)',
    preset: () => ({ label: '脚本', inputs: [], code: 'function main(input, workspace) {\n  return input;\n}' }),
    summary: (d) => `main(input, workspace) · ${(d.inputs || []).length} 参数`,
    badges: (d) => [
      (d.inputs || []).length > 0 && { text: `参数 ${d.inputs.length}` },
      d.outputSchema && { text: 'Schema' },
    ].filter(Boolean),
  },
  {
    type: 'output',
    icon: ICONS.output, label: '输出', color: 'var(--type-output)',
    preset: () => ({ label: '新输出' }),
    summary: () => '汇总上游输出',
  },
  {
    type: 'notify',
    icon: ICONS.notify, label: '消息通知', color: 'var(--accent)',
    preset: () => ({
      label: '消息通知', channel: 'feishu', mode: 'terminal',
      channelConfig: { targetType: 'chat_id', targetId: '' },
    }),
    summary: (d) => `${d.channel === 'feishu' ? '飞书' : (d.channel || '未选渠道')} · ${d.channelConfig?.targetType === 'open_id' ? '私聊' : '群聊'} · ${d.mode === 'each_node' ? '逐节点' : '仅结束'}`,
    badges: (d) => [
      { text: d.channel === 'feishu' ? '飞书卡片' : (d.channel || '渠道') },
      { text: d.channelConfig?.targetType === 'open_id' ? '私聊' : '群聊' },
      { text: d.mode === 'each_node' ? '逐节点' : '运行结束' },
    ],
  },
  {
    type: 'note',
    icon: ICONS.note, label: '注释', color: 'var(--type-note)',
    preset: () => ({ label: '说明', text: '' }),
    summary: (d) => d.text || '（空白说明）',
    badges: () => [{ text: '不参与运行', cls: 'badge-note' }],
  },
  {
    type: 'subworkflow',
    icon: ICONS.subworkflow, label: '子工作流', color: 'var(--type-subworkflow, var(--accent))',
    preset: () => ({ label: '子工作流', workflowId: '', inputMap: { triggerInput: '$upstream', runInputs: {} } }),
    summary: (d) => d.workflowName || d.workflowId || '未选择工作流',
    badges: (d) => [
      { text: '同步调用' },
      d.workflowId && { text: d.workflowId.slice(0, 12), cls: 'badge-model' },
    ].filter(Boolean),
  },
];

export const kindOf = (type) => NODE_REGISTRY.find((k) => k.type === type) || {
  type, icon: '', label: type, color: 'var(--type-unknown)', preset: () => ({}), summary: () => type,
};

function shortModel(m) {
  const parts = String(m).split(':');
  return parts[parts.length - 1].replace(/^glm-/, 'GLM ');
}
