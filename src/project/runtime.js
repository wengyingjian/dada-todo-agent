// 项目任务运行时：把纯逻辑接到 Obsidian vault 与上游任务 API 上。
import { TFile, TFolder } from 'obsidian';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import {
  buildProjectIndex, normalizeRoot, projectFilePath, normalizeCwd, matchProjectByCwd
} from './index.js';
import { isArchiveFile, pickArchiveFile } from './archive.js';
import { extractDelegations, formatDelegationLine, parseDelegationLine, planDelegationInsert, T3_MARK } from './delegate-line.js';

import { queryThreads, chooseOwner, threadTitleOf, taskDateMeta, classifyWorkspace, collectUnmatched, summarizeThreadsByCwd } from './reverse-sync.js';
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
const HEAD_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function splitFile(raw) {
  const text = String(raw == null ? '' : raw);
  const m = HEAD_RE.exec(text);
  if (!m) return { head: '', lines: text.split('\n') };
  return { head: m[0], lines: text.slice(m[0].length).split('\n') };
}

export function joinFile(head, lines) {
  return String(head || '') + (lines || []).join('\n');
}

export async function readProjectLines(plugin, node) {
  if (!node || !node.filePath) return [];
  const f = plugin.app.vault.getAbstractFileByPath(node.filePath);
  if (!(f instanceof TFile)) return [];
  return splitFile(await plugin.app.vault.read(f)).lines;
}

// 委派子行按父任务行号归组
export async function loadDelegations(plugin, node) {
  const lines = await readProjectLines(plugin, node);
  const byParent = new Map();
  for (const d of extractDelegations(lines)) {
    if (!byParent.has(d.parentLine)) byParent.set(d.parentLine, []);
    byParent.get(d.parentLine).push(d);
  }
  return byParent;
}

const PROJECT_HEAD = (cwd) => `---\ntype: project\ntags: [todoList]\nstatus: active\n${cwd ? `cwd: ${cwd}\n` : ''}---\n\n`;

export async function ensureProjectFile(plugin, node) {
  if (node.filePath) return node.filePath;
  const path = projectFilePath(node.dirPath);
  const folder = node.dirPath;
  await ensureFolder(plugin, folder);
  const cwd = normalizeCwd(node.ownCwd || '');
  await plugin.app.vault.create(path, PROJECT_HEAD(cwd));
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
  await plugin.app.vault.create(path, PROJECT_HEAD(''));
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
  const oldFile = plugin.app.vault.getAbstractFileByPath(`${newDir}/task-${node.name}.md`);
  if (oldFile instanceof TFile) {
    await plugin.app.fileManager.renameFile(oldFile, `${newDir}/task-${n}.md`);
  }
  return { ok: true, dirPath: newDir };
}

export async function setProjectCwd(plugin, node, cwd) {
  await ensureProjectFile(plugin, node);
  const f = plugin.app.vault.getAbstractFileByPath(node.filePath);
  if (!(f instanceof TFile)) return { ok: false };
  const v = normalizeCwd(cwd);
  await plugin.app.fileManager.processFrontMatter(f, (fm) => {
    if (v) fm.cwd = v; else delete fm.cwd;
    fm.type = 'project';
    if (!fm.tags) fm.tags = ['todoList'];
  });
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
  const srcFile = plugin.app.vault.getAbstractFileByPath(node.filePath);
  if (!(srcFile instanceof TFile)) return { ok: false, reason: 'no_file' };
  const { head, lines } = splitFile(await plugin.app.vault.read(srcFile));
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
      siblings.push({ path: child.path, lines: splitFile(await plugin.app.vault.read(child)).lines });
    }
  }
  const dates = blocks
    .flatMap((b) => lines.slice(b.start, b.end))
    .flatMap((l) => l.match(/\d{4}-\d{2}-\d{2}/g) || []);
  if (!dates.length) dates.push(new Date().toISOString().slice(0, 10));

  const pick = pickArchiveFile(siblings, dates, node.dirPath);
  let archiveRaw;
  const archiveFile = plugin.app.vault.getAbstractFileByPath(pick.path);
  if (archiveFile instanceof TFile) {
    archiveRaw = String(await plugin.app.vault.read(archiveFile));
    const text = archiveRaw.replace(/\s+$/, '') + '\n\n' + movedLines.join('\n') + '\n';
    await plugin.app.vault.modify(archiveFile, text);
  } else {
    await plugin.app.vault.create(pick.path, '# 归档\n\n' + movedLines.join('\n') + '\n');
  }
  await plugin.app.vault.modify(srcFile, joinFile(head, kept).replace(/\s+$/, '') + '\n');
  return { ok: true, moved: blocks.length, archivePath: pick.path };
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
  const file = plugin.app.vault.getAbstractFileByPath(node.filePath);
  if (!(file instanceof TFile)) return { ok: false };
  const { head, lines } = splitFile(await plugin.app.vault.read(file));
  // 子行紧贴任务行；任务行与后续内容之间的空行删除（否则层级断开，
  // 典型如 createChecklistTask 建父任务后 body 尾部的 \n 空串）
  const { at, removeEmpty } = planDelegationInsert(lines, parentLineNo);
  const line = formatDelegationLine(delegate);
  lines.splice(at, removeEmpty, line);
  await plugin.app.vault.modify(file, joinFile(head, lines));
  return { ok: true, lineNo: at };
}

