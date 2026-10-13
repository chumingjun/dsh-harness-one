import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ccpCliStatus, prepareCcpgCli } from '../lib/ccpg-cli.js';
import * as ccpgCli from '../lib/ccpg-cli.js';

test('ccpg status reports installation and configuration without secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-cli-status-'));
  const bin = join(root, 'ccpg-cli');
  await writeFile(bin, `#!/bin/sh
case "$*" in
  --version) echo 'ccpg-cli version 1.2.16' ;;
  'config show') printf '%s\\n' '{"appId":"cli_test","appSecret":"real-secret","brand":"feishu","users":"Test User"}' ;;
  *) exit 2 ;;
esac
`);
  await chmod(bin, 0o755);
  const status = await ccpCliStatus({ CCPG_CLI_BIN: bin });
  assert.equal(status.installed, true);
  assert.equal(status.configured, true);
  assert.equal(status.userConfigured, true);
  assert.equal(status.authRequired, false);
  assert.equal(JSON.stringify(status).includes('real-secret'), false);
});

test('ccpg prepare updates an installed CLI and reports user login when needed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-cli-prepare-'));
  const bin = join(root, 'ccpg-cli');
  await writeFile(bin, `#!/bin/sh
case "$*" in
  --version) echo 'ccpg-cli version 1.2.16' ;;
  'config show') printf '%s\\n' '{"appId":"cli_test","appSecret":"masked","brand":"feishu"}' ;;
  'update --json') printf '%s\\n' '{"ok":true,"action":"already_up_to_date","current_version":"1.2.16","latest_version":"1.2.16"}' ;;
  *) exit 2 ;;
esac
`);
  await chmod(bin, 0o755);
  const result = await prepareCcpgCli({ environment: { CCPG_CLI_BIN: bin }, platform: 'linux', arch: 'x64' });
  assert.equal(result.installed, true);
  assert.equal(result.configured, true);
  assert.equal(result.authRequired, true);
  assert.equal(result.nextAction, 'auth-login');
  assert.equal(result.loginCommand, 'ccpg-cli auth login');
});

test('ccpg one-click installer is not guessed on unsupported platforms', async () => {
  const result = await prepareCcpgCli({
    environment: { CCPG_CLI_BIN: '/definitely/not/ccpg-cli' },
    platform: 'darwin',
    arch: 'arm64',
    install: true,
  });
  assert.equal(result.installed, false);
  assert.equal(result.nextAction, 'manual-install');
  assert.match(result.reason, /linux\/amd64 and linux\/arm64/);
});

