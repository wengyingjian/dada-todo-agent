// 接线层：把 LLM 总结写进任务文件行数组。纯行变换（输入行数组 + 位置，输出变更后的同一数组），
// vault 读写由调用方（delegate.js / runtime.js）完成。
import { parseDelegationLine, countSummaryDescLines } from './delegate-line.js';

// at: 委派子行在 lines 中的下标。要求该行确实带 ⚡ t3: 标记。
// summary: { state, threadId, summarizedPromptCount, title, points }
// 返回 { ok, endLine }（endLine = 新块最后一行的下标，供调用方续查）。
export function applySummaryToLines(lines, at, summary) {
  const line = lines != null ? lines[at] : undefined;
  const d = line != null ? parseDelegationLine(line) : null;
  if (!d) return { ok: false, reason: 'not_delegation' };
  const indent = d.indent;
  const head = formatHead(indent, summary);
  const desc = (summary.points || []).map((p, i) => `${indent}  ${i + 1}. ${p}`);
  lines.splice(at, 1, head, ...desc);
  return { ok: true, endLine: at + desc.length };
}

// 替换已有总结块：先吞掉子行后紧邻的旧分点行，再写入新块
export function replaceSummaryInLines(lines, at, summary) {
  const line = lines != null ? lines[at] : undefined;
  const d = line != null ? parseDelegationLine(line) : null;
  if (!d) return { ok: false, reason: 'not_delegation' };
  const oldDescCount = countSummaryDescLines(lines, at);
  lines.splice(at, 1 + oldDescCount);
  const head = formatHead(d.indent, summary);
  const desc = (summary.points || []).map((p, i) => `${d.indent}  ${i + 1}. ${p}`);
  lines.splice(at, 0, head, ...desc);
  return { ok: true, endLine: at + desc.length };
}

function formatHead(indent, summary) {
  const boxChar = summary.state === 'completed' ? 'x' : (summary.state === 'failed' || summary.state === 'cancelled' ? '-' : '/');
  const version = summary.summarizedPromptCount != null ? `#${summary.summarizedPromptCount}` : '';
  return `${indent}- [${boxChar}] ${String(summary.title || '完成').trim()}  ⚡ t3:${summary.threadId || ''}${version}`.replace(/\s+$/, '');
}
