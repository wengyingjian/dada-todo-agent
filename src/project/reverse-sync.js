// 反向同步：读 T3 Code 的 statev2.sqlite（只读），把未绑定的会话回传成任务。
// 纯函数（SQL、行映射、归属）可单测；I/O 集中在 queryThreads。

import { execFile as nodeExecFile } from 'node:child_process';
import { matchProjectByCwd, normalizeCwd } from './index.js';
import { stateFromRun } from './delegate-line.js';

export const T3_SESSION_FILTER = "t.thread_id NOT LIKE 'import:%' AND t.thread_id NOT LIKE 'thread:provider:%'";
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function buildScanSql(floorIso) {
  return `
SELECT t.thread_id, t.title, t.created_at, t.updated_at,
       coalesce(p.workspace_root,'') AS cwd,
       -- 与 agent-deck 同口径：任一 run 在跑则 running，否则取 ordinal 最新一条
       (SELECT r.status FROM orchestration_v2_projection_runs r
         WHERE r.thread_id = t.thread_id ORDER BY r.ordinal DESC LIMIT 1) AS run_status,
       (SELECT count(*) FROM orchestration_v2_projection_runs r
         WHERE r.thread_id = t.thread_id AND r.status = 'running') AS running_runs,
       (SELECT group_concat(DISTINCT q.kind) FROM orchestration_v2_projection_runtime_requests q
         WHERE q.thread_id = t.thread_id AND q.status = 'pending') AS pending_kinds,
       (SELECT m.payload_json FROM orchestration_v2_projection_messages m
         WHERE m.thread_id = t.thread_id AND m.role = 'user'
         ORDER BY m.created_at, m.message_id LIMIT 1) AS first_user_json,
       (SELECT m.payload_json FROM orchestration_v2_projection_messages m
         WHERE m.thread_id = t.thread_id AND m.role = 'assistant'
         ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS last_assistant_json,
       (SELECT min(m.created_at) FROM orchestration_v2_projection_messages m
         WHERE m.thread_id = t.thread_id) AS first_msg_at,
       (SELECT max(m.created_at) FROM orchestration_v2_projection_messages m
         WHERE m.thread_id = t.thread_id) AS last_msg_at,
       (SELECT count(*) FROM orchestration_v2_projection_messages m
         WHERE m.thread_id = t.thread_id AND m.role = 'user' AND m.streaming = 0
           AND json_extract(m.payload_json, '$.createdBy') != 'tool') AS prompt_count
FROM orchestration_v2_projection_threads t
LEFT JOIN projection_projects p ON p.project_id = t.project_id
WHERE ${T3_SESSION_FILTER}
  AND t.deleted_at IS NULL
  AND t.created_at >= ${quote(floorIso)}
ORDER BY t.updated_at DESC`;
}

function textOf(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    return String(d && d.text ? d.text : '');
  } catch { return ''; }
}

export function mapThreadRow(row) {
  const pendingKinds = String(row.pending_kinds || '').split(',').map((s) => s.trim()).filter(Boolean);
  let runStatus = String(row.run_status || '');
  // 任一 run 在跑（含排队重跑）则覆盖为 running，对齐 agent-deck 的 threadStateFromRuns
  if (Number(row.running_runs) > 0) runStatus = 'running';
  return {
    threadId: String(row.thread_id || ''),
    title: String(row.title || ''),
    cwd: String(row.cwd || ''),
    createdAt: Date.parse(row.created_at) || 0,
    updatedAt: Date.parse(row.updated_at) || 0,
    runStatus,
    pendingKinds,
    state: stateFromRun(runStatus, pendingKinds),
    promptCount: Number(row.prompt_count) || 0,
    firstUser: textOf(row.first_user_json),
    lastAssistant: textOf(row.last_assistant_json),
    firstMsgAt: Date.parse(row.first_msg_at) || 0,
    lastMsgAt: Date.parse(row.last_msg_at) || 0
  };
}

export function threadTitleOf(t) {
  const title = String(t.title || '').trim();
  if (title && title.length >= 2 && !/^placeholder$/i.test(title)) return title;
  const first = String(t.firstUser || '').replace(/\s+/g, ' ').trim();
  if (first) return first.slice(0, 40);
  return `T3 会话 ${String(t.threadId || '').replace(/-/g, '').slice(0, 6)}`;
}

