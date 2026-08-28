// 定时任务调度核心：cron 解析、下次触发计算、重叠判定、链式 setTimeout 调度器。
// 纯逻辑无 Cordis 依赖，index.js 注入 fire/isBusy 回调；测试直接 node 跑。
import cronParser from 'cron-parser';

// cron-parser@4：默认导出是命名空间对象（CJS interop），parseExpression 是其方法
const parseCronExpression = cronParser.parseExpression?.bind(cronParser)
  ?? cronParser.default?.parseExpression?.bind(cronParser.default);

export const OVERLAP_POLICIES = ['skip', 'parallel'];
// setTimeout 上限 2^31-1 ms（约 24.8 天）：远期任务链式分段等待，避免溢出成 1ms 风暴
const MAX_WAIT = 2 ** 31 - 1;

export function isValidCron(cron, tz) {
  // cron-parser 宽松模式把空串/缺段当 *（空串 = 每分钟），先拒绝空值
  if (typeof cron !== 'string' || !cron.trim()) return false;
  try {
    parseCronExpression(cron, { currentDate: new Date(), tz: tz || undefined });
    return true;
  } catch {
    return false;
  }
}

// 合法 IANA 时区名（含 UTC / 旧别名）；空值不算合法时区
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

// 请求侧 timezone 归一化：空值 = null（跟随主机时区）；非法名抛错。
// 必须在入口拦：cron-parser 对非法 tz 静默回退本地时区，不抛错。
export function normalizeTimezoneInput(value) {
  if (value === undefined || value === null) return null;
  const tz = String(value).trim();
  if (!tz) return null;
  if (!isValidTimezone(tz)) throw new Error(`时区无效：${tz}`);
  return tz;
}

// 距下次触发的毫秒数（≥1）；cron 无效抛错（空串同上视为无效）。
// tz 为空按主机本地时区解释，等价旧行为
export function computeNextDelay(cron, now = Date.now(), tz) {
  if (typeof cron !== 'string' || !cron.trim()) throw new Error('cron 表达式为空');
  const interval = parseCronExpression(cron, { currentDate: new Date(now), tz: tz || undefined });
  return Math.max(1, interval.next().getTime() - now);
}

// 接下来 count 次触发时间（ISO 字符串），供创建表单实时预览；cron 无效抛错
export function upcomingFireTimes(cron, count = 3, now = Date.now(), tz) {
  if (typeof cron !== 'string' || !cron.trim()) throw new Error('cron 表达式为空');
  const interval = parseCronExpression(cron, { currentDate: new Date(now), tz: tz || undefined });
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

// 兼容旧 triggers.json：无新字段时补默认值（overlap=skip、enabled=true）。
// timezone=null = 跟随主机时区（旧行为）；非法值回落 null，绝不带病起调度
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
    timezone: isValidTimezone(raw?.timezone) ? raw.timezone.trim() : null,
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
    timezone: meta.timezone || null,
    enabled: meta.enabled !== false,
    createdAt: meta.createdAt,
    nextAt: meta.nextAt || null,
    fireCount: meta.fireCount || 0,
    skippedCount: meta.skippedCount || 0,
  };
}

// 链式调度器：到点按 overlap 策略决定真跑还是跳过；fireNow 供「立即运行」绕过策略。
// 计数属主是调用方（meta Map）：onFire/onSkip 回调时由调用方增量并落盘，
// onMeta 只回传 nextAt（不带 fireCount/skippedCount，避免覆盖调用方的手动计数）。
export function createScheduler({ meta, fire, isBusy, logger, now = () => Date.now(), onMeta, onFire, onSkip } = {}) {
  const normalized = normalizeScheduleMeta(meta);
  const state = {
    stopped: false,
    rawTimer: null,
    nextAt: null,
  };
  // onMeta 只回传 { key, nextAt }：计数属主是调用方（回传计数会把它手动记的账覆盖回退）
  const liveMeta = () => ({ key: normalized.key, nextAt: state.nextAt });
  const report = () => onMeta?.(liveMeta());

  const runFire = () => {
    try {
      fire?.();
      onFire?.();
    } catch (error) {
      logger?.warn?.(`dsh-ccpg 定时运行失败（${normalized.key}）：${error?.message || error}`);
    }
  };

  const armNext = () => {
    if (state.stopped) return;
    let nextMs = 1;
    try {
      nextMs = computeNextDelay(normalized.cron, now(), normalized.timezone);
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
        state.skipped = true;
        logger?.info?.(`dsh-ccpg 定时触发跳过（${normalized.key}）：上一轮运行尚未结束`);
        onSkip?.();
        report();
        armNext();
        return;
      }
      state.skipped = false;
      runFire();
      report();
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
    // 手动「立即运行」：不受 overlap/enabled 限制，不干扰既定调度链。
    // 计数同样经 onFire 回调由调用方记账。
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
