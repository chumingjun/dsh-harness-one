import { Worker } from 'node:worker_threads';
import { toJsonSafe } from './output-contract.js';

export const SCRIPT_LIMITS = Object.freeze({
  maxCodeBytes: 64 * 1024,
  maxInputBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  defaultTimeoutMs: 1000,
  minTimeoutMs: 100,
  maxTimeoutMs: 10_000,
  memoryLimitBytes: 32 * 1024 * 1024,
  stackLimitBytes: 512 * 1024,
});

export class ScriptExecutionError extends Error {
  constructor(message, code = 'SCRIPT_EXECUTION_ERROR') {
    super(message);
    this.name = 'ScriptExecutionError';
    this.code = code;
  }
}

function byteLengthJson(value) {
  const json = JSON.stringify(value);
  return { json, bytes: Buffer.byteLength(json) };
}

export function normalizeScriptTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return SCRIPT_LIMITS.defaultTimeoutMs;
  return Math.max(SCRIPT_LIMITS.minTimeoutMs, Math.min(SCRIPT_LIMITS.maxTimeoutMs, Math.floor(number)));
}

export async function runScript({ code, input, workspaceDir, readWorkspaceDir, timeoutMs, signal, workspaceLimits } = {}) {
  const source = String(code || '');
  if (!source.trim()) throw new ScriptExecutionError('脚本代码不能为空', 'SCRIPT_EMPTY');
  if (Buffer.byteLength(source) > SCRIPT_LIMITS.maxCodeBytes) {
    throw new ScriptExecutionError(`脚本源码超过 ${SCRIPT_LIMITS.maxCodeBytes} 字节上限`, 'SCRIPT_CODE_LIMIT');
  }
  const safeInput = toJsonSafe(input, '$.input');
  const encodedInput = byteLengthJson(safeInput);
  if (encodedInput.bytes > SCRIPT_LIMITS.maxInputBytes) {
    throw new ScriptExecutionError(`脚本输入超过 ${SCRIPT_LIMITS.maxInputBytes} 字节上限`, 'SCRIPT_INPUT_LIMIT');
  }
  if (!workspaceDir) throw new ScriptExecutionError('脚本工作区未配置', 'SCRIPT_WORKSPACE_MISSING');
  if (signal?.aborted) throw new ScriptExecutionError('运行已取消', 'SCRIPT_CANCELED');

  const effectiveTimeout = normalizeScriptTimeout(timeoutMs);
  const worker = new Worker(new URL('./script-worker.js', import.meta.url), {
    type: 'module',
    execArgv: [],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { await worker.terminate(); } catch { /* 已退出 */ }
      fn(value);
    };
    const onAbort = () => finish(reject, new ScriptExecutionError('运行已取消', 'SCRIPT_CANCELED'));
    const timer = setTimeout(() => {
      finish(reject, new ScriptExecutionError(`脚本执行超时（${effectiveTimeout}ms）`, 'SCRIPT_TIMEOUT'));
    }, effectiveTimeout + 100);

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('error', (error) => finish(reject, new ScriptExecutionError(`脚本 worker 异常：${error.message}`, 'SCRIPT_WORKER_ERROR')));
    worker.once('exit', (codeValue) => {
      if (!settled && codeValue !== 0) finish(reject, new ScriptExecutionError(`脚本 worker 异常退出（${codeValue}）`, 'SCRIPT_WORKER_EXIT'));
    });
    worker.once('message', (message) => {
      if (!message?.ok) {
        const codeValue = message?.error?.code || 'SCRIPT_RUNTIME_ERROR';
        return finish(reject, new ScriptExecutionError(message?.error?.message || '脚本执行失败', codeValue));
      }
      let safeValue;
      try { safeValue = toJsonSafe(message.value, '$.result'); }
      catch (error) { return finish(reject, error); }
      const encodedOutput = byteLengthJson(safeValue);
      if (encodedOutput.bytes > SCRIPT_LIMITS.maxOutputBytes) {
        return finish(reject, new ScriptExecutionError(`脚本输出超过 ${SCRIPT_LIMITS.maxOutputBytes} 字节上限`, 'SCRIPT_OUTPUT_LIMIT'));
      }
      return finish(resolve, { value: safeValue, workspaceStats: message.workspaceStats || {} });
    });
    worker.postMessage({
      code: source,
      inputJson: encodedInput.json,
      workspaceDir,
      readWorkspaceDir: readWorkspaceDir || workspaceDir,
      timeoutMs: effectiveTimeout,
      memoryLimitBytes: SCRIPT_LIMITS.memoryLimitBytes,
      stackLimitBytes: SCRIPT_LIMITS.stackLimitBytes,
      workspaceLimits,
    });
  });
}
