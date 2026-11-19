// 会话侧边栏的分组与展示格式化：纯函数，不碰 Obsidian / Vue。
// 分组语义与文件里的 ### 分组保持一致（见 groups.js），但侧边栏的展示顺序是
// 待处理 → 进行中 → 已完成，和任务文件的组序不同。

export const SECTION_KEYS = ['wait', 'run', 'done'];

const STATE_SECTION = {
  awaiting: 'wait',
  running: 'run',
  completed: 'done',
  failed: 'done',
  cancelled: 'done'
};

// 三段分组；组内 updatedAt 倒序；已完成先排序再取前 doneLimit 条。
// 未知状态（idle 等）不进任何分组。
export function groupSessions(threads, { doneLimit = 20 } = {}) {
  const buckets = { wait: [], run: [], done: [] };
  for (const t of threads || []) {
    const key = STATE_SECTION[t && t.state];
    if (key) buckets[key].push(t);
  }
  const byTime = (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
  for (const key of SECTION_KEYS) buckets[key].sort(byTime);
  if (doneLimit >= 0) buckets.done = buckets.done.slice(0, doneLimit);
  return SECTION_KEYS.map((key) => ({ key, items: buckets[key] }));
}

// 状态 chip：样式类与文案 key 与 AgentDeck 的 stateChip 对齐。
export function stateChipOf(state) {
  switch (state) {
    case 'running': return { cls: 'is-live', key: 'live' };
    case 'awaiting': return { cls: 'is-wait', key: 'wait' };
    case 'completed': return { cls: 'is-done', key: 'done' };
    case 'failed': return { cls: 'is-error', key: 'error' };
    case 'cancelled': return { cls: 'is-quiet', key: 'cancelled' };
    default: return null;
  }
}

// 相对时间拆成可翻译的片段：{ unit: 'now' | 'min' | 'hour' | 'day', n? }
export function timeAgoParts(ms, now = Date.now()) {
  if (!ms) return null;
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return { unit: 'now' };
  if (s < 3600) return { unit: 'min', n: Math.round(s / 60) };
  if (s < 86400) return { unit: 'hour', n: Math.round(s / 3600) };
  return { unit: 'day', n: Math.round(s / 86400) };
}

const UUID_RE = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

// T3 用 WAL 模式写库：主库 / -wal / -shm 任一变化都意味着会话状态可能变了。
const T3_DB_FILE_RE = /^statev2\.sqlite(?:-(?:wal|shm))?$/;
export function isT3DbFile(name) {
  return T3_DB_FILE_RE.test(String(name || ''));
}

// 工作目录只显示最后一级；会话临时目录（UUID）由界面换成「会话工作区」。
export function workspaceLabel(cwd) {
  const name = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return { name, opaque: UUID_RE.test(name) };
}
