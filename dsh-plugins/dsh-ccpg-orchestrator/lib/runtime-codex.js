// codex 适配器：codex exec --json 的事件投影与终态判定。
// 实测依据（本机 codex-cli 0.170.0）：
//   - 一次 turn 内可有多个 item（agent_message / command_execution / file_change / error）
//   - agent_message 会出现多条（前导语 + 最终答案），不能拼接当答案
//   - 配置警告以 item.completed{type:"error"} 下发，不是致命错误
//   - `-a never` 属主命令 flag，放在 exec 之前实测被接受
//   - `--output-last-message <file>` 与 --json 同用时确实写最终答案（实测文件内容恰为 "OK"）
// 故终值以该文件为事实源，缺文件不回退到预览文本。
import { readFileSync } from 'node:fs';
import { LIMITS, pushEntry } from './runtime-cli.js';

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（截断）` : text;
}

function pendingOf(acc) {
  if (!acc._codexPending) acc._codexPending = new Map();
  return acc._codexPending;
}

export const codexRuntime = {
  id: 'codex',
  bin: 'codex',
  probeArgs: ['--version'],

  buildSpawn({ persona, userPrompt, cwd, model, files, permission = 'sandbox' }) {
    // 防御性复核：单点校验在分派层（resolveRuntimePermission），这里兜底直调
    if (permission !== 'sandbox' && permission !== 'full') {
      const error = new Error(`codex 权限模式「${permission}」无效（可选 sandbox/full）`);
      error.code = 'RUNTIME_BAD_PERMISSION'; error.retryable = false; throw error;
    }
    const argv = [
      '-a', 'never',
      'exec', '--json', '--skip-git-repo-check',
      // full = danger-full-access（用户显式选择 + 运行期授权）；默认沙箱写限工作区、禁网
      '-s', permission === 'full' ? 'danger-full-access' : 'workspace-write',
      '-C', cwd,
      '--output-last-message', files.resultFile,
      '--color', 'never',
    ];
    if (files.schemaFile) argv.push('--output-schema', files.schemaFile);
    if (model) argv.push('-m', model);
    // codex 无 --system-prompt：persona 只能作为普通任务文本前置。
    // 它低于 CLI 自身规则（AGENTS.md / 用户 skills / hooks），不构成隔离。
    return { argv, stdin: `${persona}\n\n${userPrompt}` };
  },

  onFrame(ev, acc) {
    const type = ev?.type;
    if (type === 'turn.started') { acc.turns += 1; return; }
    if (type === 'turn.completed') {
      acc.sawTerminal = true;
      const u = ev.usage;
      if (u) {
        acc.usage = acc.usage || { inputTokens: 0, outputTokens: 0 };
        acc.usage.inputTokens += Number(u.input_tokens) || 0;
        acc.usage.outputTokens += Number(u.output_tokens) || 0;
      }
      return;
    }
    if (type === 'turn.failed') {
      acc.fatal = clip(ev.message || ev.error?.message || 'codex turn 失败', 400);
      return;
    }
    if (type === 'item.started' || type === 'item.completed') {
      const item = ev.item || {};
      const completed = type === 'item.completed';
      if (item.type === 'agent_message') {
        if (!completed) return;
        const text = String(item.text || '');
        if (!text.trim()) return;
        acc.preview = text;
        acc.finalText = text; // 候选；终值仍以 resultFile 为准
        pushEntry(acc, { kind: 'assistant', text: clip(text, LIMITS.maxAssistantChars) });
        return;
      }
      if (item.type === 'command_execution') {
        const pending = pendingOf(acc);
        if (!completed) {
          pushEntry(acc, { kind: 'tool', name: 'bash', args: clip(item.command, LIMITS.maxToolChars) });
          pending.set(item.id, acc.entries.length - 1);
          return;
        }
        const idx = pending.get(item.id);
        const result = {
          ok: item.exit_code === 0,
          text: clip(item.aggregated_output, LIMITS.maxToolChars),
        };
        if (idx !== undefined && acc.entries[idx]?.result === undefined) acc.entries[idx].result = result;
        else pushEntry(acc, { kind: 'tool', name: 'bash', args: clip(item.command, LIMITS.maxToolChars), result });
        pending.delete(item.id);
        return;
      }
      if (item.type === 'file_change') {
        const args = clip(JSON.stringify(item.changes || []), LIMITS.maxToolChars);
        if (!completed) { pushEntry(acc, { kind: 'tool', name: 'edit', args }); return; }
        pushEntry(acc, { kind: 'tool', name: 'edit', args, result: { ok: item.status !== 'failed', text: clip(item.status || 'completed', 200) } });
        return;
      }
      if (item.type === 'error') {
        // 实测：codex 把环境噪声也当 error item 下发——配置警告、插件市场更新失败
        // （git ls-remote / SSL_ERROR_SYSCALL）等，任务照样完成。一律只作诊断。
        // 成败由 exit code / turn.failed / turn.completed / 终值文件决定：
        // 真致命错误必然伴随缺终态或非零退出，那里才是 fail-closed 的位置。
        const message = String(item.message || '');
        pushEntry(acc, { kind: 'inject', text: clip(message, 600) });
        if (!acc.diagnostics) acc.diagnostics = [];
        if (acc.diagnostics.length < 20) acc.diagnostics.push(clip(message, 200));
        return;
      }
      acc.unknownEvents.add(`item:${item.type || '?'}`);
      return;
    }
    // 顶层 error 事件才是 codex 的真失败原因（实测：503 No available channel / Reconnecting n/5 /
    // stream 断开）。它不是 item.completed，旧实现当未知事件丢掉 → 用户只看到退出码。
    // 不单独判致命（codex 可能重连恢复），但保留最后一条供失败文案使用。
    if (type === 'error') {
      const message = String(ev.message || '');
      pushEntry(acc, { kind: 'inject', text: clip(message, 600) });
      if (!acc.diagnostics) acc.diagnostics = [];
      if (acc.diagnostics.length < 20) acc.diagnostics.push(clip(message, 200));
      acc.lastProtocolError = clip(message, 400);
      return;
    }
    if (type === 'thread.started' || type === 'token_count' || type === 'session.configured') return;
    acc.unknownEvents.add(String(type || '?'));
  },

  finalize(acc, exit, { stderrTail, stdoutPlainTail, files }) {
    const usage = acc.usage;
    const turns = acc.turns;
    const fail = (message, code, retryable = true) => {
      const error = new Error(message);
      error.code = code;
      error.retryable = retryable;
      return { text: '', usage, turns, error };
    };
    // codex 启动期失败的真正原因常在 stdout 纯文本（stderr 只有 "Reading prompt from stdin..."），
    // 两路尾部都带上，否则用户只看到一个退出码无法诊断。
    const diag = [acc.lastProtocolError, stdoutPlainTail, stderrTail].filter(Boolean).map((t) => clip(t, 400)).join(' | ');

    if (exit.spawnError) return fail(`codex 启动失败：${exit.spawnError}`, 'RUNTIME_SPAWN_FAILED', false);
    if (exit.code !== 0) {
      return fail(`codex 退出码 ${exit.code}${exit.signal ? `（信号 ${exit.signal}）` : ''}${diag ? `：${diag}` : ''}`, 'RUNTIME_EXIT_NONZERO');
    }
    if (acc.fatal) return fail(`codex 协议错误：${acc.fatal}`, 'RUNTIME_PROTOCOL_ERROR', false);
    if (!acc.sawTerminal) return fail(`codex 未收到 turn.completed，终态不可信${diag ? `：${diag}` : ''}`, 'RUNTIME_NO_TERMINAL', false);

    // 终值事实源：--output-last-message 文件。缺文件/空文件不回退到预览。
    let text = '';
    try { text = readFileSync(files.resultFile, 'utf8').trim(); } catch { text = ''; }
    if (!text) return fail('codex 未产出最终答案（--output-last-message 文件缺失或为空）', 'RUNTIME_EMPTY_RESULT', false);
    return { text, usage, turns, error: null };
  },
};
