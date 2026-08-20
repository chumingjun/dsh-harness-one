// LLM 适配层 v5：mock / deepseek / glm。
// - 节点级覆盖：createLLM() 返回带 forNode(nodeCfg) 的实例，按节点 model/channel
//   返回对应 LLM；chat({ maxRounds }) 支持每节点工具循环轮数（默认 6，上限 20）。
// - glm 默认走 BigModel Anthropic 兼容端点（Coding Plan 订阅通道）；
//   channel=openai 则走 paas/v4（按量计费通道）

const DEFAULT_MAX_TOOL_ROUNDS = 6;

import { AnthropicCompatLLM } from './llm-anthropic.js';

export class MockLLM {
  constructor() { this.name = 'mock'; }

  async chat({ systemPrompt, userPrompt, tools = [], executeTool = null }) {
    await sleep(200 + Math.random() * 400);

    // mock 模式也演示工具循环：勾了工具就假装调第一个文本工具一次
    let toolNarration = '';
    if (tools.length > 0 && executeTool) {
      const first = tools[0];
      try {
        const demoArgs = first.name === 'read_file'
          ? { filename: (userPrompt.match(/\S+\.(txt|md|csv|json)/)?.[0]) || 'unknown.txt' }
          : first.name === 'web_fetch'
            ? { url: (userPrompt.match(/https?:\/\/\S+/)?.[0]) || 'https://example.com' }
            : first.name.startsWith('feishu_doc_read')
              ? { url: (userPrompt.match(/https?:\/\/\S*feishu\.cn\/\S+/)?.[0]) || 'https://x.feishu.cn/docx/mock' }
              : { token: 'mocktoken', content: 'mock' };
        const result = await executeTool(first.name, demoArgs);
        toolNarration = `\n[工具调用 ${first.name}] → ${String(result).slice(0, 300)}`;
      } catch (e) {
        toolNarration = `\n[工具调用 ${first.name}] 失败: ${e.message}`;
      }
    }

    const lines = [
      `[mock] 已处理输入。`,
      `system 指令摘要: ${(systemPrompt || '(无)').slice(0, 60)}...`,
      `输入内容摘要: ${(userPrompt || '(无)').slice(0, 100)}...`,
      toolNarration,
      `输出(Mock)：根据上述指令完成整理，共 ${countChars(userPrompt)} 字输入。配置 DEEPSEEK_API_KEY 后将调用真实模型。`,
    ];
    return lines.filter(Boolean).join('\n');
  }
}

export class OpenAICompatLLM {
  constructor({ name, apiKey, baseUrl, model }) {
    if (!apiKey) throw new Error(`${name} API key 未配置`);
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  // tools: [{ name, description, input_schema }]；executeTool(name, args) => string
  async chat({ systemPrompt, userPrompt, tools = [], executeTool = null, maxRounds }) {
    const rounds = Math.max(1, Math.min(Number(maxRounds) || DEFAULT_MAX_TOOL_ROUNDS, 20));
    const messages = [
      { role: 'system', content: systemPrompt || '你是一个帮助完成任务的助手。' },
      { role: 'user', content: userPrompt },
    ];
    const apiTools = tools.length
      ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      : undefined;

    for (let round = 0; round < rounds; round++) {
      const body = {
        model: this.model,
        messages,
        stream: false,
        ...(apiTools ? { tools: apiTools, tool_choice: 'auto' } : {}),
      };
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${this.name} API ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error(`${this.name} 返回缺少 message`);

      // 无工具调用 → 最终回答
      if (!msg.tool_calls?.length) return msg.content || '(空响应)';

      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let result;
        if (executeTool) {
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            result = await executeTool(tc.function.name, args);
          } catch (e) {
            result = `[工具执行出错] ${e.message}`;
          }
        } else {
          result = '[工具执行器不可用]';
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 8000) });
      }
    }
    return '(达到最大工具调用轮数，强制返回)';
  }
}

