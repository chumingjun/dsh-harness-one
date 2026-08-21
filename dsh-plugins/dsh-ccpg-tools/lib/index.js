// dsh-ccpg-tools：物业编排的模型工具插件（Cordis plugin）。
// 在 dsh 进程内注册到 ctx.tools：
//   - feishu_doc_read / feishu_doc_write：飞书文档读写
// 工作区文件能力由 dsh 自带 fs 工具承担（节点 cwd 即工作区），不再重复注册。
// 技能加载由 dsh 原生 skill 工具（dsh-tool-skill + ctx.skills）承担，无自研 load_skill。

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createFeishu, FeishuClient } from './feishu.js';
import { getFeishuCredOrEnv } from './credentials.js';

export const name = 'dsh-ccpg-tools';
export const inject = ['tools'];

export const Config = z.object({});

// defineTool 要求 output: { schema, render }；文本型工具统一这个工厂
function textTool(def) {
  return defineTool({
    ...def,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
  });
}

export function apply(ctx, config) {
  const feishu = createFeishu();

  ctx.tools.register(textTool({
    name: 'feishu_doc_read',
    description: '读取一个飞书文档。输入飞书 docx/wiki 链接或 token，返回文档标题与正文文本。',
    parameters: {
      url: { type: 'string', required: true, description: '飞书文档链接（https://xxx.feishu.cn/docx/... 或 /wiki/...）或 token' },
      credentialId: { type: 'string', description: '飞书应用凭据 id（画布配置的多套凭据；留空用默认）' },
    },
    async execute(args) {
      const link = extractLink(args.url);
      if (!link) return '未识别出飞书文档链接';
      const cred = getFeishuCredOrEnv(args.credentialId);
      const cli = cred ? new FeishuClient({ appId: cred.appId, appSecret: cred.appSecret }) : feishu;
      if (!cli.enabled) {
        return `飞书未配置（在画布「设置」添加应用凭据），识别到 ${link.type} token=${link.token}`;
      }
      try {
        const { objType, token } = await cli.resolveToken(link.type, link.token);
        if (objType !== 'docx') return `暂不支持 ${objType} 类型，仅支持 docx/wiki 文档`;
        return await cli.docToMarkdown(token);
      } catch (e) {
        return `读取失败: ${e.message}`;
      }
    },
  }));

  ctx.tools.register(textTool({
    name: 'feishu_doc_write',
    description: '把文本内容追加写入一个飞书文档。需要目标文档 token。',
    parameters: {
      token: { type: 'string', required: true, description: '目标飞书 docx 文档 token' },
      content: { type: 'string', required: true, description: '要追加的文本内容' },
      credentialId: { type: 'string', description: '飞书应用凭据 id（画布配置的多套凭据；留空用默认）' },
    },
    async execute(args) {
      const cred = getFeishuCredOrEnv(args.credentialId);
      const cli = cred ? new FeishuClient({ appId: cred.appId, appSecret: cred.appSecret }) : feishu;
      if (!cli.enabled) {
        return `飞书未配置，写入跳过。目标 token=${args.token}，内容 ${args.content?.length ?? 0} 字`;
      }
      try {
        const created = await cli.api(`/docx/v1/documents/${args.token}/blocks/${args.token}/children`, {
          method: 'POST',
          body: JSON.stringify({
            children: String(args.content || '').split(/\n+/).filter(Boolean).slice(0, 50).map((text) => ({
              block_type: 2,
              paragraph: { elements: [{ text_run: { content: text } }] },
            })),
          }),
        });
        return `已追加 ${created.children?.length ?? '?'} 个段落到文档 ${args.token}`;
      } catch (e) {
        return `写入失败: ${e.message}`;
      }
    },
  }));
}

function extractLink(input) {
  const m = String(input || '').match(/feishu\.cn\/(docx|wiki|sheets|base)\/([A-Za-z0-9]+)/);
  if (m) return { type: m[1], token: m[2] };
  const t = String(input || '').trim();
  if (/^[A-Za-z0-9]{10,}$/.test(t)) return { type: 'doc', token: t };
  return null;
}
