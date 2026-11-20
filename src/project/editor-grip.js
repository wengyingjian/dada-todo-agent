// 编辑器纸飞机委派：纯函数部分，可在 Node 下单测。
// 列表行判定、行文本提取、cwd 两级判定（项目节点 → 仓库根回退）。
// CM6 注册（widget + modal）在 main.js，依赖 obsidian，不在此文件。

import { normalizeCwd } from './index.js';

// 光标所在行是不是可委派的列表项：-/*/+/1. 都算，带不带 checkbox 都算
const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

export function isGripLine(raw) {
  return LIST_LINE_RE.test(String(raw || ''));
}

// 去掉列表前缀（含缩进）与 checkbox，取任务正文
export function extractTaskText(raw) {
  let s = String(raw || '').replace(LIST_LINE_RE, '');
  s = s.replace(/^\[[ xX/-]\]\s*/, '');
  return s.trim();
}

// cwd 两级判定（扁平索引版）：
// 1) 文件路径就是某个项目节点（清单文件）本身 → 用该项目 cwd
// 2) 匹配不到（或节点无 cwd）→ 回退仓库根
export function resolveEditorCwd(filePath, nodes, vaultRoot) {
  const p = String(filePath || '');
  const hit = (nodes || []).find((n) => n.filePath === p && normalizeCwd(n.cwd));
  if (hit) return normalizeCwd(hit.cwd);
  return normalizeCwd(vaultRoot) || normalizeCwd(p.split('/').slice(0, -1).join('/'));
}