test('project lookup returns a parsed unverified snapshot and limited choice summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-cli-project-find-'));
  const bin = join(root, 'ccpg-cli');
  await writeFile(bin, `#!/bin/sh
if [ "$*" != 'project-search +find --q 花园 --topk 2 --as user --format json' ]; then
  echo 'secret unexpected command' >&2
  exit 2
fi
printf '%s\\n' '{"data":[{"project_code":"P001","project_name":"花园","score":0.95,"appSecret":"must-not-leak"},{"project_code":"P002","project_name":"另一花园","score":0.8}],"access_token":"must-not-leak","secret_page_token":"must-not-leak","next_page_token":"page-2"}'
`);
  await chmod(bin, 0o755);
  const result = await ccpgCli.findCcpgProjects({ query: '花园', topk: 2, environment: { CCPG_CLI_BIN: bin } });
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.deepEqual(result.candidates, [{ code: 'P001', name: '花园', score: 0.95 }, { code: 'P002', name: '另一花园', score: 0.8 }]);
  assert.deepEqual(result.provenance.command, ['project-search', '+find', '--q', '花园', '--topk', '2', '--as', 'user', '--format', 'json']);
  assert.equal(result.provenance.identity, 'user');
  assert.equal(result.snapshot.next_page_token, 'page-2');
  assert.deepEqual(result.provenance.scope, { query: '花园', topk: 2 });
  assert.ok(Number.isFinite(Date.parse(result.provenance.fetchedAt)));
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('project master-data snapshot uses one exact selector and preserves unverified scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-cli-project-fetch-'));
  const bin = join(root, 'ccpg-cli');
  await writeFile(bin, `#!/bin/sh
case "$*" in
  'datahub +project-list --project-code P001 --dver-type 2 --page 2 --page-size 50 --as user --format json')
    printf '%s\\n' '{"data":{"rows":[{"project_code":"P001","project_name":"花园","period":"2026-09","parking":55}],"total":51}}' ;;
  'datahub +project-list --project-name 花园 --dver-type 2 --page 1 --page-size 20 --as user --format json')
    printf '%s\\n' '{"unrecognized_business_schema":{"project":"花园","value":55}}' ;;
  *) echo 'config secret must not leak' >&2; exit 2 ;;
esac
`);
  await chmod(bin, 0o755);
  const environment = { CCPG_CLI_BIN: bin };
  const result = await ccpgCli.fetchCcpgProjectSnapshot({ projectCode: 'P001', page: 2, pageSize: 50, environment });
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.snapshot.data.rows[0].parking, 55);
  assert.deepEqual(result.provenance.scope, { projectCode: 'P001', dverType: '2', page: 2, pageSize: 50 });
  assert.equal(result.provenance.identity, 'user');
  assert.equal(result.provenance.verification, 'unverified');
  const unknown = await ccpgCli.fetchCcpgProjectSnapshot({ projectName: '花园', environment });
  assert.equal(unknown.verified, false);
  assert.deepEqual(unknown.snapshot, { unrecognized_business_schema: { project: '花园', value: 55 } });
  assert.equal(unknown.complete, undefined, 'successful transport does not establish data completeness');
});

test('read-only project APIs reject invalid scopes and hide CLI failures and secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-cli-project-errors-'));
  const bin = join(root, 'ccpg-cli');
  await writeFile(bin, `#!/bin/sh
case "$*" in
  *'--q denied '*) printf '%s\\n' '{"code":403,"message":"appSecret=private-value"}' ;;
  *'--q malformed '*) printf '%s\\n' 'stdout-private-value' ;;
  *) echo 'stderr-private-value' >&2; exit 3 ;;
esac
`);
  await chmod(bin, 0o755);
  const environment = { CCPG_CLI_BIN: bin };
  for (const args of [{ query: '' }, { query: ' valid ' }, { query: 'bad\nquery' }, { query: ['P001'] }, { query: 'valid', topk: 0 }, { query: 'valid', topk: 101 }, { query: 'valid', topk: '10' }]) {
    await assert.rejects(ccpgCli.findCcpgProjects({ ...args, environment }), /invalid/);
  }
  for (const args of [{}, { projectCode: 'P001', projectName: '花园' }, { projectCode: '' }, { projectCode: ['P001'] }, { projectName: 'bad\nname' }, { projectCode: 'P001', page: 0 }, { projectCode: 'P001', pageSize: 201 }, { projectCode: 'P001', pageSize: 1.5 }]) {
    await assert.rejects(ccpgCli.fetchCcpgProjectSnapshot({ ...args, environment }), /invalid|exactly one/);
  }
  const denied = await ccpgCli.findCcpgProjects({ query: 'denied', environment });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'cli-failed');
  const malformed = await ccpgCli.findCcpgProjects({ query: 'malformed', environment });
  assert.equal(malformed.code, 'invalid-output');
  const failed = await ccpgCli.fetchCcpgProjectSnapshot({ projectCode: 'P001', environment });
  assert.equal(failed.code, 'cli-failed');
  assert.doesNotMatch(JSON.stringify([denied, malformed, failed]), /private-value/);
  const controller = new AbortController(); controller.abort();
  const cancelled = await ccpgCli.findCcpgProjects({ query: 'valid', environment, signal: controller.signal });
  assert.equal(cancelled.code, 'cancelled');
});
