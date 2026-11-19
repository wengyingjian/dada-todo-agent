// 反向同步：读 T3 Code 的 statev2.sqlite（只读），把未绑定的会话回传成任务。
// 纯函数（SQL、行映射、归属）可单测；I/O 集中在 queryThreads。

import { execFile as nodeExecFile } from 'node:child_process';
import { matchProjectByCwd } from './index.js';
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
    lastAssistant: textOf(row.last_assistant_json)
  };
}

export function threadTitleOf(t) {
  const title = String(t.title || '').trim();
  if (title && title.length >= 2 && !/^placeholder$/i.test(title)) return title;
  const first = String(t.firstUser || '').replace(/\s+/g, ' ').trim();
  if (first) return first.slice(0, 40);
  return `T3 会话 ${String(t.threadId || '').replace(/-/g, '').slice(0, 6)}`;
}

export function chooseOwner(cwd, nodes) {
  const node = matchProjectByCwd(cwd, nodes);
  return node ? { type: 'project', node } : null;
}

// 归属分类：'project'（命中项目）/ 'ignored'（cwd 命中已忽略工作区，整条跳过）/ 'unknown'（无匹配）。
// 项目命中优先于忽略列表（忽略父目录时子目录仍可建项目）；忽略判断与 matchProjectByCwd
// 同口径：相等或以 `<忽略项>/` 开头（两侧都去掉尾斜杠再比）。
export function classifyWorkspace(cwd, nodes, ignored) {
  const owner = chooseOwner(cwd, nodes);
  if (owner) return owner;
  const target = String(cwd || '').trim().replace(/\/+$/, '');
  for (const ig of ignored || []) {
    const n = String(ig || '').trim().replace(/\/+$/, '');
    if (!n) continue;
    if (target === n || target.startsWith(n + '/')) return { type: 'ignored' };
  }
  return { type: 'unknown' };
}

// 未知工作区提醒的去重过滤（纯函数，落盘见 runtime.markUnmatchedNotified）：
// cwds 是 [{ cwd, count }]（count 为本轮该 cwd 的会话数，缺省 0），
// 过滤出「首次见到」的条目，返回弹窗条目 [{ cwd, name, count }] 与待记入的 newCwds
export function collectUnmatched(cwds, notified) {
  const seen = new Set(notified || []);
  const items = [];
  const newCwds = [];
  for (const raw of cwds || []) {
    const cwd = String(typeof raw === 'string' ? raw : (raw && raw.cwd) || '').trim().replace(/\/+$/, '');
    const count = (typeof raw === 'object' && raw && Number(raw.count)) || 0;
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    newCwds.push(cwd);
    items.push({ cwd, name: cwd.split('/').pop() || cwd, count });
  }
  return { items, newCwds };
}

// 全量会话按 cwd 汇总（手动同步弹窗的数据源；纯函数便于单测）。
// threads: queryThreads 全量结果；nodes: 项目索引节点；ignored: 已忽略工作区
// 返回按 cwd 前缀最长匹配归组的条目：[{ cwd, name, total, unbound, bound, ignored, projectDir }]
// cwd 空的会话归入 '(无 cwd)' 组。
export function summarizeThreadsByCwd(threads, nodes, ignored) {
  const norm = (s) => String(s || '').trim().replace(/\/+$/, '');
  const groups = new Map();
  for (const t of threads || []) {
    const cwd = norm(t.cwd) || '(无 cwd)';
    let g = groups.get(cwd);
    if (!g) { g = { cwd, name: cwd.split('/').pop() || cwd, total: 0, unbound: 0, bound: 0, ignored: false, projectDir: '' }; groups.set(cwd, g); }
    g.total += 1;
  }
  // 每组标注归属：ignored（命中忽略列表）或 projectDir（最长前缀命中的项目）
  for (const g of groups.values()) {
    if (g.cwd === '(无 cwd)') continue;
    const target = norm(g.cwd);
    let owner = null;
    for (const n of nodes || []) {
      const c = norm(n.cwd);
      if (!c) continue;
      if (target === c || target.startsWith(c + '/')) {
        if (!owner || c.length > norm(owner.cwd).length) owner = n;
      }
    }
    if (owner) g.projectDir = owner.dirPath || '';
    for (const ig of ignored || []) {
      const n = norm(ig);
      if (n && (target === n || target.startsWith(n + '/'))) { g.ignored = true; break; }
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.total - a.total);
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
