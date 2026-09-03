export const name = 'dsh-ccpg-llm-guard';

const MALFORMED_TOOL_CALL_CODE = 'EMPTY_RESPONSE';

// dsh 的 write/edit 等变更类工具把 sandbox_permissions/justification 当「沙箱升级」
// 参数：只有从更窄模式升级时才合法，且必须成对、justification 非空。会话已跑在
// danger-full-access（最宽）时，模型自发带上这对参数（GPT 系常见：预填权限声明）
// 会被 dsh-sandbox 校验直接拒绝，写入永远失败。清洗层在流上把这类多余参数剔除。
const ESCALATION_FIELDS = ['sandbox_permissions', 'justification'];

function malformedToolCall(block) {
  return block?.type === 'tool-call' && (
    typeof block.id !== 'string' || block.id.trim() === '' ||
    typeof block.name !== 'string' || block.name.trim() === '' ||
    typeof block.arguments !== 'string' || block.arguments.trim() === ''
  );
}

function malformedFinish() {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: 'model returned a tool call with an empty id, name, or arguments',
        code: MALFORMED_TOOL_CALL_CODE,
      },
    },
  };
}

// 剔除多余的沙箱升级参数。仅在解析成功、且对象里确实含这两个字段之一时重写；
// 解析失败或无该字段一律原样返回——升级参数若真被沙箱拒过，拒错文案会引导模型
// 正确重试，这里不能把它吞掉。justification 单独出现（无 sandbox_permissions）
// 同样过不了 dsh-sandbox 的成对校验，一并剔除。
function stripEscalationArgs(argumentsText) {
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return argumentsText;
  }
  if (!ESCALATION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(parsed, field))) {
    return argumentsText;
  }
  for (const field of ESCALATION_FIELDS) delete parsed[field];
  return JSON.stringify(parsed);
}

export async function* guardToolCalls(stream) {
  let buffered;

  for await (const chunk of stream) {
    if (buffered) {
      buffered.push(chunk);
      if (chunk.type !== 'finish') continue;

      const invalid = buffered.some((item) => item.type === 'block-end' && malformedToolCall(item.block));
      if (invalid) {
        for (const item of buffered) {
          if (item.type === 'usage') yield item;
        }
        yield malformedFinish();
        return;
      }

      for (const item of buffered) {
        if (item.type === 'block-end' && item.block?.type === 'tool-call' && typeof item.block.arguments === 'string') {
          item.block = { ...item.block, arguments: stripEscalationArgs(item.block.arguments) };
        }
      }
      yield* buffered;
      return;
    }

    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
      buffered = [chunk];
      continue;
    }

    yield chunk;
  }
}

export function apply(ctx) {
  ctx.on('llm/stream', (_options, next) => guardToolCalls(next()), {
    global: true,
    prepend: true,
  });
}
