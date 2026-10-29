#!/usr/bin/env node
// Dada Todo List 的 agent 入口（CLI）。
//
// 设计：CLI 不复制插件的任务格式，而是把插件真实的 api/tasks.js 用 esbuild 打包成
// tools/dist/dada-core.mjs（obsidian 模块换成 fs 版 mock），直接调用同一套读写函数。
// 因此：清单识别、分组 `###` 插入、幂等建文件、行内日期标记与插件完全一致；
// 改插件代码后 CLI 首次运行会自动重新打包。
//
// 用法见 `dada --help`。给 agent 的语义说明在同名 skill 里。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(REPO, 'tools', 'obsidian-mock.mjs');
const ENTRY = path.join(REPO, 'tools', 'core-entry.mjs');
const DIST = path.join(REPO, 'tools', 'dist', 'dada-core.mjs');
const PLUGIN_ID = 'dada-todo-list';
const PRIORITY = { high: '🔺', medium: '🔼', low: '🔽', none: '' };

const HELP = `dada — 往 Dada Todo List 创建任务（供 AI agent / 人使用）

用法：
  dada add <标题> [选项]         # 创建任务
  dada lists [--json]            # 列出全部清单（名称 / key / 未完成数）
  dada groups [--list <清单>]    # 列出收件箱或某清单里的 ### 分组
  dada --help

add 选项：
  --due <YYYY-MM-DD|today|tomorrow|+Nd>   截止日期（行内 📅，不建日记文件）
  --time <HH:MM>                          具体时间（需配合 --due）
  --list <清单名|清单路径>                 写进该清单；缺省写进收件箱
  --group <分组标题>                       写进该 ### 分组；缺省「未分组」（第一个 ### 之前）
  --priority <high|medium|low>             优先级
  --desc <文本>                            任务描述（额外缩进行）
  --vault <路径>                           Obsidian 库根，默认 ~/Documents/ObsidianVault
  --dry-run                                只演示会写什么，不落盘
  --json                                   机器可读输出（成功 / 失败都打印 JSON）

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

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  const boolean = new Set(['json', 'dry-run', 'help', 'build', 'quiet']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).trim();
    if (eq > 0) { flags[key] = a.slice(eq + 1); continue; }
    if (boolean.has(key)) { flags[key] = true; continue; }
    const val = argv[++i];
    if (val == null || val.startsWith('--')) throw new CliError('bad_args', `参数 --${key} 缺少值`);
    flags[key] = val;
  }
  return { flags, pos };
}

// ---------- 打包（按需） ----------
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      const m = fs.statSync(full).mtimeMs;
      if (m > newest) newest = m;
    }
  };
  walk(dir);
  return newest;
}

function ensureBundle(force) {
  const srcMtime = Math.max(
    fs.existsSync(path.join(REPO, 'src', 'core')) ? newestMtime(path.join(REPO, 'src', 'core')) : 0,
    fs.statSync(MOCK).mtimeMs,
    fs.statSync(ENTRY).mtimeMs,
  );
  const distMtime = fs.existsSync(DIST) ? fs.statSync(DIST).mtimeMs : 0;
  if (!force && distMtime > srcMtime) return;
  const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild');
  if (!fs.existsSync(esbuild)) {
    throw new CliError('no_esbuild', `找不到 esbuild：${esbuild}\n请先在 ${REPO} 执行 npm install`);
  }
  const r = spawnSync(esbuild, [
    ENTRY, '--bundle', '--platform=node', '--format=esm',
    `--alias:obsidian=${MOCK}`, `--outfile=${DIST}`, '--log-level=warning',
  ], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) throw new CliError('bundle_failed', '打包 dada-core 失败');
}

// ---------- 日期 / 路径 ----------
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
  const at = startOfDay(d);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { at, key };
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) throw new CliError('bad_time', `无法识别的时间：${value}（用 HH:MM）`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new CliError('bad_time', `时间越界：${value}`);
  return { h, min };
}

function readSettings(vault) {
  const p = path.join(vault, '.obsidian', 'plugins', PLUGIN_ID, 'data.json');
  if (!fs.existsSync(p)) {
    throw new CliError('no_settings', `找不到插件设置：${p}\n用 --vault 指定 Obsidian 库根，并确认库里装了 ${PLUGIN_ID}`);
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

async function resolveListKey(core, vault, value) {
  if (String(value).startsWith('cl:')) return String(value);
  const r = await core.loadChecklists();
  const items = (r.body && r.body.items) || [];
  const want = String(value).replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '');
  const hit = items.find((it) => it.key === 'cl:' + want || it.name === want);
  if (hit) return hit.key;
  throw new CliError('list_not_found', `找不到清单「${value}」`, {
    lists: items.map((it) => it.name),
  });
}

// ---------- 命令 ----------
async function cmdAdd(core, { flags, pos }, out) {
  const summary = (pos.slice(1).join(' ') || flags.summary || '').trim();
  if (!summary) throw new CliError('missing_summary', '缺少任务标题：dada add "标题"');

  const vault = out.vault;
  core.boot(out.settings);

  const listKey = flags.list ? await resolveListKey(core, vault, flags.list) : 'inbox';
  const relPath = core.taskFilePath(listKey);
  if (!relPath) throw new CliError('bad_path', `无法解析目标文件（key=${listKey}）`);
  const absPath = path.join(vault, relPath);
  const before = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';

  const task = { summary, description: flags.desc || '' };
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
  // 收件箱文件不存在时按插件的收件箱模板（tags: task）建，而不是 ensureTaskFile 的日记模板
  if (listKey === 'inbox') await core.ensureInboxFile();
  const r = await core.createChecklistTask(listKey, group, task);

  if (!r || r.status !== 201) {
    const reason = (r && r.body && r.body.reason) || 'unknown';
    if (reason === 'group_not_found') {
      throw new CliError('group_not_found', `「${group}」不是 ${relPath} 里的 ### 分组`, {
        groups: groupTitlesOf(vault, relPath),
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
    description: desc || undefined,
    warning: warning || undefined,
  };
}

