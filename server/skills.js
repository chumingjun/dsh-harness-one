// 技能库（渐进式加载，progressive disclosure）：
// - 常驻上下文的只有目录索引（id + 名称 + 一行描述）
// - 技能正文由模型在执行中按需调 load_skill 工具加载，不整包塞 systemPrompt
// - data/skills/*.md：frontmatter(name/description) + 正文为技能内容

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'skills');

function parseSkill(filename) {
  const raw = readFileSync(join(SKILL_DIR, filename), 'utf8');
  const meta = {};
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
    body = m[2];
  }
  return {
    id: filename.replace(/\.md$/i, ''),
    name: meta.name || filename.replace(/\.md$/i, ''),
    description: meta.description || '',
    body: body.trim(),
  };
}

function allSkills() {
  try {
    return readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md')).map(parseSkill);
  } catch {
    return [];
  }
}

// 目录清单：常驻上下文（仅 id/名称/描述）
export function listSkills() {
  return allSkills().map(({ id, name, description }) => ({ id, name, description }));
}

// 按需加载单个技能正文（load_skill 工具的后端）
export function getSkill(idOrName) {
  const hit = allSkills().find((s) => s.id === idOrName || s.name === idOrName);
  return hit || null;
}

// 注入 systemPrompt 的目录索引块（节点勾选了技能时才有）
export function skillIndexPrompt(skills) {
  const list = skills.map((s) => `- ${s.name}（load_skill 参数 name="${s.id}"）：${s.description}`);
  return `你可以使用 load_skill 工具按需加载以下技能的详细规范（先读目录，需要哪个规范再加载哪个，不要一次全加载）：\n${list.join('\n')}`;
}
