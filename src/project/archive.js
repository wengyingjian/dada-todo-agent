// 归档层：把已完成任务整块搬进同目录的 task-<起>~<止>.md，单文件上限 100 个父任务。
// 纯函数，便于单测。

export const ARCHIVE_LIMIT = 100;
const ARCHIVE_RE = /^task-(\d{4}-\d{2}-\d{2})(?:~(\d{4}-\d{2}-\d{2}))?\.md$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d) => (DATE_RE.test(String(d || '')) ? String(d) : '');

export function isArchiveFile(name) {
  return ARCHIVE_RE.test(String(name || '').split('/').pop());
}

export function parseArchiveName(name) {
  const m = ARCHIVE_RE.exec(String(name || '').split('/').pop());
  return m ? { start: m[1], end: m[2] || m[1] } : null;
}

export function archiveFileName(dates) {
  const ds = (dates || []).map(iso).filter(Boolean).sort();
  const start = ds[0] || '1970-01-01';
  const end = ds[ds.length - 1] || start;
  return start === end ? `task-${start}.md` : `task-${start}~${end}.md`;
}

// 已有区间文件纳入新任务日期后，可能扩宽；不改变文件内容，只算新文件名
export function extendArchiveRange(name, dates) {
  const cur = parseArchiveName(name);
  const all = (dates || []).map(iso).filter(Boolean);
  if (cur) all.push(cur.start, cur.end);
  if (!all.length) return name;
  all.sort();
  const start = all[0];
  const end = all[all.length - 1];
  return start === end ? `task-${start}.md` : `task-${start}~${end}.md`;
}

// 一个归档文件里「父任务」条数：只数顶层 `- [ ]`，缩进子行不算
export function countTopLevelTasks(lines) {
  let n = 0;
  for (const line of lines || []) {
    if (/^- \[[ xX/-]\]/.test(line)) n += 1;
  }
  return n;
}

// files: [{ path, lines }]（同目录下的文件与内容）
// dates: 本批要归档任务的日期（YYYY-MM-DD）
// 返回 { path, create }：create=true 表示需要新建
export function pickArchiveFile(files, dates, dirHint = '') {
  const dir = dirHint || (files.length ? String(files[0].path).split('/').slice(0, -1).join('/') : '');
  const cur = files
    .filter((f) => isArchiveFile(f.path))
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
    .pop();
  if (cur && countTopLevelTasks(cur.lines) < ARCHIVE_LIMIT) {
    return { path: cur.path, create: false };
  }
  const name = archiveFileName(dates);
  return { path: dir ? `${dir}/${name}` : name, create: true };
}
