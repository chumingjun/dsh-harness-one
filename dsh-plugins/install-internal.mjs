#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkVersions({ node, dsh, platform = process.platform, arch = process.arch }) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported platform: ${platform}/${arch}`);
  const n = /^(\d+)\.(\d+)\.(\d+)$/.exec(node);
  if (!n || Number(n[1]) < 22 || Number(n[1]) === 22 && Number(n[2]) < 19) throw new Error('Node >=22.19.0 is required. Use the DSH Desktop managed terminal/runtime.');
  const d = /^0\.2\.(\d+)(?:-rc\.(\d+))?$/.exec(dsh);
  if (!d || Number(d[1]) === 0 && d[2] && Number(d[2]) < 2) throw new Error(`Unsupported DSH version: ${dsh}. This package targets DSH >=0.2.0-rc.2 <0.3.0; update DSH or request a compatible package.`);
}

function profileName(value) {
  if (typeof value !== 'string' || !value || ['.', '..', 'node_modules'].includes(value) || /[/\\\0]/.test(value)) throw new Error('Invalid DSH profile name');
  return value;
}

export function inferProfile({ profile, env = process.env, cwd = process.cwd() } = {}) {
  if (profile !== undefined) return profileName(profile);
  if (env.DSH_DESKTOP_DEFAULT_PROFILE) return profileName(env.DSH_DESKTOP_DEFAULT_PROFILE);
  const root = resolve(env.DSH_HOME || join(homedir(), '.dsh'), 'profiles');
  if (dirname(resolve(cwd)) === root && existsSync(join(cwd, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json')));
    if (Array.isArray(pkg.dsh?.profile?.bundles)) return profileName(basename(cwd));
  }
  throw new Error('Current DSH profile unavailable. Use Open DSH Terminal, or supply --profile with the current session profile. Do not guess or create another profile.');
}

export function dshCommand({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (env.DSH_BIN) {
    if (/\.[cm]?js$/i.test(env.DSH_BIN)) return { command: process.execPath, args: [env.DSH_BIN] };
    if (platform === 'win32' && /\.(bat|cmd)$/i.test(env.DSH_BIN)) throw new Error('DSH_BIN must point to the DSH JavaScript entry, not a batch script');
    return { command: env.DSH_BIN, args: [] };
  }
  if (env.DSH_DESKTOP_APP_EXECUTABLE && env.DSH_DESKTOP_DSH_BOOTSTRAP) return { command: env.DSH_DESKTOP_APP_EXECUTABLE, args: ['--expose-internals', env.DSH_DESKTOP_DSH_BOOTSTRAP] };
  if (platform !== 'win32') return { command: 'dsh', args: [] };
  for (const directory of (env.PATH || env.Path || '').split(';').filter(Boolean)) {
    const entry = win32.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (exists(entry)) return { command: process.execPath, args: [entry] };
  }
  throw new Error('DSH executable unavailable. Open the DSH Desktop managed terminal; Windows installation never invokes a shell or guesses batch commands.');
}

export function installInternal({ directory = dirname(fileURLToPath(import.meta.url)), profile, env = process.env, run = spawnSync, check = false } = {}) {
  const delivery = JSON.parse(readFileSync(join(directory, 'delivery.json'), 'utf8'));
  if (delivery.name !== 'dsh-harness-one' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(delivery.version) || !/^\d+\.\d+\.\d+$/.test(delivery.sidebarVersion) || !Array.isArray(delivery.packages) || delivery.packages.length !== 2) throw new Error('Invalid internal delivery manifest');
  const packages = delivery.packages.map(({ file, sha256 }) => {
    if (typeof file !== 'string' || basename(file) !== file || /[/\\\0]/.test(file) || !file.endsWith('.tgz') || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid package path/checksum');
    const path = join(directory, file);
    if (!statSync(path).isFile() || dirname(realpathSync(path)) !== realpathSync(directory)) throw new Error('Unsafe package path');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) throw new Error(`Package checksum mismatch: ${file}`);
    return resolve(path);
  });
  const target = inferProfile({ profile, env });
  const profileDir = join(resolve(env.DSH_HOME || join(homedir(), '.dsh')), 'profiles', target);
  if (!existsSync(join(profileDir, 'package.json'))) throw new Error('Open DSH once to initialize the selected profile. This installer does not create profiles.');
  const before = JSON.parse(readFileSync(join(profileDir, 'package.json')));
  if (!Array.isArray(before.dsh?.profile?.bundles)) throw new Error('Selected directory is not a DSH profile');
  const legacy = Object.keys(before.dependencies || {}).filter((name) => name === 'dsh-ccpg-one' || name.startsWith('dsh-ccpg-'));
  if (legacy.length) throw new Error(`Legacy separate bundles may cause duplicate routes: ${legacy.join(', ')}. Request a migration; no existing plugin has been removed.`);
  const cli = dshCommand({ env });
  const childEnv = { ...env, ...(env.DSH_DESKTOP_APP_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
  const probe = run(cli.command, [...cli.args, '--version'], { env: childEnv, shell: false, encoding: 'utf8', timeout: 30000 });
  if (probe.error || probe.status !== 0) throw new Error('DSH version check failed. Use the DSH Desktop managed terminal/runtime.');
  const dsh = String(probe.stdout || '').trim();
  checkVersions({ node: process.versions.node, dsh });
  if (check) return { ready: true, profile: target, version: delivery.version, dsh, platform: process.platform, arch: process.arch, networkRequired: true };

  const add = run(cli.command, [...cli.args, 'plugin', '--profile', target, 'add', ...packages, '--ignore-scripts', '--config.auto-install-peers=false'], {
    env: { ...childEnv, CI: 'true' }, shell: false, stdio: 'inherit', timeout: 15 * 60 * 1000,
  });
  if (add.error || add.status !== 0) throw new Error('Plugin installation failed. See DSH package-manager diagnostics; do not restart as if installation succeeded.');
  const after = JSON.parse(readFileSync(join(profileDir, 'package.json')));
  for (const name of ['dsh-harness-one', 'dsh-better-sidebar', ...before.dsh.profile.bundles]) {
    if (!after.dsh?.profile?.bundles?.includes(name)) throw new Error(`Plugin bundle registration incomplete: ${name}. No automatic rollback/removal was attempted.`);
  }
  const require = createRequire(join(profileDir, 'package.json'));
  const installedPath = require.resolve('dsh-harness-one/package.json');
  const installed = JSON.parse(readFileSync(installedPath));
  if (installed.version !== delivery.version || installed.ccpg?.channel !== 'internal' || installed.ccpg?.scheme !== true) throw new Error('Installed package/version is not the supplied internal scheme package');
  const health = run(process.execPath, [join(dirname(installedPath), 'bin', 'check-runtime.mjs')], { env: childEnv, shell: false, stdio: 'inherit', timeout: 60000 });
  if (health.error || health.status !== 0) throw new Error('Installed plugin runtime check failed. Installation is not ready.');
  return { installed: true, profile: target, version: installed.version, restartRequired: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let profile; let check = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--profile' && args[index + 1]) profile = args[++index];
      else if (args[index] === '--check') check = true;
      else throw new Error('Usage: node install.mjs [--profile CURRENT_PROFILE] [--check]');
    }
    console.log(JSON.stringify(installInternal({ profile, check }), null, 2));
    if (!check) console.log('Plugin installed and checked. Fully restart DSH Desktop to load it. Model configuration and Feishu user login remain personal.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
