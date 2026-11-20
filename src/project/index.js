// 项目索引层（扁平版）：项目 = 一份清单文件（frontmatter 带 cwd），平铺在清单文件夹里。
// 不再有「项目根目录 + 目录树 + task-<目录名>.md」结构；已归档清单 = 落在归档文件夹内。
// 本文件不直接依赖 obsidian，纯函数部分可在 Node 下单测。

export const DEFAULT_PROJECTS_ROOT = '清单';
// 兼容旧调用：旧 projectsRoot（任务）的目录树结构已废除
export { DEFAULT_PROJECTS_ROOT as DEFAULT_CHECKLISTS_ROOT };

export function normalizeRoot(root) {
  return String(root == null ? '' : root)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function normalizeCwd(cwd) {
  const s = String(cwd == null ? '' : cwd).trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return s;
}

// 路径是否在某根目录之下（不含等于根本身）
export function isUnderRoot(path, root) {
  const r = normalizeRoot(root);
  if (!r) return false;
  return path === r ? false : path.startsWith(r + '/');
}

// files: [{ path, frontmatter }] —— 清单文件夹内的清单文件（已排除归档文件夹）
// opts: { root, defaultCwd }
// 返回：{ nodes, roots, byPath }（roots 与 nodes 相同——扁平无层级；byPath 按 filePath 索引）
// node: { name, dirPath（= 文件所在文件夹，兼容旧字段）, filePath, cwd, ownCwd, sort, status, depth: 1, children: [] }
export function buildProjectIndex(files, opts = {}) {
  const defaultCwd = normalizeCwd(opts.defaultCwd || '');
  const nodes = [];
  const byPath = new Map();
  for (const f of files || []) {
    const p = String(f.path || '');
    if (!p || !/\.md$/i.test(p)) continue;
    const fm = f.frontmatter || {};
    const ownCwd = normalizeCwd(fm.cwd || '');
    const name = p.split('/').pop().replace(/\.md$/i, '');
    const node = {
      name,
      dirPath: p.split('/').slice(0, -1).join('/'),
      filePath: p,
      cwd: ownCwd || defaultCwd,
      ownCwd,
      sort: Number.isFinite(Number(fm.sort)) && fm.sort !== '' ? Number(fm.sort) : Number.NaN,
      status: String(fm.status || 'active'),
      depth: 1,
      children: []
    };
    nodes.push(node);
    byPath.set(p, node);
  }
  nodes.sort((a, b) => {
    const sa = Number.isFinite(a.sort) ? a.sort : Number.POSITIVE_INFINITY;
    const sb = Number.isFinite(b.sort) ? b.sort : Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
  });
  return { nodes, roots: nodes, byDir: new Map(), byPath };
}

// cwd 归属：相同或以 `<项目 cwd>/` 开头，取最长匹配
export function matchProjectByCwd(cwd, nodes) {
  const target = normalizeCwd(cwd);
  if (!target) return null;
  let best = null;
  for (const n of nodes || []) {
    const c = normalizeCwd(n.cwd);
    if (!c) continue;
    if (target === c || target.startsWith(c + '/')) {
      if (!best || c.length > normalizeCwd(best.cwd).length) best = n;
    }
  }
  return best;
}
