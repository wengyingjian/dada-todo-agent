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
export function formatDelegationLine({ state = 'running', summary = '', threadId = '', indent = '\t' } = {}) {
  const box = `- [${STATE_BOX[state] || ' '}]`;
  const text = state === 'running' || state === 'awaiting' || state === 'cancelled'
    ? (summary || STATE_TEXT[state])
    : (summary || (state === 'failed' ? '失败' : '完成'));
  // 标记始终写上：还没有会话 id 的占位行 / 起进程就失败的子行也要能被识别出来
  const tail = `  ${T3_MARK}${threadId || ''}`;
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
  return { indent, state, summary, threadId };
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
