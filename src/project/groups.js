// 项目任务文件的 ### 分组：回传/导入的会话任务按状态落入固定三组，
// 同步时状态变化自动搬组。纯函数，无 Obsidian 依赖，方便单测。

// 分组定义与顺序（标题名即文件里的 ### 文字）
export const GROUPS = ['进行中', '待处理', '已完成'];

const STATE_GROUP = {
  running: '进行中',
  awaiting: '待处理',
  completed: '已完成',
  failed: '已完成',
  cancelled: '已完成'
};

// 会话状态 → 分组标题；未知状态返回空串（调用方按未分组处理）
export function groupOfState(state) {
  return STATE_GROUP[state] || '';
}

// 收集 ### 三级标题（行号 + 标题文字）。与 core api（tasks.js）的解析口径一致：
// 仅 ^### 开头，标题两侧空白裁掉。
export function collectGroupHeadings(lines) {
  const out = [];
  (lines || []).forEach((line, idx) => {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ lineNo: idx, title: m[1].trim() });
  });
  return out;
}

// 行号 → 所属分组标题；标题之前（未分组）返回空串；
// 行号超出文件时按最后一组归属（调用方一般传块首行号，超界即文件尾部块）。
export function groupOfLine(lines, lineNo) {
  let title = '';
  for (const h of collectGroupHeadings(lines)) {
    if (h.lineNo < lineNo) title = h.title; else break;
    // 超界：超过最后一个标题即仍归最后一组，循环自然结束
    if (lineNo <= h.lineNo) break;
  }
  return title;
}

// 确保三个分组标题齐全：
// - 全齐 → 原样返回（一个字节都不动）
// - 有缺失 → 按 GROUPS 固定顺序重排已有分组段，缺失组只留标题；
//   首个标题之前的「未分组老任务」整体沉到文件末尾（最后一个已有组下方）。
// 返回 { lines, added }。
export function ensureGroupHeadings(lines) {
  const src = (lines || []).slice();
  const heads = collectGroupHeadings(src);
  const have = new Set(heads.map((h) => h.title));
  const missing = GROUPS.filter((g) => !have.has(g));
  if (!missing.length) return { lines: src, added: [] };

  // 切成「段」：每段 = 标题行 + 到下一个标题前的正文；首个标题之前的行是未分组区
  const firstHead = heads.length ? heads[0].lineNo : src.length;
  const trimTail = (arr) => {
    const out = arr.slice();
    while (out.length && !String(out[out.length - 1]).trim()) out.pop();
    return out;
  };
  const ungrouped = trimTail(src.slice(0, firstHead));
  const sections = heads.map((h, i) => ({
    title: h.title,
    block: trimTail(src.slice(h.lineNo, i + 1 < heads.length ? heads[i + 1].lineNo : src.length))
  }));

  const blocks = [];
  for (const g of GROUPS) {
    const hit = sections.find((s) => s.title === g);
    blocks.push(hit ? hit.block : [`### ${g}`]);
  }
  // 非内置分组（用户自定义 ### 标题）保留原顺序，排在已知分组之后
  for (const s of sections) if (!GROUPS.includes(s.title)) blocks.push(s.block);
  const out = [];
  for (const b of blocks) {
    if (out.length) out.push('');
    out.push(...b);
  }
  // 未分组老任务沉底：紧贴最后一个分组（不再空一行，读起来仍属于该组）
  out.push(...ungrouped);
  return { lines: out, added: missing };
}

// 平铺任务列表 + 文件行 → 视图行（task / heading 占位），按 lineNo 归位排序。
// 行形态：{ kind: 'task', task } | { kind: 'heading', title, lineNo }。
// 任务行的 lineNo 用其上方最近的 ### 标题定位；标题行插在该标题 lineNo 之后、
// 下一个任务之前（视图按此顺序渲染）。
export function mergeHeadingRows(tasks, lines) {
  const headings = collectGroupHeadings(lines || []);
  const rows = (tasks || []).map((t) => ({ kind: 'task', task: t, sortKey: t.lineNo }));
  for (const h of headings) {
    rows.push({ kind: 'heading', title: h.title, lineNo: h.lineNo, sortKey: h.lineNo + 0.5 });
  }
  rows.sort((a, b) => a.sortKey - b.sortKey);
  return rows.map(({ kind, task, title, lineNo }) => (kind === 'task' ? { kind, task } : { kind, title, lineNo }));
}
