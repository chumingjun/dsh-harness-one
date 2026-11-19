// claude code 适配器：claude -p --output-format stream-json 的事件投影与终态判定。
// 实测依据（本机 claude 2.1.327）：
//   - --json-schema 可用：result.result 即符合 schema 的 JSON 字符串（subtype success / is_error false）
//   - --permission-mode acceptEdits 能覆盖用户全局 bypassPermissions；不默认放行 Bash
//   - --allowedTools 是可变参数会吞掉 argv 里的 prompt → prompt 一律走 stdin
//   - --no-session-persistence 仅 --print 下有效
//   - stream_event.event.content_block_delta.delta{type:text_delta,text} 为增量；thinking_delta 不进预览
//   - tool_use{id,name,input} 与 user.tool_result{tool_use_id,content} 按 id 配对
//   - permission_denials 非空 = 有工具被拒 → 判失败，绝不读模型自述判成功
import { LIMITS, pushEntry } from './runtime-cli.js';

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（截断）` : text;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  return '';
}

function pendingOf(acc) {
  if (!acc._claudePending) acc._claudePending = new Map();
  return acc._claudePending;
}

export const claudeRuntime = {
  id: 'claude',
  bin: 'claude',
  probeArgs: ['--version'],

  buildSpawn({ persona, userPrompt, cwd, model, files, permission = 'restricted' }) {
    // 防御性复核：单点校验在分派层（resolveRuntimePermission），这里兜底直调
    if (!['restricted', 'bash', 'full'].includes(permission)) {
      const error = new Error(`claude 权限模式「${permission}」无效（可选 restricted/bash/full）`);
      error.code = 'RUNTIME_BAD_PERMISSION'; error.retryable = false; throw error;
    }
    const argv = [
      '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      // full = bypassPermissions（用户显式选择 + 运行期授权，本机取证 headless 单独可用）；
      // 只替换 mode 值，不重复传 --permission-mode
      '--permission-mode', permission === 'full' ? 'bypassPermissions' : 'acceptEdits',
      '--no-session-persistence',
      // 实测：用户 SessionStart hook 在无控制终端时会阻塞（dsh 生产以 nohup/服务方式无 tty 运行），
      // claude 发完 hook_started 就停住直到节点超时。无人值守委派必须关掉用户 hooks：
      // 既解 tty 依赖，也避免交互 hook 扩展能力/干扰判定（前台有 tty 时不复现，极隐蔽）。
      '--settings', '{"disableAllHooks":true}',
      // 实测根因：claude 启动会拉起用户全局 mcpServers（npm exec @playwright/mcp@latest、
      // uvx minimax… 等需联网安装/初始化），等它们就绪就停住 → 节点空转到超时。
      // 无人值守委派不继承环境 MCP：既解启动挂起，也避免环境 MCP 扩展能力/注入工具。
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ];
    if (model) argv.push('--model', model);
    // schema 走 argv（非凭据）；persona+业务输入走 stdin，避免出现在进程列表
    if (files.schema) argv.push('--json-schema', JSON.stringify(files.schema));
    // acceptEdits 只自动接受编辑、不放行 Bash（实测模型会反复试 Bash 被拒空转）。
    // bash 模式（用户显式选择 + 运行期授权）才放行；--allowedTools 是可变参数，
    // 放最后且 prompt 走 stdin，避免吞词。无命令级边界，故默认 restricted + lint/UI 警告。
    if (permission === 'bash') argv.push('--allowedTools', 'Bash');
    return { argv, stdin: `${persona}\n\n${userPrompt}` };
  },

  onFrame(ev, acc) {
    const type = ev?.type;
    if (type === 'stream_event') {
      const delta = ev.event?.delta;
      if (ev.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        acc.preview = `${acc.preview}${delta.text}`.slice(-LIMITS.maxPreviewChars);
      }
      return; // 增量只进预览，不逐 delta 持久化
    }
    if (type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && block.text) {
          acc.preview = block.text;
          acc.finalText = block.text;
          pushEntry(acc, { kind: 'assistant', text: clip(block.text, LIMITS.maxAssistantChars) });
        } else if (block.type === 'tool_use') {
          pushEntry(acc, { kind: 'tool', name: block.name, args: clip(JSON.stringify(block.input ?? {}), LIMITS.maxToolChars) });
          pendingOf(acc).set(block.id, acc.entries.length - 1);
        }
        // thinking 块不进轨迹（噪声大且非交付）
      }
      return;
    }
    if (type === 'user') {
      for (const block of ev.message?.content || []) {
        if (block.type !== 'tool_result') continue;
        const idx = pendingOf(acc).get(block.tool_use_id);
        const result = { ok: block.is_error !== true, text: clip(toolResultText(block.content), LIMITS.maxToolChars) };
        if (idx !== undefined && acc.entries[idx]?.result === undefined) acc.entries[idx].result = result;
        pendingOf(acc).delete(block.tool_use_id);
      }
      return;
    }
    if (type === 'result') {
      acc.sawTerminal = true;
      acc.resultSubtype = ev.subtype;
      acc.resultIsError = ev.is_error === true;
      acc.resultText = typeof ev.result === 'string' ? ev.result : '';
      acc.turns = Number(ev.num_turns) || acc.turns;
      acc.denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
      if (ev.usage) {
        acc.usage = {
          inputTokens: Number(ev.usage.input_tokens) || 0,
          outputTokens: Number(ev.usage.output_tokens) || 0,
          ...(ev.total_cost_usd != null ? { costUsd: Number(ev.total_cost_usd) } : {}),
        };
      }
      return;
    }
    // system:init / hook_* / status / thinking_tokens 不进轨迹
    if (type === 'system') return;
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
    const diag = [acc.lastProtocolError, stdoutPlainTail, stderrTail].filter(Boolean).map((t) => clip(t, 400)).join(' | ');

    if (exit.spawnError) return fail(`claude 启动失败：${exit.spawnError}`, 'RUNTIME_SPAWN_FAILED', false);
    if (exit.code !== 0) return fail(`claude 退出码 ${exit.code}${exit.signal ? `（信号 ${exit.signal}）` : ''}${diag ? `：${diag}` : ''}`, 'RUNTIME_EXIT_NONZERO');
    if (!acc.sawTerminal) return fail(`claude 未收到 result 终态帧，终态不可信${diag ? `：${diag}` : ''}`, 'RUNTIME_NO_TERMINAL', false);
    if (acc.resultSubtype !== 'success' || acc.resultIsError) {
      return fail(`claude 终态为 ${acc.resultSubtype || '(空)'}${acc.resultIsError ? '（is_error）' : ''}${acc.resultText ? `：${clip(acc.resultText, 300)}` : ''}`, 'RUNTIME_RESULT_ERROR', false);
    }
    // 权限拒绝 = 有工具没跑成 → 判失败，绝不把模型"我被拒了"的自述当成功
    if (acc.denials.length) {
      const summary = clip(JSON.stringify(acc.denials.slice(0, 5)), 400);
      return fail(`claude 有工具被权限拒绝（${acc.denials.length} 项）：${summary}`, 'RUNTIME_PERMISSION_DENIED', false);
    }
    const text = (acc.resultText || acc.finalText || '').trim();
    if (!text) return fail('claude 未产出最终答案（result 为空）', 'RUNTIME_EMPTY_RESULT', false);
    return { text, usage, turns, error: null };
  },
};
