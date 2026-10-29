#!/usr/bin/env node
// Dada Todo List 的 agent 入口（CLI）。
//
// 设计：CLI 不复制插件的任务格式，而是把插件真实的 api/tasks.js 用 esbuild 打包成
// tools/dist/task-core.mjs（obsidian 模块换成 fs 版 mock），直接调用同一套读写函数。
// 因此：清单识别、分组 `###` 插入、幂等建文件、行内日期标记与插件完全一致；
// 改插件代码后 CLI 首次运行会自动重新打包。
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
const PRIORITY = { high: '🔺', medium: '🔼', low: '🔽', none: '' };

// 插件 id 以仓库 manifest 为准，不在代码里重复
function pluginId() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).id || 'dada-todo-list'; }
  catch { return 'dada-todo-list'; }
}

const HELP = `task — Dada Todo List 的任务入口（供 AI agent / 人使用）

用法：
  task add <标题> [选项]         # 创建任务
  task lists [--json]            # 列出全部清单（名称 / key / 未完成数）
  task groups [--list <清单>]    # 列出收件箱或某清单里的 ### 分组
  task install [选项]            # 安装命令行 + agent skill（一次性）
  task --help

add 选项：
  --due <YYYY-MM-DD|today|tomorrow|+Nd>   截止日期（行内 📅，不建日记文件）
  --time <HH:MM>                          具体时间（需配合 --due）
  --list <清单名|清单路径>                 写进该清单；缺省写进收件箱
  --group <分组标题>                       写进该 ### 分组；缺省「未分组」（第一个 ### 之前）
  --priority <high|medium|low>             优先级
  --desc <文本>                            任务描述（额外缩进行）
  --vault <路径>                           Obsidian 库根
  --dry-run                                只演示会写什么，不落盘
  --json                                   机器可读输出（成功 / 失败都打印 JSON）

库的定位（按优先级）：--vault → 环境变量 TASK_VAULT → Obsidian 当前打开的库 →
库里只有一个库时直接用。多库并存会报错并列出候选，需要显式 --vault。

install 选项：
  --bin-dir <目录>      放 task 命令的目录，默认 ~/.local/bin（或环境变量 TASK_BIN_DIR）
  --skill-dir <目录>    安装 skill 的目标目录，可重复；缺省装到已存在的
                        ~/.agents/skills、~/.dsh/skills、~/.claude/skills
  --link                技能文件用软链代替复制（改仓库里的 SKILL.md 即时生效）

说明：
  真正写盘的是插件自己的 api/tasks.js，格式与插件内新建完全一致；Obsidian 开着时
  会在 ~500ms 后自动刷新出这条任务，关着也会写进 Markdown，下次打开可见。
`;

// ---------- 参数 ----------
class CliError extends Error {
  constructor(reason, message, extra) {
    super(message || reason);
    this.reason = reason;
    this.extra = extra;
  }
}

const BOOLEAN_FLAGS = new Set(['json', 'dry-run', 'help', 'build', 'link', 'quiet']);
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
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

function parseDue(value) {
  if (!value) return null;
  const v = String(value).trim();
  const now = new Date();
  let d = null;
  if (v === 'today') d = now;
  else if (v === 'tomorrow') d = new Date(now.getTime() + 86400000);
  else if (/^\+\d{1,3}d$/.test(v)) d = new Date(now.getTime() + Number(v.slice(1, -1)) * 86400000);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, day] = v.split('-').map(Number);
    d = new Date(y, m - 1, day, 12);
    if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) {
      throw new CliError('bad_date', `日期不存在：${v}`);
    }
  } else throw new CliError('bad_date', `无法识别的日期：${v}（支持 YYYY-MM-DD / today / tomorrow / +Nd）`);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { at: startOfDay(d), key };
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) throw new CliError('bad_time', `无法识别的时间：${value}（用 HH:MM）`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new CliError('bad_time', `时间越界：${value}`);
  return { h, min };
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

async function resolveListKey(core, value) {
  if (String(value).startsWith('cl:')) return String(value);
  const r = await core.loadChecklists();
  const items = (r.body && r.body.items) || [];
  const want = String(value).replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '');
  const hit = items.find((it) => it.key === 'cl:' + want || it.name === want);
  if (hit) return hit.key;
  throw new CliError('list_not_found', `找不到清单「${value}」`, { lists: items.map((it) => it.name) });
}