async function cmdLists(core, { flags }, out) {
  core.boot(out.settings);
  const r = await core.loadChecklists();
  const items = (r.body && r.body.items) || [];
  if (flags.json) return { ok: true, cmd: 'lists', count: items.length, items };
  return { ok: true, cmd: 'lists', count: items.length, items };
}

async function cmdGroups(core, { flags }, out) {
  core.boot(out.settings);
  const listKey = flags.list ? await resolveListKey(core, out.vault, flags.list) : 'inbox';
  const relPath = core.taskFilePath(listKey);
  const groups = groupTitlesOf(out.vault, relPath);
  return { ok: true, cmd: 'groups', path: relPath, list: listKey === 'inbox' ? '收件箱' : listKey.slice(3), groups };
}

// ---------- 入口 ----------
async function main() {
  const argv = process.argv.slice(2);
  const { flags, pos } = parseArgs(argv);
  const cmd = pos[0] || (flags.help ? 'help' : '');

  if (cmd === 'build') { ensureBundle(true); return { ok: true, cmd: 'build', dist: DIST }; }
  if (!cmd || cmd === 'help' || flags.help) return { ok: true, cmd: 'help', text: HELP };

  const vault = path.resolve(flags.vault || process.env.DADA_VAULT || path.join(os.homedir(), 'Documents', 'ObsidianVault'));
  if (!fs.existsSync(vault)) throw new CliError('no_vault', `Obsidian 库不存在：${vault}`);
  process.env.DADA_VAULT = vault; // mock 按此根目录读写
  ensureBundle(false);
  const core = await import(pathToFileURL(DIST).href);
  const out = { vault, settings: readSettings(vault) };

  if (cmd === 'add') return cmdAdd(core, { flags, pos }, out);
  if (cmd === 'lists') return cmdLists(core, { flags }, out);
  if (cmd === 'groups') return cmdGroups(core, { flags }, out);
  throw new CliError('unknown_cmd', `未知命令：${cmd}\n${HELP}`);
}

const result = await main().catch((e) => {
  const err = e instanceof CliError ? e : new CliError('error', e && e.message || String(e));
  return { ok: false, reason: err.reason, message: err.message, ...(err.extra || {}) };
});

const json = process.argv.includes('--json');
if (result.text) {
  if (!json) console.log(result.text);
}
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  if (result.cmd === 'add') {
    console.log(`${result.dryRun ? '[dry-run] 将创建' : '✅ 已创建'} → ${result.path}（${result.list} · ${result.group}）`);
    if (result.line) console.log(`   ${result.line}`);
    if (!result.dryRun) console.log(`   guid: ${result.guid}`);
  } else if (result.cmd === 'lists') {
    for (const it of result.items) console.log(`  ${it.name}  —  未完成 ${it.total - it.done - it.cancelled}/${it.total}   key: ${it.key}`);
    if (!result.items.length) console.log('（没有清单：清单 = frontmatter tags 命中 checklistTags 的笔记）');
  } else if (result.cmd === 'groups') {
    console.log(`${result.path}（${result.list}）的分组：`);
    for (const g of result.groups) console.log(`  ### ${g}`);
    if (!result.groups.length) console.log('  （无 ### 分组，任务会落在文件末尾）');
  } else if (result.cmd === 'build') {
    console.log(`已重新打包：${result.dist}`);
  }
} else {
  console.error(`✗ ${result.message}`);
  if (result.lists) console.error(`可用清单：${result.lists.join(' / ')}`);
  if (result.groups && result.groups.length) console.error(`可用分组：${result.groups.map((g) => '### ' + g).join('  ')}`);
  else if (result.groups) console.error('该文件还没有 ### 分组：去掉 --group 即写入「未分组」（第一个 ### 之前）');
}
process.exit(result.ok ? 0 : 1);
