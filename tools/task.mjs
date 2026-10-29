#!/usr/bin/env node
// Dada Todo List 的 agent 入口（CLI）。
//
// 设计：CLI 不复制插件的任务格式，而是把插件真实的 api/tasks.js 用 esbuild 打包成
// tools/dist/task-core.mjs（obsidian 模块换成 fs 版 mock），直接调用同一套读写函数。
// 因此：清单识别、分组 `###` 插入、行内日期标记、勾选/取消态、跨文件移动、命令行格式
// 与插件完全一致；改插件代码后 CLI 首次运行会自动重新打包。
//
// 不写死任何个人路径：
//   - 本文件所在仓库 = 插件仓库（路径全部由 import.meta.url 推导）
//   - 插件 id 取自仓库根 manifest.json
//   - Obsidian 库按 --vault / TASK_VAULT / Obsidian 自己的库注册表 自动发现
//
// 用法见 `task --help`；给 agent 的语义说明在 skills/task-data-todo/SKILL.md。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');
const MOCK = path.join(REPO, 'tools', 'obsidian-mock.mjs');
const ENTRY = path.join(REPO, 'tools', 'core-entry.mjs');
const DIST = path.join(REPO, 'tools', 'dist', 'task-core.mjs');
const SKILL_SRC = path.join(REPO, 'skills', 'task-data-todo', 'SKILL.md');
const SKILL_NAME = 'task-data-todo';
const INBOX = 'inbox';
const PRIORITY = { high: '🔺', medium: '🔼', low: '🔽', none: '' };
const PRIORITY_RANK = { '🔺': 3, '🔼': 2, '🔽': 1 };
const DAY = 86400000;

// 插件 id 以仓库 manifest 为准，不在代码里重复
function pluginId() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).id || 'dada-todo-list'; }
  catch { return 'dada-todo-list'; }
}

const HELP = `task — Dada Todo List 的任务入口（供 AI agent / 人使用）

用法：
  task ls [选项]                        # 查询任务（默认未完成）
  task show <任务>                      # 详情：描述 / 归属 / 子任务
  task add <标题> [选项]                # 新建任务
  task edit <任务> [选项]               # 改标题 / 描述 / 优先级 / 日期
  task status <任务> <todo|done|cancelled>
  task move <任务> [--list <清单>] [--group <分组>]
  task rm <任务> --yes                  # 删除（连同描述行与子任务）
  task sub ls <任务>                    # 列子任务
  task sub add <任务> <标题> [--desc]   # 加子任务
  task cl add <名称>                    # 新建清单
  task group add <清单|收件箱> <标题>    # 新建 ### 分组（落在文件末尾）
  task lists [--json]                   # 清单列表（名称 / key / 未完成数）
  task groups [--list <清单>]           # 某个文件的 ### 分组
  task install [选项]                   # 安装命令行 + agent skill（一次性）
  task --help

任务怎么指：<任务> 可以直接给 guid（ls --json 里的 guid），也可以给标题关键词（唯一匹配才行），
配合 --list 缩小范围。改了标题/移动后行号会漂移，所以修改类命令都带 summary/完成态校验，
对不上会返回 task_not_found 而不是改错行。

ls 选项：
  --list <清单|收件箱>        只看某清单 / 收件箱
  --group <分组标题>          只看某 ### 分组（对清单与收件箱有效）
  --status <todo|done|cancelled|all>    默认 todo
  --date <today|tomorrow|week|YYYY-MM-DD>  按截止日筛（week = 今天起 7 天）
  --done-date <同 --date 取值>  按完成日筛（查「今天完成了什么」用这个）
  --tag <标签>                按行内 #标签 筛（含子标签 tag/xxx）
  --match <关键词>            标题或描述包含即命中（不区分大小写）
  --all-levels                连子任务一起列（默认只列顶层）
  --limit <N>                 最多显示 N 条，默认 100；0 = 不限
  --sort <due|priority|line>  默认 due（先优先级后截止日）
  --json                      机器可读输出

add / edit 选项：
  --due <YYYY-MM-DD|today|tomorrow|+Nd>   截止日期（行内 📅，不建日记文件）
  --time <HH:MM|HH:MM-HH:MM>              具体时间或时间段（需配合 --due）
  --list <清单名|清单路径|收件箱>          add：写进该清单；缺省收件箱
  --group <分组标题>                       add：写进该 ### 分组；缺省「未分组」
  --priority <high|medium|low|none>        优先级（none = 清除）
  --done                                   add：直接记成已完成（写 ✅ 今天）
  --desc <文本>                            任务描述（缩进行）
  --summary <文本>                         改标题（edit）
  --clear-due                              清除截止日期（edit）
  --vault <路径>                           Obsidian 库根
  --dry-run                                只演示会写什么，不落盘
  --json                                   机器可读输出（成功 / 失败都打印 JSON）

move 选项：
  --list <清单|收件箱>        目标文件；日记任务必须给
  --group <分组标题>          目标分组；同文件内移动必须给
  --keep-date                 跨文件时保留日期（默认按拖拽语义清空日期）

库的定位（按优先级）：--vault → 环境变量 TASK_VAULT → Obsidian 当前打开的库 →
库里只有一个库时直接用。多库并存会报错并列出候选，需要显式 --vault。

install 选项：
  --bin-dir <目录>      放 task 命令的目录，默认 ~/.local/bin（或环境变量 TASK_BIN_DIR）
  --skill-dir <目录>    安装 skill 的目标目录，可重复；缺省装到已存在的
                        ~/.agents/skills、~/.dsh/skills、~/.claude/skills
  --link                技能文件用软链代替复制（改仓库里的 SKILL.md 即时生效）

说明：
  真正读写盘的是插件自己的 api/tasks.js，格式与插件内操作完全一致；Obsidian 开着时
  会在 ~500ms 后自动刷新，关着也会写进 Markdown，下次打开可见。
`;

