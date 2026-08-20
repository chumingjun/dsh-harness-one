import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const DEFAULT_READ_BYTES = 5 * 1024 * 1024;
const DEFAULT_FILE_WRITE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TOTAL_WRITE_BYTES = 20 * 1024 * 1024;
const DEFAULT_LIST_ITEMS = 500;

function workspaceError(message, code = 'SCRIPT_WORKSPACE_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRelativePath(value, { allowRoot = false } = {}) {
  const raw = String(value ?? '.');
  if (!raw || raw.includes('\0') || raw.includes('\\') || isAbsolute(raw)) {
    throw workspaceError('工作区路径必须是安全的相对路径', 'SCRIPT_WORKSPACE_PATH');
  }
  const normalized = raw.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw workspaceError('工作区路径不能包含父目录跳转', 'SCRIPT_WORKSPACE_PATH');
  }
  if (!parts.length) {
    if (allowRoot) return '.';
    throw workspaceError('该操作不能使用工作区根目录', 'SCRIPT_WORKSPACE_PATH');
  }
  return parts.join('/');
}

function resolveWorkspacePath(rootDir, requestedPath, options = {}) {
  const relativePath = normalizeRelativePath(requestedPath, options);
  const root = resolve(rootDir);
  const target = relativePath === '.' ? root : resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw workspaceError('工作区路径越界', 'SCRIPT_WORKSPACE_PATH');
  }
  return { root, target, relativePath };
}

function assertNoSymlink(root, target, { includeTarget = true } = {}) {
  const rel = relative(root, target);
  if (!rel) return;
  const parts = rel.split(sep).filter(Boolean);
  const count = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  let current = root;
  for (let index = 0; index < count; index += 1) {
    current = resolve(current, parts[index]);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw workspaceError('工作区不允许通过符号链接访问文件', 'SCRIPT_WORKSPACE_SYMLINK');
    }
  }
}

function byteLength(value) {
  return Buffer.byteLength(value);
}

export function createScriptWorkspace(rootDir, options = {}) {
  const readLimit = options.maxReadBytes ?? DEFAULT_READ_BYTES;
  const fileWriteLimit = options.maxFileWriteBytes ?? DEFAULT_FILE_WRITE_BYTES;
  const totalWriteLimit = options.maxTotalWriteBytes ?? DEFAULT_TOTAL_WRITE_BYTES;
  const listLimit = options.maxListItems ?? DEFAULT_LIST_ITEMS;
  let writtenBytes = 0;

  mkdirSync(rootDir, { recursive: true });

  return {
    list(path = '.') {
      const { root, target, relativePath } = resolveWorkspacePath(rootDir, path, { allowRoot: true });
      assertNoSymlink(root, target);
      if (!existsSync(target)) throw workspaceError(`工作区路径不存在：${relativePath}`, 'SCRIPT_WORKSPACE_NOT_FOUND');
      const stat = lstatSync(target);
      if (!stat.isDirectory()) throw workspaceError(`工作区路径不是目录：${relativePath}`, 'SCRIPT_WORKSPACE_NOT_DIRECTORY');
      return readdirSync(target, { withFileTypes: true }).slice(0, listLimit).map((entry) => ({
        name: entry.name,
        path: relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`,
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
    },

    read(path, readOptions = {}) {
      const { root, target, relativePath } = resolveWorkspacePath(rootDir, path);
      assertNoSymlink(root, target);
      if (!existsSync(target)) throw workspaceError(`工作区文件不存在：${relativePath}`, 'SCRIPT_WORKSPACE_NOT_FOUND');
      const stat = lstatSync(target);
      if (!stat.isFile()) throw workspaceError(`工作区路径不是文件：${relativePath}`, 'SCRIPT_WORKSPACE_NOT_FILE');
      if (stat.size > readLimit) throw workspaceError(`工作区文件超过读取上限：${relativePath}`, 'SCRIPT_WORKSPACE_READ_LIMIT');
      const buffer = readFileSync(target);
      return readOptions?.encoding === 'base64' ? { base64: buffer.toString('base64') } : buffer.toString('utf8');
    },

    write(path, content) {
      const { root, target, relativePath } = resolveWorkspacePath(rootDir, path);
      assertNoSymlink(root, target, { includeTarget: false });
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw workspaceError('工作区不允许覆盖符号链接', 'SCRIPT_WORKSPACE_SYMLINK');
      }
      let buffer;
      if (typeof content === 'string') buffer = Buffer.from(content, 'utf8');
      else if (content && typeof content === 'object' && typeof content.base64 === 'string') buffer = Buffer.from(content.base64, 'base64');
      else throw workspaceError('workspace.write 内容必须是字符串或 { base64 }', 'SCRIPT_WORKSPACE_CONTENT');
      if (buffer.byteLength > fileWriteLimit) throw workspaceError(`单文件写入超过 ${fileWriteLimit} 字节上限`, 'SCRIPT_WORKSPACE_WRITE_LIMIT');
      if (writtenBytes + buffer.byteLength > totalWriteLimit) throw workspaceError(`本次运行写入超过 ${totalWriteLimit} 字节上限`, 'SCRIPT_WORKSPACE_WRITE_LIMIT');
      mkdirSync(dirname(target), { recursive: true });
      assertNoSymlink(root, dirname(target));
      const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
      writeFileSync(temp, buffer, { flag: 'wx' });
      renameSync(temp, target);
      writtenBytes += buffer.byteLength;
      return { path: relativePath, bytes: buffer.byteLength };
    },

    remove(path) {
      const { root, target, relativePath } = resolveWorkspacePath(rootDir, path);
      assertNoSymlink(root, target);
      if (!existsSync(target)) return false;
      const stat = lstatSync(target);
      if (!stat.isFile()) throw workspaceError('workspace.remove 只能删除文件', 'SCRIPT_WORKSPACE_NOT_FILE');
      rmSync(target);
      return true;
    },

    stats() {
      return { writtenBytes, readLimit, fileWriteLimit, totalWriteLimit, listLimit };
    },
  };
}

export const SCRIPT_WORKSPACE_LIMITS = {
  maxReadBytes: DEFAULT_READ_BYTES,
  maxFileWriteBytes: DEFAULT_FILE_WRITE_BYTES,
  maxTotalWriteBytes: DEFAULT_TOTAL_WRITE_BYTES,
  maxListItems: DEFAULT_LIST_ITEMS,
};