// 任务行日期片段（dada-todo 口径）：
// 跨天（或时间缺失）→ `🛫 <开始日期> `（如有结束日期再加 `📅 <结束日期>`）
// 同天且有时段 → `HH:MM-HH:MM ` 前缀 + `📅 <当天>`
// 返回 { timePrefix, dateSuffix }；timePrefix 以单个空格结尾，dateSuffix 以空格开头
export function taskDateMeta(t) {
  const start = Number(t.firstMsgAt) || 0;
  const end = Number(t.lastMsgAt) || start;
  if (!start) return { timePrefix: '', dateSuffix: '' };
  const p = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hm = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sd = new Date(start);
  const ed = new Date(end);
  const sameDay = key(sd) === key(ed);
  if (sameDay) {
    return { timePrefix: `${hm(sd)}-${hm(ed)} `, dateSuffix: ` 📅 ${key(sd)}` };
  }
  const suffix = key(ed) !== key(sd) ? ` 📅 ${key(ed)}` : '';
  return { timePrefix: '', dateSuffix: ` 🛫 ${key(sd)}${suffix}` };
}

export function chooseOwner(cwd, nodes) {
  const node = matchProjectByCwd(cwd, nodes);
  return node ? { type: 'project', node } : null;
}

// cwd 是否命中某个归属列表（相等或以 `<项>/` 开头，最长前缀语义由调用方比较长度）
export function cwdInList(cwd, list) {
  const target = normalizeCwd(cwd);
  if (!target) return false;
  for (const raw of list || []) {
    const n = normalizeCwd(raw);
    if (!n) continue;
    if (target === n || target.startsWith(n + '/')) return true;
  }
  return false;
}

// 归属分类：只有三种——'project' / 'journal' / 'ignored'，未设置默认 'ignored'。
// 三个来源（项目 cwd、日记列表、忽略列表）按「最长前缀」竞争：更具体的设置覆盖父目录，
// 因此三个状态可以自由切换、互相覆盖。同一前缀撞车时：显式忽略 > 显式日记 > 自有项目 >
// 继承/默认 cwd 的项目。显式状态排在项目前面，切换状态时无需清空项目 cwd（避免来回切
// 产生重复项目）；反之设置项目 cwd 时会清掉显式列表（见 setProjectCwd）。
export function classifyWorkspace(cwd, nodes, ignored, journal) {
  const target = normalizeCwd(cwd);
  if (!target) return { type: 'ignored', implicit: true };
  let best = null;
  const consider = (raw, type, extra) => {
    const n = normalizeCwd(raw);
    if (!n) return;
    if (!(target === n || target.startsWith(n + '/'))) return;
    const ownProject = type === 'project' && normalizeCwd(extra && extra.ownCwd) !== '';
    const rank = type === 'ignored' ? 3 : type === 'journal' ? 2 : (ownProject ? 1 : 0);
    if (!best || n.length > best.len || (n.length === best.len && rank > best.rank)) {
      best = { len: n.length, rank, type, extra };
    }
  };
  for (const node of nodes || []) consider(node.cwd, 'project', node);
  for (const raw of ignored || []) consider(raw, 'ignored');
  for (const raw of journal || []) consider(raw, 'journal');
  if (!best) return { type: 'ignored', implicit: true };
  return best.extra ? { type: best.type, node: best.extra, implicit: false } : { type: best.type, implicit: false };
}

// 未绑定会话的去向：'project' / 'journal' 才落盘；其余（含默认忽略）一律 'skip'。
export function unboundTarget(cls) {
  if (!cls) return 'skip';
  if (cls.type === 'project') return 'project';
  if (cls.type === 'journal') return 'journal';
  return 'skip';
}

// 只读查询：返回线程数组；任何失败都返回空数组（调用方记日志，不弹窗）
export async function queryThreads(dbPath, sinceMs, { execFile } = {}) {
  const run = execFile || nodeExecFile;
  // sinceMs 为 null/undefined 才回落 24h 窗口；0 = 全量（不能写成 sinceMs ||，falsy-0 会吞掉全量语义）
  const effectiveSince = sinceMs == null ? Date.now() - 24 * 3600 * 1000 : sinceMs;
  const floor = new Date(effectiveSince).toISOString();
  return new Promise((resolve) => {
    run('sqlite3', ['-readonly', '-json', dbPath, buildScanSql(floor)], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const rows = JSON.parse(String(stdout || '[]'));
        resolve((Array.isArray(rows) ? rows : []).map(mapThreadRow).filter((t) => t.threadId));
      } catch { resolve([]); }
    });
  });
}
