export const name = 'dsh-ccpg-llm-guard';

const MALFORMED_TOOL_CALL_CODE = 'EMPTY_RESPONSE';

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
