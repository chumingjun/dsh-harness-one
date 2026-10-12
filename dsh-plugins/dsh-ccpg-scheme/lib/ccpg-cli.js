import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const INSTALL_URL = 'http://bms.einwin.com/media/ccpg-cli/202605091513/auto-install.sh';
const AGENT_CODE = 'skill_hub_einwin';

function binaryPath(environment = process.env) {
  return environment.CCPG_CLI_BIN || 'ccpg-cli';
}

export function cliEnvironment(environment = process.env, platform = process.platform) {
  const env = { ...process.env, ...environment };
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH');
  const path = pathKey ? environment[pathKey] : env.PATH || env.Path || '';
  if (platform === 'win32') {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = path;
  } else env.PATH = [join(homedir(), '.local', 'bin'), path].filter(Boolean).join(delimiter);
  return env;
}

async function invoke(environment, args, options = {}) {
  const { stdout } = await exec(binaryPath(environment), args, {
    timeout: options.timeout ?? 120000,
    maxBuffer: 1024 * 1024,
    signal: options.signal,
    env: cliEnvironment(environment),
  });
  return stdout;
}

function validatedText(value, name, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

function validatedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`invalid ${name}`);
  return value;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => /^(?:next[_-]?)?page[_-]?token$/i.test(key) || !/(secret|token|password|passwd|authorization|credential|api.?key)/i.test(key))
    .map(([key, item]) => [key, redactSecrets(item)]));
}

async function readSnapshot(environment, command, scope, signal) {
  if (signal?.aborted) return { ok: false, code: 'cancelled', error: 'CCPG CLI read cancelled' };
  let raw;
  try { raw = await invoke(environment, command, { timeout: 60000, signal }); }
  catch {
    return { ok: false, code: signal?.aborted ? 'cancelled' : 'cli-failed', error: signal?.aborted ? 'CCPG CLI read cancelled' : 'CCPG CLI read failed; check installation, login and permissions' };
  }
  const snapshot = parseJson(raw);
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, code: 'invalid-output', error: 'CCPG CLI returned no structured JSON snapshot' };
  if (snapshot.ok === false || snapshot.success === false || snapshot.error || /^\d+$/.test(String(snapshot.code ?? '')) && ![0, 200].includes(Number(snapshot.code))) return { ok: false, code: 'cli-failed', error: 'CCPG CLI did not confirm a successful read; check login and permissions' };
  return { ok: true, verified: false, snapshot: redactSecrets(snapshot), provenance: { source: 'ccpg-cli', fetchedAt: new Date().toISOString(), command, identity: 'user', scope, verification: 'unverified' } };
}

function candidateRows(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  for (const key of ['results', 'items', 'rows', 'projects', 'data']) {
    if (Array.isArray(snapshot?.[key])) return snapshot[key];
    for (const nested of ['results', 'items', 'rows', 'projects']) if (Array.isArray(snapshot?.[key]?.[nested])) return snapshot[key][nested];
  }
  return [];
}

export async function findCcpgProjects({ query, topk = 10, environment = process.env, signal } = {}) {
  validatedText(query, 'query');
  validatedInteger(topk, 'topk', 100);
  const result = await readSnapshot(environment, ['project-search', '+find', '--q', query, '--topk', String(topk), '--as', 'user', '--format', 'json'], { query, topk }, signal);
  if (!result.ok) return result;
  const candidates = candidateRows(result.snapshot).slice(0, topk).flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const code = row.project_code ?? row.projectCode ?? row.code;
    const name = row.project_name ?? row.projectName ?? row.name;
    if (typeof code !== 'string' && typeof name !== 'string') return [];
    return [{ ...(typeof code === 'string' ? { code: code.slice(0, 200) } : {}), ...(typeof name === 'string' ? { name: name.slice(0, 200) } : {}), ...(typeof row.score === 'number' && Number.isFinite(row.score) ? { score: row.score } : {}) }];
  });
  return { ...result, candidates };
}

export async function fetchCcpgProjectSnapshot({ projectCode, projectName, page = 1, pageSize = 20, environment = process.env, signal } = {}) {
  if ((projectCode !== undefined) === (projectName !== undefined)) throw new Error('choose exactly one projectCode or projectName');
  const selector = projectCode !== undefined ? { projectCode: validatedText(projectCode, 'projectCode', 100) } : { projectName: validatedText(projectName, 'projectName') };
  validatedInteger(page, 'page', 10000);
  validatedInteger(pageSize, 'pageSize', 200);
  const args = ['datahub', '+project-list', projectCode !== undefined ? '--project-code' : '--project-name', projectCode ?? projectName, '--dver-type', '2', '--page', String(page), '--page-size', String(pageSize), '--as', 'user', '--format', 'json'];
  return readSnapshot(environment, args, { ...selector, dverType: '2', page, pageSize }, signal);
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function configState(raw) {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object') return { configured: false };
  return {
    configured: Boolean(value.appId && value.brand),
    brand: value.brand || null,
    appId: value.appId || null,
    userConfigured: Boolean(value.users),
  };
}

export async function ccpCliStatus(environment = process.env) {
  const result = { installed: false, configured: false, userConfigured: false, authRequired: true };
  try { result.version = (await invoke(environment, ['--version'])).trim(); result.installed = true; }
  catch { return result; }
  try { Object.assign(result, configState(await invoke(environment, ['config', 'show']))); }
  catch { result.configured = false; }
  result.authRequired = !result.userConfigured;
  return result;
}

export async function prepareCcpgCli({ environment = process.env, platform = process.platform, arch = process.arch, install = true } = {}) {
  let activeEnvironment = environment;
  let status = await ccpCliStatus(environment);
  if (!status.installed) {
    if (!install) return { ...status, nextAction: 'install' };
    if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) {
      return { ...status, nextAction: 'manual-install', reason: `The official one-click installer covers linux/amd64 and linux/arm64; this host is ${platform}/${arch}.` };
    }
    await exec('/bin/bash', ['-c', `curl -fsSL ${JSON.stringify(INSTALL_URL).replaceAll('"', "'")} | bash`], {
      timeout: 300000,
      maxBuffer: 1024 * 1024,
      env: cliEnvironment(environment),
    });
    // The official installer writes the default PATH binary; ignore a stale custom override.
    activeEnvironment = environment.CCPG_CLI_BIN ? { ...environment, CCPG_CLI_BIN: undefined } : environment;
    status = await ccpCliStatus(activeEnvironment);
    if (!status.installed) throw new Error('ccpg-cli installer finished but the command is still unavailable; reopen the terminal or add ~/.local/bin to PATH');
  }

  const update = parseJson(await invoke(activeEnvironment, ['update', '--json'], { timeout: 300000 }));
  status = await ccpCliStatus(activeEnvironment);
  if (!status.configured) {
    await invoke(activeEnvironment, ['config', 'init', '--agent-code', AGENT_CODE], { timeout: 180000 });
    status = await ccpCliStatus(activeEnvironment);
  }
  if (!status.configured) throw new Error('ccpg-cli config init did not produce a configured application');
  return {
    ...status,
    update: update ? { ok: update.ok !== false, currentVersion: update.current_version || null, latestVersion: update.latest_version || null, action: update.action || null } : null,
    nextAction: status.authRequired ? 'auth-login' : 'ready',
    loginCommand: status.authRequired ? 'ccpg-cli auth login' : null,
    source: 'CCPG CLI Linux guide, Feishu docx/HvrndidqwoM4pbxeEW4ciBO5nVe, revision 169',
  };
}
