// 重开画布收编 live 运行（纯函数，可单测）：
// openWorkflow/newWorkflow 重置运行态后，SSE snapshot 只在连接建立时发一次（不重发），
// 必须主动拉 /runs/detail（live run 读引擎内存实时态）把节点状态投影回画布，
// 运行中节点的动画/计时/边流动才能恢复。字段形状与 SSE snapshot 投影同源。

export const TERMINAL_RUN_STATUSES = Object.freeze(['success', 'error', 'canceled', 'skipped']);

/** 已终态节点集合：收编后 node-status 增量计数（done x/total）的种子，避免进度从 0 跳变 */
export function seedTerminalNodeIds(nodeStates = {}) {
  return new Set(Object.entries(nodeStates || {})
    .filter(([, st]) => TERMINAL_RUN_STATUSES.includes(st?.status))
    .map(([nodeId]) => nodeId));
}

/** 运行详情 → 画布节点投影：恢复 runStatus（动画源）及计时/字数/错误/输出等展示字段 */
export function projectRunNodeStates(nodes, detail, runId) {
  const states = detail?.nodeStates || {};
  const outputs = detail?.outputs || {};
  return (nodes || []).map((n) => {
    const st = states[n.id];
    if (!st) return n;
    const data = { ...n.data, runStatus: st.status };
    if (st.startedAt) data.runStartedAt = st.startedAt;
    if (st.chars != null) data.runChars = st.chars;
    if (st.turns != null) data.runTurns = st.turns;
    if (st.error) data.runError = st.error;
    if (st.durationMs != null) data.durationMs = st.durationMs;
    if (st.model) data.runtimeModel = st.model;
    if (st.artifacts) { data.artifacts = st.artifacts; data.artifactsRunId = runId; }
    const out = outputs[n.id];
    if (out != null) data.runOutput = String(out).slice(0, 4000);
    return { ...n, data };
  });
}

/** 运行详情 → runStatus 补丁：running 置徽标与进度；拉详情期间已结束则只回填终态 */
export function adoptRunStatusPatch(detail, runId, currentTotal = 0) {
  if (detail?.status !== 'running') {
    return { running: false, runId, last: detail?.status };
  }
  return {
    running: true,
    runId,
    done: Object.values(detail?.nodeStates || {})
      .filter((st) => TERMINAL_RUN_STATUSES.includes(st.status)).length,
    total: (detail?.graph?.nodes || []).filter((n) => n.type !== 'notify').length || currentTotal,
  };
}
