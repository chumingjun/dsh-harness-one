// 工具注册表 + 执行器。对应 dsh 的 ctx.tools seam：注册 schema，按名称分发执行。
// 每个智能体节点勾选的工具子集在编排时注入模型。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFeishuLinks } from './feishu.js';
import { getSkill, listSkills } from './skills.js';
import { wsWrite, wsRead, wsList } from './workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATTACH_DIR = join(__dirname, '..', 'data', 'attachments');

// ---- 工具定义（schema 透传给模型） ----

const definitions = [
  {
    name: 'read_file',
    description: '读取运行时上传的附件内容。attachments 中列出的文件名均可读取。',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '附件文件名（来自上游 attachments 清单）' },
      },
      required: ['filename'],
    },
  },
  {
    name: 'web_fetch',
    description: '抓取一个公开 HTTP(S) URL 的文本内容（截断到前 8000 字符）。',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 URL' } },
      required: ['url'],
    },
  },
  {
    name: 'feishu_doc_read',
    description: '读取一个飞书文档。输入飞书文档/wiki 链接或 token，返回文档标题与正文文本。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '飞书文档链接（https://xxx.feishu.cn/docx/... 或 /wiki/...）' },
      },
      required: ['url'],
    },
  },
  {
    name: 'feishu_doc_write',
    description: '把文本内容写入（追加到）一个飞书文档。需要文档 token。',
    input_schema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: '目标飞书 docx 文档 token' },
        content: { type: 'string', description: '要追加的文本内容' },
      },
      required: ['token', 'content'],
    },
  },
];

// 渐进式技能加载工具：目录常驻 systemPrompt，正文按需取
const loadSkillDefinition = {
  name: 'load_skill',
  description: '加载一个技能的详细规范。systemPrompt 里的技能目录列出了可用 name；需要某个规范时再调用，不要一次加载全部。',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能 name（来自技能目录清单，如 "gongdan-guifan"）' },
    },
    required: ['name'],
  },
};

// 工作区文件工具：agent 的落盘产物（每个节点独立目录，ctx.ws 注入）
const wsDefinitions = [
  {
    name: 'ws_write',
    description: '把内容写入你工作区内的文件（可建子目录）。用于沉淀中间产物和最终交付物，如 report.md、工单.md。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径，如 "工单.md"' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'ws_read',
    description: '读取你工作区内一个文件的内容（自己之前写的、或上游 agent 留下的）。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'ws_list',
    description: '列出你工作区的文件清单（含子目录）。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的目录路径，默认根目录' } },
    },
  },
];

export function toolDefinitions(_selected) {
  // 占位兼容：agent 节点走 agentToolSet；此函数仅返回基础定义
  return [...definitions, ...wsDefinitions];
}

// 节点勾选了技能时：在工具清单里追加 load_skill（与工具勾选独立）
export function toolDefinitionsWithSkills(selected) {
  const base = toolDefinitions(selected);
  return base.some((d) => d.name === 'load_skill') ? base : [...base, loadSkillDefinition];
}

// 勾选过滤：'*' 全量；否则按名字
export function agentToolSet(selected) {
  const pool = [...definitions, ...wsDefinitions, loadSkillDefinition];
  if (!selected?.length) {
    // 未勾选外部工具：仍给工作区三件套 + load_skill（agent 基础能力）
    return [...wsDefinitions, loadSkillDefinition];
  }
  const names = new Set(selected.includes('*') ? pool.map((d) => d.name) : selected);
  const base = pool.filter((d) => names.has(d.name));
  const baseNames = new Set(base.map((d) => d.name));
  // 基础能力始终保留
  for (const d of [...wsDefinitions, loadSkillDefinition]) {
    if (!baseNames.has(d.name)) base.push(d);
  }
  return base;
}

// ---- 执行器 ----

