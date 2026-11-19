// 对话弹窗的纯逻辑：消息归一化、回答载荷、滚动判定。
// t3_thread_read 取的是最后一页（beforePosition）而不是最早一页，页内按 position 升序；
// 这里仍统一排序一次，保证合并翻页结果时顺序稳定。不依赖 Obsidian，便于 node --test 直接跑。

const ROLE_BY_TYPE = {
  user_message: 'user',
  assistant_message: 'assistant'
};

// 活跃回合：此时发送必须排队，否则 T3 会把它当成 steer 插进当前回合。
const ACTIVE_STATUSES = new Set(['preparing', 'starting', 'running', 'waiting', 'queued']);

function emptyDraft(question) {
  return { selections: [], custom: '', ...(question && question.__draft) };
}

// newest-first → 时间正序；丢空文本和非消息项；同位置同文本去重；只留最新 limit 条。
export function normalizeMessages(items, { limit = 50 } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const role = ROLE_BY_TYPE[item && item.type];
    if (!role) continue;
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text.trim()) continue;
    const position = Number.isFinite(Number(item.position)) ? Number(item.position) : 0;
    const key = `${position}\u0000${role}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ position, role, text, runId: item.runId ?? null });
  }
  out.sort((a, b) => a.position - b.position);
  return limit >= 0 ? out.slice(-limit) : out;
}

function optionValue(option) {
  return option && option.value !== undefined && option.value !== null ? option.value : option.label;
}

// draft: { [questionId]: { selections: string[], custom: string } }
// 返回 { answers, missing }；missing 是必答但没答的问题 id。
export function buildAnswers(questions, draft = {}) {
  const answers = {};
  const missing = [];
  for (const question of questions || []) {
    const d = draft[question.id] ?? emptyDraft(question);
    const selections = Array.isArray(d.selections) ? d.selections.filter(Boolean) : [];
    const custom = String(d.custom ?? '').trim();
    const multi = question.multiSelect === true;

    let value;
    if (multi) {
      const order = new Map((question.options || []).map((o, i) => [optionValue(o), i]));
      const picked = [...new Set(selections)].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
      if (custom && !picked.includes(custom)) picked.push(custom);
      value = picked;
    } else {
      value = custom || selections[0] || '';
    }

    // T3 实际下发的提问常常不带 required；未声明时按必答处理，
    // 避免用户什么都没选就提交一个空回答。要跳过必须显式 required: false。
    const required = question.required !== false;
    const answered = multi ? value.length > 0 : value !== '';
    if (!answered && required) {
      missing.push(question.id);
      continue;
    }
    answers[question.id] = value;
  }
  return { answers, missing };
}

// 消息区距底 80px 内就算「贴底」；用户主动上翻后不再强制跟随。
export function shouldStickToBottom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

// 忙碌时 queue（当作下一轮），空闲时 auto（立即开跑）。
export function sendMode(status) {
  return ACTIVE_STATUSES.has(status) ? 'queue' : 'auto';
}