// ---------- 参数 ----------
class CliError extends Error {
  constructor(reason, message, extra) {
    super(message || reason);
    this.reason = reason;
    this.extra = extra;
  }
}

const BOOLEAN_FLAGS = new Set([
  'json', 'dry-run', 'help', 'build', 'link', 'quiet',
  'yes', 'clear-due', 'keep-date', 'all-levels', 'done',
]);
const REPEATABLE_FLAGS = new Set(['skill-dir']);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).trim();
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    if (inline === undefined && BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
    const val = inline !== undefined ? inline : argv[++i];
    if (val == null || (inline === undefined && String(val).startsWith('--'))) {
      throw new CliError('bad_args', `参数 --${key} 缺少值`);
    }
    if (REPEATABLE_FLAGS.has(key)) (flags[key] = flags[key] || []).push(val);
    else flags[key] = val;
  }
  return { flags, pos };
}

function ok(data, text) { return { ok: true, data, text }; }

// ---------- 打包（按需） ----------
function newestMtime(dir) {
  let newest = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { const m = newestMtime(full); if (m > newest) newest = m; continue; }
    const m = fs.statSync(full).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

function ensureBundle(force) {
  const srcDir = path.join(REPO, 'src', 'core');
  const srcMtime = Math.max(
    fs.existsSync(srcDir) ? newestMtime(srcDir) : 0,
    fs.statSync(MOCK).mtimeMs,
    fs.statSync(ENTRY).mtimeMs,
  );
  const distMtime = fs.existsSync(DIST) ? fs.statSync(DIST).mtimeMs : 0;
  if (!force && distMtime > srcMtime) return;
  const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild');
  if (!fs.existsSync(esbuild)) {
    throw new CliError('no_esbuild', `找不到 esbuild：${esbuild}\n请先在插件仓库执行 npm install`);
  }
  const r = spawnSync(esbuild, [
    ENTRY, '--bundle', '--platform=node', '--format=esm',
    `--alias:obsidian=${MOCK}`, `--outfile=${DIST}`, '--log-level=warning',
  ], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) throw new CliError('bundle_failed', '打包 task-core 失败');
}

// ---------- 日期 ----------
const pad2 = (n) => String(n).padStart(2, '0');
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function fmtDay(ms) {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDue(value) {
  if (!value) return null;
  const v = String(value).trim();
  const now = new Date();
  let d = null;
  if (v === 'today') d = now;
  else if (v === 'tomorrow') d = new Date(now.getTime() + DAY);
  else if (/^\+\d{1,3}d$/.test(v)) d = new Date(now.getTime() + Number(v.slice(1, -1)) * DAY);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, day] = v.split('-').map(Number);
    d = new Date(y, m - 1, day, 12);
    if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) {
      throw new CliError('bad_date', `日期不存在：${v}`);
    }
  } else throw new CliError('bad_date', `无法识别的日期：${v}（支持 YYYY-MM-DD / today / tomorrow / +Nd）`);
  return { at: startOfDay(d), key: fmtDay(d) };
}

// 时间：HH:MM 或 HH:MM-HH:MM（跨午夜时结束时间落到次日）
function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})(?:\s*[-~]\s*(\d{1,2}):(\d{2}))?$/.exec(String(value || '').trim());
  if (!m) throw new CliError('bad_time', `无法识别的时间：${value}（用 HH:MM 或 HH:MM-HH:MM）`);
  const toOffset = (hs, ms) => {
    const h = Number(hs); const min = Number(ms);
    if (h > 23 || min > 59) throw new CliError('bad_time', `时间越界：${value}`);
    return (h * 60 + min) * 60000;
  };
  const start = toOffset(m[1], m[2]);
  const end = m[3] != null ? toOffset(m[3], m[4]) : null;
  return { start, end, endOffset: end == null ? null : (end > start ? end : end + DAY) };
}

function dateRange(value) {
  const v = String(value).trim();
  const today = startOfDay(new Date());
  if (v === 'today') return [today, today + DAY];
  if (v === 'tomorrow') return [today + DAY, today + 2 * DAY];
  if (v === 'week' || v === 'week7') return [today, today + 7 * DAY];
  const due = parseDue(v);
  return [due.at, due.at + DAY];
}

// ---------- 库定位（不写死路径） ----------
function obsidianConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'obsidian', 'obsidian.json');
}

// Obsidian 自己的库注册表：[{ path, open }]
function registryVaults() {
  try {
    const json = JSON.parse(fs.readFileSync(obsidianConfigPath(), 'utf8'));
    return Object.values(json.vaults || {})
      .filter((v) => v && typeof v.path === 'string')
      .map((v) => ({ path: v.path, open: !!v.open }));
  } catch { return []; }
}

function resolveVault(flags) {
  const explicit = flags.vault || process.env.TASK_VAULT;
  if (explicit) {
    const v = path.resolve(String(explicit));
    if (!fs.existsSync(v)) throw new CliError('no_vault', `Obsidian 库不存在：${v}`);
    return v;
  }
  const vaults = registryVaults().filter((v) => fs.existsSync(v.path));
  const opened = vaults.filter((v) => v.open).map((v) => v.path);
  if (opened.length === 1) return opened[0];
  const pool = opened.length ? opened : vaults.map((v) => v.path);
  if (pool.length === 1) return pool[0];
  if (pool.length > 1) {
    throw new CliError('ambiguous_vault', '检测到多个 Obsidian 库，请用 --vault 指定', { vaults: pool });
  }
  throw new CliError('no_vault', '未找到 Obsidian 库：用 --vault 指定，或设置环境变量 TASK_VAULT');
}

function readSettings(vault) {
  const p = path.join(vault, '.obsidian', 'plugins', pluginId(), 'data.json');
  if (!fs.existsSync(p)) {
    throw new CliError('no_settings', `该库没有 ${pluginId()} 的插件设置：${p}\n先在这个库里安装并启用 Dada Todo List，或用 --vault 换库`);
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new CliError('bad_settings', `插件设置不是合法 JSON：${p}（${e.message}）`); }
}

