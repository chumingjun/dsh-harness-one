import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const providerName = 'ccpg-scheme-defaults';
const rank = 600;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const officeRoot = join(root, '..', 'vendor', 'dsh-skill-office', 'assets');
const names = ['ccpg-scheme', 'pdf', 'office-docx', 'office-pptx', 'office-xlsx'];

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!frontmatter) throw new Error(`scheme skill has no frontmatter: ${path}`);
  const field = (name) => new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*$`, 'mu').exec(frontmatter[1])?.[1];
  const name = field('name'); const description = field('description');
  if (!name || !description) throw new Error(`scheme skill frontmatter is incomplete: ${path}`);
  return { name, description, content: raw.slice(frontmatter[0].length).trim() };
}

export function registerSchemeSkills(ctx) {
  if (!ctx.skills?.registerProvider) throw new Error('ctx.skills.registerProvider is required');
  return ctx.skills.registerProvider((control) => ({
    name: providerName,
    async list() {
      if (control.signal.aborted) throw new Error('scheme skill provider is disposed');
      return Promise.all(names.map(async (name) => {
        const directory = join(name.startsWith('office-') ? officeRoot : root, name);
        const path = join(directory, 'SKILL.md'); const skill = parseSkill(await readFile(path, 'utf8'), path);
        return { name: skill.name, description: skill.description, invocation: { modelInvocable: true, userInvocable: true }, provider: providerName, source: 'bundled', rank: name.startsWith('office-') ? rank + 1 : rank, resourceBase: { kind: 'directory', path: directory }, locator: path };
      }));
    },
    async get(candidate, options = {}) {
      if (control.signal.aborted || options.signal?.aborted) throw new Error('scheme skill provider is disposed');
      const path = candidate.locator; const skill = parseSkill(await readFile(path, { encoding: 'utf8', signal: options.signal }), path);
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      const reading = candidate.name.startsWith('office-') ? '\n\n## Scheme material reading\n\nFor read-only scheme inputs, preserve the original and use native file capabilities to read text, tables and relevant document content. Rendering is needed only for an actual image or layout question. Do not run delivery/layout QA for ordinary material extraction. Save one Markdown interpretation through material_complete when review is needed; keep unreadable facts explicit. The installed host Office skill takes precedence over this bundled fallback. If renderer paths are unavailable, use the scheme material_render_pages capability for explicitly selected pages; do not discover or install another renderer.' : '';
      return { ...summary, content: skill.content + reading };
    },
  }));
}
