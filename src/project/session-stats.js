// 会话侧边栏顶部统计：从 queryThreads 的结果聚合今日协作时长 / 会话数 / 项目时间轴。
// 纯函数，供 sessions-view.js 渲染与单测。

// 区间并集：输入 [[起,止],...]（分钟），排序合并重叠/相邻段
export function unionSegs(segs) {
  const sorted = [...segs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length && s <= out[out.length - 1][1]) {
      const last = out[out.length - 1];
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// 分钟 → "45m" / "3h 20m" / "3h"（同 AgentDeck fmtMin）
export function fmtMin(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 60) return n + 'm';
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// 项目名：cwd 末段；无 cwd 用占位符
export function projectName(cwd) {
  const s = String(cwd || '').replace(/\/+$/, '');
  const last = s.split('/').pop();
  return last || '—';
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 把一个会话的 [firstMsgAt, lastMsgAt] 裁剪到 [dayStart, now]，转成当天分钟段。
// 起点在 now 之后、或区间完全在今天 0 点之前 → null。
function sessionSeg(t, dayStart, nowMin) {
  const first = Number(t.firstMsgAt) || 0;
  const last = Number(t.lastMsgAt) || first;
  if (!first) return null;
  const startMin = Math.max(0, Math.ceil((first - dayStart) / 60000));
  const endMin = Math.max(0, Math.floor((last - dayStart) / 60000));
  if (startMin > nowMin) return null;
  if (endMin <= 0 && startMin <= 0) return null;
  return [Math.max(0, startMin), Math.max(startMin + 1, endMin)];
}

// 当天统计（基准日由 dayStart 决定，供按天循环复用）
function statsForDay(threads, dayStart, nowMin) {
  const all = [];
  const byCwd = new Map();
  let sessions = 0;
  let prompts = 0;
  for (const t of threads || []) {
    const seg = sessionSeg(t, dayStart, nowMin);
    if (!seg) continue;
    sessions += 1;
    prompts += Number(t.promptCount) || 0;
    all.push(seg);
    const cwd = String(t.cwd || '');
    const key = cwd || '(unknown)';
    let p = byCwd.get(key);
    if (!p) {
      p = { cwd, name: cwd ? projectName(cwd) : '—', segs: [] };
      byCwd.set(key, p);
    }
    p.segs.push(seg);
  }
  const merged = unionSegs(all);
  const wall = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  const projects = [...byCwd.values()]
    .map((p) => {
      const segs = unionSegs(p.segs);
      return {
        cwd: p.cwd,
        name: p.name,
        segs,
        min: segs.reduce((sum, [a, b]) => sum + (b - a), 0)
      };
    })
    .filter((p) => p.min >= 1)
    .sort((a, b) => b.min - a.min);
  return { wall, sessions, prompts, merged, projects };
}

// 时间轴窗口：从首段活动所在整点 → 现在所在整点，至少 180 分钟
function timelineOf(merged, nowMin) {
  const nowCeil = Math.ceil(nowMin / 60) * 60;
  if (!merged.length) return { from: 0, to: Math.max(nowCeil, 180), nowMin };
  const first = Math.min(...merged.map(([s]) => s), nowMin);
  const from = Math.floor(first / 60) * 60;
  const to = Math.max(nowCeil, from + 180);
  return { from, to, nowMin };
}

// 今日统计：threads 来自 queryThreads（可能包含昨天/更早的会话，内部按天裁剪）
export function computeTodayStats(threads, nowTs) {
  const dayStart = startOfDay(nowTs);
  const nowMin = Math.max(0, Math.floor((nowTs - dayStart) / 60000));
  const { wall, sessions, prompts, merged, projects } = statsForDay(threads, dayStart, nowMin);
  return { wall, sessions, prompts, projects, timeline: timelineOf(merged, nowMin) };
}

// 「较 7 日均」：今天之前 7 天里、有用量 ≥1 分钟的天数 ≥3 才返回 { avgMin, pct }，否则 null
export function weekComparison(threads, nowTs) {
  const dayStart = startOfDay(nowTs);
  const perDay = new Map(); // dayOffset(1..7) -> minutes
  for (const t of threads || []) {
    const first = Number(t.firstMsgAt) || 0;
    const last = Number(t.lastMsgAt) || first;
    if (!first || first >= dayStart) continue;
    const seg = [[first, Math.max(first + 60000, last)]];
    for (const [s, e] of unionSegs(seg)) {
      for (let d = 1; d <= 7; d++) {
        const ds = dayStart - d * 86400000;
        const de = ds + 86400000;
        const a = Math.max(s, ds);
        const b = Math.min(e, de);
        if (b > a) perDay.set(d, (perDay.get(d) || 0) + Math.round((b - a) / 60000));
      }
    }
  }
  const days = [...perDay.values()].filter((m) => m >= 1);
  if (days.length < 3) return null;
  const avgMin = Math.round(days.reduce((x, y) => x + y, 0) / days.length);
  if (avgMin <= 0) return null;
  const { wall } = statsForDay(threads, dayStart, Math.floor((nowTs - dayStart) / 60000));
  const pct = Math.round((wall / avgMin - 1) * 100);
  return { avgMin, pct };
}
