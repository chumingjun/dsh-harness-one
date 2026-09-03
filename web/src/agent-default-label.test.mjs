// 节点面板「模型与轮次」默认值展示链（issue：WF1 默认模型被展示成 dsh 默认）。
// 前端展示必须与引擎解析链（orchestrator/lib/agent-defaults.js）对齐：
// 节点未配置时第一顺位是设置面板「Workflow One」默认值（llmConfig.wf1Defaults），
// 未设置才回退 dsh 全局选择（llmConfig.default*）。用源码断言（与 notify-node.test.mjs 同模式）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(root, 'NodePanel.jsx'), 'utf8');

// llmConfig.wf1Defaults 是展示链的第一顺位数据源
assert.match(panel, /llmConfig\.wf1Defaults/, 'NodePanel 应从 llmConfig.wf1Defaults 读取 WF1 默认值');

// 占位文案：WF1 设置了渠道时显示「跟随 Workflow One 默认」，而不是「跟随 dsh 默认」
assert.match(panel, /跟随 Workflow One 默认/, '占位文案应包含「跟随 Workflow One 默认」分支');

// 渠道下拉占位：wf1Provider 存在时优先展示 WF1 层
assert.match(panel, /wf1Provider\s*\?\s*`跟随 Workflow One 默认/, '渠道下拉占位应优先 wf1Provider');

// effectiveProvider 链：wf1Provider 优先于 llmConfig.defaultProvider
assert.match(panel, /const defaultProvider = wf1Provider \|\| llmConfig\.defaultProvider \|\| ''/, 'defaultProvider 应先取 wf1Provider');

// 思考级别继承链：WF1 档位优先，且要求同渠道同模型（与引擎 resolve 同语义）
assert.match(panel, /wf1Defaults\.reasoningEffort && wf1Model && effectiveProvider === wf1Provider/, '思考级别继承应先看 WF1 档位');

console.log('agent default label tests: passed');
