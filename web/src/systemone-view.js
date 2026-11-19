// systemone 前端纯逻辑：边标签映射 / 分支 chips / 自动分配 / 概率排序 / 判决色调。
// 消费引擎 data 契约（orchestrator lib/systemone.js 的 shapeSystemOneAnswer）；
// 画布边标签、连线面板 chips、判决卡共用这一份映射，不写第二套。

const NOUL_LABELS = { yes: '是', no: '否', unsettled: '待定' };

/** 边标签：按源节点类型映射。condition 保持旧语义；systemone noul 中文判决集，choice 选项名原样。 */
export function edgeBranchLabel(nodeData, branch) {
  if (!branch) return undefined;
  if (nodeData?.nodeType === 'systemone') {
    const mode = nodeData.mode || 'noul';
    if (mode === 'noul') return NOUL_LABELS[branch] || branch;
    return branch; // choice 选项名原样；score 不分流（lint 已 warn）
  }
  if (branch === 'true') return '是';
  if (branch === 'false') return '否';
  return branch;
}

/** 连线面板分支 chips：noul 三判决 / choice 当前选项 / score 空（不分流）。 */
export function systemOneBranchChips(nodeData) {
  const mode = nodeData?.mode || 'noul';
  if (mode === 'noul') return [['yes', '是'], ['no', '否'], ['unsettled', '待定']];
  if (mode === 'choice') {
    return (nodeData?.options || [])
      .map((o) => String(o?.name ?? '').trim())
      .filter(Boolean)
      .map((name) => [name, name]);
  }
  return [];
}

/** 拖线自动分配：按判决集顺序补第一个未用分支；全用过 → undefined（边不带 branch = 不限）。 */
export function nextSystemOneBranch(nodeData, existingBranches = []) {
  const used = new Set(existingBranches);
  const next = systemOneBranchChips(nodeData).find(([value]) => !used.has(value));
  return next ? next[0] : undefined;
}

/** 概率降序（判决卡条形列表）：分布永远可见，藏起次高概率是危险 UX。 */
export function sortedProbabilities(probabilities) {
  if (!probabilities || typeof probabilities !== 'object') return [];
  return Object.entries(probabilities).sort((a, b) => Number(b[1]) - Number(a[1]));
}

/** 判决色调：是绿 / 否红 / 待定琥珀；choice/score 中性（结论不预设好坏）。 */
export function verdictTone(data) {
  if (data?.mode === 'noul' && NOUL_LABELS[data.verdict]) return data.verdict;
  return 'neutral';
}
