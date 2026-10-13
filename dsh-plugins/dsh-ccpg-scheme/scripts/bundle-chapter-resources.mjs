import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readableName } from './resource-names.mjs';

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const labels = { knowledge: '知识依据', 'output-template': '输出模板', 'reference-example': '参考案例', 'collection-template': '采集模板' };

export function bundleChapterResources(root, chapters, mainRows, sourceDir, authorization) {
  if (!authorization) throw new Error('internal resource distribution authorization is required');
  const index = JSON.parse(fs.readFileSync(path.join(sourceDir, 'index.json'), 'utf8'));
  if (index.group !== 'rules') throw new Error('project rehearsal materials cannot be bundled as skills');
  const resources = [];
  const copy = (source, target, record) => {
    const real = fs.realpathSync(source);
    if (!real.startsWith(fs.realpathSync(sourceDir) + path.sep)) throw new Error('resource escapes source directory');
    const dest = path.join(root, target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(real, dest);
    resources.push({ path: target, sha256: digest(dest), source: record.source, sourceRevision: index.sourceRevision, permission: authorization });
  };
  for (const chapter of chapters) {
    const skillDir = path.dirname(chapter.skill);
    const relevant = index.records.filter((record) => record.uses.some((use) => {
      const code = String(mainRows[use.row - 2]?.['章节'] ?? '').match(/^\d+(?:\.\d+)*/)?.[0];
      return code === chapter.code;
    }));
    chapter.references = [];
    for (const record of relevant) {
      const uses = record.uses.filter((use) => String(mainRows[use.row - 2]?.['章节'] ?? '').match(/^\d+(?:\.\d+)*/)?.[0] === chapter.code);
      const roles = [...new Set(uses.map((use) => use.role))];
      const role = roles.includes('knowledge') ? 'knowledge' : roles.includes('output-template') ? 'output-template' : roles[0];
      const leaf = readableName(record.title);
      const folder = role.includes('template') ? 'assets' : 'references';
      const duplicate = relevant.some((other) => other.id !== record.id && readableName(other.title) === leaf);
      const relativeDir = path.join(folder, labels[role], leaf + (duplicate ? `-来源行${Math.min(...uses.map((use) => use.row))}` : ''));
      const ref = { title: record.title, roles, source: record.source, sourceRows: uses.map((use) => use.row), status: record.status, inputIds: [...new Set(uses.filter((use) => use.role === 'knowledge').map((use) => String(mainRows[use.row - 2]?.['输入资料'] ?? '').match(/^Z-\d+/)?.[0]).filter(Boolean))] };
      chapter.references.push(ref);
      if (record.status === 'skipped') { ref.reason = record.skipReason; continue; }
      if (record.status !== 'downloaded' || !record.original) throw new Error(`resource not downloaded: ${record.title}`);
      const original = path.join(sourceDir, record.original);
      if (digest(original) !== record.sha256) throw new Error(`source hash mismatch: ${record.title}`);
      ref.original = path.join(relativeDir, path.basename(original));
      copy(original, path.join(skillDir, ref.original), record);
      if (record.parsed?.path) {
        const markdown = path.join(sourceDir, record.parsed.path);
        if (digest(markdown) !== record.parsed.sha256) throw new Error(`parsed hash mismatch: ${record.title}`);
        ref.content = path.join(relativeDir, '正文.md');
        ref.parseStatus = record.parsed.status;
        copy(markdown, path.join(skillDir, ref.content), record);
        const imagesDir = path.join(path.dirname(markdown), 'images');
        if (fs.existsSync(imagesDir)) for (const image of fs.readdirSync(imagesDir)) {
          copy(path.join(imagesDir, image), path.join(skillDir, relativeDir, 'images', image), record);
        }
      }
    }
    const approved = /^internal distribution approved:/i.test(authorization);
    for (const ref of chapter.references.filter((item) => item.original && item.inputIds.length)) {
      for (const inputId of ref.inputIds) {
        chapter.blockers = chapter.blockers.filter((blocker) => blocker.code !== 'KNOWLEDGE_RESOURCE_UNVERIFIED' || blocker.message.match(/^Z-\d+/)?.[0] !== inputId);
        if (!approved) chapter.blockers.push({ code: 'KNOWLEDGE_RIGHTS_UNKNOWN', message: `${inputId} 原文已随本地候选技能绑定，但未明确允许随包分发`, unresolved: false });
      }
    }
    chapter.blockers = [...new Map(chapter.blockers.map((item) => [`${item.code}:${item.message}`, item])).values()];
  }
  return { resources, sourceRevision: index.sourceRevision };
}
