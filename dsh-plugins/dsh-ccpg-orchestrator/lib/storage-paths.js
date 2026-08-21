import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-ccpg-orchestrator';
const DEFAULT_LEGACY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function hashedKey(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
}

export const stableHashedKey = hashedKey;

export function createStoragePaths({
  dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
  legacyRoot = DEFAULT_LEGACY_ROOT,
} = {}) {
  const resolvedDshHome = resolve(dshHome);
  const root = join(resolvedDshHome, 'plugin-data', PLUGIN_NAME);
  const state = join(root, 'state');
  const workflows = join(root, 'workflows');
  const attachments = join(root, 'attachments');
  const runs = join(root, 'runs');
  const runtime = join(root, 'runtime');
  const resolvedLegacyRoot = resolve(legacyRoot);
  const legacy = {
    root: resolvedLegacyRoot,
    state: resolvedLegacyRoot,
    workflows: join(resolvedLegacyRoot, 'workflows'),
    attachments: join(resolvedLegacyRoot, 'attachments'),
    runs: join(resolvedLegacyRoot, 'runs'),
    runtime: resolvedLegacyRoot,
    workspaces: join(resolvedLegacyRoot, 'workspaces'),
    runArtifacts: join(resolvedLegacyRoot, 'run-artifacts'),
  };

  const runRoot = ({ workflowId, runId }) => join(runtime, hashedKey(workflowId), hashedKey(runId));
  const workspaceForNode = ({ workflowId, runId, nodeId }) => (
    join(runRoot({ workflowId, runId }), 'nodes', hashedKey(nodeId), 'workspace')
  );
  const artifactRunDir = ({ workflowId, runId }) => join(runRoot({ workflowId, runId }), 'artifacts');

  return {
    dshHome: resolvedDshHome,
    root,
    newRoot: root,
    pluginRoot: root,
    legacyRoot: resolvedLegacyRoot,
    legacy,
    legacyState: legacy.state,
    legacyWorkflows: legacy.workflows,
    legacyAttachments: legacy.attachments,
    legacyRuns: legacy.runs,
    legacyRuntime: legacy.runtime,
    legacyWorkspaces: legacy.workspaces,
    legacyRunArtifacts: legacy.runArtifacts,
    state,
    stateDir: state,
    workflows,
    workflowsDir: workflows,
    attachments,
    attachmentsDir: attachments,
    runs,
    runsDir: runs,
    runtime,
    runtimeDir: runtime,
    workspaceRoot: runtime,
    artifactRoot: runtime,
    runRoot,
    workspaceForNode,
    workspaceFor: workspaceForNode,
    artifactRunDir,
    runArtifactDir: artifactRunDir,
  };
}

export const resolveStoragePaths = createStoragePaths;