// ---------- 清单 / 分组 ----------
function isListKey(key) { return String(key || '').startsWith('cl:'); }

function keyLabel(key) {
  if (key === INBOX) return '收件箱';
  if (isListKey(key)) return String(key).slice(3).split('/').pop();
  return String(key);
}

function groupTitlesOf(vault, relPath) {
  const abs = path.join(vault, relPath);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

async function resolveListKey(core, value) {
  if (String(value).startsWith('cl:')) return String(value);
  const r = await core.loadChecklists();
  const items = (r.body && r.body.items) || [];
  const want = String(value).replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '');
  const hit = items.find((it) => it.key === 'cl:' + want || it.name === want);
  if (hit) return hit.key;
  throw new CliError('list_not_found', `找不到清单「${value}」`, { lists: items.map((it) => it.name) });
}

async function resolveTargetKey(core, value) {
  const v = String(value || '').trim();
  if (/^(inbox|收件箱)$/i.test(v)) return INBOX;
  return resolveListKey(core, v);
}

// 从写入前后的内容差里挑出「新增的任务行」
function addedTaskLines(before, after) {
  const count = new Map();
  for (const l of before.split('\n')) count.set(l, (count.get(l) || 0) + 1);
  const added = [];
  for (const l of after.split('\n')) {
    const n = count.get(l) || 0;
    if (n > 0) count.set(l, n - 1);
    else if (l.trim()) added.push(l);
  }
  return added;
}

// ---------- 任务读取 / 寻址 ----------
const STATUS_LABEL = { todo: '未完成', done: '已完成', cancelled: '已取消', all: '全部' };
const STATUS_TEST = {
  todo: (t) => !t.completed && !t.cancelled,
  done: (t) => t.completed && !t.cancelled,
  cancelled: (t) => !!t.cancelled,
  all: () => true,
};

function statusOf(t) {
  if (t.cancelled) return 'cancelled';
  return t.completed ? 'done' : 'todo';
}

function priorityRank(t) { return PRIORITY_RANK[t.priority] || 0; }

// 全量读取：日记 + 收件箱（loadAll），再补上每个清单（含无日期任务，loadAll 会漏掉）
async function loadTasksFor(core, flags) {
  if (flags.list != null) {
    const key = await resolveTargetKey(core, flags.list);
    const r = await core.loadByList(key);
    if (!r || r.status !== 200) {
      throw new CliError((r && r.body && r.body.reason) || 'load_failed', `读取失败：${keyLabel(key)}`);
    }
    return r.body.items || [];
  }
  const seen = new Set();
  const items = [];
  const push = (arr) => {
    for (const t of arr || []) {
      if (!seen.has(t.guid)) { seen.add(t.guid); items.push(t); }
    }
  };
  push((await core.loadAll()).body.items);
  const lists = (await core.loadChecklists()).body.items || [];
  for (const l of lists) push((await core.loadByList(l.key)).body.items);
  return items;
}

// 清单 / 收件箱里的任务 → 所属 ### 分组（日记任务没有分组概念）
async function groupMap(core, items) {
  const map = new Map();
  const keys = new Set(items.filter((t) => t.date === INBOX || isListKey(t.date)).map((t) => t.date));
  for (const key of keys) {
    const r = key === INBOX ? await core.loadInboxGroups() : await core.loadChecklistGroups(key);
    if (!r || r.status !== 200) continue;
    for (const g of (r.body.groups || [])) {
      for (const t of (g.tasks || [])) map.set(`${key}|${t.lineNo}`, g.title || '');
    }
  }
  return map;
}

// 递归展开子任务（仅 --all-levels 用；listTasks 只返回顶层，children 要单独取）
async function withSubtasks(core, items) {
  const out = items.slice();
  const queue = items.filter((t) => t.subtaskCount);
  while (queue.length) {
    const t = queue.shift();
    const r = await core.listSubtasks(t.guid);
    for (const sub of (r && r.body && r.body.items) || []) {
      out.push(sub);
      if (sub.subtaskCount) queue.push(sub);
    }
  }
  return out;
}

function viewOf(t, gmap) {
  const group = gmap ? (gmap.get(`${t.date}|${t.lineNo}`) || '') : '';
  return {
    guid: t.guid,
    summary: t.summary,
    description: t.description || '',
    status: statusOf(t),
    priority: t.priority || '',
    due: t.dueAt != null ? fmtDay(t.dueAt) : '',
    time: t.time || '',
    timeEnd: t.timeEnd || '',
    done: t.completedAt != null ? fmtDay(t.completedAt) : '',
    dueAllDay: !!t.dueAllDay,
    tags: t.tags || [],
    links: t.links || [],
    subtaskCount: t.subtaskCount || 0,
    list: { key: t.date, name: keyLabel(t.date), type: t.date === INBOX ? 'inbox' : (isListKey(t.date) ? 'checklist' : 'daily') },
    group,
    file: t.file || '',
    lineNo: t.lineNo,
  };
}

function textLine(t, gmap) {
  const mark = t.cancelled ? '-' : (t.completed ? 'x' : ' ');
  const where = t.date === INBOX ? '收件箱' : (isListKey(t.date) ? keyLabel(t.date) : `日记 ${t.date}`);
  const g = gmap ? (gmap.get(`${t.date}|${t.lineNo}`) || '') : '';
  const timeText = t.time ? (t.timeEnd ? `${t.time}-${t.timeEnd}` : t.time) : '';
  const when = t.dueAt != null
    ? `${fmtDay(t.dueAt)}${timeText ? ' ' + timeText : ''}`
    : (timeText ? `${timeText}（无日期）` : '（无日期）');
  const parts = [`[${mark}]`, when];
  if (t.priority) parts.push(t.priority);
  parts.push(`${'  '.repeat(t.indent || 0)}${t.summary}`);
  if (t.description) parts.push('…');
  parts.push(`· ${where}${g ? ' › ' + g : ''}`);
  if (t.subtaskCount) parts.push(`· 子任务 ${t.subtaskCount}`);
  parts.push(`· #${t.guid}`);
  return parts.join(' ');
}

