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
       (SELECT r.status FROM orchestration_v2_projection_runs r
         WHERE r.thread_id = t.thread_id ORDER BY r.ordinal DESC LIMIT 1) AS run_status,
       (SELECT group_concat(DISTINCT q.kind) FROM orchestration_v2_projection_runtime_requests q
         WHERE q.thread_id = t.thread_id AND q.status = 'pending') AS pending_kinds,
       (SELECT m.payload_json FROM orchestration_v2_projection_messages m
         WHERE m.thread_id = t.thread_id AND m.role = 'user'
         ORDER BY m.created_at, m.message_id LIMIT 1) AS first_user_json,
       (SELECT m.payload_json FROM orchestration_v2_projection_messages m
         WHERE m.thread_id = t.thread_id AND m.role = 'assistant'
         ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS last_assistant_json
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
  const runStatus = String(row.run_status || '');
  return {
    threadId: String(row.thread_id || ''),
    title: String(row.title || ''),
    cwd: String(row.cwd || ''),
    createdAt: Date.parse(row.created_at) || 0,
    updatedAt: Date.parse(row.updated_at) || 0,
    runStatus,
    pendingKinds,
    state: stateFromRun(runStatus, pendingKinds),
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

// 只读查询：返回线程数组；任何失败都返回空数组（调用方记日志，不弹窗）
export async function queryThreads(dbPath, sinceMs, { execFile } = {}) {
  const run = execFile || nodeExecFile;
  const floor = new Date(sinceMs || Date.now() - 24 * 3600 * 1000).toISOString();
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
