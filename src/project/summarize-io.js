// 委派总结 I/O 层：从 T3 数据库取全会话消息（sqlite3 只读）、调用 OpenAI 兼容 LLM。
// 两个模块都通过参数注入 execFile / fetch，测试不打真库不真调网。

import { execFile as nodeExecFile } from 'node:child_process';

const T3_SESSION_FILTER = "t.thread_id NOT LIKE 'import:%' AND t.thread_id NOT LIKE 'thread:provider:%'";
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------- sqlite：全会话消息 ----------

export function buildMessagesSql(threadId) {
  return `
SELECT m.role, m.payload_json
FROM orchestration_v2_projection_messages m
JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
WHERE m.thread_id = ${quote(threadId)}
  AND m.role IN ('user','assistant')
  AND m.streaming = 0
  AND (m.role != 'user' OR json_extract(m.payload_json, '$.createdBy') = 'user')
  AND ${T3_SESSION_FILTER.replace(/t\./g, 't.')}
  AND t.deleted_at IS NULL
ORDER BY m.created_at, m.message_id`;
}

// 行 → [{ role, text, createdBy }]；解析失败的行跳过
export function mapMessageRows(rows) {
  const out = [];
  for (const row of rows || []) {
    let d = null;
    try { d = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json; } catch { /* 跳过 */ }
    if (!d || typeof d.text !== 'string') continue;
    out.push({ role: String(row.role), text: d.text, createdBy: d.createdBy != null ? String(d.createdBy) : null });
  }
  return out;
}

// 只读查询全部消息；任何失败返回空数组（调用方回退到截断行为，不弹窗）
export async function fetchThreadMessages(dbPath, threadId, { execFile } = {}) {
  const run = execFile || nodeExecFile;
  return new Promise((resolve) => {
    run('sqlite3', ['-readonly', '-json', dbPath, buildMessagesSql(threadId)], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const rows = JSON.parse(String(stdout || '[]'));
        resolve(mapMessageRows(Array.isArray(rows) ? rows : []));
      } catch { resolve([]); }
    });
  });
}
