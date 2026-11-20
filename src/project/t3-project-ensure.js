// 委派前确保 cwd 已注册为 T3 项目：t3 thread start <cwd> 只接受已注册项目
// （或项目内路径），未注册时 CLI 报 "No T3 Code project matches"。
// 判定（projectCovers/needsRegister）纯函数可单测；注册走 `t3 project add`。

import { execFile } from 'node:child_process';
import { normalizeCwd } from './index.js';

// cwd 是否被某个已注册项目覆盖：cwd 等于/在项目内，或项目在 cwd 内（父子任一侧都算）
export function projectCovers(roots, cwd) {
  const c = normalizeCwd(cwd);
  if (!c) return false;
  return (roots || []).some((r) => {
    const n = normalizeCwd(r);
    if (!n) return false;
    return c === n || c.startsWith(n + '/') || n.startsWith(c + '/');
  });
}

export function needsRegister(roots, cwd) {
  return !projectCovers(roots, cwd);
}

// 查询 T3 项目注册表（只读 sqlite3 -json），失败返回 []
export function listT3Projects(dbPath, { execFile: run = execFile } = {}) {
  return new Promise((resolve) => {
    run('sqlite3', ['-readonly', '-json', dbPath,
      "select workspace_root from projection_projects where deleted_at is null"],
      { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          const rows = JSON.parse(String(stdout || '[]'));
          resolve((Array.isArray(rows) ? rows : []).map((r) => String(r.workspace_root || '')).filter(Boolean));
        } catch { resolve([]); }
      });
  });
}

// 注册新项目（t3 project add <cwd>）；已存在/失败都不抛错，返回是否疑似成功
export function registerT3Project(binary, cwd, { execFile: run = execFile } = {}) {
  return new Promise((resolve) => {
    run(binary, ['project', 'add', cwd], { timeout: 15000 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      // CLI 对重复添加通常报 already exists——这也算「已注册」，不算失败
      resolve(!err || /already exists/i.test(out));
    });
  });
}

// 组合入口：委派前调用——cwd 未注册则先注册，再返回。注册失败返回 false（调用方决定是否继续）。
export async function ensureT3Project(dbPath, binary, cwd) {
  const roots = await listT3Projects(dbPath);
  if (!needsRegister(roots, cwd)) return true;
  return registerT3Project(binary, cwd);
}