function candidateOf(t) {
  return { guid: t.guid, summary: t.summary, due: t.dueAt != null ? fmtDay(t.dueAt) : '', status: statusOf(t), file: t.file || '', lineNo: t.lineNo };
}

function sortTasks(a, b) {
  return priorityRank(b) - priorityRank(a) || ((a.dueAt == null ? Infinity : a.dueAt) - (b.dueAt == null ? Infinity : b.dueAt)) || (a.lineNo - b.lineNo);
}

function matchTasks(items, ref, kw) {
  const key = String(ref == null ? '' : ref).trim();
  const isGuid = /^(inbox|cl:|[0-9]{4}-[0-9]{2}-[0-9]{2})#/.test(key);
  let cands;
  if (isGuid) {
    cands = items.filter((t) => t.guid === key);
  } else if (key) {
    const k = key.toLowerCase();
    cands = items.filter((t) => String(t.summary || '').toLowerCase().includes(k) || String(t.description || '').toLowerCase().includes(k));
  } else {
    cands = kw ? items.slice() : [];
  }
  if (kw) {
    const k = kw.toLowerCase();
    cands = cands.filter((t) => String(t.summary || '').toLowerCase().includes(k) || String(t.description || '').toLowerCase().includes(k));
  }
  return cands;
}

// <任务>：guid 精确匹配，否则按标题/描述关键词唯一匹配；顶层找不到时再展开子任务找一轮
async function findTask(core, out, ref, flags) {
  const items = await loadTasksFor(core, flags);
  const key = String(ref == null ? '' : ref).trim();
  const kw = flags && flags.match != null ? String(flags.match).trim() : '';
  let cands = matchTasks(items, ref, kw);
  if (!cands.length) cands = matchTasks(await withSubtasks(core, items), ref, kw);
  if (!cands.length) {
    throw new CliError('task_not_found', `找不到任务：${key || kw || '(空)'}`);
  }
  if (cands.length > 1) {
    throw new CliError('ambiguous_task', `匹配到 ${cands.length} 条任务，请给更精确的关键词或 guid`, {
      candidates: cands.slice(0, 10).map(candidateOf),
    });
  }
  return cands[0];
}

