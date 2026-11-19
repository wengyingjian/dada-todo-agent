// 接线层：把 LLM 总结写进任务文件行数组。纯行变换（输入行数组 + 位置，输出变更后的同一数组），
// vault 读写由调用方（delegate.js / runtime.js）完成。
// 标题行统一走 session-line 的 rewriteSessionLine：只改标题/状态/标记，
// 保留时间前缀与 📅/🛫 等日期徽标（同步任务行与委派子行共用）。
import { countSummaryDescLines } from './delegate-line.js';
import { splitSessionLine, rewriteSessionLine, descIndentOf, locateSessionLine } from './session-line.js';

// at: 会话行在 lines 中的下标。要求该行确实是任务行（带标记或新建的普通任务行）。
// summary: { state, threadId, summarizedPromptCount, title, points }
// 返回 { ok, endLine }（endLine = 新块最后一行的下标，供调用方续查）。
export function applySummaryToLines(lines, at, summary) {
  const line = lines != null ? lines[at] : undefined;
  const s = line != null ? splitSessionLine(line) : null;
  if (!s) return { ok: false, reason: 'not_delegation' };
  const head = rewriteSessionLine(line, summary);
  const ind = descIndentOf(s);
  const desc = (summary.points || []).map((p, i) => `${ind}${i + 1}. ${p}`);
  lines.splice(at, 1, head, ...desc);
  return { ok: true, endLine: at + desc.length };
}

// 替换已有总结块：先吞掉会话行后紧邻的旧分点行，再写入新块
export function replaceSummaryInLines(lines, at, summary) {
  const line = lines != null ? lines[at] : undefined;
  const s = line != null ? splitSessionLine(line) : null;
  if (!s) return { ok: false, reason: 'not_delegation' };
  const oldDescCount = countSummaryDescLines(lines, at);
  lines.splice(at, 1 + oldDescCount);
  const head = rewriteSessionLine(line, summary);
  const ind = descIndentOf(s);
  const desc = (summary.points || []).map((p, i) => `${ind}${i + 1}. ${p}`);
  lines.splice(at, 0, head, ...desc);
  return { ok: true, endLine: at + desc.length };
}

// 行号漂移安全定位：优先按 threadId 现场扫整份文件找会话行；
// 找不到时回退到缓存行号（仍要求该行确实是会话行）。
// 返回行下标，找不到返回 -1。
export function locateDelegationLine(lines, threadId, cachedLineNo = -1) {
  return locateSessionLine(lines, { threadId, cachedLineNo });
}
