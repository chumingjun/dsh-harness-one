import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const registry = readFileSync(join(root, 'registry.jsx'), 'utf8');
const panel = readFileSync(join(root, 'NodePanel.jsx'), 'utf8');
const app = readFileSync(join(root, 'App.jsx'), 'utf8');

assert.match(registry, /type: 'notify'/);
assert.match(registry, /channel: 'feishu', mode: 'terminal'/);
assert.match(registry, /channelConfig: \{ targetType: 'chat_id', targetId: '' \}/);
assert.match(panel, /nodeType === 'notify'/);
assert.match(panel, /value=\{d\.channelConfig\?\.targetId \|\| ''\}/);
assert.match(panel, /<option value="chat_id">群聊<\/option>/);
assert.match(panel, /<option value="open_id">私聊<\/option>/);
assert.match(panel, /targetId: ''/);
assert.match(panel, /value=\{d\.mode \|\| 'terminal'\}/);
assert.match(panel, /notificationChannels\.length/);
assert.match(app, /notificationChannels=\{catalog\.notificationChannels\}/);
assert.match(app, /node\.type !== 'notify'/);
assert.match(app, /nodeType !== 'notify'/);

console.log('notify node tests: passed');