export function createToolExecutor({ feishu }) {
  return {
    definitions,

    async execute(name, args, ctx = {}) {
      switch (name) {
        case 'read_file': {
          const { filename } = args;
          if (!ctx.attachments?.some((a) => a.filename === filename)) {
            return `[read_file] 附件清单中没有 ${JSON.stringify(filename)}。可用附件：${(ctx.attachments || []).map((a) => a.filename).join(', ') || '(无)'}`;
          }
          try {
            const content = readFileSync(join(ATTACH_DIR, filename), 'utf8');
            return content.slice(0, 8000);
          } catch {
            return `[read_file] ${filename} 是二进制或不可读为文本`;
          }
        }

        case 'web_fetch': {
          const { url } = args;
          if (!/^https?:\/\//.test(url)) return '[web_fetch] 仅支持 http(s) URL';
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            const text = await res.text();
            return stripHtml(text).slice(0, 8000) || '(空响应)';
          } catch (e) {
            return `[web_fetch] 抓取失败: ${e.message}`;
          }
        }

        case 'feishu_doc_read': {
          const links = extractFeishuLinks(args.url);
          const link = links[0] || (args.url?.startsWith('http') ? null : { type: 'doc', token: args.url });
          if (!link) return '[feishu_doc_read] 未识别出飞书文档链接';
          if (!feishu?.enabled) {
            return `[feishu_doc_read] 飞书未配置（需 FEISHU_APP_ID/FEISHU_APP_SECRET），识别到 ${link.type} 文档 token=${link.token}。配置后即可读取真实内容。`;
          }
          const { objType, token } = await feishu.resolveToken(link.type, link.token);
          if (objType !== 'docx') return `[feishu_doc_read] 暂不支持 ${objType} 类型，仅支持 docx/wiki 文档`;
          return await feishu.docToMarkdown(token);
        }

        case 'feishu_doc_write': {
          if (!feishu?.enabled) {
            return `[feishu_doc_write] 飞书未配置，写入被跳过。目标 token=${args.token}，内容 ${args.content?.length ?? 0} 字。`;
          }
          // 追加一个文本块到文档末尾
          const blocks = await feishu.api(`/docx/v1/documents/${args.token}/blocks/${args.token}/descendant`, {
            method: 'GET',
          }).catch(() => null);
          void blocks;
          // 简化实现：以 children 形式在文档根 block 下追加段落
          const created = await feishu.api(`/docx/v1/documents/${args.token}/blocks/${args.token}/children`, {
            method: 'POST',
            body: JSON.stringify({
              children: splitParagraphs(args.content).map((text) => ({
                block_type: 2, // paragraph
                paragraph: { elements: [{ text_run: { content: text } }] },
              })),
            }),
          });
          return `[feishu_doc_write] 已追加 ${created.children?.length ?? '?'} 个段落到文档 ${args.token}`;
        }

        case 'load_skill': {
          const skill = getSkill(args.name);
          if (!skill) {
            const available = listSkills().map((s) => s.id).join(', ');
            return `[load_skill] 没有技能 "${args.name}"。可用技能：${available || '(无)'}`;
          }
          return `【技能：${skill.name}】\n${skill.body}`;
        }

        case 'ws_write': {
          if (!ctx.ws) return '[ws_write] 该节点没有工作区';
          try {
            const p = wsWrite(ctx.ws, args.path, args.content);
            return `[ws_write] 已写入 ${p}`;
          } catch (e) { return `[ws_write] ${e.message}`; }
        }

        case 'ws_read': {
          if (!ctx.ws) return '[ws_read] 该节点没有工作区';
          try {
            return wsRead(ctx.ws, args.path).slice(0, 16_000);
          } catch (e) { return `[ws_read] ${e.message}`; }
        }

        case 'ws_list': {
          if (!ctx.ws) return '[ws_list] 该节点没有工作区';
          try {
            return wsList(ctx.ws, args.path || '.');
          } catch (e) { return `[ws_list] ${e.message}`; }
        }

        default:
          return `[未知工具: ${name}]`;
      }
    },
  };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim();
}

function splitParagraphs(text) {
  return String(text || '').split(/\n+/).filter(Boolean).slice(0, 50);
}
