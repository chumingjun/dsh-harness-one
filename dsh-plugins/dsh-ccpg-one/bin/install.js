#!/usr/bin/env node
// dsh-ccpg-one 安装入口（npx dsh-ccpg-one / npm exec dsh-ccpg-one）。
//
// 为什么存在：`dsh plugin --profile X add dsh-ccpg-one` 是 profile 目录里裸跑
// pnpm 11 的薄转发器，而聚合依赖链 dsh-ccpg-one → dsh-better-sidebar → node-pty
// 带原生构建脚本。pnpm 11 的 strict-dep-builds 在 allowBuilds 未声明时直接
// ERR_PNPM_IGNORED_BUILDS 非零退出——dsh 跳过 bundle 注册，且 pnpm 已往 profile
// 的 pnpm-workspace.yaml 写入非法占位符（`node-pty: set this to true or false`），
// 把 `pnpm approve-builds` 和重跑 install 一起堵死（issue #24）。
// 包内 postinstall 不可用（它本身也在被拦的构建脚本之列），所以唯一可靠的
// 修复位置在安装之前：先把 profile 的 workspace 放行写好，再交给 dsh plugin。
//
// 幂等：已正确的条目不动；pnpm 写入的占位符归位为 true。全程不删用户条目。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME, '.dsh');
const PROFILE = process.argv[2] || 'dsh-ccpg';
const PKG = 'dsh-ccpg-one';
const SUBPLUGINS = ['dsh-ccpg-canvasui', 'dsh-ccpg-document-preview', 'dsh-ccpg-larkauth',
  'dsh-ccpg-llm-guard', 'dsh-ccpg-orchestrator', 'dsh-ccpg-tools', 'dsh-ccpg-web'];

const trailingNewline = (s) => (s.endsWith('\n') ? '' : '\n');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const say = (msg) => console.log(`[dsh-ccpg-one] ${msg}`);
const die = (msg) => { console.error(`[dsh-ccpg-one] ${msg}`); process.exit(1); };

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`用法：npx ${PKG} [profile] [--prewrite]
在 ~/.dsh/profiles/<profile> 预写 pnpm 11 放行（allowBuilds: node-pty/protobufjs/koffi、
minimumReleaseAgeExclude: dsh-ccpg-*），然后 dsh plugin add ${PKG}。

--prewrite   只做预写后退出（setup.sh --one 复用；不执行安装）。

pnpm 11 用户直接 \`dsh plugin add ${PKG}\` 遇 ERR_PNPM_IGNORED_BUILDS 时，重跑 install
无效（pnpm 反复拦截，见 issue #24）——用本命令安装，它会先把放行写对。

CCPG_NO_SIDEBAR=1 / CCPG_ONLY_CORE=1：装完后 dsh plugin remove dsh-better-sidebar
（侧栏挂载是上游包自己的 bundle 层；聚合层不再 insert，关闭须移除依赖本身）。`);
  process.exit(0);
}

