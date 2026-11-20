// 项目任务运行时：把纯逻辑接到 Obsidian vault 与上游任务 API 上。
import { TFile, TFolder } from 'obsidian';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import {
  buildProjectIndex, normalizeRoot, projectFilePath, normalizeCwd
} from './index.js';
import { isArchiveFile, pickArchiveFile } from './archive.js';
import { extractDelegations, formatDelegationLine, parseDelegationLine, planDelegationInsert, T3_MARK } from './delegate-line.js';
import { groupOfState, ensureGroupHeadings, groupOfLine, isTaskLine, groupBlockLineOf, shouldMoveToGroup } from './groups.js';
import { locateSessionLine, rewriteSessionLine, stripSessionMark } from './session-line.js';

import { queryThreads, threadTitleOf, taskDateMeta, classifyWorkspace, unboundTarget, cwdInList } from './reverse-sync.js';
import { summarize, summarizeThread } from './delegate.js';
import { shouldResummarize } from './summarize-llm.js';
import { replaceSummaryInLines, locateDelegationLine } from './summarize-apply.js';
import { DEFAULT_SETTINGS, mergeProjectSettings } from './settings.js';
import * as API from '../core/api/tasks.js';

export { DEFAULT_SETTINGS };

export function projectSettings(plugin) {
  return mergeProjectSettings(plugin.settings && plugin.settings.project);
}

export function rootOf(plugin) {
  return normalizeRoot(projectSettings(plugin).projectsRoot || '任务');
}

export function listKeyOf(filePath) {
  return 'cl:' + String(filePath).replace(/\.md$/i, '');
}

export function scanProjects(plugin) {
  const root = rootOf(plugin);
  const vault = plugin.app.vault;
  const dirs = [];
  const files = [];
  let all = [];
  try { all = vault.getAllLoadedFiles(); } catch { all = []; }
  for (const f of all) {
    const p = f.path;
    if (p !== root && !p.startsWith(root + '/')) continue;
    if (f instanceof TFolder) {
      if (p !== root) dirs.push({ path: p });
    } else if (f instanceof TFile && /\.md$/i.test(p)) {
      const cache = plugin.app.metadataCache.getFileCache(f);
      files.push({ path: p, frontmatter: (cache && cache.frontmatter) || {} });
    }
  }
  return buildProjectIndex(dirs, files, {
    root,
    defaultCwd: projectSettings(plugin).projectDefaultCwd || ''
  });
}

export function nodeOf(plugin, dirPath) {
  const idx = scanProjects(plugin);
  return idx.byDir.get(dirPath) || null;
}

// 上游任务 API 统一返回 { status, body }；这里只关心 body
function unwrap(r) {
  if (!r) return {};
  return r.body && typeof r.body === 'object' ? r.body : r;
}

export async function loadProjectTasks(plugin, node) {
  if (!node || !node.filePath) return [];
  const b = unwrap(await API.loadByList(listKeyOf(node.filePath)));
  return b.ok === false ? [] : (b.items || []);
}

// 上游任务 API 的行号是「正文行号」（不含 frontmatter）。项目视图的读写一律按这个口径，
// 否则归档与委派子行会整体错位。
// 文件 IO 已收口到 core/api/tasks.js 的行级原语（readListDoc/writeListDoc/...）：
// 项目文件与清单文件共用同一套 frontmatter 切分与写路径，本模块不再直接 vault.read/modify。

export function splitFile(raw) {
  // 兼容保留（delegate.test.mjs 等单测与外部调用）：语义与 core 的 splitDoc 一致
  const text = String(raw == null ? '' : raw);
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (!m) return { head: '', lines: text.split('\n') };
  return { head: m[0], lines: text.slice(m[0].length).split('\n') };
}

export function joinFile(head, lines) {
  return String(head || '') + (lines || []).join('\n');
}

export async function readProjectLines(plugin, node) {
  if (!node || !node.filePath) return [];
  const doc = await API.readListDoc(node.filePath);
  return doc ? doc.lines : [];
}

// 委派子行按父行行号归组。
// self 行（顶层任务自带的标记 = 同步新建的单级任务）不是「挂在某个任务下的委派」，
// 否则项目视图会把任务自己当成自己的子行重复显示。
export async function loadDelegations(plugin, node) {
  const lines = await readProjectLines(plugin, node);
  const byParent = new Map();
  for (const d of extractDelegations(lines)) {
    if (d.self) continue;
    if (!byParent.has(d.parentLine)) byParent.set(d.parentLine, []);
    byParent.get(d.parentLine).push(d);
  }
  return byParent;
}

// 项目文件 frontmatter（type: project + 清单标记 + status + cwd）——与清单文件共用
// createListFile 单一出处，本模块不再维护第二套模板。
const PROJECT_FM = (cwd) => ({ type: 'project', tags: [checklistTags()[0] || 'todoList'], status: 'active', cwd: cwd || undefined });

export async function ensureProjectFile(plugin, node) {
  if (node.filePath) return node.filePath;
  const path = projectFilePath(node.dirPath);
  const cwd = normalizeCwd(node.ownCwd || '');
  const r = await API.createListFile(path, PROJECT_FM(cwd));
  if (!r.ok && r.reason !== 'exists') return null;
  node.filePath = path;
  return path;
}

async function ensureFolder(plugin, folder) {
  if (!folder) return;
  const exists = plugin.app.vault.getAbstractFileByPath(folder);
  if (exists) return;
  const parent = folder.split('/').slice(0, -1).join('/');
  if (parent) await ensureFolder(plugin, parent);
  try { await plugin.app.vault.createFolder(folder); } catch (e) { /* 并发创建 */ }
}

export async function createTask(plugin, node, summary) {
  const text = String(summary || '').trim();
  if (!text) return { ok: false, reason: 'missing_summary' };
  await ensureProjectFile(plugin, node);
  return unwrap(await API.createChecklistTask(listKeyOf(node.filePath), '', { summary: text }));
}

export async function toggleTask(plugin, task, done) {
  return unwrap(await API.toggleTask(task.guid, done));
}

export async function removeTask(plugin, task) {
  return unwrap(await API.deleteTask(task.guid));
}

export async function editTask(plugin, task, patch) {
  return unwrap(await API.updateTask(task.guid, patch));
}