export const DeepSeekLLM = class extends OpenAICompatLLM {
  constructor(opts) {
    super({ name: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', ...opts });
  }
};

// GLM：智谱 BigModel 开放平台，OpenAI 兼容端点 /api/paas/v4
export const GLMLLM = class extends OpenAICompatLLM {
  constructor(opts) {
    super({ name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', ...opts });
  }
};

// LLM 路由：持有全局默认（环境变量决定），并按节点配置覆盖 model/channel。
// 节点配置字段：{ model?: string, channel?: 'anthropic'|'openai' }
export class LLMRouter {
  constructor({ defaultLLM, glmKey, glmDefaultChannel, deepseekKey }) {
    this.default = defaultLLM;
    this.glmKey = glmKey || null;
    this.glmDefaultChannel = glmDefaultChannel || 'anthropic';
    this.deepseekKey = deepseekKey || null;
    this._cache = new Map();
  }

  get name() { return this.default.name; }
  get defaultModel() { return this.default.model || null; }

  // 节点级解析：返回该节点实际使用的 LLM 实例
  forNode(nodeCfg = {}) {
    const wantedModel = nodeCfg.model || '';
    const channel = nodeCfg.channel || '';

    // 无任何覆盖 → 全局默认
    if (!wantedModel && !channel) return this.default;

    // deepseek 系模型 → DeepSeek 通道（需配 Key）
    if (/^deepseek/i.test(wantedModel)) {
      if (!this.deepseekKey) return this._err('DeepSeek 未配置 DEEPSEEK_API_KEY');
      return this._cached(`ds:${wantedModel}`, () => new DeepSeekLLM({
        apiKey: this.deepseekKey,
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        model: wantedModel,
      }));
    }

    // glm 系模型（或显式 glm 渠道）→ 按 channel 选协议
    if (/^glm/i.test(wantedModel) || this.glmKey) {
      if (!this.glmKey) return this._err('GLM 未配置 GLM_API_KEY');
      const ch = channel || this.glmDefaultChannel;
      const model = wantedModel || this.default.model || 'glm-5.3';
      if (ch === 'anthropic') {
        return this._cached(`glm-a:${model}`, () => new AnthropicCompatLLM({
          name: 'glm', apiKey: this.glmKey,
          baseUrl: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/anthropic',
          model,
        }));
      }
      return this._cached(`glm-o:${model}`, () => new GLMLLM({
        apiKey: this.glmKey,
        baseUrl: process.env.GLM_OPENAI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
        model,
      }));
    }

    return this.default;
  }

  _cached(key, make) {
    if (!this._cache.has(key)) this._cache.set(key, make());
    return this._cache.get(key);
  }

  _err(msg) {
    const e = new Error(msg);
    e.isConfigError = true;
    return { name: 'error', chat: async () => { throw e; } };
  }

  // 供 /api/llm-config 暴露给前端
  describe() {
    return {
      defaultMode: this.default.name,
      defaultModel: this.defaultModel,
      glmEnabled: Boolean(this.glmKey),
      glmDefaultChannel: this.glmDefaultChannel,
      deepseekEnabled: Boolean(this.deepseekKey),
      glmModels: ['glm-5.3', 'glm-5.2', 'glm-5-turbo', 'glm-4.7'],
      deepseekModels: ['deepseek-chat', 'deepseek-reasoner'],
      defaultMaxRounds: DEFAULT_MAX_TOOL_ROUNDS,
    };
  }
}

export function createLLM() {
  const glmKey = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || null;
  const deepseekKey = process.env.DEEPSEEK_API_KEY || null;

  if (glmKey) {
    const model = process.env.GLM_MODEL || 'glm-5.3';
    const channel = (process.env.GLM_COMPAT || 'anthropic') === 'openai' ? 'openai' : 'anthropic';
    const defaultLLM = channel === 'anthropic'
      ? new AnthropicCompatLLM({ name: 'glm', apiKey: glmKey, baseUrl: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/anthropic', model })
      : new GLMLLM({ apiKey: glmKey, baseUrl: process.env.GLM_OPENAI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4', model });
    console.log(`[llm] 默认 GLM model=${model}（${channel} 通道）；节点可按 model/channel 覆盖`);
    return new LLMRouter({ defaultLLM, glmKey, glmDefaultChannel: channel, deepseekKey });
  }
  if (deepseekKey) {
    const defaultLLM = new DeepSeekLLM({
      apiKey: deepseekKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    });
    console.log(`[llm] 默认 DeepSeek model=${defaultLLM.model}；节点可按 model/channel 覆盖`);
    return new LLMRouter({ defaultLLM, glmKey: null, glmDefaultChannel: 'anthropic', deepseekKey });
  }
  console.log('[llm] 使用 mock 模式（设置 GLM_API_KEY 或 DEEPSEEK_API_KEY 启用真实模型）');
  return new LLMRouter({ defaultLLM: new MockLLM(), glmKey: null, glmDefaultChannel: 'anthropic', deepseekKey: null });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function countChars(s) { return (s || '').length; }
