// 会话行的统一读写：文件里两种带 ⚡ t3: 标记的行共用同一套解析/改写。
//   - 委派子行：缩进列表项，挂在用户自己的列表项下（父行可能是任务，也可能是普通列表项）
//   - 同步任务行：顶层任务行，标记就挂在任务行尾（自己就是绑定，没有父行）
// 改写时必须保留时间前缀 / 日期徽标等元数据——整行重新拼字符串最容易把它们弄丢。
import { T3_MARK, parseDelegationLine } from './delegate-line.js';

const TASK_RE = /^([ \t]*)- \[([ xX/-])\]\s?(.*)$/;
const TIME_PREFIX_RE = /^(\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?\s)/;
const DATE_TAIL_RE = /((?:\s(?:📅|🛫|⏳|➕|✅|❌)\s\d{4}-\d{2}-\d{2})+)$/;

const BOX_OF = { completed: 'x', failed: '-', cancelled: '-', running: '/', awaiting: '/' };

// 状态文字 → 状态（用于无标记行改写时判断原 box 语义）
function stateOfBox(box) {
  const b = String(box || '').toLowerCase();
  if (b === 'x') return 'completed';
  if (b === '-') return 'failed';
  if (b === '/') return 'running';
  return '';
}

// 拆出会话行的各段：缩进 / box / 时间前缀 / 标题 / 日期后缀 / 原标记解析结果。
// 行上没有 ⚡ t3: 标记时 parsed 为 null（新建任务后第一次落标记会走这里）。
export function splitSessionLine(line) {
  const raw = String(line == null ? '' : line);
  if (!TASK_RE.test(raw)) return null;
  const d = parseDelegationLine(raw);
  const markAt = raw.indexOf(T3_MARK);
  const head = (d && markAt >= 0 ? raw.slice(0, markAt) : raw).replace(/\s+$/, '');
  const hm = TASK_RE.exec(head);
  if (!hm) return null;
  const timePrefix = (TIME_PREFIX_RE.exec(hm[3]) || [''])[0];
  const afterTime = hm[3].slice(timePrefix.length);
  const dateSuffix = (DATE_TAIL_RE.exec(afterTime) || [''])[0];
  const title = afterTime.slice(0, afterTime.length - dateSuffix.length).trim();
  return { indent: hm[1], box: hm[2], timePrefix, title, dateSuffix, parsed: d };
}

// 改写一行会话记录：只替换传入的字段，其余（缩进/时间/日期/box）原样保留。
// patch: { state, title, threadId, pendingId, summarizedPromptCount }
export function rewriteSessionLine(line, patch = {}) {
  const s = splitSessionLine(line);
  if (!s) return line;
  const box = patch.state ? (BOX_OF[patch.state] || s.box) : s.box;
  const title = patch.title != null ? String(patch.title).trim() : s.title;
  const threadId = patch.threadId != null ? patch.threadId : ((s.parsed && s.parsed.threadId) || '');
  const pendingId = patch.pendingId != null ? patch.pendingId : ((s.parsed && s.parsed.pendingId) || '');
  const count = patch.summarizedPromptCount !== undefined
    ? patch.summarizedPromptCount
    : ((s.parsed && s.parsed.summarizedPromptCount) || null);
  const token = threadId || (pendingId ? `p!${pendingId}` : '');
  const version = count != null ? `#${count}` : '';
  const body = `${s.timePrefix}${title}${s.dateSuffix}`;
  return `${s.indent}- [${box}] ${body}  ${T3_MARK}${token}${version}`.replace(/\s+$/, '');
}

// 描述分点行的缩进：比会话行深一级
export function descIndentOf(split) {
  return `${(split && split.indent) || ''}  `;
}

// 从任务标题（不含 `- [ ]` 前缀）里剥掉会话标记，供项目视图显示
export function stripSessionMark(text) {
  const s = String(text || '');
  const at = s.indexOf(T3_MARK);
  return (at >= 0 ? s.slice(0, at) : s).replace(/\s+$/, '').trim();
}

// 任务标题（不含 `- [ ]` 前缀）里的会话标记段（`⚡ t3:<id>#n`）；没有返回 ''
export function sessionMarkOf(text) {
  const s = String(text || '');
  const at = s.indexOf(T3_MARK);
  return at >= 0 ? s.slice(at).trim() : '';
}

// 任务标题（不含 `- [ ]` 前缀）绑定到哪个会话；没有返回 ''（self 行的 threadId）
export function sessionThreadIdOf(text) {
  const d = parseDelegationLine(`- [x] ${String(text || '')}`);
  return d ? d.threadId : '';
}

// 编辑器的行内标记（`⚡ t3:<id>` 带 #count）整体作为可点击链接，不参与标题展示
export function sessionStateOf(line) {
  const d = parseDelegationLine(line);
  return d ? d.state : stateOfBox((splitSessionLine(line) || {}).box);
}

// 行号漂移安全定位：threadId → pendingId → 缓存行号（仍要求该行是会话行）
export function locateSessionLine(lines, { threadId = '', pendingId = '', cachedLineNo = -1 } = {}) {
  const arr = lines || [];
  if (threadId) {
    const at = arr.findIndex((l) => {
      const d = parseDelegationLine(l);
      return d && d.threadId === threadId;
    });
    if (at >= 0) return at;
  }
  if (pendingId) {
    const at = arr.findIndex((l) => {
      const d = parseDelegationLine(l);
      return d && d.pendingId === pendingId;
    });
    if (at >= 0) return at;
  }
  if (cachedLineNo >= 0 && cachedLineNo < arr.length && parseDelegationLine(arr[cachedLineNo])) {
    return cachedLineNo;
  }
  return -1;
}
