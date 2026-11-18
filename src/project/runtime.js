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
import { extractDelegations, formatDelegationLine, parseDelegationLine, T3_MARK } from './delegate-line.js';
import { queryThreads, chooseOwner, threadTitleOf } from './reverse-sync.js';
import { summarize } from './delegate.js';
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

export async function loadProjectTasks(plugin, node) {
  if (!node || !node.filePath) return [];
  const r = await API.loadByList(listKeyOf(node.filePath));
  return r && r.ok ? r.items : [];
}

export async function readProjectLines(plugin, node) {
  if (!node || !node.filePath) return [];
  const f = plugin.app.vault.getAbstractFileByPath(node.filePath);
  if (!(f instanceof TFile)) return [];
  return String(await plugin.app.vault.read(f)).split('\n');
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
  return API.createChecklistTask(listKeyOf(node.filePath), '', { summary: text });
}

export async function toggleTask(plugin, task, done) {
  return API.toggleTask(task.guid, done);
}

export async function removeTask(plugin, task) {
  return API.deleteTask(task.guid);
}

export async function editTask(plugin, task, patch) {
  return API.updateTask(task.guid, patch);
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
  await plugin.app.fileManager.processFrontMatter(f, (fm) => {
    const v = normalizeCwd(cwd);
    if (v) fm.cwd = v; else delete fm.cwd;
    fm.type = 'project';
    if (!fm.tags) fm.tags = ['todoList'];
  });
  return { ok: true };
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
  const raw = String(await plugin.app.vault.read(srcFile));
  const lines = raw.split('\n');
  const blocks = taskBlocks(lines).filter((b) => target.has(b.start));
  if (!blocks.length) return { ok: true, moved: 0 };

  const movedLines = [];
  const removed = new Set();
  for (const b of blocks) {
    for (let i = b.start; i < b.end; i++) { movedLines.push(lines[i]); removed.add(i); }
  }
  const kept = lines.filter((_, i) => !removed.has(i)).join('\n');

  const dir = node.dirPath;
  const folder = plugin.app.vault.getAbstractFileByPath(dir);
  const siblings = [];
  if (folder instanceof TFolder) {
    for (const child of folder.children) {
      if (!(child instanceof TFile) || !/\.md$/i.test(child.path)) continue;
      if (child.path === node.filePath) continue;
      siblings.push({ path: child.path, lines: String(await plugin.app.vault.read(child)).split('\n') });
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
  await plugin.app.vault.modify(srcFile, kept.replace(/\s+$/, '') + '\n');
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
  const lines = String(await plugin.app.vault.read(file)).split('\n');
  let insertAt = parentLineNo + 1;
  while (insertAt < lines.length && /^\s*$/.test(lines[insertAt])) insertAt++;
  const line = formatDelegationLine(delegate);
  lines.splice(insertAt, 0, line);
  await plugin.app.vault.modify(file, lines.join('\n'));
  return { ok: true, lineNo: insertAt };
}

export async function updateDelegation(plugin, filePath, threadId, patch) {
  const file = plugin.app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return { ok: false };
  const lines = String(await plugin.app.vault.read(file)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const d = parseDelegationLine(lines[i]);
    if (!d || d.threadId !== threadId) continue;
    lines[i] = formatDelegationLine({
      state: patch.state || d.state,
      summary: patch.summary != null ? patch.summary : d.summary,
      threadId,
      indent: d.indent
    });
    await plugin.app.vault.modify(file, lines.join('\n'));
    return { ok: true, lineNo: i };
  }
  return { ok: false, reason: 'not_found' };
}

// 扫描所有项目文件 + 日记，建立 threadId → 位置 的映射（md 是真相源）
export async function rebuildDelegationMap(plugin) {
  const map = new Map();
  const root = rootOf(plugin);
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    if (f.path !== root && !f.path.startsWith(root + '/')) continue;
    const lines = String(await plugin.app.vault.read(f)).split('\n');
    for (const d of extractDelegations(lines)) {
      if (!d.threadId) continue;
      map.set(d.threadId, { filePath: f.path, lineNo: d.line, parentLine: d.parentLine, state: d.state, summary: d.summary });
    }
  }
  return map;
}

export function hasDelegationMark(line) {
  return String(line || '').indexOf(T3_MARK) >= 0;
}

// ---------- T3 Code 数据库与反向同步 ----------

export function t3DbPath() {
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
  return path.join(home, 'userdata', 'statev2.sqlite');
}

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
  const minAge = Math.max(0, Number(s.reverseSyncMinMinutes) || 3) * 60000;
  const maxChars = Number(s.summaryMaxChars) || 200;
  const now = Date.now();
  let created = 0;
  let updated = 0;

  for (const t of threads) {
    const loc = map.get(t.threadId);
    if (loc) {
      if (t.state && t.state !== loc.state) {
        const r = await updateDelegation(plugin, loc.filePath, t.threadId, { state: t.state });
        if (r.ok) updated += 1;
      }
      continue;
    }
    if (ignored.has(t.threadId)) continue;
    if (now - t.createdAt < minAge) continue;

    const owner = chooseOwner(t.cwd, idx.nodes);
    let filePath;
    let dirPath;
    if (owner) {
      await ensureProjectFile(plugin, owner.node);
      filePath = owner.node.filePath;
      dirPath = owner.node.dirPath;
    } else {
      filePath = journalPathFor(plugin, todayKeyLocal());
      if (!filePath) continue;
      dirPath = filePath.split('/').slice(0, -1).join('/');
    }
    const key = 'cl:' + filePath.replace(/\.md$/i, '');
    const r = await API.createChecklistTask(key, '', { summary: threadTitleOf(t) });
    if (!r || !r.ok) continue;
    await appendDelegation(plugin, { filePath, dirPath }, r.task.lineNo, {
      state: t.state || 'running',
      summary: summaryOfThread(t, maxChars),
      threadId: t.threadId
    });
    created += 1;
  }
  return { created, updated };
}

export async function ignoreThread(plugin, threadId) {
  const list = new Set((plugin.settings && plugin.settings.projectIgnoredThreads) || []);
  list.add(threadId);
  plugin.settings.projectIgnoredThreads = Array.from(list);
  await plugin.saveData(plugin.settings);
}
