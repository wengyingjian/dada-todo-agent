// 委派子行的纯逻辑：生成 / 解析 / 状态映射。与进程、Obsidian 无关，便于单测。

export const T3_MARK = '⚡ t3:';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function shortId(threadId) {
  // 会话 id 可能带 mcp: 之类前缀，展示时只取 uuid 的前 6 位
  const id = String(threadId || '');
  const uuid = UUID_RE.exec(id);
  return (uuid ? uuid[0] : id).replace(/-/g, '').slice(0, 6);
}

const STATE_TEXT = {
  running: '进行中…',
  awaiting: '等你回答…',
  cancelled: '已取消'
};

const STATE_BOX = {
  running: '/',
  awaiting: '/',
  completed: 'x',
  failed: '-',
  cancelled: '-'
};

// state: running | awaiting | completed | failed | cancelled
export function formatDelegationLine({ state = 'running', summary = '', threadId = '', summarizedPromptCount = null, indent = '\t' } = {}) {
  const box = `- [${STATE_BOX[state] || ' '}]`;
  const text = state === 'running' || state === 'awaiting' || state === 'cancelled'
    ? (summary || STATE_TEXT[state])
    : (summary || (state === 'failed' ? '失败' : '完成'));
  // 标记始终写上：还没有会话 id 的占位行 / 起进程就失败的子行也要能被识别出来
  // #count 记录「总结时见过的 user prompt 数」，反向同步用它判断会话是否有新内容需要再总结
  const version = summarizedPromptCount != null ? `#${summarizedPromptCount}` : '';
  const tail = `  ${T3_MARK}${threadId || ''}${version}`;
  return `${indent}${box} ${text}${tail}`.replace(/\s+$/, '');
}

export function parseDelegationLine(line) {
  const raw = String(line == null ? '' : line);
  const idx = raw.indexOf(T3_MARK);
  if (idx < 0) return null;
  // 会话 id 可能是 `mcp:<uuid>`：整段都算 id（数据库里就是这个形态），只截掉行尾杂字符
  const tail = raw.slice(idx + T3_MARK.length).trim();
  const token = (tail.split(/\s+/)[0] || '');
  const uuid = UUID_RE.exec(token);
  // 允许没有会话 id：占位行、启动就失败的子行都属于委派记录
  const threadId = uuid ? token.slice(0, token.indexOf(uuid[0]) + uuid[0].length) : '';
  // #count 版本标记：紧跟会话 id 之后（#5 → summarizedPromptCount=5），旧格式行没有则为 null
  const versionToken = token.slice(threadId ? token.indexOf(uuid[0]) + uuid[0].length : 0);
  const vm = /^#(\d+)$/.exec(versionToken);
  const summarizedPromptCount = vm ? Number(vm[1]) : null;
  const m = /^([ \t]*)- \[([ xX/–-])\]\s*(.*)$/.exec(raw.slice(0, idx).replace(/\s+$/, ''));
  if (!m) return null;
  const indent = m[1];
  const box = m[2].toLowerCase();
  let state = 'running';
  if (box === 'x') state = 'completed';
  else if (box === '-') state = 'failed';
  else if (box === '/') state = 'running';
  const summary = m[3].replace(/\s+$/, '');
  if (state === 'running' && /等你回答/.test(summary)) state = 'awaiting';
  if (box === '-' && /已取消/.test(summary)) state = 'cancelled';
  return { indent, state, summary, threadId, summarizedPromptCount };
}

// ---------- LLM 总结块：子行下方的分点描述行 ----------
// 描述行 = 缩进比任务行更深 + 以「数字.」开头（普通列表行，不满足任务正则，不会进任务树）

const DESC_RE = /^([ \t]+)\d+\.\s/;

export function renderSummaryBlock({ indent = '\t', state = 'completed', summary = '', threadId = '', summarizedPromptCount = null, title = '', points = [] } = {}) {
  const head = formatDelegationLine({ state, summary: title || summary, threadId, summarizedPromptCount, indent });
  const lines = [head];
  for (let i = 0; i < points.length; i++) lines.push(`${indent}  ${i + 1}. ${points[i]}`);
  return lines;
}

// lines[start] 是委派子行时，返回其后紧邻的描述行条数（0 表示无描述块）
export function countSummaryDescLines(lines, start) {
  let n = 0;
  for (let i = start + 1; i < (lines || []).length; i++) {
    if (DESC_RE.test(String(lines[i] || ''))) { n += 1; continue; }
    break;
  }
  return n;
}

// ---------- 委派子行插入位置规划 ----------
// 任务行与子行之间不允许夹空行（空行会断开层级，视觉上像隔了一条）。
// 子行直接插在任务行的下一行；任务行与后续内容之间的空行删掉。
// 返回 { at, removeEmpty }：at = 插入下标，removeEmpty = 插入后需删除的空行数
// （典型场景：createChecklistTask 建父任务后 body 以 \n 结尾，尾部空串留在新任务后）。
export function planDelegationInsert(lines, parentLineNo) {
  const at = parentLineNo + 1;
  let removeEmpty = 0;
  let i = at;
  while (i < (lines || []).length && /^\s*$/.test(String(lines[i] || ''))) {
    i += 1;
    removeEmpty += 1;
  }
  return { at, removeEmpty };
}

// T3 状态口径（见 spec §8.3）
export function stateFromRun(runStatus, pendingKinds = []) {
  const pending = (pendingKinds || []).filter((k) => k && k !== 'auth_refresh');
  if (pending.length) return 'awaiting';
  switch (String(runStatus || '')) {
    case 'queued':
    case 'preparing':
    case 'starting':
    case 'running':
    case 'waiting':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'interrupted':
    case 'cancelled':
    case 'rolled_back':
      return 'cancelled';
    default:
      return null;
  }
}

// 从文件行里提取委派记录，parentLine 用于重建映射与定位
export function extractDelegations(lines) {
  const out = [];
  const stack = [];
  (lines || []).forEach((line, i) => {
    const d = parseDelegationLine(line);
    if (d) {
      out.push({ ...d, line: i, parentLine: stack.length ? stack[stack.length - 1].line : -1 });
      return;
    }
    const task = /^([ \t]*)- \[[ xX/-]\]/.exec(line);
    if (task) {
      const depth = task[1].replace(/\t/g, '  ').length;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      stack.push({ line: i, depth });
    }
  });
  return out.map(({ indent, ...rest }) => rest);
}