// --- 1. 定位 dsh：优先 PATH，其次已安装 profile 的扁平兜底目录（--prewrite 不需要 dsh）---
const prewriteOnly = process.argv.includes('--prewrite');
const dshCandidates = ['dsh', join(DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh/lib/bin.js')];
const dsh = prewriteOnly ? null : dshCandidates.find((c) => spawnSync(c, ['--version']).status === 0);
if (!prewriteOnly && !dsh) die('未找到 dsh（先 npm i -g @deepseek-ai/dsh）');

// --- 2. 让 dsh 先初始化 profile（其模板含 pnpm-workspace.yaml），再预写放行 ---
if (!prewriteOnly && !existsSync(join(DSH_HOME, 'profiles', PROFILE, 'package.json'))) {
  const ls = spawnSync(dsh, ['plugin', '--profile', PROFILE, 'ls'], { encoding: 'utf8' });
  // initProfile 在首次 plugin 调用时完成；ls 本身可能因 pnpm 环境差异非零，目录在即可
  if (!existsSync(join(DSH_HOME, 'profiles', PROFILE, 'package.json'))) {
    die(`profile ${PROFILE} 初始化失败（可先跑一次：${dsh} plugin --profile ${PROFILE} ls）`);
  }
}
const wsPath = join(DSH_HOME, 'profiles', PROFILE, 'pnpm-workspace.yaml');
const original = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : 'packages:\n  - .\n';
let text = normalizePlaceholders(original);
text = ensureMapping(text, 'allowBuilds', ['node-pty', 'protobufjs', 'koffi']);
text = ensureSequence(text, 'minimumReleaseAgeExclude', [PKG, ...SUBPLUGINS]);
if (text !== original) writeFileSync(wsPath, text);
say(text !== original ? `已预写 ${wsPath}（allowBuilds + minimumReleaseAgeExclude）` : 'workspace 放行已就绪，跳过');

// --prewrite：只修放行后退出（setup.sh --one 在 dsh plugin add 之前复用）
if (process.argv.includes('--prewrite')) process.exit(0);

// --- 3. 安装 ---
say(`dsh plugin --profile ${PROFILE} add ${PKG} …`);
const add = spawnSync(dsh, ['plugin', '--profile', PROFILE, 'add', PKG], { stdio: 'inherit' });
if (add.status !== 0) {
  console.error(`[dsh-ccpg-one] 安装失败（exit ${add.status}）。
若上面有 ERR_PNPM_IGNORED_BUILDS：重试无效（pnpm 会反复拦截）——重跑本命令即可，
它会先把 profile pnpm-workspace.yaml 的放行修正（allowBuilds: node-pty: true）再安装。`);
  process.exit(add.status ?? 1);
}

// 可选件开关（安装层）：侧栏挂载由上游 dsh-better-sidebar 自己的 bundle 层提供，
// 聚合 patch 不再 insert（双 insert = duplicate route；!!js 退让在双注册现场会递归爆栈），
// 因此 CCPG_NO_SIDEBAR / CCPG_ONLY_CORE 在此落为移除依赖本身。
if (process.env.CCPG_NO_SIDEBAR || process.env.CCPG_ONLY_CORE) {
  say('CCPG_NO_SIDEBAR/CCPG_ONLY_CORE 生效：移除 dsh-better-sidebar …');
  const rm = spawnSync(dsh, ['plugin', '--profile', PROFILE, 'remove', 'dsh-better-sidebar'], { stdio: 'inherit' });
  if (rm.status !== 0) console.error('[dsh-ccpg-one] better-sidebar 移除失败（可手动：dsh plugin --profile ' + PROFILE + ' remove dsh-better-sidebar）');
}
say('安装完成，重启 dsh 生效。独立画布: http://127.0.0.1:4021/wf1/');

// ======== profile pnpm-workspace.yaml 预写（幂等，不删用户条目）========

// 归位 pnpm 写入的占位符（issue #24）：`  node-pty: set this to true or false` → `  node-pty: true`
function normalizePlaceholders(text) {
  return text.replace(/^(\s*)(node-pty|protobufjs):.*$/gm, '$1$2: true');
}

// 确保 `key:\n  name: true` 映射；key 块不存在时追加到文件末尾
function ensureMapping(text, key, names) {
  let out = text;
  for (const name of names) {
    if (new RegExp(`^\\s*${escapeRe(name)}:\\s*true\\s*$`, 'm').test(out)) continue;
    const blockRe = new RegExp(`^([ \\t]*)${escapeRe(key)}:[ \\t]*$`, 'm');
    const m = out.match(blockRe);
    if (m) {
      const lines = out.split('\n');
      lines.splice(lines.indexOf(m[0]) + 1, 0, `${m[1]}  ${name}: true`);
      out = lines.join('\n');
    } else {
      out += `${trailingNewline(out)}${key}:\n${names.map((n) => `  ${n}: true`).join('\n')}\n`;
      return out;
    }
  }
  return out;
}

// 确保 `key:\n  - item` 序列；key 块存在时追加到该块最后一个列表项后，不存在则追加到文件末尾
function ensureSequence(text, key, items) {
  let out = text;
  for (const item of items) {
    if (new RegExp(`^\\s*-\\s+${escapeRe(item)}\\s*$`, 'm').test(out)) continue;
    const blockRe = new RegExp(`^([ \\t]*)${escapeRe(key)}:[ \\t]*$`, 'm');
    const m = out.match(blockRe);
    if (m) {
      const lines = out.split('\n');
      // 块 = 键行之后所有空行与缩进行（列表项/嵌套内容），到下一个顶级键为止
      let insertAfter = lines.indexOf(m[0]);
      let last = insertAfter;
      for (let i = insertAfter + 1; i < lines.length; i++) {
        if (lines[i].trim() === '' || /^\s+\S/.test(lines[i])) { if (/^\s*-\s/.test(lines[i])) last = i; }
        else break;
      }
      lines.splice(last + 1, 0, `${m[1]}  - ${item}`);
      out = lines.join('\n');
    } else {
      out += `${trailingNewline(out)}${key}:\n${items.map((x) => `  - ${x}`).join('\n')}\n`;
      return out;
    }
  }
  return out;
}

// ======== profile pnpm-workspace.yaml 预写（幂等，不删用户条目）========
