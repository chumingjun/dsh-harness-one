import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { installInternal, checkVersions, inferProfile, dshCommand } from '../../install-internal.mjs';

for (const platform of ['darwin', 'win32', 'linux']) {
  for (const arch of ['arm64', 'x64']) checkVersions({ node: '22.19.0', dsh: '0.2.0-rc.2', platform, arch });
}
for (const node of ['20.19.0', '22.18.0']) assert.throws(() => checkVersions({ node, dsh: '0.2.0-rc.2' }), /Node/);
for (const dsh of ['0.1.9', '0.2.0-rc.1', '0.3.0', 'garbage']) assert.throws(() => checkVersions({ node: '22.19.0', dsh }), /DSH/);
checkVersions({ node: '24.1.0', dsh: '0.2.1' });
checkVersions({ node: '26.3.0', dsh: '0.2.0-rc.3' });
assert.throws(() => checkVersions({ node: '24.1.0', dsh: '0.2.0', platform: 'freebsd', arch: 'x64' }), /platform/);
assert.throws(() => inferProfile({ env: {}, cwd: tmpdir() }), /profile/);
assert.equal(inferProfile({ env: { DSH_DESKTOP_DEFAULT_PROFILE: '工作 desktop' } }), '工作 desktop');
for (const name of ['../other', '.', 'node_modules', 'x/y', 'x\\y']) assert.throws(() => inferProfile({ profile: name, env: {} }), /profile/);
assert.deepEqual(dshCommand({ platform: 'win32', env: { DSH_DESKTOP_APP_EXECUTABLE: 'C:\\Desktop App\\app.exe', DSH_DESKTOP_DSH_BOOTSTRAP: 'C:\\Desktop App\\dsh.js' } }), {
  command: 'C:\\Desktop App\\app.exe', args: ['--expose-internals', 'C:\\Desktop App\\dsh.js'],
});
assert.deepEqual(dshCommand({ platform: 'darwin', env: { DSH_DESKTOP_APP_EXECUTABLE: '/Desktop/app', DSH_DESKTOP_DSH_BOOTSTRAP: '/Desktop/dsh.js' } }), {
  command: '/Desktop/app', args: ['--expose-internals', '/Desktop/dsh.js'],
});
assert.throws(() => dshCommand({ platform: 'win32', env: { DSH_BIN: 'DSH.CMD' } }), /JavaScript/);
assert.deepEqual(dshCommand({ platform: 'win32', env: { Path: 'C:\\First;C:\\Node' }, exists: (path) => path === win32.join('C:\\Node', 'node_modules/@deepseek-ai/dsh/lib/bin.js') }), {
  command: process.execPath, args: [win32.join('C:\\Node', 'node_modules/@deepseek-ai/dsh/lib/bin.js')],
});

const root = mkdtempSync(join(tmpdir(), 'ccpg-internal-install-'));
const home = join(root, 'home'); const directory = join(root, '安装包');
const profile = '工作 desktop'; const profileDir = join(home, 'profiles', profile);
mkdirSync(directory); mkdirSync(profileDir, { recursive: true });
const sourceManifest = { name: 'profile', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
writeFileSync(join(profileDir, 'package.json'), JSON.stringify(sourceManifest));
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# preserve user port and provider\n');
const files = ['internal.tgz', 'sidebar.tgz'].map((file, index) => {
  const bytes = Buffer.from(`archive${index}`); writeFileSync(join(directory, file), bytes);
  return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
});
writeFileSync(join(directory, 'delivery.json'), JSON.stringify({
  name: 'dsh-harness-one', version: '0.11.4-internal.portable.r15', sidebarVersion: '0.25.0', packages: files,
}));
const calls = [];
const env = { DSH_HOME: home, DSH_BIN: '/test/dsh.js', DSH_DESKTOP_APP_EXECUTABLE: process.execPath, DSH_DESKTOP_DSH_BOOTSTRAP: '/test/desktop.js' };
const run = (command, args, options) => {
  calls.push({ command, args, options });
  if (args.at(-1) === '--version') return { status: 0, stdout: '0.2.0-rc.2\n', stderr: '' };
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json')));
  manifest.dependencies['dsh-harness-one'] = 'file:internal.tgz';
  manifest.dependencies['dsh-better-sidebar'] = 'file:sidebar.tgz';
  manifest.dsh.profile.bundles.push('dsh-harness-one', 'dsh-better-sidebar');
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest));
  const installed = join(profileDir, 'node_modules', 'dsh-harness-one');
  mkdirSync(join(installed, 'bin'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-harness-one', version: '0.11.4-internal.portable.r15', ccpg: { channel: 'internal', scheme: true }, exports: { './package.json': './package.json' } }));
  writeFileSync(join(installed, 'bin/check-runtime.mjs'), '// test fixture');
  return { status: 0, stdout: '', stderr: '' };
};
try {
  const before = readFileSync(join(profileDir, 'package.json'), 'utf8');
  const checked = installInternal({ directory, profile, env, run, check: true });
  assert.equal(checked.ready, true);
  assert.equal(calls.length, 1);
  assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before);
  calls.length = 0;
  const installed = installInternal({ directory, profile, env, run });
  assert.equal(installed.installed, true);
  const add = calls.find((call) => call.args.includes('add'));
  assert(add.args.includes(join(directory, 'internal.tgz')), 'must install the supplied archive, never the public package');
  assert(add.args.includes(join(directory, 'sidebar.tgz')));
  assert(add.args.includes('--ignore-scripts'));
  assert(add.args.includes('--config.auto-install-peers=false'));
  assert.equal(add.options.shell, false);
  assert.equal(add.options.env.ELECTRON_RUN_AS_NODE, '1', 'Desktop child process must run as Node');
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '# preserve user port and provider\n');
  assert(!existsSync(join(home, 'profiles', 'dsh-ccpg')), 'must not create an unrelated default profile');
  const failedRun = (command, args) => args.at(-1) === '--version' ? { status: 0, stdout: '0.2.0-rc.2' } : { status: 1 };
  assert.throws(() => installInternal({ directory, profile, env, run: failedRun }), /installation failed/i);
  writeFileSync(join(directory, 'internal.tgz'), 'tampered');
  calls.length = 0;
  assert.throws(() => installInternal({ directory, profile, env, run }), /checksum/i);
  assert.equal(calls.length, 0, 'tampered package must not reach any subprocess');
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('✓ portable installer profile/version/checksum, exact internal archives, and failure boundaries');