export async function updateDelegation(plugin, filePath, threadId, patch) {
  const file = plugin.app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return { ok: false };
  const { head, lines } = splitFile(await plugin.app.vault.read(file));
  for (let i = 0; i < lines.length; i++) {
    const d = parseDelegationLine(lines[i]);
    if (!d || d.threadId !== threadId) continue;
    lines[i] = formatDelegationLine({
      state: patch.state || d.state,
      summary: patch.summary != null ? patch.summary : d.summary,
      threadId,
      indent: d.indent
    });
    await plugin.app.vault.modify(file, joinFile(head, lines));
    return { ok: true, lineNo: i };
  }
  return { ok: false, reason: 'not_found' };
}

// 扫描所有项目文件 + 日记，建立 threadId → 位置 的映射（md 是真相源）
export async function rebuildDelegationMap(plugin) {
  const map = new Map();
  const root = rootOf(plugin);
  // 项目文件 + 日记：回传到日记的会话也要能持续更新状态
  const journal = String((plugin.settings && plugin.settings.journalFolder) || '/')
    .trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const inScope = (p) => {
    if (root && (p === root || p.startsWith(root + '/'))) return true;
    if (!journal) return true; // 日记文件夹为库根 → 全库
    return p === journal || p.startsWith(journal + '/');
  };
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    if (!inScope(f.path)) continue;
    const lines = splitFile(await plugin.app.vault.read(f)).lines;
    for (const d of extractDelegations(lines)) {
      if (!d.threadId) continue;
      const entry = { filePath: f.path, lineNo: d.line, parentLine: d.parentLine, state: d.state, summary: d.summary, summarizedPromptCount: d.summarizedPromptCount };
      const prev = map.get(d.threadId);
      // 同一会话出现多行（历史误回填/复制）：全部保留，map 值为数组；单行时也统一为数组形态
      if (prev) prev.push(entry);
      else map.set(d.threadId, [entry]);
    }
  }
  return map;
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