// ---------- 命令：add / lists / groups ----------
async function cmdAdd(core, { flags, pos }, out) {
  const summary = (pos.slice(1).join(' ') || flags.summary || '').trim();
  if (!summary) throw new CliError('missing_summary', '缺少任务标题：task add "标题"');
  core.boot(out.settings);

  const listKey = flags.list != null ? await resolveTargetKey(core, flags.list) : INBOX;
  const relPath = core.taskFilePath(listKey);
  if (!relPath) throw new CliError('bad_path', `无法解析目标文件（key=${listKey}）`);
  const absPath = path.join(out.vault, relPath);
  const before = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';

  const task = { summary };
  if (flags.done) task.completed = true; // 直接写已完成记录（✅ 今天）
  const due = parseDue(flags.due);
  if (due) {
    if (flags.time != null) {
      const tm = parseTime(flags.time);
      task.dueAllDay = false;
      task.dueAt = due.at + tm.start;
      if (tm.endOffset != null) task.dueEndAt = due.at + tm.endOffset;
    } else {
      task.dueAllDay = true; // 关键：否则 API 会把午夜写成 "00:00" 时间前缀
      task.dueAt = due.at;
    }
  } else if (flags.time != null) {
    throw new CliError('bad_args', '--time 需要同时给 --due');
  }
  const pKey = String(flags.priority || 'none').toLowerCase();
  if (!(pKey in PRIORITY)) throw new CliError('bad_priority', `未知优先级：${flags.priority}`);
  if (PRIORITY[pKey]) task.priority = PRIORITY[pKey];

  const group = String(flags.group || '').trim();
  const dryRun = !!flags['dry-run'];
  core.setDryRun(dryRun);
  core.takeOps();
  // 收件箱文件不存在时按插件的收件箱模板（tags: task）建，而不是日记模板
  if (listKey === INBOX) await core.ensureInboxFile();
  const r = await core.createChecklistTask(listKey, group, task);

  if (!r || r.status !== 201) {
    const reason = (r && r.body && r.body.reason) || 'unknown';
    if (reason === 'group_not_found') {
      throw new CliError('group_not_found', `「${group}」不是 ${relPath} 里的 ### 分组`, {
        groups: groupTitlesOf(out.vault, relPath),
      });
    }
    throw new CliError(reason, `创建失败：${reason}`);
  }

  // 描述：createChecklistTask 只写任务行（与插件弹窗行为一致），描述走 updateTask 落成缩进行
  const t = r.body.task;
  let warning = '';
  const desc = String(flags.desc || '').trim();
  if (desc && t && t.guid) {
    const u = await core.updateTask(t.guid, { description: desc, expectSummary: summary });
    if (!u || u.status !== 200) {
      warning = `任务已创建，但描述未写入（${(u && u.body && u.body.reason) || 'unknown'}）`;
    }
  }
  const ops = core.takeOps();

  const after = ops.length ? ops[ops.length - 1].content : before;
  const line = (addedTaskLines(before, after).find((l) => /^\s*- \[/.test(l)) || '').trim();
  const created = ops.some((o) => o.op === 'create');

  const data = {
    ok: true, cmd: 'add', dryRun,
    path: relPath,
    createdFile: created,
    list: keyLabel(listKey),
    group: group || '（未分组）',
    guid: t && t.guid,
    lineNo: t && t.lineNo,
    line,
    summary,
    warning: warning || undefined,
  };
  const text = [
    `${dryRun ? '[dry-run] 将创建' : '✅ 已创建'} → ${relPath}（${keyLabel(listKey)} · ${data.group}）`,
    line ? `   ${line}` : '',
    !dryRun && t ? `   guid: ${t.guid}` : '',
    warning ? `   ⚠ ${warning}` : '',
  ].filter(Boolean).join('\n');
  return ok(data, text);
}

async function cmdLists(core, { flags }, out) {
  core.boot(out.settings);
  const r = await core.loadChecklists();
  const items = (r.body && r.body.items) || [];
  const data = { ok: true, cmd: 'lists', count: items.length, items };
  const text = [
    ...items.map((it) => `  ${it.name}  —  未完成 ${it.total - it.done - it.cancelled}/${it.total}   key: ${it.key}`),
    items.length ? '' : '（没有清单：清单 = frontmatter tags 命中 checklistTags 的笔记）',
  ].join('\n');
  return ok(data, text);
}

async function cmdGroups(core, { flags }, out) {
  core.boot(out.settings);
  const listKey = flags.list != null ? await resolveTargetKey(core, flags.list) : INBOX;
  const relPath = core.taskFilePath(listKey);
  const groups = groupTitlesOf(out.vault, relPath);
  const data = { ok: true, cmd: 'groups', path: relPath, list: keyLabel(listKey), groups };
  const text = [
    `${relPath}（${keyLabel(listKey)}）的分组：`,
    ...groups.map((g) => `  ### ${g}`),
    groups.length ? '' : '  （无 ### 分组，任务会落在文件末尾）',
  ].join('\n');
  return ok(data, text);
}

// ---------- 命令：ls / show ----------
async function cmdLs(core, { flags }, out) {
  core.boot(out.settings);
  const status = String(flags.status || 'todo').toLowerCase();
  if (!(status in STATUS_TEST)) throw new CliError('bad_status', `未知状态：${flags.status}（todo / done / cancelled / all）`);
  let items = await loadTasksFor(core, flags);
  if (flags['all-levels']) items = await withSubtasks(core, items);
  items = items.filter(STATUS_TEST[status]);
  if (flags.date != null) {
    const [from, to] = dateRange(flags.date);
    items = items.filter((t) => t.dueAt != null && t.dueAt >= from && t.dueAt < to);
  }
  if (flags['done-date'] != null) {
    const [from, to] = dateRange(flags['done-date']);
    items = items.filter((t) => t.completedAt != null && t.completedAt >= from && t.completedAt < to);
  }
  if (flags.tag != null) {
    const tag = String(flags.tag).replace(/^#/, '');
    items = items.filter((t) => (t.tags || []).some((x) => x === tag || String(x).startsWith(tag + '/')));
  }
  if (flags.match != null) {
    const k = String(flags.match).toLowerCase();
    items = items.filter((t) => String(t.summary || '').toLowerCase().includes(k) || String(t.description || '').toLowerCase().includes(k));
  }
  if (!flags['all-levels']) items = items.filter((t) => !t.indent);
  const gmap = await groupMap(core, items);
  if (flags.group !== undefined) {
    const want = String(flags.group);
    items = items.filter((t) => (gmap.get(`${t.date}|${t.lineNo}`) || '') === want);
  }
  const sortBy = String(flags.sort || 'due');
  const sorted = items.slice().sort((a, b) => {
    if (sortBy === 'priority') return priorityRank(b) - priorityRank(a) || (a.lineNo - b.lineNo);
    if (sortBy === 'line') return a.lineNo - b.lineNo;
    return sortTasks(a, b);
  });
  const limit = flags.limit != null ? Math.max(0, Number(flags.limit) || 0) : 100;
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const data = {
    ok: true, cmd: 'ls', total: sorted.length, shown: shown.length,
    filters: {
      list: flags.list != null ? String(flags.list) : '',
      group: flags.group != null ? String(flags.group) : '',
      status, date: flags.date != null ? String(flags.date) : '',
      doneDate: flags['done-date'] != null ? String(flags['done-date']) : '',
      tag: flags.tag != null ? String(flags.tag) : '',
      match: flags.match != null ? String(flags.match) : '',
    },
    items: shown.map((t) => viewOf(t, gmap)),
  };
  const head = `${STATUS_LABEL[status]} ${sorted.length} 条${sorted.length > shown.length ? `（只显示前 ${shown.length} 条，--limit 0 取消）` : ''}`;
  return ok(data, [head, ...shown.map((t) => textLine(t, gmap))].join('\n'));
}

async function cmdShow(core, { flags, pos }, out) {
  core.boot(out.settings);
  const t = await findTask(core, out, pos[1], flags);
  const gmap = await groupMap(core, [t]);
  const subs = await core.listSubtasks(t.guid);
  const subtasks = (subs && subs.body && subs.body.items) || [];
  const view = viewOf(t, gmap);
  const data = { ok: true, cmd: 'show', task: view, subtasks: subtasks.map((s) => viewOf(s, gmap)) };
  const lines = [
    `${view.summary}   [${STATUS_LABEL[view.status]}]`,
    `  guid   ${view.guid}`,
    `  归属   ${view.list.name}${view.group ? ' › ' + view.group : ''}`,
    `  日期   ${view.due || '无'}${view.time ? ' ' + view.time + (view.timeEnd ? '-' + view.timeEnd : '') : (view.due ? '（全天）' : '')}`,
    view.priority ? `  优先级 ${view.priority}` : '',
    view.done ? `  完成于 ${view.done}` : '',
    view.tags.length ? `  标签   ${view.tags.map((x) => '#' + x).join(' ')}` : '',
    view.description ? `  描述   ${view.description.split('\n').join('\n         ')}` : '',
    `  子任务 ${subtasks.length}`,
    ...subtasks.map((s) => `    [${s.completed ? 'x' : ' '}] ${s.summary}`),
  ].filter(Boolean);
  return ok(data, lines.join('\n'));
}

// ---------- 命令：edit / status / move / rm ----------
function priorityPatch(value) {
  const p = String(value).toLowerCase();
  if (!(p in PRIORITY)) throw new CliError('bad_priority', `未知优先级：${value}（high / medium / low / none）`);
  return PRIORITY[p];
}

async function cmdEdit(core, { flags, pos }, out) {
  core.boot(out.settings);
  const t = await findTask(core, out, pos[1], flags);
  const patch = { expectSummary: t.summary, expectCompleted: t.completed };
  if (flags.summary != null) patch.summary = String(flags.summary);
  if (flags.desc != null) patch.description = String(flags.desc);
  if (flags.priority != null) patch.priority = priorityPatch(flags.priority);
  if (flags['clear-due']) { patch.dueAt = null; patch.startAt = null; patch.dueEndAt = null; }
  else if (flags.due != null) {
    const due = parseDue(flags.due);
    if (flags.time != null) {
      const tm = parseTime(flags.time);
      patch.dueAllDay = false;
      patch.dueAt = due.at + tm.start;
      patch.dueEndAt = tm.endOffset != null ? due.at + tm.endOffset : null;
    } else {
      patch.dueAllDay = true;
      patch.dueAt = due.at;
      patch.dueEndAt = null;
    }
  } else if (flags.time != null) {
    throw new CliError('bad_args', '--time 需要同时给 --due');
  }
  const touched = ['summary', 'description', 'priority', 'dueAt', 'dueEndAt'].filter((k) => Object.prototype.hasOwnProperty.call(patch, k));
  if (!touched.length) throw new CliError('bad_args', '没有要改的内容：--summary / --desc / --priority / --due / --clear-due');

  const dryRun = !!flags['dry-run'];
  core.setDryRun(dryRun);
  core.takeOps();
  const r = await core.updateTask(t.guid, patch);
  if (!r || r.status !== 200) {
    const reason = (r && r.body && r.body.reason) || 'unknown';
    if (reason === 'not_found') {
      throw new CliError('task_not_found', '任务定位失败（文件可能被外部改动），请重新 task ls 拿 guid');
    }
    throw new CliError(reason, `修改失败：${reason}`);
  }
  const nt = r.body.task;
  const gmap = await groupMap(core, [nt]);
  const data = { ok: true, cmd: 'edit', dryRun, changed: touched, task: viewOf(nt, gmap) };
  const text = `${dryRun ? '[dry-run] 将修改' : '✅ 已修改'} → ${data.task.list.name}${data.task.group ? ' › ' + data.task.group : ''}\n   ${textLine(nt, gmap)}`;
  return ok(data, text);
}

async function cmdStatus(core, { flags, pos }, out) {
  core.boot(out.settings);
  const raw = String(pos[2] || '').toLowerCase();
  const state = { done: 'done', complete: 'done', completed: 'done', todo: 'todo', undone: 'todo', active: 'todo', cancel: 'cancelled', cancelled: 'cancelled', canceled: 'cancelled' }[raw];
  if (!state) throw new CliError('bad_status', `未知状态：${pos[2]}（todo / done / cancelled）`);
  const t = await findTask(core, out, pos[1], flags);
  const dryRun = !!flags['dry-run'];
  core.setDryRun(dryRun);
  core.takeOps();
  const r = await core.setChecklistStatus(t.guid, state);
  if (!r || r.status !== 200) {
    const reason = (r && r.body && r.body.reason) || 'unknown';
    throw new CliError(reason, reason === 'not_found' ? '任务定位失败，请重新 task ls 拿 guid' : `改状态失败：${reason}`);
  }
  const nt = r.body.task;
  const gmap = await groupMap(core, [nt]);
  const data = { ok: true, cmd: 'status', dryRun, status: state, task: viewOf(nt, gmap) };
  return ok(data, `${dryRun ? '[dry-run] 将标记' : '✅ 已标记'} ${STATUS_LABEL[state]}：${nt.summary}\n   ${textLine(nt, gmap)}`);
}

async function cmdMove(core, { flags, pos }, out) {
  core.boot(out.settings);
  const srcFlags = Object.assign({}, flags);
  delete srcFlags.list; // --list 在 move 里指「目标」，不能用来过滤源任务
  const t = await findTask(core, out, pos[1], srcFlags);
  let targetKey = null;
  if (flags.list != null) targetKey = await resolveTargetKey(core, flags.list);
  const sameKey = targetKey != null && targetKey === t.date;
  if (!targetKey) {
    if (t.date !== INBOX && !isListKey(t.date)) {
      throw new CliError('bad_args', '日记任务要移动请加 --list（CLI 不支持把任务移进某一天，改日期请用 task edit --due）');
    }
    targetKey = t.date;
  }
  const group = flags.group === undefined ? undefined : String(flags.group);
  if (sameKey && group === undefined) {
    throw new CliError('bad_args', '目标就是当前文件：只换分组请加 --group');
  }
  const targetGroup = group === undefined ? '' : group;
  if (targetGroup) {
    const relPath = core.taskFilePath(targetKey);
    const headings = groupTitlesOf(out.vault, relPath);
    if (!headings.includes(targetGroup)) {
      throw new CliError('group_not_found', `「${targetGroup}」不是 ${relPath} 里的 ### 分组`, { groups: headings });
    }
  }
  const dryRun = !!flags['dry-run'];
  core.setDryRun(dryRun);
  core.takeOps();
  const r = await core.moveTaskToGroup(t.guid, targetKey, targetGroup, { keepDate: !!flags['keep-date'] });
  if (!r || r.status !== 200) {
    const reason = (r && r.body && r.body.reason) || 'unknown';
    const extra = reason === 'group_not_found'
      ? { groups: groupTitlesOf(out.vault, core.taskFilePath(targetKey)) }
      : {};
    throw new CliError(reason, `移动失败：${reason}`, extra);
  }
  const nt = r.body.task;
  const gmap = await groupMap(core, [nt]);
  const data = { ok: true, cmd: 'move', dryRun, task: viewOf(nt, gmap) };
  return ok(data, `${dryRun ? '[dry-run] 将移动' : '✅ 已移动'} → ${keyLabel(targetKey)}${targetGroup ? ' › ' + targetGroup : '（未分组）'}\n   ${textLine(nt, gmap)}`);
}

async function cmdRm(core, { flags, pos }, out) {
  core.boot(out.settings);
  if (!flags.yes) throw new CliError('confirm_required', '删除不可恢复：确认要删就加 --yes');
  const t = await findTask(core, out, pos[1], flags);
  const dryRun = !!flags['dry-run'];
  core.setDryRun(dryRun);
  core.takeOps();
  const r = await core.deleteTask(t.guid);
  if (!r || r.status !== 200) {
    const reason = (r && r.body && r.body.reason) || 'unknown';
    throw new CliError(reason, reason === 'not_found' ? '任务定位失败，请重新 task ls 拿 guid' : `删除失败：${reason}`);
  }
  const data = { ok: true, cmd: 'rm', dryRun, task: { guid: t.guid, summary: t.summary, list: keyLabel(t.date) } };
  return ok(data, `${dryRun ? '[dry-run] 将删除' : '✅ 已删除'}：${t.summary}${t.file ? `（${t.file}）` : ''}`);
}

// ---------- 命令：sub / cl / group ----------
async function cmdSub(core, { flags, pos }, out) {
  core.boot(out.settings);
  const action = String(pos[1] || '');
  if (action === 'ls') {
    const parent = await findTask(core, out, pos[2], flags);
    const r = await core.listSubtasks(parent.guid);
    const items = (r && r.body && r.body.items) || [];
    const gmap = await groupMap(core, [parent]);
    const data = { ok: true, cmd: 'sub.ls', parent: viewOf(parent, gmap), items: items.map((s) => viewOf(s, gmap)) };
    const text = [
      `${parent.summary} 的子任务 ${items.length} 条`,
      ...items.map((s) => `  [${s.completed ? 'x' : (s.cancelled ? '-' : ' ')}] ${s.summary}   · #${s.guid}`),
    ].join('\n');
    return ok(data, text);
  }
  if (action === 'add') {
    const parent = await findTask(core, out, pos[2], flags);
    const summary = (pos.slice(3).join(' ') || flags.summary || '').trim();
    if (!summary) throw new CliError('missing_summary', '缺少子任务标题：task sub add <任务> "标题"');
    const task = { summary };
    if (flags.desc != null) task.description = String(flags.desc);
    if (flags.priority != null) task.priority = priorityPatch(flags.priority);
    const dryRun = !!flags['dry-run'];
    core.setDryRun(dryRun);
    core.takeOps();
    const r = await core.createSubtask(parent.guid, task);
    if (!r || r.status !== 201) {
      const reason = (r && r.body && r.body.reason) || 'unknown';
      throw new CliError(reason, `加子任务失败：${reason}`);
    }
    const nt = r.body.task;
    const gmap = await groupMap(core, [nt]);
    const data = { ok: true, cmd: 'sub.add', dryRun, parent: { guid: parent.guid, summary: parent.summary }, task: viewOf(nt, gmap) };
    return ok(data, `${dryRun ? '[dry-run] 将添加' : '✅ 已添加'}子任务：${nt.summary}（父：${parent.summary}）\n   ${textLine(nt, gmap)}`);
  }
  throw new CliError('bad_args', '用法：task sub ls <任务> / task sub add <任务> "标题"');
}

async function cmdCl(core, { flags, pos }, out) {
  core.boot(out.settings);
  if (String(pos[1] || '') !== 'add') throw new CliError('bad_args', '用法：task cl add <名称>');
  const name = (pos.slice(2).join(' ') || flags.name || '').trim();
  if (!name) throw new CliError('missing_name', '缺少清单名：task cl add "名称"');
  const dryRun = !!flags['dry-run'];
  core.setDryRun(dryRun);
  core.takeOps();
  const r = await core.createChecklist(name);
  if (!r || r.status !== 201) {
    const reason = (r && r.body && r.body.reason) || 'unknown';
    if (reason === 'exists_other') throw new CliError('exists', `已有同名清单：${r.body.path}`);
    if (reason === 'exists') throw new CliError('exists', `同名清单已存在：${name}`);
    throw new CliError(reason, `创建清单失败：${reason}`);
  }
  const item = r.body.item || {};
  const data = { ok: true, cmd: 'cl.add', dryRun, key: r.body.key, path: r.body.path, name: item.name || name };
  return ok(data, `${dryRun ? '[dry-run] 将创建' : '✅ 已创建'}清单：${data.name} → ${data.path}（key: ${data.key}）`);
}

async function cmdGroup(core, { flags, pos }, out) {
  core.boot(out.settings);
  if (String(pos[1] || '') !== 'add') throw new CliError('bad_args', '用法：task group add <清单|收件箱> <标题>');
  const target = (pos[2] || flags.list || '').trim();
  const title = (pos.slice(3).join(' ') || flags.title || '').trim();
  if (!target) throw new CliError('bad_args', '缺少目标：task group add <清单|收件箱> <标题>');
  if (!title) throw new CliError('missing_title', '缺少分组标题：task group add <清单|收件箱> "标题"');
  if (/[\r\n]/.test(title)) throw new CliError('bad_title', '分组标题不能换行');
  const key = await resolveTargetKey(core, target);
  if (key === INBOX) await core.ensureInboxFile();
  const relPath = core.taskFilePath(key);
  const absPath = path.join(out.vault, relPath);
  if (!fs.existsSync(absPath)) throw new CliError('no_file', `文件不存在：${relPath}`);
  const headings = groupTitlesOf(out.vault, relPath);
  if (headings.includes(title)) throw new CliError('group_exists', `分组已存在：### ${title}`);
  const dryRun = !!flags['dry-run'];
  const content = fs.readFileSync(absPath, 'utf8');
  const next = content.replace(/\s+$/, '') + `\n\n### ${title}\n`;
  if (!dryRun) fs.writeFileSync(absPath, next, 'utf8');
  const data = { ok: true, cmd: 'group.add', dryRun, key, path: relPath, title, groups: [...headings, title] };
  return ok(data, `${dryRun ? '[dry-run] 将新增' : '✅ 已新增'}分组 ### ${title} → ${relPath}（落在文件末尾）`);
}

// ---------- 命令：install ----------
function detectSkillDirs() {
  return ['agents', 'dsh', 'claude']
    .map((d) => path.join(os.homedir(), '.' + d, 'skills'))
    .filter((d) => fs.existsSync(d));
}

async function cmdInstall({ flags }) {
  if (!fs.existsSync(SKILL_SRC)) throw new CliError('no_skill', `仓库里缺少技能文件：${SKILL_SRC}`);
  ensureBundle(true);

  const binDir = path.resolve(String(flags['bin-dir'] || process.env.TASK_BIN_DIR || path.join(os.homedir(), '.local', 'bin')));
  fs.mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, 'task');
  const st = fs.lstatSync(link, { throwIfNoEntry: false });
  let binAction = 'created';
  if (st) {
    if (st.isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === SELF) {
      binAction = 'kept';
    } else {
      throw new CliError('bin_conflict', `${link} 已存在且不是本 CLI 的软链，不覆盖；用 --bin-dir 换目录`);
    }
  } else {
    fs.symlinkSync(SELF, link);
  }

  const skillDirs = flags['skill-dir'] ? flags['skill-dir'].map((d) => path.resolve(String(d))) : detectSkillDirs();
  const skills = [];
  for (const dir of skillDirs) {
    const targetDir = path.join(dir, SKILL_NAME);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, 'SKILL.md');
    if (fs.lstatSync(target, { throwIfNoEntry: false })) fs.rmSync(target, { force: true });
    if (flags.link) fs.symlinkSync(SKILL_SRC, target);
    else fs.copyFileSync(SKILL_SRC, target);
    skills.push({ dir, path: target, mode: flags.link ? 'link' : 'copy' });
  }

  const onPath = String(process.env.PATH || '').split(path.delimiter).includes(binDir);
  const data = {
    ok: true, cmd: 'install',
    bin: { dir: binDir, path: link, action: binAction, onPath },
    skills,
    warning: skills.length ? undefined : '没有检测到 agent 技能目录，用 --skill-dir <目录> 指定',
  };
  const text = [
    `${binAction === 'kept' ? '已是最新' : '已安装'}命令：${data.bin.path}`,
    onPath ? '' : `   ⚠ ${binDir} 不在 PATH，加一行：export PATH="${binDir}:$PATH"`,
    ...skills.map((s) => `已${s.mode === 'link' ? '软链' : '复制'}技能：${s.path}`),
    data.warning ? `   ⚠ ${data.warning}` : '',
  ].filter(Boolean).join('\n');
  return ok(data, text);
}

