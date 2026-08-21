import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { resolveInside, safeFileId, safeFilename } from './safe-path.js';

function runFolder(startedAt) {
  const date = new Date(startedAt || Date.now());
  const value = Number.isFinite(date.getTime()) ? date : new Date();
  return value.toISOString().replace('T', ' ').replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
}

function availableTarget(directory, filename) {
  const safe = safeFilename(filename, '成果文件');
  const extension = extname(safe);
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = index === 1 ? safe : `${stem} (${index})${extension}`;
    const target = resolveInside(directory, candidate);
    if (target && !existsSync(target)) return { target, name: candidate };
  }
  throw new Error(`文件重名过多：${safe}`);
}

export function saveArtifactsToWorkspace({ cwd, run, artifacts, resolveArtifact }) {
  if (!isAbsolute(String(cwd || ''))) throw new Error('当前会话没有可用的工作目录');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('当前工作目录不可用');
  if (!run?.runId) throw new Error('运行记录无效');
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('没有可保存的成果');
  if (typeof resolveArtifact !== 'function') throw new Error('成果解析器不可用');

  const realCwd = realpathSync(cwd);
  const workflowFolder = safeFileId(run.workflowName || '未命名工作流', '未命名工作流');
  const relativeDirectory = join('工作流成果', workflowFolder, runFolder(run.startedAt));
  const directory = resolveInside(realCwd, relativeDirectory);
  if (!directory) throw new Error('成果目录无效');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const realDirectory = realpathSync(directory);
  if (resolveInside(realCwd, realDirectory) !== realDirectory) throw new Error('成果目录越界');

  const saved = [];
  for (const artifact of artifacts) {
    const resolved = resolveArtifact(artifact.id);
    if (!resolved?.file || !existsSync(resolved.file) || !statSync(resolved.file).isFile()) {
      throw new Error(`成果不存在：${artifact.name || artifact.id}`);
    }
    const { target, name } = availableTarget(realDirectory, artifact.name);
    copyFileSync(resolved.file, target, fsConstants.COPYFILE_EXCL);
    saved.push({ id: artifact.id, name });
  }
  return { savedCount: saved.length, names: saved.map((item) => item.name) };
}