// 一次扫描：回传未绑定会话 + 更新已绑定会话的状态
export async function syncOnce(plugin) {
  const s = projectSettings(plugin);
  if (!s.reverseSync) return { created: 0, updated: 0 };
  const since = Math.max(Number(s.syncSince) || 0, Date.now() - 24 * 3600 * 1000);
  const threads = await queryThreads(t3DbPath(), since).catch(() => []);
  if (!threads.length) return { created: 0, updated: 0 };

  const idx = scanProjects(plugin);
  const map = await rebuildDelegationMap(plugin);
  const ignored = new Set((plugin.settings && plugin.settings.projectIgnoredThreads) || []);
  const ignoredWorkspaces = (plugin.settings && plugin.settings.projectIgnoredWorkspaces) || [];
  // 本轮扫到的未知工作区（cwd → 会话数）：同步结束后弹窗提醒
  const unmatched = new Map();
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
      // 同一会话可能有多条委派行（历史误回填/复制），每行独立处理：
      // 状态统一到最新；再总结只处理「#count 落后」的行，完成后该行不再命中门槛
      let newest = locs[0];
      for (const loc of locs) {
        if ((loc.summarizedPromptCount || 0) > (newest.summarizedPromptCount || 0)) newest = loc;
        if (t.state && t.state !== loc.state) {
          const r = await updateDelegation(plugin, loc.filePath, t.threadId, { state: t.state });
          if (r.ok) updated += 1;
        }
        // LLM 总结配置齐全时，按「静默 + #count 计数变化」双门槛重新总结已绑定会话
        if (s.summaryLlmBaseUrl && s.summaryLlmApiKey && s.summaryLlmModel) {
          const fresh = await resummarizeIfNeeded(plugin, t, loc, s);
          if (fresh) updated += 1;
        }
      }
      // 绑定在日记（项目根之外）的会话：其 cwd 同样是「未知工作区」，收集提醒。
      // 只提醒（决定之后的归属），不搬动已落日记的任务行
      if (s.unmatchedPrompt !== false && t.cwd) {
        const inProject = locs.some((loc) => {
          const dir = String(loc.filePath || '').replace(/\/[^/]*$/, '');
          return dir === rootOf(plugin) || dir.startsWith(rootOf(plugin) + '/');
        });
        if (!inProject) unmatched.set(t.cwd, (unmatched.get(t.cwd) || 0) + 1);
      }
      void newest;
      continue;
    }
    if (ignored.has(t.threadId)) continue;
    if (now - t.createdAt < minAge) continue;

    const cls = classifyWorkspace(t.cwd, idx.nodes, ignoredWorkspaces);
    if (cls.type === 'ignored') continue;
    let filePath;
    let dirPath;
    if (cls.type === 'project') {
      await ensureProjectFile(plugin, cls.node);
      filePath = cls.node.filePath;
      dirPath = cls.node.dirPath;
    } else {
      // 未知工作区：弹窗提醒（每个 cwd 只提一次，见 collectUnmatched），本轮仍写当天日记兜底
      if (s.unmatchedPrompt !== false && t.cwd) unmatched.set(t.cwd, (unmatched.get(t.cwd) || 0) + 1);
      filePath = journalPathFor(plugin, todayKeyLocal());
      if (!filePath) continue;
      dirPath = filePath.split('/').slice(0, -1).join('/');
    }
    const key = 'cl:' + filePath.replace(/\.md$/i, '');
    const meta = taskDateMeta(t);
    const r = unwrap(await API.createChecklistTask(key, '', { summary: `${meta.timePrefix}${threadTitleOf(t)}${meta.dateSuffix}` }));
    if (!r || !r.ok) continue;
    await appendDelegation(plugin, { filePath, dirPath }, r.task.lineNo, {
      state: t.state || 'running',
      summary: summaryOfThread(t, maxChars),
      threadId: t.threadId
    });
    created += 1;
  }
  // 未知工作区提醒：回调弹窗由 main 层注入，runtime 不碰 Obsidian UI；失败不影响同步结果
  if (unmatched.size && typeof plugin.onUnmatchedWorkspaces === 'function') {
    try { plugin.onUnmatchedWorkspaces(Array.from(unmatched, ([cwd, count]) => ({ cwd, count }))); } catch { /* 提醒失败不阻塞 */ }
  }
  return { created, updated };
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
  const file = plugin.app.vault.getAbstractFileByPath(loc.filePath);
  if (!(file instanceof TFile)) return false;
  const { head, lines } = splitFile(await plugin.app.vault.read(file));
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
  await plugin.app.vault.modify(file, joinFile(head, lines));
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
export async function importThreadsToProject(plugin, node) {
  if (!node || !node.dirPath) return { imported: 0, skipped: 0, reason: 'no_node' };
  await ensureProjectFile(plugin, node);
  const s = projectSettings(plugin);
  const maxChars = Number(s.summaryMaxChars) || 200;
  // 全量：syncSince=0 且窗口开到库最早（buildScanSql 只按 created_at >= floor 过滤）
  const threads = await queryThreads(t3DbPath(), 0).catch(() => []);
  const map = await rebuildDelegationMap(plugin);
  const ignoredWs = (plugin.settings && plugin.settings.projectIgnoredWorkspaces) || [];
  const targetCwd = normalizeCwd(node.cwd || '');
  if (!targetCwd) return { imported: 0, skipped: 0, reason: 'no_cwd' };

  let imported = 0;
  let skipped = 0;
  for (const t of threads) {
    // 只导入 cwd 落在本项目下的会话（与同步同口径：相等或子目录）
    const c = normalizeCwd(t.cwd);
    if (!c || !(c === targetCwd || c.startsWith(targetCwd + '/'))) { skipped += 1; continue; }
    if (map.get(t.threadId)) { skipped += 1; continue; }
    const ignoredList = new Set((plugin.settings && plugin.settings.projectIgnoredThreads) || []);
    if (ignoredList.has(t.threadId)) { skipped += 1; continue; }
    for (const ig of ignoredWs) {
      const n = String(ig || '').trim().replace(/\/+$/, '');
      if (n && (c === n || c.startsWith(n + '/'))) { skipped += 1; continue; }
    }
    const key = listKeyOf(node.filePath);
    const meta = taskDateMeta(t);
    const r = unwrap(await API.createChecklistTask(key, '', { summary: `${meta.timePrefix}${threadTitleOf(t)}${meta.dateSuffix}` }));
    if (!r || !r.ok) { skipped += 1; continue; }
    await appendDelegation(plugin, node, r.task.lineNo, {
      state: t.state || 'completed',
      summary: summaryOfThread(t, maxChars),
      threadId: t.threadId
    });
    imported += 1;
  }
  return { imported, skipped };
}

