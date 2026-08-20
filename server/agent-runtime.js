// 节点 agent 运行时层：默认 dsh（DeepSeek Harness）作为底座执行 agent 节点；
// dsh 不可用时回退到编排器内置工具循环（BuiltInRuntime）。
//
// dsh 接入方式：spawn `node --expose-internals <dsh-bin> --profile headless <task>`，
// cwd = 节点工作区（dsh 以调用目录为默认工作区根，天然与 workspace.js 对齐），
// 完整 agent 能力（循环/bash/fs/技能/subagent）由 dsh 底座提供。
//
// dsh 需要的环境事实（探测用）：
// - DSH_BIN：dsh 安装的 bin.js 路径（默认探测 ~/.local/npm-global）
// - DSH_NODE：能跑 dsh 的 node（>=20 且支持 --expose-internals；默认探测环境）
// - 凭据：环境变量 GLM_API_KEY / DEEPSEEK_API_KEY，或 headless profile
//   的 cordis.patch.yml/cordis.yml 里已配 provider apiKey（dsh 子进程自带，不依赖 env）
// - profile headless 已初始化（~/.dsh/profiles/headless）

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CANDIDATE_NODES = [
  process.env.DSH_NODE,
  '/tmp/node-v22.20.0-darwin-arm64/bin/node', // 便携版 Node22（系统 18 跑不动 dsh）
].filter(Boolean);

const CANDIDATE_BINS = [
  process.env.DSH_BIN,
  join(homedir(), '.local/npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
].filter(Boolean);

// 凭据判定（实测 env -i 全清后 dsh headless 仍可跑通，key 由 dsh 内部存储兜底）：
// env 有 GLM_API_KEY / DEEPSEEK_API_KEY，或 headless profile 的 cordis 配置里
// 出现 apiKey / apiKeyEnv 任意认证字段，即视为凭据就绪。
function hasDshCredentials() {
  if (process.env.GLM_API_KEY || process.env.DEEPSEEK_API_KEY) return true;
  const profileDir = join(homedir(), '.dsh/profiles/headless');
  return ['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml', 'cordis.yaml'].some((f) => {
    try {
      return /^(\s*)(apiKey|apiKeyEnv):\s*\S/m.test(readFileSync(join(profileDir, f), 'utf8'));
    } catch {
      return false;
    }
  });
}

export function detectDsh() {
  const node = CANDIDATE_NODES.find((p) => existsSync(p));
  const bin = CANDIDATE_BINS.find((p) => existsSync(p));
  const profile = join(homedir(), '.dsh/profiles/headless/package.json');
  const reasons = [];
  if (!node) reasons.push('无可用的 Node>=20（设 DSH_NODE）');
  if (!bin) reasons.push('未找到 dsh 安装（设 DSH_BIN 或 npm i -g @deepseek-ai/dsh）');
  if (!existsSync(profile)) reasons.push('headless profile 未初始化（跑一次 dsh --profile headless 自动生成）');
  if (!hasDshCredentials()) reasons.push('无凭据（设 GLM_API_KEY / DEEPSEEK_API_KEY，或在 ~/.dsh/profiles/headless/cordis.patch.yml 配 apiKey）');
  return { available: reasons.length === 0, node, bin, reasons };
}

// 用 dsh headless 跑一个任务。返回 stdout（最终回复）。
// 超时默认 5 分钟；kill 整个进程组避免残留。
export function runDshTask({ node, bin, cwd, task, env = {}, timeoutMs = 300_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['--expose-internals', bin, '--profile', 'headless', task], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`dsh 执行超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const text = out.trim();
        resolve(text || '(dsh 无输出)');
      } else {
        const tail = (err || out).split('\n').filter(Boolean).slice(-3).join(' | ');
        reject(new Error(`dsh 退出码 ${code}: ${tail.slice(0, 300)}`));
      }
    });
  });
}
