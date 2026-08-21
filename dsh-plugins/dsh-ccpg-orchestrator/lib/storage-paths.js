import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-ccpg-orchestrator';
const HIDDEN_DIR = '.workflow-one';
const DEFAULT_PACKAGE_LEGACY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function hashedKey(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
}

export const stableHashedKey = hashedKey;

function absoluteDirectory(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`);
  return resolve(value);
}

function legacyLayout(root, kind) {
  if (kind === 'plugin-data') {
    return {
      root,
      state: join(root, 'state'),
      workflows: join(root, 'workflows'),
      attachments: join(root, 'attachments'),
      runs: join(root, 'runs'),
      runtime: join(root, 'runtime'),
      workspaces: join(root, 'runtime'),
      runArtifacts: join(root, 'runtime'),
    };
  }
  return {
    root,
    state: root,
    workflows: join(root, 'workflows'),
    attachments: join(root, 'attachments'),
    runs: join(root, 'runs'),
    runtime: root,
    workspaces: join(root, 'workspaces'),
    runArtifacts: join(root, 'run-artifacts'),
  };
}

export function createStoragePaths({
  workspaceRoot,
  dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
  legacyRoot = DEFAULT_PACKAGE_LEGACY_ROOT,
} = {}) {
  const workspace = absoluteDirectory(workspaceRoot, 'workspaceRoot');
  const root = join(workspace, HIDDEN_DIR);
  const state = join(root, 'state');
  const workflows = join(root, 'workflows');
  const attachments = join(root, 'attachments');
  const runs = join(root, 'runs');
  const runtime = join(root, 'runtime');
  const resolvedDshHome = absoluteDirectory(dshHome, 'dshHome');
  const pluginDataLegacy = legacyLayout(join(resolvedDshHome, 'plugin-data', PLUGIN_NAME), 'plugin-data');
  const packageLegacy = legacyLayout(absoluteDirectory(legacyRoot, 'legacyRoot'), 'package-data');
  const legacyRoots = [pluginDataLegacy, packageLegacy];

  const runRoot = ({ workflowId, runId }) => join(runtime, hashedKey(workflowId), hashedKey(runId));
  const workspaceForNode = ({ workflowId, runId, nodeId }) => (
    join(runRoot({ workflowId, runId }), 'nodes', hashedKey(nodeId), 'workspace')
  );
  const artifactRunDir = ({ workflowId, runId }) => join(runRoot({ workflowId, runId }), 'artifacts');

  return {
    workspaceRoot: workspace,
    dshHome: resolvedDshHome,
    root,
    newRoot: root,
    pluginRoot: root,
    hiddenDir: HIDDEN_DIR,
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
    artifactRoot: runtime,
    legacyRoots,
    legacy: packageLegacy,
    pluginDataLegacy,
    packageLegacy,
    legacyRoot: packageLegacy.root,
    legacyState: packageLegacy.state,
    legacyWorkflows: packageLegacy.workflows,
    legacyAttachments: packageLegacy.attachments,
    legacyRuns: packageLegacy.runs,
    legacyRuntime: packageLegacy.runtime,
    legacyWorkspaces: packageLegacy.workspaces,
    legacyRunArtifacts: packageLegacy.runArtifacts,
    runRoot,
    workspaceForNode,
    workspaceFor: workspaceForNode,
    artifactRunDir,
    runArtifactDir: artifactRunDir,
  };
}

export const resolveStoragePaths = createStoragePaths;
