// 每个 agent 节点一个独立工作目录（沙箱边界 = 目录边界）：
// data/workspaces/<sanitized-node-label>/，agent 只能通过 ws_* 工具在自己目录内读写。
// 这对应 dsh/Codex 的 cwd 概念：agent 的产物落盘、上游可以引用、可跨运行复用。

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'workspaces');

// 节点标签 → 安全目录名（中文可保留，去掉路径分隔符等危险字符）
function sanitize(label) {
  const s = String(label || '').replace(/[/\\:*?"<>|\s]+/g, '_').replace(/^\.+/, '');
  return s || 'agent';
}

export function workspaceFor(node) {
  const dir = join(WS_ROOT, sanitize(node.data?.label || node.id));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 防目录逃逸：解析后必须仍在 dir 内
function safePath(dir, rel) {
  const p = normalize(join(dir, rel));
  if (p !== dir && !p.startsWith(dir + sep)) throw new Error(`路径越界: ${rel}`);
  return p;
}

export function wsWrite(dir, rel, content) {
  const p = safePath(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(content ?? ''), 'utf8');
  return p;
}

export function wsRead(dir, rel) {
  const p = safePath(dir, rel);
  const st = statSync(p);
  if (st.size > 512 * 1024) return readFileSync(p, 'utf8').slice(0, 200_000);
  return readFileSync(p, 'utf8');
}

export function wsList(dir, rel = '.') {
  const p = safePath(dir, rel);
  const out = [];
  const walk = (cur, depth) => {
    if (depth > 3) return;
    for (const name of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, name.name);
      const relPath = full.slice(dir.length + 1);
      if (name.isDirectory()) {
        out.push(`${relPath}/`);
        walk(full, depth + 1);
      } else {
        const st = statSync(full);
        out.push(`${relPath} (${st.size}B)`);
      }
    }
  };
  walk(p, 0);
  return out.join('\n') || '(空)';
}

export function wsClean(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
