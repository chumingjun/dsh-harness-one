// Anthropic 协议适配（BigModel Coding Plan 走 /api/anthropic）：
// messages 协议 + tool_use 工具循环。GLM-5.3 会返回 thinking 块，仅取 text 块作为输出。

const DEFAULT_MAX_TOOL_ROUNDS = 6;

export class AnthropicCompatLLM {
  constructor({ name = 'glm', apiKey, baseUrl, model, maxTokens = 8192 }) {
    if (!apiKey) throw new Error(`${name} API key 未配置`);
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.maxTokens = maxTokens;
  }

  async chat({ systemPrompt, userPrompt, tools = [], executeTool = null, maxRounds }) {
    const rounds = Math.max(1, Math.min(Number(maxRounds) || DEFAULT_MAX_TOOL_ROUNDS, 20));
    const messages = [{ role: 'user', content: userPrompt || '(无输入)' }];
    const apiTools = tools.length
      ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
      : undefined;

    for (let round = 0; round < rounds; round++) {
      const body = {
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt || '你是一个帮助完成任务的助手。',
        messages,
        ...(apiTools ? { tools: apiTools } : {}),
      };
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${this.name}(anthropic) API ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.type === 'error') throw new Error(`${this.name}(anthropic) ${data.error?.message || '未知错误'}`);

      const blocks = data.content || [];
      const textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      // 无工具调用 → 最终回答
      if (!toolUses.length) return textOut || '(空响应)';

      messages.push({ role: 'assistant', content: blocks });
      const toolResults = [];
      for (const tu of toolUses) {
        let result;
        if (executeTool) {
          try {
            result = await executeTool(tu.name, tu.input || {});
          } catch (e) {
            result = `[工具执行出错] ${e.message}`;
          }
        } else {
          result = '[工具执行器不可用]';
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: String(result).slice(0, 8000),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    return '(达到最大工具调用轮数，强制返回)';
  }
}
