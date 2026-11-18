// 项目索引层：把 <projectsRoot>/ 下的目录树映射成项目节点。
// 目录即项目；项目文件为同目录下 `task-<目录名>.md`（可缺省，懒创建）。
// 本文件不直接依赖 obsidian，纯函数部分可在 Node 下单测。

export const DEFAULT_PROJECTS_ROOT = '任务';
const PROJECT_FILE_RE = /^task-(.+)\.md$/i;

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

export function isUnderRoot(path, root) {
  const r = normalizeRoot(root);
  if (!r) return false;
  return path === r ? false : path.startsWith(r + '/');
}

// 目录路径 → 项目文件路径（与目录同名，前缀 task-）
export function projectFilePath(dirPath) {
  const dir = dirPath.replace(/\/+$/g, '');
  const name = dir.split('/').pop();
  return `${dir}/task-${name}.md`;
}

// 项目文件路径 → 所属目录（不是项目文件返回 null）
export function projectDirOf(path, root) {
  if (!isUnderRoot(path, root)) return null;
  const parts = path.split('/');
  if (parts.length < 3) return null; // root/<dir>/<file>
  const file = parts[parts.length - 1];
  const dirName = parts[parts.length - 2];
  const m = PROJECT_FILE_RE.exec(file);
  if (!m) return null;
  if (m[1] !== dirName) return null;
  return parts.slice(0, -1).join('/');
}

function dirDepth(path, root) {
  const r = normalizeRoot(root);
  return path.slice(r.length + 1).split('/').length;
}

function compareNodes(a, b) {
  const sa = Number.isFinite(a.sort) ? a.sort : Number.POSITIVE_INFINITY;
  const sb = Number.isFinite(b.sort) ? b.sort : Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa - sb;
  return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
}

// dirs:   [{ path }]                          —— vault 里的目录
// files:  [{ path, frontmatter }]             —— vault 里的 markdown 文件
// opts:   { root, defaultCwd }
// 返回：{ nodes: [node], roots: [node], byDir: Map }
// node: { name, dirPath, filePath, cwd, ownCwd, sort, status, depth, children }
export function buildProjectIndex(dirs, files, opts = {}) {
  const root = normalizeRoot(opts.root || DEFAULT_PROJECTS_ROOT);
  const defaultCwd = normalizeCwd(opts.defaultCwd || '');
  if (!root) return { nodes: [], roots: [], byDir: new Map() };

  const dirPaths = new Set();
  for (const d of dirs || []) {
    const p = String(d.path || '').replace(/\/+$/g, '');
    if (!isUnderRoot(p, root)) continue;
    // 任意层级都建节点；. 开头的目录跳过
    const rel = p.slice(root.length + 1);
    if (!rel || rel.split('/').some((s) => s.startsWith('.'))) continue;
    dirPaths.add(p);
  }

  const fileMap = new Map();
  const fmMap = new Map();
  for (const f of files || []) {
    const dir = projectDirOf(f.path, root);
    if (!dir) continue;
    if (!dirPaths.has(dir)) dirPaths.add(dir);
    fileMap.set(dir, f.path);
    fmMap.set(dir, f.frontmatter || {});
  }

  // 补齐中间层级（只登记文件、未登记目录时）
  for (const dir of Array.from(dirPaths)) {
    let cur = dir;
    while (true) {
      const parent = cur.split('/').slice(0, -1).join('/');
      if (!isUnderRoot(parent, root)) break;
      dirPaths.add(parent);
      cur = parent;
    }
  }

  const byDir = new Map();
  for (const dir of dirPaths) {
    const fm = fmMap.get(dir) || {};
    byDir.set(dir, {
      name: dir.split('/').pop(),
      dirPath: dir,
      filePath: fileMap.get(dir) || '',
      cwd: '',
      ownCwd: normalizeCwd(fm.cwd || ''),
      sort: Number.isFinite(Number(fm.sort)) && fm.sort !== '' ? Number(fm.sort) : Number.NaN,
      status: String(fm.status || 'active'),
      depth: dirDepth(dir, root),
      children: []
    });
  }

  const roots = [];
  for (const node of byDir.values()) {
    const parentPath = node.dirPath.split('/').slice(0, -1).join('/');
    const parent = byDir.get(parentPath);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // 自顶向下继承 cwd，并排序
  const walk = (node, inheritedCwd) => {
    node.cwd = node.ownCwd || inheritedCwd || defaultCwd;
    node.children.sort(compareNodes);
    for (const c of node.children) walk(c, node.cwd);
  };
  roots.sort(compareNodes);
  for (const r of roots) walk(r, '');

  const nodes = Array.from(byDir.values());
  return { nodes, roots, byDir };
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

// 从 Obsidian vault 收集目录与文件条目（运行时用；纯函数不依赖 obsidian）
export function collectVaultEntries(vault, root) {
  const r = normalizeRoot(root);
  const dirs = [];
  const files = [];
  const all = typeof vault.getAllLoadedFiles === 'function' ? vault.getAllLoadedFiles() : [];
  for (const f of all) {
    const p = f.path;
    if (!isUnderRoot(p, r) && p !== r) continue;
    if (f.children) {
      if (isUnderRoot(p, r)) dirs.push({ path: p });
    } else if (/\.md$/i.test(p)) {
      const cache = f.__fmCache || {};
      files.push({ path: p, frontmatter: cache });
    }
  }
  return { dirs, files };
}
