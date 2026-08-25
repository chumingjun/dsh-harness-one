// 定时任务调度核心：cron 解析、下次触发计算、重叠判定、链式 setTimeout 调度器。
// 纯逻辑无 Cordis 依赖，index.js 注入 fire/isBusy 回调；测试直接 node 跑。
import cronParser from 'cron-parser';

// cron-parser@4：默认导出是命名空间对象（CJS interop），parseExpression 是其方法
const parseCronExpression = cronParser.parseExpression?.bind(cronParser)
  ?? cronParser.default?.parseExpression?.bind(cronParser.default);

export const OVERLAP_POLICIES = ['skip', 'parallel'];
// setTimeout 上限 2^31-1 ms（约 24.8 天）：远期任务链式分段等待，避免溢出成 1ms 风暴
const MAX_WAIT = 2 ** 31 - 1;

export function isValidCron(cron) {
  // cron-parser 宽松模式把空串/缺段当 *（空串 = 每分钟），先拒绝空值
  if (typeof cron !== 'string' || !cron.trim()) return false;
  try {
    parseCronExpression(cron, { currentDate: new Date() });
    return true;
  } catch {
    return false;
  }
}

// 距下次触发的毫秒数（≥1）；cron 无效抛错（空串同上视为无效）
export function computeNextDelay(cron, now = Date.now()) {
  if (typeof cron !== 'string' || !cron.trim()) throw new Error('cron 表达式为空');
  const interval = parseCronExpression(cron, { currentDate: new Date(now) });
  return Math.max(1, interval.next().getTime() - now);
}

// 接下来 count 次触发时间（ISO 字符串），供创建表单实时预览；cron 无效抛错
export function upcomingFireTimes(cron, count = 3, now = Date.now()) {
  if (typeof cron !== 'string' || !cron.trim()) throw new Error('cron 表达式为空');
  const interval = parseCronExpression(cron, { currentDate: new Date(now) });
  const times = [];
  for (let i = 0; i < count; i += 1) times.push(interval.next().toISOString());
  return times;
}

// 该工作流在本工作区是否仍有 live 运行（不论来源：手动/定时/webhook）。
// runsMap = Orchestrator.runs（runId → { run, s, cancel }）
export function hasLiveRunForWorkflow(runsMap, workspaceRoot, workflowId) {
  if (!workflowId) return false;
  for (const entry of runsMap.values()) {
    const run = entry?.run;
    if (run?.workflowId === workflowId && run?.workspaceRoot === workspaceRoot) return true;
  }
  return false;
}

// 兼容旧 triggers.json：无新字段时补默认值（overlap=skip、enabled=true）
export function normalizeScheduleMeta(raw) {
  const overlap = OVERLAP_POLICIES.includes(raw?.overlap) ? raw.overlap : 'skip';
  return {
    key: raw?.key || null,
    workflowId: raw?.workflowId || null,
    workflowName: raw?.workflowName || '',
    cron: String(raw?.cron || ''),
    input: raw?.input || '',
    runInputs: raw?.runInputs && typeof raw?.runInputs === 'object' ? raw.runInputs : {},
    overlap,
    enabled: raw?.enabled !== false,
    createdAt: raw?.createdAt || null,
    nextAt: raw?.nextAt || null,
    fireCount: Number.isFinite(raw?.fireCount) ? raw.fireCount : 0,
    skippedCount: Number.isFinite(raw?.skippedCount) ? raw.skippedCount : 0,
  };
}

// 落盘只存稳定字段（运行态 nextAt/fireCount/skippedCount 也持久化，重启恢复统计）
export function persistableScheduleMeta(meta) {
  return {
    key: meta.key,
    workflowId: meta.workflowId,
    workflowName: meta.workflowName,
    cron: meta.cron,
    input: meta.input,
    runInputs: meta.runInputs || {},
    overlap: meta.overlap || 'skip',
    enabled: meta.enabled !== false,
    createdAt: meta.createdAt,
    nextAt: meta.nextAt || null,
    fireCount: meta.fireCount || 0,
    skippedCount: meta.skippedCount || 0,
  };
}

// 链式调度器：到点按 overlap 策略决定真跑还是跳过；fireNow 供「立即运行」绕过策略。
// onMeta 在统计/nextAt 变化时回调（index.js 借此同步 meta Map 并落盘）。
export function createScheduler({ meta, fire, isBusy, logger, now = () => Date.now(), onMeta } = {}) {
  const normalized = normalizeScheduleMeta(meta);
  const state = {
    stopped: false,
    rawTimer: null,
    nextAt: null,
    fireCount: normalized.fireCount,
    skippedCount: normalized.skippedCount,
  };
  const liveMeta = () => ({
    ...normalized,
    key: normalized.key,
    nextAt: state.nextAt,
    fireCount: state.fireCount,
    skippedCount: state.skippedCount,
  });
  const report = () => onMeta?.(liveMeta());

  const runFire = () => {
    state.fireCount += 1;
    report();
    try {
      fire?.();
    } catch (error) {
      logger?.warn?.(`dsh-ccpg 定时运行失败（${normalized.key}）：${error?.message || error}`);
    }
  };

  const armNext = () => {
    if (state.stopped) return;
    let nextMs = 1;
    try {
      nextMs = computeNextDelay(normalized.cron, now());
    } catch (error) {
      state.stopped = true;
      state.nextAt = null;
      logger?.warn?.(`dsh-ccpg 定时表达式无效（${normalized.key}）：${error?.message}`);
      report();
      return;
    }
    state.nextAt = new Date(now() + nextMs).toISOString();
    report();
    const onTime = () => {
      if (state.stopped) return;
      if (normalized.overlap === 'skip' && isBusy?.()) {
        state.skippedCount += 1;
        logger?.info?.(`dsh-ccpg 定时触发跳过（${normalized.key}）：上一轮运行尚未结束`);
        report();
        armNext();
        return;
      }
      runFire();
      armNext();
    };
    if (nextMs > MAX_WAIT) {
      state.rawTimer = setTimeout(armNext, Math.floor(MAX_WAIT / 2));
      return;
    }
    state.rawTimer = setTimeout(onTime, nextMs);
  };
  armNext();

  return {
    // 手动「立即运行」：不受 overlap/enabled 限制，不干扰既定调度链
    fireNow() {
      if (state.stopped) return false;
      runFire();
      return true;
    },
    getMeta: liveMeta,
    stop() {
      state.stopped = true;
      if (state.rawTimer) clearTimeout(state.rawTimer);
    },
  };
}
