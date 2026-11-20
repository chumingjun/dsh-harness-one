// pi 适配器：pi --mode json 的事件投影与终态判定。
// 实测依据（本机 pi 1.5.0）：
//   - exit=0 不代表成功：默认模型 401 / 部分模型 503 时进程仍 exit 0，失败只在事件里
//   - 必须显式 --provider/--model（默认模型在本机是坏的）；auto_retry 会重试 3-4 次
//   - role:"system" 消息约 51KB，必须跳过
//   - 不能用 readline 切 JSONL（共享层按 LF 字节切）
//   - toolCall{id,name,arguments} 与 message_end{role:toolResult,toolCallId,content,isError} 按 id 配对
//   - 终态 = agent_end{willRetry:false} + agent_settled{aborted:false} + 最终 assistant 非空且 stopReason 正常
// pi 无沙箱：执行准入由宿主 config.enablePiRuntime 门禁（默认禁用），本适配器不做安全承诺。
import { LIMITS, pushEntry } from './runtime-cli.js';

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（截断）` : text;
}

function pendingOf(acc) {
  if (!acc._piPending) acc._piPending = new Map();
  return acc._piPending;
}

export const piRuntime = {
  id: 'pi',
  bin: 'pi',
  probeArgs: ['--version'],

  buildSpawn({ persona, userPrompt, cwd, model }) {
    // model 约定 provider/model；lint 已校验形状，这里再拆一次并拒绝额外 flag 注入
    const slash = String(model || '').indexOf('/');
    const provider = slash < 0 ? '' : String(model).slice(0, slash).trim();
    const rest = slash < 0 ? '' : String(model).slice(slash + 1).trim();
    if (!provider || !rest || /[\s]/.test(provider) || rest.startsWith('-')) {
      const error = new Error(`pi 模型须为 provider/model 形式（当前：${model || '(空)'}）`);
      error.code = 'RUNTIME_BAD_MODEL';
      error.retryable = false;
      throw error;
    }
    // 无人值守不继承环境 MCP/扩展：实测 pi 会连用户 mcp.json 与 orca 等扩展，
    // 既拖慢/挂起启动，又往生命周期里注入干扰（模型空转多轮不产出）。
    const argv = ['--mode', 'json', '-p', '--no-session', '--no-mcp', '--no-extensions', '--provider', provider, '--model', rest];
    return { argv, stdin: `${persona}\n\n${userPrompt}` };
  },

  onFrame(ev, acc) {
    const type = ev?.type;
    if (type === 'turn_start') { acc.turns += 1; return; }
    if (type === 'message_update') {
      const e = ev.assistantMessageEvent;
      if (e?.type === 'text_delta' && e.delta) acc.preview = `${acc.preview}${e.delta}`.slice(-LIMITS.maxPreviewChars);
      return;
    }
    if (type === 'message_end') {
      const m = ev.message || {};
      if (m.role === 'system' || m.role === 'user') return; // system 约 51KB，跳过
      if (m.role === 'toolResult') {
        const idx = pendingOf(acc).get(m.toolCallId);
        const text = (m.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
        const result = { ok: m.isError !== true, text: clip(text, LIMITS.maxToolChars) };
        if (idx !== undefined && acc.entries[idx]?.result === undefined) acc.entries[idx].result = result;
        pendingOf(acc).delete(m.toolCallId);
        return;
      }
      if (m.role === 'assistant') {
        for (const block of m.content || []) {
          if (block.type === 'text' && block.text) {
            acc.preview = block.text;
            acc.finalText = block.text;
            pushEntry(acc, { kind: 'assistant', text: clip(block.text, LIMITS.maxAssistantChars) });
          } else if (block.type === 'toolCall') {
            pushEntry(acc, { kind: 'tool', name: block.name, args: clip(JSON.stringify(block.arguments ?? {}), LIMITS.maxToolChars) });
            pendingOf(acc).set(block.id, acc.entries.length - 1);
          }
        }
        // 最终 assistant 的 stopReason/errorMessage 是成败依据（exit code 不可信）
        acc.finalStopReason = m.stopReason;
        acc.finalErrorMessage = m.errorMessage || null;
        if (m.usage) {
          acc.usage = acc.usage || { inputTokens: 0, outputTokens: 0 };
          acc.usage.inputTokens += Number(m.usage.input) || 0;
          acc.usage.outputTokens += Number(m.usage.output) || 0;
          const cost = m.usage.cost?.total;
          if (cost) acc.usage.costUsd = (acc.usage.costUsd || 0) + Number(cost);
        }
        return;
      }
      return;
    }
    if (type === 'agent_end') { acc.sawAgentEnd = true; acc.willRetry = ev.willRetry; return; }
    if (type === 'agent_settled') { acc.sawSettled = true; acc.aborted = ev.aborted === true; return; }
    if (type === 'auto_retry_start' || type === 'auto_retry_end') {
      // 重试不是有效进展，也不判致命；留一条诊断让卡住原因可见
      if (!acc.diagnostics) acc.diagnostics = [];
      if (acc.diagnostics.length < 20) acc.diagnostics.push(clip(`${type}${ev.error ? `: ${ev.error}` : ''}`, 200));
      return;
    }
    if (type === 'session' || type === 'agent_start' || type === 'message_start' || type === 'turn_end'
      || type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') return;
    acc.unknownEvents.add(String(type || '?'));
  },

  finalize(acc, exit, { stderrTail, stdoutPlainTail }) {
    const usage = acc.usage;
    const turns = acc.turns;
    const fail = (message, code, retryable = true) => {
      const error = new Error(message);
      error.code = code;
      error.retryable = retryable;
      return { text: '', usage, turns, error };
    };
    const diag = [acc.finalErrorMessage, acc.lastProtocolError, stdoutPlainTail, stderrTail].filter(Boolean).map((t) => clip(t, 400)).join(' | ');

    if (exit.spawnError) return fail(`pi 启动失败：${exit.spawnError}`, 'RUNTIME_SPAWN_FAILED', false);
    if (exit.code !== 0) return fail(`pi 退出码 ${exit.code}${exit.signal ? `（信号 ${exit.signal}）` : ''}${diag ? `：${diag}` : ''}`, 'RUNTIME_EXIT_NONZERO');
    if (!acc.sawAgentEnd || !acc.sawSettled) return fail(`pi 缺 agent_end/agent_settled 终态帧，终态不可信${diag ? `：${diag}` : ''}`, 'RUNTIME_NO_TERMINAL', false);
    if (acc.aborted) return fail('pi 运行被中止（agent_settled.aborted）', 'RUNTIME_ABORTED', false);
    // exit=0 但 stopReason=error / errorMessage 非空 → 失败（实测 401/503 就是这个形状）
    if (acc.finalStopReason === 'error' || acc.finalErrorMessage) {
      return fail(`pi 最终响应错误（stopReason=${acc.finalStopReason || '(空)'}）${diag ? `：${diag}` : ''}`, 'RUNTIME_RESULT_ERROR', false);
    }
    const text = (acc.finalText || '').trim();
    if (!text) return fail('pi 未产出最终答案', 'RUNTIME_EMPTY_RESULT', false);
    return { text, usage, turns, error: null };
  },
};
