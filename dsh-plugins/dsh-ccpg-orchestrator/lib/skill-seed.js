// workflow-one 技能种子：把 skills/workflow-one.md 写进 dsh 用户级技能发现根，
// 官方 / 菜单自动列出（dsh-tool-skill 注入正文），机制沿 larkauth 种 feishu-cli 先例。
// 幂等且不覆盖用户改动：目标存在且无管理标记（用户自己写的）→不碰；
// 带标记且内容不同（插件发版更新）→覆盖；内容相同→跳过。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SKILL_ID = 'workflow-one';
const SKILL_MARKER = 'managed-by: dsh-ccpg-orchestrator';
const BUNDLED_SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', `${SKILL_ID}.md`);

/** 种子到 DSH_HOME（未设置则 ~/.dsh）/skills/；返回写入的目标路径，未写返回 null */
export function ensureWorkflowSkill({ log } = {}) {
  const targetDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills');
  const target = join(targetDir, `${SKILL_ID}.md`);
  try {
    const src = readFileSync(BUNDLED_SKILL, 'utf8');
    if (existsSync(target)) {
      const cur = readFileSync(target, 'utf8');
      if (!cur.includes(SKILL_MARKER)) return null; // 用户改过，不覆盖
      if (cur === src) return null;
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, src);
    log?.(`技能已种子: ${target}`);
    return target;
  } catch (e) {
    log?.(`技能种子失败: ${e.message || e}`);
    return null;
  }
}