export async function createProject(plugin, parentDirPath, name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, reason: 'empty' };
  if (/[\\/:*?"<>|#^[\]]/.test(n)) return { ok: false, reason: 'bad_name' };
  const root = rootOf(plugin);
  const base = parentDirPath || root;
  const dir = `${base}/${n}`;
  if (plugin.app.vault.getAbstractFileByPath(dir)) return { ok: false, reason: 'exists' };
  await ensureFolder(plugin, dir);
  const path = projectFilePath(dir);
  const r = await API.createListFile(path, PROJECT_FM(''));
  if (!r.ok && r.reason !== 'exists') return { ok: false, reason: r.reason || 'create_failed' };
  return { ok: true, dirPath: dir, filePath: path };
}

export async function renameProject(plugin, node, newName) {
  const n = String(newName || '').trim();
  if (!n) return { ok: false, reason: 'empty' };
  if (/[\\/:*?"<>|#^[\]]/.test(n)) return { ok: false, reason: 'bad_name' };
  const parent = node.dirPath.split('/').slice(0, -1).join('/');
  const newDir = `${parent}/${n}`;
  if (plugin.app.vault.getAbstractFileByPath(newDir)) return { ok: false, reason: 'exists' };
  const folder = plugin.app.vault.getAbstractFileByPath(node.dirPath);
  if (!(folder instanceof TFolder)) return { ok: false, reason: 'no_folder' };
  await plugin.app.fileManager.renameFile(folder, newDir);
  // task-*.md 重命名走核心原语（过自写标记与重名校验）
  const oldPath = `${newDir}/task-${node.name}.md`;
  if (plugin.app.vault.getAbstractFileByPath(oldPath)) {
    await API.renameListFile(oldPath, `${newDir}/task-${n}.md`);
  }
  return { ok: true, dirPath: newDir };
}

export async function setProjectCwd(plugin, node, cwd) {
  await ensureProjectFile(plugin, node);
  const v = normalizeCwd(cwd);
  const fm = await API.updateListFrontmatter(node.filePath, {
    cwd: v || undefined,
    type: 'project',
    tags: PROJECT_FM(v).tags
  });
  if (!fm) return { ok: false };
  // 设置/修改项目 cwd = 明确选择「项目」：清掉该 cwd 的日记 / 忽略记录，避免显式列表覆盖项目
  if (v && plugin.settings) {
    const s = plugin.settings;
    s.projectIgnoredWorkspaces = stripWorkspace(s.projectIgnoredWorkspaces, v);
    s.projectJournalWorkspaces = stripWorkspace(s.projectJournalWorkspaces, v);
    await plugin.saveData(s);
  }
  // 元数据缓存刷新有延迟，把结果一并返回，调用方可以立刻更新界面
  return { ok: true, cwd: v };
}

// 当天日记路径（复用上游 taskFilePath 的查找与回落逻辑）
export function journalPathFor(plugin, dateKey) {
  try { return API.taskFilePath(dateKey) || ''; } catch { return ''; }
}

// ---------- 归档 ----------

// 按顶层任务切块：返回 [{ line, start, end, guidKey }]
export function taskBlocks(lines) {
  const starts = [];
  (lines || []).forEach((line, i) => {
    if (/^- \[[ xX/-]\]/.test(line)) starts.push(i);
  });
  return starts.map((start, k) => ({
    start,
    end: k + 1 < starts.length ? starts[k + 1] : lines.length
  }));
}

export async function archiveTasks(plugin, node, lineNos) {
  const target = new Set(lineNos);
  if (!target.size) return { ok: true, moved: 0 };
  const doc = await API.readListDoc(node.filePath);
  if (!doc) return { ok: false, reason: 'no_file' };
  const { head, lines } = doc;
  const blocks = taskBlocks(lines).filter((b) => target.has(b.start));
  if (!blocks.length) return { ok: true, moved: 0 };

  const movedLines = [];
  const removed = new Set();
  for (const b of blocks) {
    for (let i = b.start; i < b.end; i++) { movedLines.push(lines[i]); removed.add(i); }
  }
  const kept = lines.filter((_, i) => !removed.has(i));

  const dir = node.dirPath;
  const folder = plugin.app.vault.getAbstractFileByPath(dir);
  const siblings = [];
  if (folder instanceof TFolder) {
    for (const child of folder.children) {
      if (!(child instanceof TFile) || !/\.md$/i.test(child.path)) continue;
      if (child.path === node.filePath) continue;
      const sib = await API.readListDoc(child.path);
      siblings.push({ path: child.path, lines: sib ? sib.lines : [] });
    }
  }
  const dates = blocks
    .flatMap((b) => lines.slice(b.start, b.end))
    .flatMap((l) => l.match(/\d{4}-\d{2}-\d{2}/g) || []);
  if (!dates.length) dates.push(new Date().toISOString().slice(0, 10));

  const pick = pickArchiveFile(siblings, dates, node.dirPath);
  const archiveDoc = await API.readListDoc(pick.path);
  if (archiveDoc) {
    // 追加到归档文件末尾：原内容去尾随空白 + 空行分隔 + 搬入块 + 结尾换行
    // （等价于旧实现的 `raw.replace(/\s+$/,'') + '\n\n' + moved + '\n'`，lines 末尾空串即结尾换行）
    await API.writeListDoc(pick.path, archiveDoc.head,
      [...trimTrailingBlank(archiveDoc.lines), '', ...movedLines, '']);
  } else {
    await API.createListFile(pick.path, {}, ['# 归档', '', ...movedLines, '']);
  }
  await API.writeListDoc(node.filePath, head, [...trimTrailingBlank(kept), '']);
  return { ok: true, moved: blocks.length, archivePath: pick.path };
}

// 去尾随空行（末尾的空串行），配合末尾补 '' 实现「以单个换行收尾」
function trimTrailingBlank(lines) {
  const out = (lines || []).slice();
  while (out.length && !String(out[out.length - 1] || '').trim()) out.pop();
  return out;
}

export async function listArchives(plugin, node) {
  const folder = plugin.app.vault.getAbstractFileByPath(node.dirPath);
  if (!(folder instanceof TFolder)) return [];
  return folder.children
    .filter((c) => c instanceof TFile && isArchiveFile(c.path))
    .map((c) => ({ path: c.path, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- 委派子行写入 ----------

export async function appendDelegation(plugin, node, parentLineNo, delegate) {
  const doc = await API.readListDoc(node.filePath);
  if (!doc) return { ok: false };
  // 子行紧贴父行下一行（中间有空行会断开列表层级）；父行下方原有空行被子行顶到后面，不删除
  const { at } = planDelegationInsert(doc.lines, parentLineNo);
  const line = formatDelegationLine(delegate);
  const at2 = await API.insertListLines(node.filePath, at - 1, [line]);
  if (at2 == null) return { ok: false };
  return { ok: true, lineNo: at2 };
}

// 确保项目文件的三个 ### 分组标题齐全（缺失的追加到末尾），落盘。
// 返回 true 表示文件有变更。已有任务块一律不动（老任务留在未分组区）。
async function ensureGroupHeadingsInFile(plugin, filePath) {
  const doc = await API.readListDoc(filePath);
  if (!doc) return false;
  const { lines: next, added } = ensureGroupHeadings(doc.lines);
  if (!added.length) return false;
  await API.writeListDoc(filePath, doc.head, next);
  return true;
}

// 更新一行会话记录（状态 / 标题 / 回填线程 id）。
// 按 threadId 现场定位；回填阶段可传 patch.pendingId 按占位 id 定位。
// 只替换指定字段——时间前缀与 📅/🛫 日期徽标原样保留。
export async function updateDelegation(plugin, filePath, threadId, patch = {}) {
  const doc = await API.readListDoc(filePath);
  if (!doc) return { ok: false };
  const at = locateSessionLine(doc.lines, { threadId, pendingId: patch.pendingId || '' });
  if (at < 0) return { ok: false, reason: 'not_found' };
  const next = rewriteSessionLine(doc.lines[at], {
    state: patch.state,
    title: patch.summary,
    threadId: threadId || undefined,
    summarizedPromptCount: patch.summarizedPromptCount
  });
  const r = await API.replaceListLines(filePath, at, [next]);
  if (!r) return { ok: false };
  return { ok: true, lineNo: r.lineNo };
}

// 状态跨组时把整块（父任务 + 委派子行 + 总结描述行）搬到目标分组末尾。
// 仅项目文件（task-*.md）内的行参与搬组（日记兜底行无 ### 分组概念）；未知状态不搬。
// 父行是普通列表项（用户随手写的 `- xxx`）时没有分组归属，不搬，只更新子行状态。
async function moveDelegationToGroup(plugin, loc, state) {
  const target = groupOfState(state);
  if (!target) return { ok: false, reason: 'no_group' };
  if (!/task-[^/]*\.md$/.test(String(loc.filePath || ''))) return { ok: false, reason: 'not_project' };
  // 先补齐分组标题再重新读文件定位：补标题会改变行号，定位必须基于最终内容
  await ensureGroupHeadingsInFile(plugin, loc.filePath);
  const doc = await API.readListDoc(loc.filePath);
  if (!doc) return { ok: false, reason: 'no_file' };
  const lines = doc.lines;
  // 现场重扫定位（一次同步里前面搬过块后缓存行号全部漂移，loc.lineNo/parentLine 都不可信）
  const at = locateSessionLine(lines, { threadId: loc.threadId });
  if (at < 0) return { ok: false, reason: 'not_found' };
  const blockLine = groupBlockLineOf(lines, at);
  if (blockLine < 0) return { ok: false, reason: 'no_parent_task' };
  if (groupOfLine(lines, blockLine) === target) return { ok: false, reason: 'same_group' };
  const key = 'cl:' + loc.filePath.replace(/\.md$/i, '');
  return unwrap(await API.moveChecklistTask(key, `${key}#${blockLine}`, target));
}

// 委派承载文件登记：在项目根/日记文件夹之外的普通笔记里委派时，同步也必须能找到原行。
// 记录下来后 rebuildDelegationMap 一并扫描；单次登记是幂等的。
export async function registerDelegationFile(plugin, filePath) {
  const p = String(filePath || '').trim();
  if (!p) return;
  const list = new Set((plugin.settings && plugin.settings.projectDelegationFiles) || []);
  if (list.has(p)) return;
  list.add(p);
  plugin.settings.projectDelegationFiles = Array.from(list);
  await plugin.saveData(plugin.settings);
}

// 扫描所有项目文件 + 日记 + 已登记的委派承载文件，建立 threadId → 位置 的映射（md 是真相源）。
// pending 是还没有 threadId、但有占位 id 的行：同步新建前先用它认领，避免重复建任务。
export async function scanDelegationRecords(plugin) {
  const bound = new Map();
  const pending = [];
  const root = rootOf(plugin);
  // 项目文件 + 日记：回传到日记的会话也要能持续更新状态
  const journal = String((plugin.settings && plugin.settings.journalFolder) || '/')
    .trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const extra = new Set((plugin.settings && plugin.settings.projectDelegationFiles) || []);
  const inScope = (p) => {
    if (extra.has(p)) return true;
    if (root && (p === root || p.startsWith(root + '/'))) return true;
    if (!journal) return true; // 日记文件夹为库根 → 全库
    return p === journal || p.startsWith(journal + '/');
  };
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    if (!inScope(f.path)) continue;
    const doc = await API.readListDoc(f.path);
    const lines = doc ? doc.lines : [];
    for (const d of extractDelegations(lines)) {
      if (!d.threadId) {
        // 占位行：记下摘要与 pendingId，供 syncOnce 认领
        if (d.pendingId) {
          pending.push({ filePath: f.path, lineNo: d.line, parentLine: d.parentLine, self: d.self, state: d.state, summary: d.summary, pendingId: d.pendingId });
        }
        continue;
      }
      // threadId 必须带上：moveDelegationToGroup 按它现场重定位（早先缺失导致搬组永远 not_found）
      // group / movable 是扫描时的分组快照，用于幂等判「需不需要搬」，避免每轮同步白读文件
      const blockLine = groupBlockLineOf(lines, d.line);
      const entry = {
        filePath: f.path, lineNo: d.line, parentLine: d.parentLine, self: d.self,
        state: d.state, summary: d.summary, summarizedPromptCount: d.summarizedPromptCount,
        threadId: d.threadId,
        movable: blockLine >= 0,
        group: blockLine >= 0 ? groupOfLine(lines, blockLine) : ''
      };
      const prev = bound.get(d.threadId);
      // 同一会话出现多行（历史误回填/复制）：全部保留，map 值为数组；单行时也统一为数组形态
      if (prev) prev.push(entry);
      else bound.set(d.threadId, [entry]);
    }
  }
  return { bound, pending };
}

export async function rebuildDelegationMap(plugin) {
  return (await scanDelegationRecords(plugin)).bound;
}

export function hasDelegationMark(line) {
  return String(line || '').indexOf(T3_MARK) >= 0;
}

// ---------- T3 Code 数据库与反向同步 ----------

import { t3DbPath } from './t3-paths.js';
export { t3DbPath };

export function t3EnvironmentId() {
  try {
    const home = process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
    const id = fs.readFileSync(path.join(home, 'userdata', 'environment-id'), 'utf8').trim();
    return /^[0-9a-f-]{36}$/i.test(id) ? id : '';
  } catch { return ''; }
}

export function t3DeepLink(threadId) {
  const env = t3EnvironmentId();
  return env && threadId
    ? `t3code://threads/${encodeURIComponent(env)}/${encodeURIComponent(threadId)}`
    : '';
}

export function openExternal(url) {
  try {
    const { shell } = require('electron');
    if (shell && typeof shell.openExternal === 'function') { shell.openExternal(url); return true; }
  } catch { /* not electron */ }
  try {
    execFile('/usr/bin/open', [url], () => {});
    return true;
  } catch { return false; }
}

export async function recentThreads(plugin, { minutes = 1440 } = {}) {
  return queryThreads(t3DbPath(), Date.now() - minutes * 60000);
}

export function todayKeyLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function summaryOfThread(t, maxChars) {
  if (t.state === 'completed') return summarize(t.lastAssistant, maxChars) || '完成';
  if (t.state === 'failed') return summarize(t.lastAssistant, maxChars) || '失败';
  if (t.state === 'awaiting') return '等你回答…';
  return '进行中…';
}

// 占位行与线程的匹配：占位摘要就是委派 prompt 的截断文本，线程 firstUser 是同一段 prompt。
// 只有唯一命中才认领，多个候选宁可新建也不猜（避免把并发委派串到一起）。
function matchPending(pending, thread) {
  const norm = (v) => String(v || '').replace(/\s+/g, '').slice(0, 40);
  const first = norm(thread.firstUser);
  if (!first) return null;
  const hits = (pending || []).filter((p) => {
    const s = norm(p.summary);
    return s && (s === first || s.startsWith(first) || first.startsWith(s));
  });
  return hits.length === 1 ? hits[0] : null;
}

// 同步新建单级任务：一级任务行（标题已含时间/日期）+ 行尾标记，下方跟分点描述。
// 会话不是委派出去的，没有父任务可挂，所以不再建「父任务 + 委派子行」两级；
// 行尾的 ⚡ t3: 标记就是后续同步认出它的唯一凭据。
async function createThreadTask(plugin, node, { groupTitle, summary, points = [], threadId, state = 'running', promptCount = null }) {
  const r = unwrap(await API.createChecklistTask(listKeyOf(node.filePath), groupTitle, { summary }));
  if (!r || !r.ok || !r.task) return null;
  const doc = await API.readListDoc(node.filePath);
  if (!doc) return null;
  const { head, lines } = doc;
  // createChecklistTask 返回正文行号；落笔前校验它确实是任务行，行号失效时按标题兜底
  let at = Number.isInteger(r.task.lineNo) ? r.task.lineNo : -1;
  if (at < 0 || !isTaskLine(lines[at])) {
    const want = stripSessionMark(summary);
    at = lines.findIndex((l) => isTaskLine(l) && String(l).includes(want));
  }
  if (at < 0) return null;
  const head2 = rewriteSessionLine(lines[at], { state, threadId, summarizedPromptCount: promptCount });
  const desc = (points || []).map((p, i) => `  ${i + 1}. ${p}`);
  const r2 = await API.replaceListLines(node.filePath, at, [head2, ...desc]);
  if (!r2) return null;
  return { ok: true, lineNo: at };
}

// 一次扫描：回传未绑定会话 + 更新已绑定会话的状态。
// 未绑定会话只有两条去路：命中项目 → 写项目文件；显式选择放入日记 → 写当天日记。
// 忽略与未设置一律跳过（未设置的仅弹窗提醒，关闭弹窗仍保持未设置，不回传）。
export async function syncOnce(plugin) {
  const s = projectSettings(plugin);
  if (!s.reverseSync) return { created: 0, updated: 0 };
  const since = Math.max(Number(s.syncSince) || 0, Date.now() - 24 * 3600 * 1000);
  const threads = await queryThreads(t3DbPath(), since).catch(() => []);
  if (!threads.length) return { created: 0, updated: 0 };

  const idx = scanProjects(plugin);
  const { bound: map, pending } = await scanDelegationRecords(plugin);
  const ignored = new Set((plugin.settings && plugin.settings.projectIgnoredThreads) || []);
  const ignoredWorkspaces = (plugin.settings && plugin.settings.projectIgnoredWorkspaces) || [];
  // 三种归属：项目（frontmatter cwd）/ 日记 / 忽略；未记录默认忽略，不回传
  const journalWorkspaces = (plugin.settings && plugin.settings.projectJournalWorkspaces) || [];
  // 0 表示立刻同步：不能用 `|| 3`，否则 0 会被当成未设置而回落到 3 分钟
  const rawMin = Number(s.reverseSyncMinMinutes);
  const minAge = Math.max(0, Number.isFinite(rawMin) ? rawMin : 3) * 60000;
  const maxChars = Number(s.summaryMaxChars) || 200;
  const now = Date.now();
  let created = 0;
  let updated = 0;

  for (const t of threads) {
    const locs = map.get(t.threadId);
    if (locs && locs.length) {
      // 同一会话可能有多条委派行（历史误回填/复制），每行独立处理。
      for (const loc of locs) {
        const state = t.state || loc.state;
        // 先搬组、后改状态：core 的 readTasks 走 cachedRead，放在 modify 之后
        // 可能读到旧版本把刚写的状态覆盖回去；搬组后 updateDelegation 仍按 threadId 定位，不受行号漂移影响。
        // 搬组独立于状态变化：用扫描时的分组快照做幂等判断，
        // 这样「状态已是 completed 但还留在进行中」（历史搬组失败）也能在下一轮纠正。
        // 父行是普通列表项（movable=false）没有分组归属，不搬。
        if (shouldMoveToGroup({ movable: loc.movable, group: loc.group, state })) {
          await moveDelegationToGroup(plugin, loc, state);
        }
        let lineNo = loc.lineNo;
        if (t.state && t.state !== loc.state) {
          const r = await updateDelegation(plugin, loc.filePath, t.threadId, { state: t.state });
          if (r.ok) { updated += 1; lineNo = r.lineNo; }
        }
        const llm = llmConfigured(s) && workspaceLlmEnabled(plugin, t.cwd);
        // 刚结束（running/awaiting → completed/failed）：不等静默阈值，立刻总结一次，
        // 「回来的时候是什么就是什么」——原地换成 LLM 标题 + 分点描述。
        // 历史行（已是 completed 但从未写过 #count）同样立即补，否则要白等 30 分钟静默门槛。
        const done = state === 'completed' || state === 'failed';
        const justFinished = done && loc.state !== state;
        const neverSummarized = done && loc.summarizedPromptCount == null && Number(t.promptCount) > 0;
        if (justFinished || neverSummarized) {
          if (llm) {
            try {
              const sum = await summarizeThread(plugin, { threadId: t.threadId, dbPath: t3DbPath(), settings: s });
              if (sum) {
                const r2 = await applySummaryAtLine(plugin, { filePath: loc.filePath }, lineNo, {
                  state, threadId: t.threadId, summarizedPromptCount: sum.promptCount,
                  title: sum.title, points: sum.points
                });
                if (r2 && r2.ok) updated += 1;
              }
            } catch { /* 保留现状，静默重总结随后补 */ }
          }
        } else if (llm) {
          // 完成后又有新对话：静默 + #count 增量双门槛重总结
          const fresh = await resummarizeIfNeeded(plugin, t, loc, s);
          if (fresh) updated += 1;
        }
      }
      continue;
    }
    if (ignored.has(t.threadId)) continue;

    // 文件里已有占位行（还没回填 threadId）：先认领，绝不新建重复任务。
    // 委派发生在任意笔记里都可能，认领不看 cwd 归属，也不受最小年龄限制。
    const hit = matchPending(pending, t);
    if (hit) {
      const state = t.state || 'running';
      const r = await updateDelegation(plugin, hit.filePath, t.threadId, {
        pendingId: hit.pendingId,
        state,
        summary: state === 'running' || state === 'awaiting' ? undefined : summaryOfThread(t, maxChars)
      });
      if (r.ok) {
        updated += 1;
        pending.splice(pending.indexOf(hit), 1);
        await moveDelegationToGroup(plugin, { filePath: hit.filePath, threadId: t.threadId }, state);
        // 已完成/失败：立即用 LLM 标题+分点替换占位摘要（配置齐全且该工作区启用 LLM 时）
        if ((state === 'completed' || state === 'failed') && llmConfigured(s) && workspaceLlmEnabled(plugin, t.cwd)) {
          try {
            const sum = await summarizeThread(plugin, { threadId: t.threadId, dbPath: t3DbPath(), settings: s });
            if (sum) {
              await applySummaryAtLine(plugin, { filePath: hit.filePath }, r.lineNo, {
                state, threadId: t.threadId, summarizedPromptCount: sum.promptCount,
                title: sum.title, points: sum.points
              });
            }
          } catch { /* 保留占位摘要，之后静默重总结再补 */ }
        }
      }
      continue;
    }

    if (now - t.createdAt < minAge) continue;

    const cls = classifyWorkspace(t.cwd, idx.nodes, ignoredWorkspaces, journalWorkspaces);
    const target = unboundTarget(cls);
    // 忽略（含未记录 cwd 的默认忽略）不进入任何文件
    if (target === 'skip') continue;
    let filePath;
    let groupTitle = '';
    if (target === 'project') {
      await ensureProjectFile(plugin, cls.node);
      filePath = cls.node.filePath;
      // 分组写入：先补齐 ### 标题（createChecklistTask 对缺失分组返回 404），按状态入组
      await ensureGroupHeadingsInFile(plugin, filePath);
      groupTitle = groupOfState(t.state);
    } else {
      // 明确放入日记：写当天日记
      filePath = journalPathFor(plugin, todayKeyLocal());
      if (!filePath) continue;
    }
    const meta = taskDateMeta(t);
    const state = t.state || 'running';
    // 已结束的新会话：同步取 LLM 标题+分点，任务名直接用它；running 先用线程标题，
    // 完成后由已绑定路径的静默重总结补上。
    let sum = null;
    if ((state === 'completed' || state === 'failed') && llmConfigured(s) && workspaceLlmEnabled(plugin, t.cwd)) {
      try { sum = await summarizeThread(plugin, { threadId: t.threadId, dbPath: t3DbPath(), settings: s }); } catch { sum = null; }
    }
    const ins = await createThreadTask(plugin, { filePath }, {
      groupTitle,
      summary: `${meta.timePrefix}${sum ? sum.title : threadTitleOf(t)}${meta.dateSuffix}`,
      points: sum ? sum.points : [],
      threadId: t.threadId,
      state,
      promptCount: sum ? sum.promptCount : null
    });
    if (!ins) continue;
    created += 1;
  }
  return { created, updated };
}

function llmConfigured(s) {
  return !!(s.summaryLlmBaseUrl && s.summaryLlmApiKey && s.summaryLlmModel);
}

// 工作区级 LLM 开关：默认开，只有用户显式关闭的 cwd 才跳过 LLM。
function workspaceLlmEnabled(plugin, cwd) {
  const off = (plugin.settings && plugin.settings.projectLlmDisabledWorkspaces) || [];
  return !cwdInList(cwd, off);
}

// 再总结决策与执行：会话静默超过阈值且 user prompt 计数相对子行 #count 有增加时，
// 取全会话重新总结并整体替换子行总结块（覆盖只留最新）。失败静默跳过，不阻塞状态更新。
export async function resummarizeIfNeeded(plugin, thread, loc, s) {
  const decision = shouldResummarize({
    state: thread.state || loc.state,
    summarizedPromptCount: loc.summarizedPromptCount,
    currentPromptCount: thread.promptCount,
    updatedAt: thread.updatedAt
  }, { silentMs: (Number(s.summarySilentMinutes) || 30) * 60000 });
  if (!decision) return false;
  const summary = await summarizeThread(plugin, {
    threadId: thread.threadId,
    dbPath: t3DbPath(),
    settings: s
  });
  if (!summary || summary.promptCount <= (loc.summarizedPromptCount || 0)) return false;
  const doc = await API.readListDoc(loc.filePath);
  if (!doc) return false;
  const { head, lines } = doc;
  // 行号漂移安全定位：按 threadId 现场扫文件，缓存行号只作回退
  const at = locateDelegationLine(lines, thread.threadId, loc.lineNo);
  if (at < 0) return false;
  const r = replaceSummaryInLines(lines, at, {
    state: thread.state || loc.state,
    threadId: thread.threadId,
    summarizedPromptCount: summary.promptCount,
    title: summary.title,
    points: summary.points
  });
  if (!r.ok) return false;
  await API.writeListDoc(loc.filePath, head, lines);
  return true;
}

export async function ignoreThread(plugin, threadId) {
  const list = new Set((plugin.settings && plugin.settings.projectIgnoredThreads) || []);
  list.add(threadId);
  plugin.settings.projectIgnoredThreads = Array.from(list);
  await plugin.saveData(plugin.settings);
}

// ---------- 历史会话导入与搬回 ----------

// 全量扫描 T3 库（不限 24 小时窗口），把属于该项目 cwd 的、尚未绑定在任何文件里的
// 会话导入为「任务 + 委派子行」。返回 { imported, skipped }。
// opts.llm 为真时逐会话调 LLM 总结（配置缺失或调用失败回落截断摘要）。
export async function importThreadsToProject(plugin, node, opts = {}) {
  if (!node || !node.dirPath) return { imported: 0, skipped: 0, reason: 'no_node' };
  await ensureProjectFile(plugin, node);
  const s = projectSettings(plugin);
  const maxChars = Number(s.summaryMaxChars) || 200;
  const useLlm = !!opts.llm && llmConfigured(s);
  // 全量：syncSince=0 且窗口开到库最早（buildScanSql 只按 created_at >= floor 过滤）
  const threads = await queryThreads(t3DbPath(), 0).catch(() => []);
  const map = await rebuildDelegationMap(plugin);
  const { ignored, journal } = workspaceLists(plugin);
  const idx = scanProjects(plugin);
  const targetCwd = normalizeCwd(node.cwd || '');
  if (!targetCwd) return { imported: 0, skipped: 0, reason: 'no_cwd' };
  const targetDir = normalizeCwd(node.dirPath);
  // 该会话是否真的归属本项目：cwd 落在项目下、且没有被更具体的显式设置覆盖
  const belongsHere = (cwd) => {
    const cls = classifyWorkspace(cwd, idx.nodes, ignored, journal);
    return cls.type === 'project' && !!cls.node && normalizeCwd(cls.node.dirPath) === targetDir;
  };

  // 分组写入：先补齐 ### 标题（createChecklistTask 对缺失分组返回 404）
  await ensureGroupHeadingsInFile(plugin, node.filePath);

  let imported = 0;
  let skipped = 0;
  for (const t of threads) {
    const c = normalizeCwd(t.cwd);
    if (!c || !(c === targetCwd || c.startsWith(targetCwd + '/')) || !belongsHere(c)) { skipped += 1; continue; }
    if (map.get(t.threadId)) { skipped += 1; continue; }
    const ignoredList = new Set((plugin.settings && plugin.settings.projectIgnoredThreads) || []);
    if (ignoredList.has(t.threadId)) { skipped += 1; continue; }
    const meta = taskDateMeta(t);
    const state = t.state || 'completed';
    // 导入是一次性手动操作：先取 LLM 标题+分点，一次成型单级任务；
    // 失败回落线程标题 + 截断摘要（仍保持「任务-描述」一级结构）。
    let sum = null;
    if (useLlm) {
      try { sum = await summarizeThread(plugin, { threadId: t.threadId, dbPath: t3DbPath(), settings: s }); } catch { sum = null; }
    }
    const ins = await createThreadTask(plugin, node, {
      groupTitle: groupOfState(state),
      summary: `${meta.timePrefix}${sum ? sum.title : threadTitleOf(t)}${meta.dateSuffix}`,
      points: sum ? sum.points : [summaryOfThread(t, maxChars)],
      threadId: t.threadId,
      state,
      promptCount: sum ? sum.promptCount : null
    });
    if (!ins) { skipped += 1; continue; }
    imported += 1;
  }
  return { imported, skipped };
}

// 把某个 cwd 的历史会话按「会话日期」写入对应日记（没有对应日记文件时由上游 API 创建）。
// 与项目导入同口径：跳过已绑定、已忽略的会话；opts.llm 控制是否逐条 LLM 总结。
export async function importThreadsToJournal(plugin, cwd, opts = {}) {
  const targetCwd = normalizeCwd(cwd);
  if (!targetCwd) return { imported: 0, skipped: 0, reason: 'no_cwd' };
  const s = projectSettings(plugin);
  const maxChars = Number(s.summaryMaxChars) || 200;
  const useLlm = !!opts.llm && llmConfigured(s);
  const threads = await queryThreads(t3DbPath(), 0).catch(() => []);
  const map = await rebuildDelegationMap(plugin);
  const ignoredThreads = new Set((plugin.settings && plugin.settings.projectIgnoredThreads) || []);
  let imported = 0;
  let skipped = 0;
  for (const t of threads) {
    const c = normalizeCwd(t.cwd);
    if (!c || !(c === targetCwd || c.startsWith(targetCwd + '/'))) continue;
    if (map.get(t.threadId) || ignoredThreads.has(t.threadId)) { skipped += 1; continue; }
    // 落到会话开始那天的日记；时间缺失时退回创建时间
    const day = todayKeyLocal(new Date(Number(t.firstMsgAt) || Number(t.createdAt) || Date.now()));
    const filePath = journalPathFor(plugin, day);
    if (!filePath) { skipped += 1; continue; }
    const meta = taskDateMeta(t);
    const state = t.state || 'completed';
    let sum = null;
    if (useLlm) {
      try { sum = await summarizeThread(plugin, { threadId: t.threadId, dbPath: t3DbPath(), settings: s }); } catch { sum = null; }
    }
    const ins = await createThreadTask(plugin, { filePath }, {
      groupTitle: '',
      summary: `${meta.timePrefix}${sum ? sum.title : threadTitleOf(t)}${meta.dateSuffix}`,
      points: sum ? sum.points : [summaryOfThread(t, maxChars)],
      threadId: t.threadId,
      state,
      promptCount: sum ? sum.promptCount : null
    });
    if (!ins) { skipped += 1; continue; }
    imported += 1;
  }
  return { imported, skipped };
}

// 把刚插入的委派占位行替换为总结块（行号可能漂移，按 threadId 现场定位）。
async function applySummaryAtLine(plugin, node, lineNo, summary) {
  const doc = await API.readListDoc(node.filePath);
  if (!doc) return { ok: false };
  const { head, lines } = doc;
  const at = locateDelegationLine(lines, summary.threadId, lineNo);
  if (at < 0) return { ok: false, reason: 'not_found' };
  // 用「替换」而不是「追加」：该行可能已有一版分点（再总结/重复触发），追加会留下残行
  const r = replaceSummaryInLines(lines, at, summary);
  if (!r.ok) return r;
  await API.writeListDoc(node.filePath, head, lines);
  return { ok: true, lineNo: at };
}

// 搬回：把绑定在本项目 cwd 会话、却落在项目文件之外的委派块（典型是日记兜底）整体
// 剪切进项目任务文件——父任务行 + 子行 + 总结描述行一起搬，日记里删干净。
// 返回 { moved, files: [被清理的文件路径] }
export async function moveDelegationsToProject(plugin, node) {
  if (!node || !node.filePath || !node.dirPath) return { moved: 0, files: [], reason: 'no_node' };
  const targetCwd = normalizeCwd(node.cwd || '');
  if (!targetCwd) return { moved: 0, files: [], reason: 'no_cwd' };
  const targetDir = normalizeCwd(node.dirPath);
  const { ignored, journal } = workspaceLists(plugin);
  const idx = scanProjects(plugin);
  const belongsHere = (cwd) => {
    const cls = classifyWorkspace(cwd, idx.nodes, ignored, journal);
    return cls.type === 'project' && !!cls.node && normalizeCwd(cls.node.dirPath) === targetDir;
  };

  // cwd → threadId 集合（全量查一次；子目录被显式切成日记/忽略的不搬）
  const threads = await queryThreads(t3DbPath(), 0).catch(() => []);
  const wanted = new Set(threads
    .filter((t) => {
      const c = normalizeCwd(t.cwd);
      return c && (c === targetCwd || c.startsWith(targetCwd + '/')) && belongsHere(c);
    })
    .map((t) => t.threadId));
  if (!wanted.size) return { moved: 0, files: [] };

  const root = rootOf(plugin);
  const inProjectRoot = (p) => p === root || p.startsWith(root + '/');
  const map = await rebuildDelegationMap(plugin);
  const filePaths = new Set();
  for (const [threadId, locs] of map.entries()) {
    if (!wanted.has(threadId)) continue;
    for (const loc of locs) {
      if (!inProjectRoot(loc.filePath)) filePaths.add(loc.filePath);
    }
  }
  if (!filePaths.size) return { moved: 0, files: [] };

  const movedTargets = [];
  const cleanedFiles = [];
  for (const srcPath of filePaths) {
    const doc = await API.readListDoc(srcPath);
    if (!doc) continue;
    const { head, lines } = doc;
    // 收集要搬的顶层任务块：块内任一行是目标 threadId 的委派子行 → 整块搬
    const blocks = taskBlocks(lines).filter((b) =>
      lines.slice(b.start, b.end).some((l) => {
        const d = parseDelegationLine(l);
        return d && d.threadId && wanted.has(d.threadId);
      }));
    if (!blocks.length) continue;
    const removed = new Set();
    for (const b of blocks) {
      for (let i = b.start; i < b.end; i++) { movedTargets.push(lines[i]); removed.add(i); }
    }
    const kept = lines.filter((_, i) => !removed.has(i));
    await API.writeListDoc(srcPath, head, [...trimTrailingBlank(kept), '']);
    cleanedFiles.push(srcPath);
  }
  if (!movedTargets.length) return { moved: 0, files: [] };

  // 追加到项目任务文件尾部（保留 frontmatter）
  const tf = await API.readListDoc(node.filePath);
  if (!tf) return { moved: 0, files: [], reason: 'no_file' };
  await API.writeListDoc(node.filePath, tf.head,
    [...trimTrailingBlank(tf.lines), '', ...movedTargets, '']);
  return { moved: movedTargets.filter((l) => /^- \[[ xX/-]\]/.test(l)).length, files: cleanedFiles };
}

// ---------- 工作区归属管理（项目 / 日记 / 忽略） ----------

function workspaceLists(plugin) {
  const s = plugin.settings || {};
  return {
    ignored: s.projectIgnoredWorkspaces || [],
    journal: s.projectJournalWorkspaces || [],
    llmOff: s.projectLlmDisabledWorkspaces || []
  };
}

// 当前工作区列表（设置页「项目」tab 的数据源）：
// T3 全量会话的 cwd + 项目自身 cwd + 显式日记/忽略条目，按 cwd 去重。
// kind 由 classifyWorkspace 统一裁定（项目最长前缀 > 日记 > 忽略，未记录默认忽略）。
export async function workspaceRows(plugin) {
  const threads = await queryThreads(t3DbPath(), 0).catch(() => []);
  const idx = scanProjects(plugin);
  const map = await rebuildDelegationMap(plugin);
  const { ignored, journal, llmOff } = workspaceLists(plugin);
  const rows = new Map();
  const ensure = (cwd) => {
    const c = normalizeCwd(cwd);
    if (!c) return null;
    let r = rows.get(c);
    if (!r) {
      r = { cwd: c, name: c.split('/').pop() || c, total: 0, unbound: 0, kind: 'ignored', projectDir: '', projectName: '', llm: true };
      rows.set(c, r);
    }
    return r;
  };
  for (const t of threads) {
    const r = ensure(t.cwd);
    if (!r) continue;
    r.total += 1;
    if (!map.get(t.threadId)) r.unbound += 1;
  }
  for (const raw of ignored) ensure(raw);
  for (const raw of journal) ensure(raw);
  // 项目即使还没有会话也列出来，便于改名 / 调整归属
  for (const n of idx.nodes) ensure(n.ownCwd);
  const out = Array.from(rows.values());
  for (const r of out) {
    const cls = classifyWorkspace(r.cwd, idx.nodes, ignored, journal);
    r.kind = cls.type;
    r.projectDir = cls.node ? cls.node.dirPath : '';
    r.projectName = cls.node ? cls.node.name : '';
    // 只有「自己拥有该 cwd」的项目才可改名；子目录继承父项目时仅展示归属
    r.ownProject = !!(cls.node && normalizeCwd(cls.node.ownCwd) === r.cwd);
    r.llm = !cwdInList(r.cwd, llmOff);
  }
  const order = { project: 0, journal: 1, ignored: 2 };
  out.sort((a, b) => (order[a.kind] - order[b.kind]) || a.cwd.localeCompare(b.cwd));
  return out;
}

function stripWorkspace(list, cwd) {
  const v = normalizeCwd(cwd);
  return (list || []).filter((x) => normalizeCwd(x) !== v);
}

function pushWorkspace(list, cwd) {
  const v = normalizeCwd(cwd);
  const set = new Set((list || []).map(normalizeCwd).filter(Boolean));
  if (v) set.add(v);
  return Array.from(set);
}

// 切换某个 cwd 的归属（三选一，自由切换）。
// - project：已有关联项目则复用；否则按 name 新建项目并写入 cwd
// - journal / ignored：解除「自己拥有该 cwd」的项目（继承型项目不动，靠最长前缀覆盖），
//   再写入对应列表，保证与另一个列表互斥
export async function setWorkspaceKind(plugin, cwd, kind, { name = '' } = {}) {
  const v = normalizeCwd(cwd);
  if (!v) return { ok: false, reason: 'empty' };
  if (!['project', 'journal', 'ignored'].includes(kind)) return { ok: false, reason: 'bad_kind' };
  const s = plugin.settings;
  const idx = scanProjects(plugin);
  const owner = idx.nodes.find((n) => normalizeCwd(n.ownCwd) === v) || null;

  if (kind === 'project') {
    if (owner) {
      // 已有关联项目：只清理互斥列表，不新建
      s.projectIgnoredWorkspaces = stripWorkspace(s.projectIgnoredWorkspaces, v);
      s.projectJournalWorkspaces = stripWorkspace(s.projectJournalWorkspaces, v);
      await plugin.saveData(s);
      return { ok: true, dirPath: owner.dirPath, already: true };
    }
    // 新建项目时由 createProjectWithCwd 统一清理互斥列表
    return createProjectWithCwd(plugin, String(name || '').trim() || v.split('/').pop() || '未命名项目', v);
  }

  // 切到日记 / 忽略：保留项目 cwd 不动（显式列表在同前缀下优先），
  // 这样切回「项目」时能复用原项目，不会重复建目录。
  s.projectIgnoredWorkspaces = stripWorkspace(s.projectIgnoredWorkspaces, v);
  s.projectJournalWorkspaces = stripWorkspace(s.projectJournalWorkspaces, v);
  if (kind === 'journal') s.projectJournalWorkspaces = pushWorkspace(s.projectJournalWorkspaces, v);
  else s.projectIgnoredWorkspaces = pushWorkspace(s.projectIgnoredWorkspaces, v);
  await plugin.saveData(s);
  return { ok: true, projectDir: owner ? owner.dirPath : '' };
}

// 按 cwd 改项目名（目录与 task-*.md 一起重命名，frontmatter cwd 不变）
export async function renameProjectByCwd(plugin, cwd, newName) {
  const v = normalizeCwd(cwd);
  const idx = scanProjects(plugin);
  // 只认「自己拥有该 cwd」的项目；子目录行（继承父项目 cwd）不能通过这里误改父项目名
  const node = idx.nodes.find((n) => normalizeCwd(n.ownCwd) === v);
  if (!node) return { ok: false, reason: 'no_project' };
  return renameProject(plugin, node, newName);
}

// 工作区级 LLM 开关（默认开；关闭写入 projectLlmDisabledWorkspaces）
export async function setWorkspaceLlm(plugin, cwd, enabled) {
  const v = normalizeCwd(cwd);
  if (!v) return { ok: false, reason: 'empty' };
  let list = (plugin.settings && plugin.settings.projectLlmDisabledWorkspaces) || [];
  list = enabled ? stripWorkspace(list, v) : pushWorkspace(list, v);
  plugin.settings.projectLlmDisabledWorkspaces = list;
  await plugin.saveData(plugin.settings);
  return { ok: true };
}

// 历史会话同步（设置页每行按钮）：项目 → 导入 + 把日记里的旧委派块搬回；
// 日记 → 按会话日期写入对应日记；忽略 → 不执行。
export async function syncWorkspaceHistory(plugin, cwd, { llm = false } = {}) {
  const v = normalizeCwd(cwd);
  const idx = scanProjects(plugin);
  const { ignored, journal } = workspaceLists(plugin);
  const cls = classifyWorkspace(v, idx.nodes, ignored, journal);
  if (cls.type === 'project') return importAndMoveForNode(plugin, cls.node, { llm });
  if (cls.type === 'journal') {
    const r = await importThreadsToJournal(plugin, v, { llm });
    return { ok: true, imported: r.imported, moved: 0 };
  }
  return { ok: false, reason: 'ignored' };
}

// 按节点导入 + 搬回的合并入口；node 缺 cwd 时报错
export async function importAndMoveForNode(plugin, node, opts = {}) {
  if (!node || !normalizeCwd(node.cwd || '')) return { ok: false, reason: 'no_cwd' };
  const imp = await importThreadsToProject(plugin, node, opts);
  const mv = await moveDelegationsToProject(plugin, node);
  return { ok: true, imported: imp.imported, moved: mv.moved };
}

// 按预设名创建项目并把 cwd 写进 frontmatter；名称冲突时自动加后缀 -2 / -3 …
// opts.importHistory 为真时：全量导入该项目 cwd 的历史会话 + 把落在日记的委派块搬回来
export async function createProjectWithCwd(plugin, name, cwd, opts = {}) {
  const root = rootOf(plugin);
  const base = String(name || '').trim() || '未命名项目';
  let dirPath = `${root}/${base}`;
  for (let i = 2; plugin.app.vault.getAbstractFileByPath(dirPath); i++) dirPath = `${root}/${base}-${i}`;
  const finalName = dirPath.split('/').pop();
  const r = await createProject(plugin, '', finalName);
  if (!r || !r.ok) return r;
  const node = nodeOf(plugin, r.dirPath);
  if (!node) return { ok: false, reason: 'no_node' };
  const cw = await setProjectCwd(plugin, node, cwd);
  if (!cw || !cw.ok) return { ok: false, reason: 'cwd_failed' };
  // 归属已确定：清掉该 cwd 的忽略 / 日记记录，避免旧列表在下次同步时抢先拦截
  const st = plugin.settings;
  st.projectIgnoredWorkspaces = stripWorkspace(st.projectIgnoredWorkspaces, cwd);
  st.projectJournalWorkspaces = stripWorkspace(st.projectJournalWorkspaces, cwd);
  await plugin.saveData(st);
  let imported = 0;
  let moved = 0;
  if (opts.importHistory) {
    const imp = await importThreadsToProject(plugin, node, { llm: !!opts.llm });
    imported = imp.imported;
    const mv = await moveDelegationsToProject(plugin, node);
    moved = mv.moved;
  }
  return { ok: true, dirPath: r.dirPath, filePath: r.filePath, imported, moved };
}
