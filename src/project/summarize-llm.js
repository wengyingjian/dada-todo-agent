// 委派总结 LLM 模块：把 T3 会话 transcript 交给 OpenAI 兼容 LLM，
// 产出「一句话标题 + 1234 分点描述」。纯函数集中在此，便于单测；
// 网络调用（callSummaryLlm）是唯一 I/O，测试外的调用方负责注入 fetch。

// ---------- 会话版本计数 ----------

// 数「真实用户发言数」：role=user、有文本、非工具注入。
// createdBy 口径：'tool' 是工具注入要滤掉；'agent' 是委派入口代发（T3 把 MCP 发起记为 agent），算真实发言；
// 缺省视为真实发言（旧数据）。
// 作为会话版本号记在子行标记 #count 上。
export function countUserPrompts(msgs) {
  return (msgs || []).filter((m) => {
    if (!m || m.role !== 'user') return false;
    if (!String(m.text || '').trim()) return false;
    if (m.createdBy === 'tool') return false;
    return true;
  }).length;
}

// ---------- transcript 组装 ----------

// msgs: [{ role: 'user'|'assistant', text, createdBy? }]
// 只保留文本消息；user 消息滤掉工具注入（createdBy === 'tool'；'agent' 代发算真实发言）。
// 超预算时从头部丢弃（保留最新对话，最新消息最重要）。
export function buildTranscript(msgs, { maxChars = 24000 } = {}) {
  const kept = (msgs || []).filter((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    if (!String(m.text || '').trim()) return false;
    if (m.role === 'user' && m.createdBy === 'tool') return false;
    return true;
  });
  const render = (m) => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.text).trim()}`;
  let out = [];
  let total = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    const line = render(kept[i]);
    if (total + line.length > maxChars && out.length) break;
    out.unshift(line);
    total += line.length;
  }
  return out.join('\n\n');
}

// ---------- prompt 构建 ----------

export function buildSummaryPrompt(delegationPrompt, transcript) {
  const system = [
    '你是任务总结助手。根据一次 AI 委派会话的完整对话记录，产出一个简明总结。',
    '输出格式（严格遵守，不要多余开场白）：',
    '标题: <一句话概括这次委派做了什么，不超过 30 字>',
    '1. <要点一>',
    '2. <要点二>',
    '...',
    '要求：分点不超过 5 点，每点一行、一句话；只总结实际完成/讨论的内容，不要臆测。'
  ].join('\n');
  const user = [
    `委派时的任务描述：${String(delegationPrompt || '').slice(0, 500)}`,
    '',
    '完整会话记录：',
    String(transcript || '')
  ].join('\n');
  return { system, user };
}

// ---------- 响应解析 ----------

// reply: LLM 原文。解析出 { title, points }；格式不符时兜底（整段当标题）。
export function parseSummaryReply(reply, { maxPoints = 5 } = {}) {
  const lines = String(reply || '').split('\n').map((s) => s.trim()).filter(Boolean);
  let title = '';
  const points = [];
  for (const line of lines) {
    const tm = /^标题[:：]\s*(.+)$/.exec(line) || /^[#*]*\s*标题\s*[:：]\s*(.+)$/.exec(line);
    if (tm && !title) { title = tm[1].trim(); continue; }
    const pm = /^\d+[.、)]\s*(.+)$/.exec(line);
    if (pm && points.length < maxPoints) points.push(pm[1].trim());
  }
  if (!title) {
    // 兜底：取第一行非分点文本当标题
    const fallback = lines.find((l) => !/^\d+[.、)]/.test(l));
    title = (fallback || lines[0] || '完成').replace(/^[#*\-\s]+/, '').slice(0, 60);
  }
  return { title, points };
}

// ---------- 再总结决策（spec：静默 30 分钟 + user prompt 计数增加） ----------

// t: { state, summarizedPromptCount, currentPromptCount, updatedAt }
// completed/failed 且会话静默超过 silentMs 且计数相对已总结版本有增加 → true
export function shouldResummarize(t, { now = Date.now(), silentMs = 30 * 60000 } = {}) {
  if (!t || (t.state !== 'completed' && t.state !== 'failed')) return false;
  const summarized = t.summarizedPromptCount;
  const current = t.currentPromptCount;
  if (!Number.isFinite(current) || current <= 0) return false;
  if (summarized != null && current <= summarized) return false;
  const updatedAt = Number(t.updatedAt) || 0;
  if (!updatedAt || now - updatedAt < silentMs) return false;
  return true;
}