// ---------- 命令：add / lists / groups ----------
async function cmdAdd(core, { flags, pos }, out) {
  const summary = (pos.slice(1).join(' ') || flags.summary || '').trim();
  if (!summary) throw new CliError('missing_summary', '缺少任务标题：task add "标题"');
  core.boot(out.settings);

  const listKey = flags.list ? await resolveListKey(core, flags.list) : 'inbox';
  const relPath = core.taskFilePath(listKey);
  if (!relPath) throw new CliError('bad_path', `无法解析目标文件（key=${listKey}）`);
  const absPath = path.join(out.vault, relPath);
  const before = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';

  const task = { summary };
  const due = parseDue(flags.due);
  if (due) {
    if (flags.time) {
      const { h, min } = parseTime(flags.time);
      task.dueAllDay = false;
      task.dueAt = due.at + h * 3600000 + min * 60000;
    } else {
      task.dueAllDay = true; // 关键：否则 API 会把午夜写成 "00:00" 时间前缀
      task.dueAt = due.at;
    }
  } else if (flags.time) {
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
  if (listKey === 'inbox') await core.ensureInboxFile();
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

  return {
    ok: true,
    cmd: 'add',
    dryRun,
    path: relPath,
    createdFile: created,
    list: listKey === 'inbox' ? '收件箱' : path.basename(listKey.slice(3)),
    group: group || '（未分组）',
    guid: t && t.guid,
    lineNo: t && t.lineNo,
    line,
    summary,
    warning: warning || undefined,
  };
}

async function cmdLists(core, { flags }, out) {
  core.boot(out.settings);
  const r = await core.loadChecklists();
  const items = (r.body && r.body.items) || [];
  return { ok: true, cmd: 'lists', count: items.length, items };
}

async function cmdGroups(core, { flags }, out) {
  core.boot(out.settings);
  const listKey = flags.list ? await resolveListKey(core, flags.list) : 'inbox';
  const relPath = core.taskFilePath(listKey);
  return {
    ok: true,
    cmd: 'groups',
    path: relPath,
    list: listKey === 'inbox' ? '收件箱' : path.basename(listKey.slice(3)),
    groups: groupTitlesOf(out.vault, relPath),
  };
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
  return {
    ok: true,
    cmd: 'install',
    bin: { dir: binDir, path: link, action: binAction, onPath },
    skills,
    warning: skills.length ? undefined : '没有检测到 agent 技能目录，用 --skill-dir <目录> 指定',
  };
}

// ---------- 入口 ----------
async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] || (flags.help ? 'help' : '');

  if (cmd === 'build') { ensureBundle(true); return { ok: true, cmd: 'build', dist: DIST }; }
  if (cmd === 'install') return cmdInstall({ flags });
  if (!cmd || cmd === 'help' || flags.help) return { ok: true, cmd: 'help', text: HELP };

  const vault = resolveVault(flags);
  process.env.TASK_VAULT = vault; // mock 按此根目录读写
  ensureBundle(false);
  const core = await import(pathToFileURL(DIST).href);
  const out = { vault, settings: readSettings(vault) };

  if (cmd === 'add') return cmdAdd(core, { flags, pos }, out);
  if (cmd === 'lists') return cmdLists(core, { flags }, out);
  if (cmd === 'groups') return cmdGroups(core, { flags }, out);
  throw new CliError('unknown_cmd', `未知命令：${cmd}\n${HELP}`);
}

const result = await main().catch((e) => {
  const err = e instanceof CliError ? e : new CliError('error', (e && e.message) || String(e));
  return { ok: false, reason: err.reason, message: err.message, ...(err.extra || {}) };
});

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  if (result.text) console.log(result.text);
  else if (result.cmd === 'add') {
    console.log(`${result.dryRun ? '[dry-run] 将创建' : '✅ 已创建'} → ${result.path}（${result.list} · ${result.group}）`);
    if (result.line) console.log(`   ${result.line}`);
    if (!result.dryRun) console.log(`   guid: ${result.guid}`);
    if (result.warning) console.log(`   ⚠ ${result.warning}`);
  } else if (result.cmd === 'lists') {
    for (const it of result.items) console.log(`  ${it.name}  —  未完成 ${it.total - it.done - it.cancelled}/${it.total}   key: ${it.key}`);
    if (!result.items.length) console.log('（没有清单：清单 = frontmatter tags 命中 checklistTags 的笔记）');
  } else if (result.cmd === 'groups') {
    console.log(`${result.path}（${result.list}）的分组：`);
    for (const g of result.groups) console.log(`  ### ${g}`);
    if (!result.groups.length) console.log('  （无 ### 分组，任务会落在文件末尾）');
  } else if (result.cmd === 'build') {
    console.log(`已重新打包：${result.dist}`);
  } else if (result.cmd === 'install') {
    console.log(`${result.bin.action === 'kept' ? '已是最新' : '已安装'}命令：${result.bin.path}`);
    if (!result.bin.onPath) console.log(`   ⚠ ${result.bin.dir} 不在 PATH，加一行：export PATH="${result.bin.dir}:$PATH"`);
    for (const s of result.skills) console.log(`已${s.mode === 'link' ? '软链' : '复制'}技能：${s.path}`);
    if (result.warning) console.log(`   ⚠ ${result.warning}`);
  }
} else {
  console.error(`✗ ${result.message}`);
  if (result.vaults) console.error(`候选库：\n${result.vaults.map((v) => '  ' + v).join('\n')}`);
  if (result.lists) console.error(`可用清单：${result.lists.join(' / ')}`);
  if (result.groups && result.groups.length) console.error(`可用分组：${result.groups.map((g) => '### ' + g).join('  ')}`);
  else if (result.groups) console.error('该文件还没有 ### 分组：去掉 --group 即写入「未分组」（第一个 ### 之前）');
}
process.exit(result.ok ? 0 : 1);
