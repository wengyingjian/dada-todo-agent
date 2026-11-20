// 会话侧边栏的搜索与项目筛选：纯函数，供 sessions-view.js 与单测。
// 搜索口径同 AgentDeck：空格分词 AND，haystack = 标题 / 正文 / cwd / threadId 等。

const haystackOf = (t) => [
  t.title, t.firstUser, t.lastAssistant, t.cwd, t.threadId, t.state
].map((s) => String(s || '').toLowerCase());

// 空格分词 AND 匹配；空词返回原数组
export function searchMatches(threads, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return threads;
  const terms = q.split(/\s+/);
  return threads.filter((t) => {
    const hay = haystackOf(t).join('\n');
    return terms.every((term) => hay.includes(term));
  });
}

// 项目筛选：cwd 精确相等；未选项目（null/''）返回原数组；cwd 为空的会话无法归属
export function filterByProject(threads, cwd) {
  if (!cwd) return threads;
  return threads.filter((t) => t.cwd && String(t.cwd) === String(cwd));
}
