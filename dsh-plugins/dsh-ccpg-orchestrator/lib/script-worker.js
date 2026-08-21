import { parentPort } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
import { createScriptWorkspace } from './script-workspace.js';

const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const ERROR_LIMIT_CHARS = 2000;

function safeError(error) {
  const message = String(error?.message || error || '脚本执行失败')
    .replaceAll(process.cwd(), '<workspace>')
    .slice(0, ERROR_LIMIT_CHARS);
  return { message, code: error?.code || 'SCRIPT_RUNTIME_ERROR' };
}

function responseFor(call) {
  try {
    const workspace = responseFor.workspace;
    if (call.method === 'list') return { ok: true, value: workspace.list(call.path) };
    if (call.method === 'read') return { ok: true, value: workspace.read(call.path, call.options) };
    if (call.method === 'write') return { ok: true, value: workspace.write(call.path, call.content) };
    if (call.method === 'remove') return { ok: true, value: workspace.remove(call.path) };
    return { ok: false, error: { message: `未知工作区方法：${call.method}`, code: 'SCRIPT_WORKSPACE_METHOD' } };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

function guestBootstrap(code) {
  return `
'use strict';
const __forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
function __deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) __deepFreeze(value[key], seen);
  return Object.freeze(value);
}
function __assertJson(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON 输出包含非有限数（' + path + '）');
    return;
  }
  if (typeof value !== 'object') throw new Error('JSON 输出包含不可序列化的 ' + typeof value + '（' + path + '）');
  if (seen.has(value)) throw new Error('JSON 输出包含循环引用（' + path + '）');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error('JSON 输出包含空数组项（' + path + '[' + index + ']）');
      __assertJson(value[index], path + '[' + index + ']', seen);
    }
  } else {
    for (const key of Object.keys(value)) {
      if (__forbiddenKeys.has(key)) throw new Error('JSON 输出包含不安全字段（' + path + '.' + key + '）');
      __assertJson(value[key], path + '.' + key, seen);
    }
  }
  seen.delete(value);
}
const __hostCall = __hostWorkspaceCall;
function __workspaceCall(method, payload) {
  const response = JSON.parse(__hostCall(JSON.stringify({ method, ...payload })));
  if (!response.ok) {
    const error = new Error(response.error?.message || '工作区操作失败');
    error.code = response.error?.code || 'SCRIPT_WORKSPACE_ERROR';
    throw error;
  }
  return response.value;
}
const workspace = Object.freeze({
  list(path = '.') { return __workspaceCall('list', { path }); },
  read(path, options = undefined) { return __workspaceCall('read', { path, options }); },
  write(path, content) { return __workspaceCall('write', { path, content }); },
  remove(path) { return __workspaceCall('remove', { path }); },
});
const input = __deepFreeze(JSON.parse(__inputJson));
delete globalThis.__hostWorkspaceCall;
delete globalThis.__inputJson;
const __main = (function (input, workspace, __hostWorkspaceCall, __hostCall, __inputJson, __workspaceCall, __deepFreeze, __assertJson) {
${code}
return typeof main === 'function' ? main : null;
})(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
if (typeof __main !== 'function') throw new Error('脚本必须声明 function main(input, workspace)');
const __result = __main(input, workspace);
if (__result && typeof __result.then === 'function') throw new Error('首版脚本不支持 async/Promise，请返回同步 JSON 值');
__assertJson(__result);
const __serialized = JSON.stringify(__result);
if (__serialized === undefined) throw new Error('脚本返回值必须是 JSON 兼容值');
__serialized;
`;
}

async function execute(message) {
  const deadline = Date.now() + message.timeoutMs;
  responseFor.workspace = createScriptWorkspace(message.workspaceDir, {
    ...(message.workspaceLimits || {}),
    readRootDir: message.readWorkspaceDir || message.workspaceDir,
    writeRootDir: message.workspaceDir,
  });
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(message.memoryLimitBytes || MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(message.stackLimitBytes || STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const inputHandle = context.newString(message.inputJson);
    context.setProp(context.global, '__inputJson', inputHandle);
    inputHandle.dispose();

    const workspaceCallHandle = context.newFunction('__hostWorkspaceCall', (requestHandle) => {
      let response;
      try {
        const call = JSON.parse(context.getString(requestHandle));
        response = responseFor(call);
      } catch (error) {
        response = { ok: false, error: safeError(error) };
      }
      return context.newString(JSON.stringify(response));
    });
    context.setProp(context.global, '__hostWorkspaceCall', workspaceCallHandle);
    workspaceCallHandle.dispose();

    const evaluated = context.evalCode(guestBootstrap(message.code), 'workflow-script.js');
    if (evaluated.error) {
      const dumped = context.dump(evaluated.error);
      evaluated.error.dispose();
      const error = new Error(String(dumped?.message || dumped || '脚本执行失败').slice(0, ERROR_LIMIT_CHARS));
      if (/interrupted/i.test(error.message)) error.code = 'SCRIPT_TIMEOUT';
      throw error;
    }
    const outputJson = context.getString(evaluated.value);
    evaluated.value.dispose();
    return { value: JSON.parse(outputJson), workspaceStats: responseFor.workspace.stats() };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

parentPort.on('message', async (message) => {
  try {
    parentPort.postMessage({ ok: true, ...(await execute(message)) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: safeError(error) });
  }
});
