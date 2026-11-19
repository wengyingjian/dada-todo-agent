// 委派子行的纯逻辑：生成 / 解析 / 状态映射。与进程、Obsidian 无关，便于单测。

export const T3_MARK = '⚡ t3:';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function shortId(threadId) {
  // 会话 id 可能带 mcp: 之类前缀，展示时只取 uuid 的前 6 位
  const id = String(threadId || '');
  const uuid = UUID_RE.exec(id);
  return (uuid ? uuid[0] : id).replace(/-/g, '').slice(0, 6);
}

// 占位行的临时 id（`p!a1b2c3d4`）：会话 id 要等 CLI 跑起来才拿得到，插入后、回填前
// 必须能唯一定位这一行。否则并发委派会串行，反向同步也会把同一会话当未绑定再建一条。
const PENDING_RE = /^p!([0-9a-z]+)$/i;

// 从 `t3:` 之后的那段 token 里取会话 id：允许 mcp: 前缀，截到 uuid 结尾（不含 #count 版本号）。
// 没有 uuid（占位行 / 起进程就失败的子行）返回 ''。
export function threadIdFromToken(rawToken) {
  const token = String(rawToken == null ? '' : rawToken);
  const uuid = UUID_RE.exec(token);
  return uuid ? token.slice(0, token.indexOf(uuid[0]) + uuid[0].length) : '';
}

// 占位行的临时 id；不是占位行返回 ''
export function pendingIdFromToken(rawToken) {
  const token = String(rawToken == null ? '' : rawToken);
  const uuid = UUID_RE.exec(token);
  if (uuid) return '';
  const m = PENDING_RE.exec(token);
  return m ? m[1] : '';
}

// 编辑器用：找出文本里所有「可点击」的会话标记 `⚡ t3:<id>`（含 #count 版本号整段）。
// 返回相对文本的偏移 [{ from, to, threadId }]；没有会话 id 的标记不返回。
const THREAD_LINK_RE = /⚡\s*t3:(\S*)/g;

export function findThreadLinks(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  THREAD_LINK_RE.lastIndex = 0;
  let m;
  while ((m = THREAD_LINK_RE.exec(s))) {
    const threadId = threadIdFromToken(m[1]);
    if (!threadId) continue;
    out.push({ from: m.index, to: m.index + m[0].length, threadId });
  }
  return out;
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
export function formatDelegationLine({ state = 'running', summary = '', threadId = '', pendingId = '', summarizedPromptCount = null, indent = '\t' } = {}) {
  const box = `- [${STATE_BOX[state] || ' '}]`;
  const text = state === 'running' || state === 'awaiting' || state === 'cancelled'
    ? (summary || STATE_TEXT[state])
    : (summary || (state === 'failed' ? '失败' : '完成'));
  // 标记始终写上：还没有会话 id 的占位行 / 起进程就失败的子行也要能被识别出来
  // #count 记录「总结时见过的 user prompt 数」，反向同步用它判断会话是否有新内容需要再总结
  const version = summarizedPromptCount != null ? `#${summarizedPromptCount}` : '';
  const token = threadId || (pendingId ? `p!${pendingId}` : '');
  const tail = `  ${T3_MARK}${token}${version}`;
  return `${indent}${box} ${text}${tail}`.replace(/\s+$/, '');
}

export function parseDelegationLine(line) {
  const raw = String(line == null ? '' : line);
  const idx = raw.indexOf(T3_MARK);
  if (idx < 0) return null;
  // 会话 id 可能是 `mcp:<uuid>`：整段都算 id（数据库里就是这个形态），只截掉行尾杂字符
  const tail = raw.slice(idx + T3_MARK.length).trim();
  const token = (tail.split(/\s+/)[0] || '');
  // #count 版本标记紧跟 id：先摘掉再解析 id（`p!xxx#2` / `mcp:<uuid>#5` 都适用）
  const vm = /#(\d+)$/.exec(token);
  const summarizedPromptCount = vm ? Number(vm[1]) : null;
  const core = vm ? token.slice(0, vm.index) : token;
  // 允许没有会话 id：占位行、启动就失败的子行都属于委派记录
  const threadId = threadIdFromToken(core);
  const pendingId = pendingIdFromToken(core);
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
  return { indent, state, summary, threadId, pendingId, summarizedPromptCount };
}

// ---------- LLM 总结块：子行下方的分点描述行 ----------
// 描述行 = 缩进比任务行更深 + 以「数字.」开头（普通列表行，不满足任务正则，不会进任务树）

// 允许「- 」前缀：块经 core 的 serializeBlock 搬组后会写成 `\t- 1. …`，
// 两种形态都必须认成描述行，否则再次总结时旧分点删不掉。
const DESC_RE = /^([ \t]+)(?:-\s+)?\d+\.\s/;

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
// 子行直接插在父行的下一行；父行下方原有的空行会被子行顶到后面，不需要删除——
// 删除反而会吃掉用户自己的分段空行。removeEmpty 保留为 0 只为兼容 splice 调用。
export function planDelegationInsert(lines, parentLineNo) {
  const at = Math.max(0, Math.min((lines || []).length, parentLineNo + 1));
  return { at, removeEmpty: 0 };
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

// 任意列表项（任务行 `- [ ]` 或普通列表项 `- xxx` / 空项 `-`）：委派可以挂在用户
// 随手写的列表项下，父行不一定是 checkbox 任务，所以父行栈按列表项而不是任务行维护。
const LIST_ITEM_RE = /^([ \t]*)-(\s|$)/;

// 从文件行里提取会话记录，parentLine 用于重建映射与定位。
// self = 顶层任务行自带标记（同步新建的单级任务，标记就是它自己的绑定）；
// 否则是挂在父列表项下的委派子行。
export function extractDelegations(lines) {
  const out = [];
  const stack = [];
  (lines || []).forEach((line, i) => {
    const d = parseDelegationLine(line);
    if (d) {
      const self = !d.indent;
      out.push({ ...d, line: i, self, parentLine: self ? i : (stack.length ? stack[stack.length - 1].line : -1) });
      // self 行本身也是顶层列表项，继续入栈供其下可能出现的子行归属；子行不入栈
      if (!self) return;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      const depth = item[1].replace(/\t/g, '  ').length;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      stack.push({ line: i, depth });
    }
  });
  return out.map(({ indent, ...rest }) => rest);
}