// 搬回：把绑定在本项目 cwd 会话、却落在项目文件之外的委派块（典型是日记兜底）整体
// 剪切进项目任务文件——父任务行 + 子行 + 总结描述行一起搬，日记里删干净。
// 返回 { moved, files: [被清理的文件路径] }
export async function moveDelegationsToProject(plugin, node) {
  if (!node || !node.filePath) return { moved: 0, files: [], reason: 'no_node' };
  const targetCwd = normalizeCwd(node.cwd || '');
  if (!targetCwd) return { moved: 0, files: [], reason: 'no_cwd' };

  // cwd → threadId 集合（全量查一次）
  const threads = await queryThreads(t3DbPath(), 0).catch(() => []);
  const wanted = new Set(threads
    .filter((t) => {
      const c = normalizeCwd(t.cwd);
      return c && (c === targetCwd || c.startsWith(targetCwd + '/'));
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
    const f = plugin.app.vault.getAbstractFileByPath(srcPath);
    if (!(f instanceof TFile)) continue;
    const { head, lines } = splitFile(await plugin.app.vault.read(f));
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
    await plugin.app.vault.modify(f, joinFile(head, kept).replace(/\s+$/, '') + '\n');
    cleanedFiles.push(srcPath);
  }
  if (!movedTargets.length) return { moved: 0, files: [] };

  // 追加到项目任务文件尾部（保留 frontmatter）
  const tf = plugin.app.vault.getAbstractFileByPath(node.filePath);
  if (!(tf instanceof TFile)) return { moved: 0, files: [], reason: 'no_file' };
  const raw = String(await plugin.app.vault.read(tf)).replace(/\s+$/, '');
  await plugin.app.vault.modify(tf, raw + '\n\n' + movedTargets.join('\n') + '\n');
  return { moved: movedTargets.filter((l) => /^- \[[ xX/-]\]/.test(l)).length, files: cleanedFiles };
}

// ---------- 未知工作区弹窗提醒 ----------

// 去重过滤（纯函数在 reverse-sync.js）；落盘与列表增删在此
export { collectUnmatched };

export async function markUnmatchedNotified(plugin, cwds) {
  const list = new Set((plugin.settings && plugin.settings.projectNotifiedWorkspaces) || []);
  for (const c of cwds || []) list.add(normalizeCwd(c));
  plugin.settings.projectNotifiedWorkspaces = Array.from(list);
  await plugin.saveData(plugin.settings);
}

export async function removeNotifiedWorkspace(plugin, cwd) {
  const target = normalizeCwd(cwd);
  const list = new Set((plugin.settings && plugin.settings.projectNotifiedWorkspaces) || []);
  list.delete(target);
  plugin.settings.projectNotifiedWorkspaces = Array.from(list);
  await plugin.saveData(plugin.settings);
}

export async function ignoreWorkspace(plugin, cwd) {
  const v = normalizeCwd(cwd);
  if (!v) return { ok: false, reason: 'empty' };
  const list = new Set((plugin.settings && plugin.settings.projectIgnoredWorkspaces) || []);
  list.add(v);
  plugin.settings.projectIgnoredWorkspaces = Array.from(list);
  await plugin.saveData(plugin.settings);
  // 忽略即不再提醒：同步清除已提醒记录
  await removeNotifiedWorkspace(plugin, v);
  return { ok: true };
}

// 「放入日记，不再提醒」：不建项目也不忽略，只是把这个 cwd 记入已提醒，
// 之后该 cwd 的会话静默走日记兜底（想重新弹提醒可在 data.json 清 projectNotifiedWorkspaces）
export async function keepJournalWorkspace(plugin, cwd) {
  await markUnmatchedNotified(plugin, [cwd]);
  return { ok: true };
}

// ---------- 手动同步（设置页入口） ----------

// 全量查 T3 库并按 cwd 汇总归属状态（unbound = 24h 窗口内且未绑定的活动会话数口径之外，
// 这里 unbound 是全库未绑定数，供手动同步弹窗展示与导入）
export async function fullSyncSummary(plugin) {
  const threads = await queryThreads(t3DbPath(), 0).catch(() => []);
  const idx = scanProjects(plugin);
  const map = await rebuildDelegationMap(plugin);
  const ignoredWs = (plugin.settings && plugin.settings.projectIgnoredWorkspaces) || [];
  const notifiedWs = new Set((plugin.settings && plugin.settings.projectNotifiedWorkspaces) || []);
  const norm = (s) => String(s || '').trim().replace(/\/+$/, '');
  const groups = summarizeThreadsByCwd(threads, idx.nodes, ignoredWs);
  // 标注每组未绑定数与「放入日记」标记（在已提醒列表且未归属项目 = journalOnly，可重置）
  for (const g of groups) {
    const target = norm(g.cwd);
    let unbound = 0;
    for (const t of threads) {
      const c = norm(t.cwd);
      if (g.cwd === '(无 cwd)') { if (!c) { if (!map.get(t.threadId)) unbound += 1; } continue; }
      if (c === target || c.startsWith(target + '/')) { if (!map.get(t.threadId)) unbound += 1; }
    }
    g.unbound = unbound;
    g.journalOnly = !g.ignored && !g.projectDir && notifiedWs.has(target);
  }
  return groups;
}

// 按节点导入 + 搬回的合并入口（手动同步与弹窗创建共用）；node 缺 cwd 时报错
export async function importAndMoveForNode(plugin, node) {
  if (!node || !normalizeCwd(node.cwd || '')) return { ok: false, reason: 'no_cwd' };
  const imp = await importThreadsToProject(plugin, node);
  const mv = await moveDelegationsToProject(plugin, node);
  return { ok: true, imported: imp.imported, moved: mv.moved };
}

export async function unignoreWorkspace(plugin, cwd) {
  const target = normalizeCwd(cwd);
  const list = new Set((plugin.settings && plugin.settings.projectIgnoredWorkspaces) || []);
  list.delete(target);
  plugin.settings.projectIgnoredWorkspaces = Array.from(list);
  await plugin.saveData(plugin.settings);
}

// 手动同步弹窗的「重置为未归属」：从忽略列表和已提醒列表都移除，
// 该 cwd 回到三选一状态（创建项目 / 放入日记 / 忽略）
export async function resetWorkspace(plugin, cwd) {
  await unignoreWorkspace(plugin, cwd);
  await removeNotifiedWorkspace(plugin, cwd);
  return { ok: true };
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
  let imported = 0;
  let moved = 0;
  if (opts.importHistory) {
    const imp = await importThreadsToProject(plugin, node);
    imported = imp.imported;
    const mv = await moveDelegationsToProject(plugin, node);
    moved = mv.moved;
  }
  return { ok: true, dirPath: r.dirPath, filePath: r.filePath, imported, moved };
}
