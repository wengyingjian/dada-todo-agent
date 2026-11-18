#!/usr/bin/env node
// 构建并安装到 Obsidian 库：node scripts/install.mjs [vaultPath]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vault = process.argv[2] || path.join(homedir(), 'Documents/ObsidianVault');
const target = path.join(vault, '.obsidian/plugins/dada-todo-agent');

execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
if (!existsSync(target)) mkdirSync(target, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  copyFileSync(path.join(root, 'dada-todo-agent', f), path.join(target, f));
}
console.log(`installed → ${target}`);
