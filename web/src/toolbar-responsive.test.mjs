import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(root, 'App.jsx'), 'utf8');
const menus = readFileSync(join(root, 'ToolbarMenus.jsx'), 'utf8');
const styles = readFileSync(join(root, 'styles.css'), 'utf8');

assert.match(app, /toolbar-compact-hide/);
assert.match(app, /compactOnly: true/);
assert.match(menus, /tb-menu-compact-only/);
assert.match(styles, /@media \(max-width: 860px\)[\s\S]*toolbar \.toolbar-compact-hide[\s\S]*tb-menu-compact-only/);
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*tb-add-label/);

console.log('toolbar responsive tests: passed');