// ---------- 入口 ----------
async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] || (flags.help ? 'help' : '');

  if (cmd === 'build') {
    ensureBundle(true);
    return ok({ ok: true, cmd: 'build', dist: DIST }, `已重新打包：${DIST}`);
  }
  if (cmd === 'install') return cmdInstall({ flags });
  if (!cmd || cmd === 'help' || flags.help) return ok({ ok: true, cmd: 'help', text: HELP }, HELP);

  const vault = resolveVault(flags);
  process.env.TASK_VAULT = vault; // mock 按此根目录读写
  ensureBundle(false);
  const core = await import(pathToFileURL(DIST).href);
  const out = { vault, settings: readSettings(vault) };

  switch (cmd) {
    case 'ls': case 'list': return cmdLs(core, { flags }, out);
    case 'show': case 'get': return cmdShow(core, { flags, pos }, out);
    case 'add': return cmdAdd(core, { flags, pos }, out);
    case 'edit': case 'update': return cmdEdit(core, { flags, pos }, out);
    case 'status': return cmdStatus(core, { flags, pos }, out);
    case 'move': return cmdMove(core, { flags, pos }, out);
    case 'rm': case 'delete': case 'del': return cmdRm(core, { flags, pos }, out);
    case 'sub': return cmdSub(core, { flags, pos }, out);
    case 'cl': case 'checklist': return cmdCl(core, { flags, pos }, out);
    case 'group': return cmdGroup(core, { flags, pos }, out);
    case 'lists': return cmdLists(core, { flags }, out);
    case 'groups': return cmdGroups(core, { flags }, out);
    default: throw new CliError('unknown_cmd', `未知命令：${cmd}\n${HELP}`);
  }
}

const result = await main().catch((e) => {
  const err = e instanceof CliError ? e : new CliError('error', (e && e.message) || String(e));
  return { ok: false, data: { ok: false, reason: err.reason, message: err.message, ...(err.extra || {}) } };
});

const wantJson = process.argv.includes('--json');
if (wantJson) {
  console.log(JSON.stringify(result.data, null, 2));
} else if (result.ok) {
  console.log(result.text);
} else {
  const d = result.data || {};
  console.error(`✗ ${d.message}`);
  if (d.vaults) console.error(`候选库：\n${d.vaults.map((v) => '  ' + v).join('\n')}`);
  if (d.lists) console.error(`可用清单：${d.lists.join(' / ')}`);
  if (d.candidates) console.error(`候选任务：\n${d.candidates.map((c) => `  ${c.guid}  [${c.status}]  ${c.summary}`).join('\n')}`);
  if (d.groups && d.groups.length) console.error(`可用分组：${d.groups.map((g) => '### ' + g).join('  ')}`);
  else if (d.groups) console.error('该文件还没有 ### 分组：去掉 --group 即写入「未分组」（第一个 ### 之前）');
}
process.exit(result.ok ? 0 : 1);
