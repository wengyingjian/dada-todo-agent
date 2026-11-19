#!/usr/bin/env node
// 项目任务插件的端到端验收（对应需求规格 §10）。
// 前提：Obsidian 以 --remote-debugging-port=9333 启动，且本插件已启用。
// 用法：
//   node scripts/e2e/run.mjs            # 全跑
//   node scripts/e2e/run.mjs --only 1,3 # 只跑指定编号
//   node scripts/e2e/run.mjs --skip-slow # 跳过会真的起 T3 Code 会话的用例（8、9、12、13）
// 所有测试数据都落在库根的 __e2e/ 下，跑完自动清理并还原插件设置。

import { mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { connect, poll } from './driver.mjs';

// 测试数据分两处：
// - 库内 __e2e/：项目文件、日记，跑完删除；
// - 库外沙盒 SANDBOX：会话的工作目录，单独登记成一个 T3 项目，跑完连同会话一起删掉，
//   不碰库本身这个 T3 项目，也不会把测试会话留在用户正常的工作区。
const VAULT = process.env.E2E_VAULT || path.join(homedir(), 'Documents/ObsidianVault');
const SANDBOX = process.env.E2E_SANDBOX || path.join(homedir(), 'Documents/ObsidianWork', 'e2e-dada-todo');

// 新建的 T3 项目没有默认模型，起会话必须显式给提供方与模型；沿用库项目最近用过的
const MODEL = await (async () => {
  const db = `${homedir()}/.t3/userdata/statev2.sqlite`;
  const sql = `select json_extract(t.payload_json,'$.modelSelection.instanceId'), json_extract(t.payload_json,'$.modelSelection.model')
    from orchestration_v2_projection_threads t join projection_projects p on p.project_id = t.project_id
    where p.workspace_root = '${VAULT.replace(/'/g, "''")}' and json_extract(t.payload_json,'$.modelSelection.model') is not null
    order by t.created_at desc limit 1;`;
  const out = await new Promise((res) => execFile('sqlite3', ['-readonly', '-separator', '\t', db, sql], (e, o) => res(String(o || ''))));
  const [provider, model] = out.trim().split('\t');
  return { provider: provider || 'claudeAgent', model: model || '' };
})();

const CFG = {
  base: '__e2e',
  root: '__e2e/任务',
  journal: '__e2e/日记',
  cwd: SANDBOX
};

const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? new Set(args[i + 1].split(',').map((s) => s.trim())) : null;
})();
const skipSlow = args.includes('--skip-slow');

const { ev, close } = await connect();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

// ---------- 页面助手注入 ----------
const INSTALL = String.raw`
(() => {
  if (window.__e2e && window.__e2e.__v === 9) return 'ready';
  const app = window.app;
  const VIEW_SEL = '.workspace-leaf-content[data-type="dada-todo-agent-view"]';
  const root = () => document.querySelector(VIEW_SEL) || document;
  const h = {
    __v: 9,
    app,
    get plugin() { return app.plugins.plugins['dada-todo-agent']; },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    root,
    q: (s) => root().querySelector(s),
    qa: (s) => Array.from(root().querySelectorAll(s)),
    text: (el) => (el ? String(el.textContent || '').trim() : ''),
    click(el) {
      if (!el) throw new Error('click: 元素不存在');
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    },
    dblclick(el) { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return true; },
    ctx(el) { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 })); return true; },
    setVal(el, v) {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    },
    enter(el) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    },
    async read(p) { try { return await app.vault.adapter.read(p); } catch { return null; } },
    async exists(p) { try { return await app.vault.adapter.exists(p); } catch { return false; } },
    async mkdir(p) {
      let cur = '';
      for (const s of String(p).split('/')) {
        cur = cur ? cur + '/' + s : s;
        if (!(await h.exists(cur))) { try { await app.vault.createFolder(cur); } catch {} }
      }
      return true;
    },
    async write(p, text) {
      const f = app.vault.getAbstractFileByPath(p);
      if (f) { await app.vault.modify(f, text); return true; }
      const dir = p.split('/').slice(0, -1).join('/');
      if (dir) await h.mkdir(dir);
      await app.vault.create(p, text);
      return true;
    },
    async rm(p) {
      const f = app.vault.getAbstractFileByPath(p);
      // 目录被外部手工删掉时缓存里还留着，删除会因 ENOENT 抛错，忽略即可
      if (f) await app.vault.delete(f, true).catch(() => {});
      return true;
    },
    async openView() {
      await app.commands.executeCommandById('dada-todo-agent:open-dada-todo-agent');
      return true;
    },
    viewLabel() {
      const b = document.querySelector('.tk-viewpill-item.on .vp-label');
      return b ? b.textContent.trim() : '';
    },
    switchView(key) {
      const map = { day: '日视图', four: '周视图', month: '月视图', agenda: '日程', cl: '清单', matrix: '四象限', project: '项目', all: '列表' };
      const label = map[key] || key;
      const btns = Array.from(document.querySelectorAll('.tk-viewpill-item'));
      const b = btns.find((x) => (x.querySelector('.vp-label') || {}).textContent && x.querySelector('.vp-label').textContent.trim() === label);
      if (!b) throw new Error('找不到视图按钮 ' + label + '；现有：' + btns.map((x) => x.textContent.trim()).join('|'));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    nodes() {
      return Array.from(root().querySelectorAll('.pa-node')).map((el) => ({
        name: ((el.querySelector('.pa-node-name') || {}).textContent || '').trim(),
        active: el.classList.contains('active'),
        count: ((el.querySelector('.pa-cnt') || {}).textContent || '').trim(),
        depth: (() => { let d = 0, n = el; while ((n = n.parentElement)) { if (n.classList && n.classList.contains('pa-nodes')) d++; } return d - 1; })()
      }));
    },
    nodeEl(name) {
      return Array.from(root().querySelectorAll('.pa-node')).find((n) => ((n.querySelector('.pa-node-name') || {}).textContent || '').trim() === name);
    },
    clickNode(name) {
      const el = h.nodeEl(name);
      if (!el) throw new Error('找不到项目节点 ' + name);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    // 展开树里所有折叠的节点：视图重挂载后展开状态会重置，选项目前先摊平
    async expandAll() {
      for (let i = 0; i < 8; i++) {
        const carets = Array.from(root().querySelectorAll('.pa-caret')).filter((c) => c.textContent.trim() !== '▾');
        if (!carets.length) break;
        carets.forEach((c) => c.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await h.sleep(60); // 等 Vue 把子节点渲染出来再展开下一层
      }
      return true;
    },
    ensureExpanded(name) {
      const el = h.nodeEl(name);
      if (!el) throw new Error('找不到项目节点 ' + name);
      const c = el.querySelector('.pa-caret');
      if (c && c.textContent.trim() !== '▾') c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    clickCaret(name) {
      const el = h.nodeEl(name);
      if (!el) throw new Error('找不到项目节点 ' + name);
      const c = el.querySelector('.pa-caret');
      if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    openNodeMenu(name) {
      const el = h.nodeEl(name);
      if (!el) throw new Error('找不到项目节点 ' + name);
      const more = el.querySelector('.pa-node-more');
      if (!more) throw new Error('节点缺少「⋯」按钮');
      more.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    inlineItems() { return Array.from(root().querySelectorAll('.pa-inline-item')).map((m) => m.textContent.trim()); },
    clickInline(text) {
      const it = Array.from(root().querySelectorAll('.pa-inline-item')).find((m) => m.textContent.trim() === text);
      if (!it) throw new Error('内嵌菜单没有 ' + text + '；现有 ' + h.inlineItems().join('|'));
      it.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    menu() { return Array.from(document.querySelectorAll('.menu .menu-item')).map((m) => m.textContent.trim()); },
    clickMenu(text) {
      const it = Array.from(document.querySelectorAll('.menu .menu-item')).find((m) => m.textContent.trim() === text);
      if (!it) throw new Error('菜单项不存在 ' + text + '；现有 ' + h.menu().join('|'));
      it.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    // 插件用自绘输入弹窗（Electron 里 window.prompt 不可用）：预先排好答案，弹窗一出现就填上并确定
    prompt(answers) {
      window.__e2eAnswers = (answers || []).slice();
      if (!h.__askTimer) {
        h.__askTimer = setInterval(async () => {
          const el = document.querySelector('.pa-ask');
          if (!el || el.dataset.e2eDone === '1') return;
          if (!window.__e2eAnswers || !window.__e2eAnswers.length) return;
          const inputs = Array.from(el.querySelectorAll('.pa-ask-input, .pa-ask-field input'));
          if (!inputs.length) return;
          el.dataset.e2eDone = '1';
          const v = window.__e2eAnswers.shift();
          const vals = Array.isArray(v) || (v && typeof v === 'object')
            ? inputs.map((inp, i) => (v && typeof v === 'object' && !Array.isArray(v) ? (v[Object.keys(v)[i]] ?? '') : v[i]))
            : inputs.map(() => v);
          inputs.forEach((inp, i) => h.setVal(inp, String(vals[i] ?? '')));
          await h.sleep(80); // 等 v-model 把值同步进组件状态再点确定
          const ok = el.querySelector('.pa-ask-ok');
          if (ok) ok.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }, 30);
      }
      return true;
    },
    restorePrompt() {
      if (h.__askTimer) { clearInterval(h.__askTimer); h.__askTimer = null; }
      window.__e2eAnswers = [];
      return true;
    },
    tasks() {
      return Array.from(root().querySelectorAll('.pa-task')).map((el) => ({
        title: ((el.querySelector('.pa-task-title') || {}).textContent || '').trim(),
        done: el.classList.contains('done'),
        fly: !!el.querySelector('.pa-fly'),
        dels: Array.from(el.querySelectorAll('.pa-delegation')).map((d) => ({
          state: ((d.querySelector('.pa-delegation-state') || {}).textContent || '').trim(),
          summary: ((d.querySelector('.pa-delegation-sum') || {}).textContent || '').trim(),
          pill: ((d.querySelector('.pa-pill') || {}).textContent || '').trim()
        }))
      }));
    },
    taskEl(title) {
      return Array.from(root().querySelectorAll('.pa-task')).find((el) => ((el.querySelector('.pa-task-title') || {}).textContent || '').trim() === title);
    },
    clickTaskEl(title, sel) {
      const el = h.taskEl(title);
      if (!el) throw new Error('找不到任务行 ' + title);
      const target = sel ? el.querySelector(sel) : el;
      if (!target) throw new Error('任务行 ' + title + ' 缺少 ' + sel);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    addTask(text) {
      const inp = root().querySelector('.pa-new-input');
      if (!inp) throw new Error('找不到新建任务输入框');
      h.setVal(inp, text);
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    },
    sessions() {
      return Array.from(root().querySelectorAll('.pa-session-group')).map((g) => ({
        title: ((g.querySelector('.pa-session-group-h') || {}).textContent || '').trim(),
        items: Array.from(g.querySelectorAll('.pa-session-title')).map((x) => x.textContent.trim())
      }));
    },
    sizes() {
      const v = root().querySelector('.pa-view');
      if (!v) return null;
      const basis = (s) => { const e = v.querySelector(s); return e ? getComputedStyle(e).flexBasis : null; };
      return {
        narrow: v.classList.contains('narrow'),
        tiny: v.classList.contains('tiny'),
        tree: basis('.pa-tree'),
        sessions: basis('.pa-sessions'),
        sessionsShown: !!v.querySelector('.pa-sessions'),
        fly: v.querySelectorAll('.pa-fly').length
      };
    },
    resize(w) { const v = root().querySelector('.pa-view'); if (v) v.style.width = w ? w + 'px' : ''; return true; },
    header() {
      const t = root().querySelector('.pa-main-title');
      const c = root().querySelector('.pa-cwd');
      return { title: (t ? t.textContent : '').trim(), cwd: c ? c.textContent.trim() : '' };
    },
    projSettings(patch) {
      Object.assign(app.plugins.plugins['dada-todo-agent'].settings.project, patch);
      return app.plugins.plugins['dada-todo-agent'].saveSettings();
    },
    errors() { return (window.__e2eErrors || []).slice(); }
  };
  window.__e2e = h;
  window.__e2eErrors = window.__e2eErrors || [];
  window.addEventListener('error', (e) => window.__e2eErrors.push('error: ' + (e.message || e.type)));
  window.addEventListener('unhandledrejection', (e) => window.__e2eErrors.push('rejection: ' + String(e.reason)));
  return 'installed';
})()`;

// ---------- Node 侧封装 ----------
const P = {
  sleep,
  eval: ev,
  async install() { return ev(INSTALL); },
  async read(p) { return ev(`__e2e.read(${J(p)})`); },
  async exists(p) { return ev(`__e2e.exists(${J(p)})`); },
  async write(p, t) { return ev(`__e2e.write(${J(p)}, ${J(t)})`); },
  async rm(p) { return ev(`__e2e.rm(${J(p)})`); },
  async mkdir(p) { return ev(`__e2e.mkdir(${J(p)})`); },
  async openView() { return ev('__e2e.openView()'); },
  async switchView(k) { return ev(`__e2e.switchView(${J(k)})`); },
  async viewLabel() { return ev('__e2e.viewLabel()'); },
  async nodes() { return ev('__e2e.nodes()'); },
  async clickNode(n) { return ev(`__e2e.clickNode(${J(n)})`); },
  async clickCaret(n) { return ev(`__e2e.clickCaret(${J(n)})`); },
  async ensureExpanded(n) { return ev(`__e2e.ensureExpanded(${J(n)})`); },
  async menu() { return ev('__e2e.menu()'); },
  async openNodeMenu(n) { return ev(`__e2e.openNodeMenu(${J(n)})`); },
  async inlineItems() { return ev('__e2e.inlineItems()'); },
  async clickInline(t) { return ev(`__e2e.clickInline(${J(t)})`); },
  async clickMenu(t) { return ev(`__e2e.clickMenu(${J(t)})`); },
  async prompt(a) { return ev(`__e2e.prompt(${J(a)})`); },
  async restorePrompt() { return ev('__e2e.restorePrompt()'); },
  async tasks() { return ev('__e2e.tasks()'); },
  async clickTaskEl(t, sel) { return ev(`__e2e.clickTaskEl(${J(t)}, ${J(sel || '')})`); },
  async dblclickTask(t) { return ev(`__e2e.dblclick(__e2e.taskEl(${J(t)}).querySelector('.pa-task-title'))`); },
  async addTask(t) { return ev(`__e2e.addTask(${J(t)})`); },
  async sessions() { return ev('__e2e.sessions()'); },
  async sizes() { return ev('__e2e.sizes()'); },
  async resize(w) { return ev(`__e2e.resize(${w || 0})`); },
  async header() { return ev('__e2e.header()'); },
  async projSettings(patch) { return ev(`__e2e.projSettings(${J(patch)})`); },
  async errors() { return ev('__e2e.errors()') || []; },
  async q(sel) { return ev(`!!__e2e.q(${J(sel)})`); },
  async count(sel) { return ev(`__e2e.qa(${J(sel)}).length`); },
  async textOf(sel) { return ev(`__e2e.text(__e2e.q(${J(sel)}))`); },
  async waitView() { return poll(() => P.q('.pa-view'), { timeout: 15000, label: '项目视图挂载' }); },
  async waitTask(title) { return poll(async () => (await P.tasks()).some((t) => t.title === title), { timeout: 15000, label: '任务出现：' + title }); },
  async waitFileHas(path, needle, timeout = 15000) {
    return poll(async () => { const t = await P.read(path); return t && t.includes(needle); }, { timeout, label: `${path} 包含 ${needle}` });
  },
  async selectProject(name) {
    // 视图整块重挂载后，树会回到全部折叠状态，所以先摊平再点
    await ev('__e2e.expandAll()');
    await P.clickNode(name);
    await poll(async () => (await P.header()).title === name, { timeout: 8000, label: '选中项目 ' + name });
    await sleep(400);
    return true;
  },
  async remountProject() { await P.switchView('all'); await sleep(300); await P.switchView('project'); await P.waitView(); await sleep(300); }
};

// 项目根下若干测试项目用到的文件路径
const F = {
  工作: `${CFG.root}/工作/task-工作.md`,
  LoopForge: `${CFG.root}/工作/LoopForge/task-LoopForge.md`,
  空项目: `${CFG.root}/空项目/task-空项目.md`,
  归档项目: `${CFG.root}/归档项目/task-归档项目.md`,
  容量项目: `${CFG.root}/容量项目/task-容量项目.md`,
  日期项目: `${CFG.root}/日期项目/task-日期项目.md`
};

async function archiveFiles(dir) {
  return await ev(`(() => { const f = __e2e.app.vault.getFolderByPath(${J(dir)}); return (f ? f.children : []).map((c) => c.name).filter((n) => /^task-\\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\\.md$/.test(n)); })()`);
}

// ---------- 断言与用例框架 ----------
class Skip extends Error {}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const results = [];
async function runCase(id, title, fn, { slow = false } = {}) {
  if (only && !only.has(String(id))) return;
  if (skipSlow && slow) { results.push({ id, title, status: 'SKIP', note: '--skip-slow' }); return; }
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ id, title, status: 'PASS', note: note || '', ms: Date.now() - t0 });
    console.log(`✅ ${id}. ${title}${note ? ' — ' + note : ''}`);
  } catch (e) {
    if (e instanceof Skip) {
      results.push({ id, title, status: 'SKIP', note: e.message, ms: Date.now() - t0 });
      console.log(`⏭️  ${id}. ${title} — ${e.message}`);
    } else {
      results.push({ id, title, status: 'FAIL', note: e.message, ms: Date.now() - t0 });
      console.log(`❌ ${id}. ${title} — ${e.message}`);
    }
  }
}

// ---------- 准备 / 收尾 ----------
const plugin = await ev(`(() => {
  const p = window.app.plugins.plugins['dada-todo-agent'];
  if (!p) return null;
  return { version: p.manifest.version, id: p.manifest.id, viewType: p.viewType, settings: { project: p.settings.project, journalFolder: p.settings.journalFolder } };
})()`);
if (!plugin) throw new Error('插件 dada-todo-agent 未加载');
assert(plugin.id === 'dada-todo-agent', '插件 id 应为 dada-todo-agent，实际 ' + plugin.id);

const backup = JSON.parse(await ev(`JSON.stringify({
  project: window.app.plugins.plugins['dada-todo-agent'].settings.project,
  journalFolder: window.app.plugins.plugins['dada-todo-agent'].settings.journalFolder,
  projectIgnoredThreads: window.app.plugins.plugins['dada-todo-agent'].settings.projectIgnoredThreads || [],
  menuHiddenViews: window.app.plugins.plugins['dada-todo-agent'].settings.menuHiddenViews || []
})`));
await P.install();
await ev('window.__e2eErrors.length = 0');

// 中途退出（Ctrl-C、未捕获异常）也要还原设置：否则用户真实设置会被测试值覆盖
const RESTORE_JS = `(async () => {
  try {
    const p = window.app.plugins.plugins['dada-todo-agent'];
    p.settings.journalFolder = ${J(backup.journalFolder)};
    Object.assign(p.settings.project, ${J(backup.project)});
    p.settings.projectIgnoredThreads = ${J(backup.projectIgnoredThreads || [])};
    p.settings.menuHiddenViews = ${J(backup.menuHiddenViews || [])};
    await p.saveSettings();
  } catch (e) { /* 插件可能已被停用 */ }
  try { await __e2e.rm(${J(CFG.base)}); } catch { /* 目录可能还没建 */ }
  return true;
})()`;
let restoring = false;
async function emergencyRestore(reason) {
  if (restoring) return;
  restoring = true;
  console.error('\n中断（' + reason + '），正在还原插件设置与清理测试目录…');
  try { await ev(RESTORE_JS); } catch (e) { console.error('还原失败，请手工把 projectsRoot 改回「任务」、journalFolder 改回「10-时间轴/日记」，并删除 __e2e/：', e.message); }
}
process.on('SIGINT', () => { emergencyRestore('SIGINT').finally(() => process.exit(130)); });
process.on('uncaughtException', (e) => { console.error(e); emergencyRestore('uncaughtException').finally(() => process.exit(1)); });

await P.rm(CFG.base);
await P.mkdir(CFG.base);
mkdirSync(CFG.cwd, { recursive: true });
if (!skipSlow) await t3ProjectAdd(CFG.cwd);
await ev(`(() => {
  const p = window.app.plugins.plugins['dada-todo-agent'];
  Object.assign(p.settings.project, ${J({
    projectsRoot: CFG.root,
    journalFolder: undefined,
    t3Binary: '',
    t3Provider: MODEL.provider,
    t3Model: MODEL.model,
    projectDefaultCwd: CFG.cwd,
    reverseSync: true,
    reverseSyncSeconds: 15,
    reverseSyncMinMinutes: 0,
    summaryMaxChars: 200,
    syncSince: Date.now() - 3600000
  })});
  delete p.settings.project.journalFolder;
  p.settings.journalFolder = ${J(CFG.journal)};
  p.settings.projectIgnoredThreads = [];
  p.settings.menuHiddenViews = [];
  return p.saveSettings();
})()`);

// 设置改动后重载插件：视图菜单里的显隐是按加载时的设置算的
await ev(`(async () => {
  const app = window.app;
  await app.plugins.disablePlugin('dada-todo-agent');
  await new Promise((r) => setTimeout(r, 400));
  await app.plugins.enablePlugin('dada-todo-agent');
  await new Promise((r) => setTimeout(r, 1200));
  return true;
})()`);
await P.openView();
// 视图壳挂载后可能停在上次用过的子视图（比如「清单」），先切到「项目」再等它渲染
await poll(async () => (await P.count('.tk-viewpill-item')) > 0, { timeout: 15000, label: '视图壳挂载' });
await P.switchView('project');
await P.waitView();
await sleep(500);

// ---------- 用例 ----------
await runCase(1, '嵌套项目：新建父/子项目并解析任务', async () => {
  await P.prompt([{ name: '工作', cwd: '' }]);
  await P.eval(`__e2e.click(__e2e.q('.pa-tree-head .pa-act'))`);
  await poll(async () => P.exists(F.工作), { timeout: 8000, label: '父项目文件创建' });

  await P.openNodeMenu('工作');
  await sleep(150);
  const items = await P.inlineItems();
  assert(items.includes('新建子项目'), '节点菜单缺少「新建子项目」：' + items.join('|'));
  await P.prompt([{ name: 'LoopForge', cwd: '' }]);
  await P.clickInline('新建子项目');
  await poll(async () => P.exists(F.LoopForge), { timeout: 8000, label: '子项目文件创建' });

  await P.ensureExpanded('工作');
  await sleep(200);
  const nodes = await P.nodes();
  const w = nodes.find((n) => n.name === '工作');
  const lf = nodes.find((n) => n.name === 'LoopForge');
  assert(w && lf, '树里应有「工作」与「LoopForge」：' + JSON.stringify(nodes));
  assert(lf.depth > 0, 'LoopForge 应是「工作」的子节点');

  await P.selectProject('LoopForge');
  await P.addTask('设计数据库');
  await P.waitTask('设计数据库');
  await P.addTask('写接口');
  await P.waitTask('写接口');
  await sleep(400);
  const txt = await P.read(F.LoopForge);
  assert(txt.includes('- [ ] 设计数据库'), '项目文件里应有任务行');
  assert(txt.includes('- [ ] 写接口'), '第二条任务行缺失');
  const tasks = await P.tasks();
  eq(tasks.length, 2, '面板任务数');
  const lfNode = (await P.nodes()).find((n) => n.name === 'LoopForge');
  eq(lfNode.count, '2', '子节点未完成计数');
  const wNode = (await P.nodes()).find((n) => n.name === '工作');
  eq(wNode.count, '', '父节点只统计自己文件里的任务，不应把子项目的算进来');
  return '两行任务已落盘，子节点计数 2';
});

await runCase(2, '只有目录没有项目文件：显示空项目，首次建任务时懒创建文件', async () => {
  await P.mkdir(`${CFG.root}/空项目`);
  await P.remountProject();
  const node = (await P.nodes()).find((n) => n.name === '空项目');
  assert(node, '没有项目文件的目录也应出现在树里');
  assert(!(await P.exists(F.空项目)), '此时不应已有项目文件');

  await P.selectProject('空项目');
  eq((await P.tasks()).length, 0, '空项目应没有任务');
  await P.addTask('第一条任务');
  await P.waitTask('第一条任务');
  const txt = await poll(async () => { const t = await P.read(F.空项目); return t && t.includes('第一条任务') ? t : null; }, { timeout: 8000, label: '懒创建项目文件' });
  assert(/tags:\s*(\[[^\]]*todoList|.*todoList)/.test(txt), '新建的项目文件应带 todoList 标记：' + txt.slice(0, 200));
  assert(/type:\s*project/.test(txt), '新建的项目文件应带 type: project');
  return '目录先于文件存在，建任务时自动补文件';
});

await runCase(3, 'cwd：子项目继承父级，设置后覆盖', async () => {
  await P.selectProject('工作');
  await P.openNodeMenu('工作');
  await sleep(150);
  await P.prompt([`${CFG.cwd}/parent`]);
  await P.clickInline('设置 cwd');
  const parentTxt = await poll(async () => { const t = await P.read(F.工作); return t && t.includes('cwd:') ? t : null; }, { timeout: 8000, label: '父项目写入 cwd' });
  await poll(async () => (await P.header()).cwd === `${CFG.cwd}/parent`, { timeout: 8000, label: '标题栏刷新 cwd' });

  await P.ensureExpanded('工作');
  await sleep(200);
  await P.selectProject('LoopForge');
  eq((await P.header()).cwd, `${CFG.cwd}/parent`, '子项目应继承父级 cwd');

  await P.openNodeMenu('LoopForge');
  await sleep(150);
  await P.prompt([CFG.cwd]);
  await P.clickInline('设置 cwd');
  await poll(async () => (await P.header()).cwd === CFG.cwd, { timeout: 8000, label: '子项目标题栏刷新 cwd' });
  const parentTxt2 = await P.read(F.工作);
  assert(parentTxt2.includes(`${CFG.cwd}/parent`), '父项目 cwd 不应被子项目改写');
  return `父级 ${CFG.cwd}/parent，子级 ${CFG.cwd}`;
});

await runCase(4, '重命名项目：目录与项目文件同步改名，任务不丢，选中态保持', async () => {
  await P.ensureExpanded('工作');
  await sleep(150);
  await P.selectProject('LoopForge');
  await P.openNodeMenu('LoopForge');
  await sleep(150);
  await P.prompt(['LoopForge2']);
  await P.clickInline('重命名项目');
  await poll(async () => P.exists(`${CFG.root}/工作/LoopForge2/task-LoopForge2.md`), { timeout: 8000, label: '目录与文件改名' });
  assert(!(await P.exists(`${CFG.root}/工作/LoopForge/task-LoopForge.md`)), '旧路径应不存在');
  const txt = await P.read(`${CFG.root}/工作/LoopForge2/task-LoopForge2.md`);
  assert(txt.includes('设计数据库') && txt.includes('写接口'), '改名后任务不应丢');

  const nodes = await P.nodes();
  const n2 = nodes.find((n) => n.name === 'LoopForge2');
  assert(n2, '树里应显示新名字');
  assert(n2.active, '改名后应保持选中');

  await P.openNodeMenu('LoopForge2');
  await sleep(150);
  await P.prompt(['LoopForge']);
  await P.clickInline('重命名项目');
  await poll(async () => P.exists(F.LoopForge), { timeout: 8000, label: '改回原名' });
  return '目录、项目文件、选中态同步';
});

await runCase(5, '三栏宽度：<720 收会话栏，<520 再收项目树', async () => {
  await sleep(300);
  let s = await P.sizes();
  assert(s && s.tree && s.sessions, '默认应同时显示两栏：' + JSON.stringify(s));
  assert(!s.narrow && !s.tiny, '默认宽度不应是窄布局');

  await P.resize(700);
  await sleep(600);
  s = await P.sizes();
  assert(s.narrow, '700px 时应进入 narrow');
  assert(!s.sessionsShown, '<720px 应收起会话栏');

  await P.resize(480);
  await sleep(600);
  s = await P.sizes();
  assert(s.tiny, '480px 时应进入 tiny');
  const treeHidden = await P.eval(`(() => { const t = __e2e.q('.pa-tree'); return t ? getComputedStyle(t).display === 'none' : true; })()`);
  assert(treeHidden, '<520px 应收起项目树');

  await P.resize(0);
  await sleep(600);
  const btn = await P.eval(`(() => { const b = Array.from(__e2e.root().querySelectorAll('.pa-btn')).find((x) => x.textContent.includes('显示会话')); if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; } return false; })()`);
  assert(btn, '应收起后能手动重新显示会话栏');
  return '230/280px 基准，700px 收右栏，480px 收左栏';
});

await runCase(6, '面板内增删改勾：md 与上游视图同步', async () => {
  await P.selectProject('空项目');
  await P.addTask('待改名任务');
  await P.waitTask('待改名任务');
  await sleep(300);

  await P.prompt(['已改名任务']);
  await P.dblclickTask('待改名任务');
  await P.waitTask('已改名任务');
  assert((await P.read(F.空项目)).includes('已改名任务'), '改名应写回 md');

  await P.clickTaskEl('已改名任务', '.pa-check');
  await poll(async () => (await P.read(F.空项目)).includes('- [x] 已改名任务'), { timeout: 8000, label: '勾选写回 md' });
  const done = (await P.tasks()).find((t) => t.title === '已改名任务');
  assert(done && done.done, '面板应显示已完成');

  await P.addTask('将被删除');
  await P.waitTask('将被删除');
  await sleep(300);
  await P.clickTaskEl('将被删除', '.pa-del');
  await poll(async () => !(await P.read(F.空项目)).includes('将被删除'), { timeout: 8000, label: '删除写回 md' });

  await P.switchView('cl');
  await sleep(600);
  const clText = await ev('document.body.innerText.slice(0, 20000)');
  assert(!clText.includes('已改名任务'), '清单视图不应出现项目目录里的任务（应被过滤）');
  assert(await P.q('.tk-clview-wrap'), '清单视图应正常渲染');

  await P.switchView('project');
  await P.waitView();
  await P.selectProject('空项目');
  const titles = (await P.tasks()).map((t) => t.title);
  assert(titles.includes('已改名任务'), '回到项目视图任务仍在：' + titles.join('|'));
  return '新增 / 双击改名 / 勾选 / 删除均写回 md；项目文件不进清单视图';
});

await runCase(7, '✈ 只出现在项目视图，不影响其它视图', async () => {
  await P.switchView('project');
  await P.waitView();
  await P.selectProject('空项目');
  assert((await P.sizes()).fly > 0, '项目视图应有 ✈');

  for (const v of ['day', 'four', 'month', 'agenda', 'cl', 'matrix', 'all']) {
    await P.switchView(v);
    await sleep(500);
    assert(!(await P.q('.pa-fly')), `视图 ${v} 不应出现 ✈`);
    assert(await P.q('.tk-body'), `视图 ${v} 未渲染`);
    const label = await P.viewLabel();
    assert(label, `视图 ${v} 切换后菜单应有选中项`);
  }
  await P.switchView('project');
  await P.waitView();
  return '其它 7 个视图都没有 ✈';
});

await runCase(16, '归档：单条与批量把整条任务（含子行）搬到归档文件', async () => {
  await P.projSettings({ projectsRoot: CFG.root });
  await P.switchView('project');
  await P.waitView();
  await P.mkdir(CFG.root);
  await P.write(`${CFG.root}/归档项目/task-归档项目.md`, `---
type: project
tags: [todoList]
---

- [x] 归档甲
- [ ] 归档乙
`);
  await P.remountProject();
  await P.clickNode('归档项目');
  await sleep(500);

  await P.clickTaskEl('归档甲', '.pa-act[title="归档"]');
  await sleep(800);
  const proj = await P.read(F.归档项目);
  assert(!proj.includes('归档甲'), '单条归档后项目文件不应再有该任务');
  const archives = await archiveFiles(`${CFG.root}/归档项目`);
  assert(archives.length === 1, '应生成一个归档文件：' + JSON.stringify(archives));
  const arcTxt = await P.read(`${CFG.root}/归档项目/${archives[0]}`);
  assert(arcTxt.includes('归档甲'), '归档文件里应有该任务');

  await P.addTask('归档丙');
  await P.waitTask('归档丙');
  await sleep(300);
  await P.clickTaskEl('归档丙', '.pa-check');
  await poll(async () => (await P.read(F.归档项目)).includes('- [x] 归档丙'), { timeout: 8000, label: '勾选丙' });
  await P.eval(`(() => { const b = Array.from(__e2e.root().querySelectorAll('.pa-btn')).find((x) => x.textContent.includes('归档已完成')); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await poll(async () => !(await P.read(F.归档项目)).includes('归档丙'), { timeout: 8000, label: '批量归档' });
  const arcTxt2 = await P.read(`${CFG.root}/归档项目/${archives[0]}`);
  assert(arcTxt2.includes('归档丙'), '批量归档应写入同一个归档文件');
  return '单条 + 批量均落到 task-<日期>.md';
});

await runCase(17, '归档上限：满 100 条父任务后再归档会新建文件', async () => {
  const dir = `${CFG.root}/容量项目`;
  const lines = Array.from({ length: 100 }, (_, i) => `- [x] 容量任务${String(i + 1).padStart(3, '0')} 📅 2026-11-01`).join('\n');
  await P.write(`${dir}/task-容量项目.md`, `---\ntype: project\ntags: [todoList]\n---\n\n${lines}\n`);
  await P.remountProject();
  await P.clickNode('容量项目');
  await sleep(800);
  await P.eval(`(() => { const b = Array.from(__e2e.root().querySelectorAll('.pa-btn')).find((x) => x.textContent.includes('归档已完成')); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await poll(async () => { const t = await P.read(F.容量项目); return t && !t.includes('容量任务001'); }, { timeout: 15000, label: '100 条批量归档' });

  await P.addTask('第 101 条');
  await P.waitTask('第 101 条');
  await sleep(300);
  await P.clickTaskEl('第 101 条', '.pa-check');
  await poll(async () => (await P.read(F.容量项目)).includes('- [x] 第 101 条'), { timeout: 8000, label: '勾选第 101 条' });
  await P.eval(`(() => { const b = Array.from(__e2e.root().querySelectorAll('.pa-btn')).find((x) => x.textContent.includes('归档已完成')); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(1200);

  const names = (await archiveFiles(dir)).sort();
  assert(names.length >= 2, '满 100 条后应新建第二个归档文件：' + JSON.stringify(names));
  const first = await P.read(`${dir}/${names[0]}`);
  const countFirst = (first.match(/^- \[x\] 容量任务/gm) || []).length;
  eq(countFirst, 100, '第一个归档文件的父任务数');
  return `生成 ${names.join(' / ')}`;
});

await runCase(18, '归档文件名：多日期写区间，单日期写单个日期', async () => {
  const dir = `${CFG.root}/日期项目`;
  await P.write(`${dir}/task-日期项目.md`, `---
type: project
tags: [todoList]
---

- [x] 范围甲 📅 2026-11-01
- [x] 范围乙 📅 2026-11-05
`);
  await P.remountProject();
  await P.clickNode('日期项目');
  await sleep(500);
  await P.eval(`(() => { const b = Array.from(__e2e.root().querySelectorAll('.pa-btn')).find((x) => x.textContent.includes('归档已完成')); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await poll(async () => { const t = await P.read(`${dir}/task-日期项目.md`); return t && !t.includes('范围甲'); }, { timeout: 10000, label: '日期范围归档' });
  const names = await archiveFiles(dir);
  assert(names.some((n) => n.includes('2026-11-01~2026-11-05')), '多日期应写区间名：' + JSON.stringify(names));

  // 单日期要单独放一个项目：归档会复用同目录里未满 100 条的归档文件
  const dir2 = `${CFG.root}/单日项目`;
  await P.write(`${dir2}/task-单日项目.md`, `---
type: project
tags: [todoList]
---

- [x] 单日丙 📅 2026-11-09
`);
  await P.remountProject();
  await P.selectProject('单日项目');
  await P.eval(`(() => { const b = Array.from(__e2e.root().querySelectorAll('.pa-btn')).find((x) => x.textContent.includes('归档已完成')); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await poll(async () => { const t = await P.read(`${dir2}/task-单日项目.md`); return t && !t.includes('单日丙'); }, { timeout: 10000, label: '单日期归档' });
  const names2 = await archiveFiles(dir2);
  assert(names2.some((n) => /2026-11-09(~2026-11-09)?/.test(n)), '单日期应写单日期名：' + JSON.stringify(names2));
  return names.concat(names2).join(' / ');
});

await runCase(20, '回归：7 个视图都能正常切换与渲染', async () => {
  for (const v of ['day', 'four', 'month', 'agenda', 'cl', 'matrix', 'all', 'project']) {
    await P.switchView(v);
    await sleep(700);
    const ok = await P.eval(`!!__e2e.q('.tk-body') || !!__e2e.q('.pa-view')`);
    assert(ok, `视图 ${v} 渲染失败`);
  }
  await P.waitView();
  return '日/周/月/日程/清单/四象限/列表/项目 均正常';
});

// ---------- 依赖真实 T3 Code 的用例 ----------
const real = (fn) => fn;

await runCase(8, '委派：点 ✈ 起真实会话，cwd 正确，结束后回写摘要与跳转', real(async () => {
  await P.switchView('project');
  await P.waitView();
  await sleep(300);
  await P.ensureExpanded('工作');
  await sleep(200);
  await P.selectProject('LoopForge');
  const before = (await P.tasks()).length;
  assert(before >= 2, 'LoopForge 应至少有两条任务');

  await P.clickTaskEl('设计数据库', '.pa-fly');
  await sleep(300);
  assert(await P.q('.pa-modal-mask'), '点 ✈ 应弹出委派弹窗');
  await P.eval(`(() => { const ta = __e2e.q('.pa-modal textarea'); __e2e.setVal(ta, '请只回复两个字：收到'); return true; })()`);
  await P.eval(`(() => { const b = __e2e.q('.pa-modal .pa-btn.primary'); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);

  // 子行是「先写文件、面板等委派结束才刷新」，所以占位行要直接看文件
  const runningLine = await poll(async () => {
    const t = await P.read(F.LoopForge);
    return t && /⚡ t3:?\s*$|进行中…/.test(t) ? t.split('\n').find((l) => /进行中…/.test(l)) : null;
  }, { timeout: 30000, label: '占位委派子行写入文件' });
  assert(runningLine, '应先写入「进行中」占位子行');

  const done = await poll(async () => {
    const t = (await P.tasks()).find((x) => x.title === '设计数据库');
    const d = t && t.dels.find((x) => x.state === '完成' || x.state === '失败');
    return d ? { task: t, d } : null;
  }, { timeout: 300000, interval: 2000, label: '委派结束回写' });
  eq(done.d.state, '完成', '委派应成功完成：' + JSON.stringify(done.d));

  const txt = await P.read(F.LoopForge);
  const line = txt.split('\n').find((l) => l.includes('⚡ t3:'));
  assert(line, 'md 里应写入带会话 id 的委派子行');
  // CLI 返回的会话 id 可能带 mcp: 前缀，按「mark 后的整段」取
  const threadId = (line.match(/⚡ t3:(\S+)/) || [])[1];
  assert(threadId, '子行应包含完整会话 id：' + line);

  const rows = JSON.parse(await execT3(['thread', 'list', '--json']));
  const hit = rows.find((r) => r.threadId === threadId);
  assert(hit, 'T3 Code 里应能查到该会话：' + threadId);
  // T3 Code 把 cwd 归一到已登记项目的根目录，所以只要「项目 cwd 落在它下面」就算对
  const dbCwd = await t3CwdOf(threadId);
  assert(dbCwd && (CFG.cwd === dbCwd || CFG.cwd.startsWith(dbCwd + '/')), `会话 cwd 应落在项目 cwd 内：T3 记录 ${dbCwd}，项目 cwd ${CFG.cwd}`);
  assert(done.task.dels.some((d) => d.pill.includes('⚡')), '子行应有可点击的 ⚡ 跳转');
  return `会话 ${threadId.slice(0, 8)}，cwd ${CFG.cwd}`;
}));

await runCase(9, '等待回答：右栏「待你处理」出现该会话', real(async () => {
  await P.selectProject('LoopForge');
  await P.addTask('等待回答用例');
  await P.waitTask('等待回答用例');
  await sleep(300);
  await P.clickTaskEl('等待回答用例', '.pa-fly');
  await sleep(300);
  await P.eval(`(() => { const ta = __e2e.q('.pa-modal textarea'); __e2e.setVal(ta, '在继续之前，请先用 AskUserQuestion 工具问我一个问题：先做哪一部分？等我回答后再动手。'); return true; })()`);
  await P.eval(`(() => { const b = __e2e.q('.pa-modal .pa-btn.primary'); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);

  const awaiting = await poll(async () => {
    const t = (await P.tasks()).find((x) => x.title === '等待回答用例');
    return t && t.dels.find((d) => d.state === '待回答');
  }, { timeout: 180000, interval: 3000, label: '进入待回答' }).catch(() => null);
  if (!awaiting) throw new Skip('模型没有触发提问（无法在自动化里稳定复现），状态映射由单测覆盖');

  const groups = await P.sessions();
  const g = groups.find((x) => x.title.startsWith('待你处理'));
  assert(g && g.items.length > 0, '右栏「待你处理」应列出该会话：' + JSON.stringify(groups));
  return '子行与右栏都识别为待回答';
}));

await runCase(10, '失败的委派：子行标失败，父任务状态不变', real(async () => {
  await P.projSettings({ t3Binary: '/nonexistent/t3-e2e' });
  try {
  await P.selectProject('空项目');
  await P.clickTaskEl('已改名任务', '.pa-fly');
  await sleep(300);
  await P.eval(`(() => { const b = __e2e.q('.pa-modal .pa-btn.primary'); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);

  const failed = await poll(async () => {
    const t = (await P.tasks()).find((x) => x.title === '已改名任务');
    return t && t.dels.find((d) => d.state === '失败');
  }, { timeout: 60000, label: '失败子行' });
  assert(failed, '应出现失败子行');
  const txt = await P.read(F.空项目);
  assert(/- \[-\]/.test(txt), '失败子行应写成 - [-]：' + txt);
  assert(txt.includes('- [x] 已改名任务'), '父任务状态不应被失败影响');
  return '- [-] 落盘，父任务仍为已完成';
  } finally {
    await P.projSettings({ t3Binary: '' });
  }
}));

await runCase(11, '同一任务连续委派两次：两条子行互不覆盖', real(async () => {
  await P.selectProject('LoopForge');
  const t0 = (await P.tasks()).find((x) => x.title === '设计数据库');
  const n0 = t0.dels.length;
  await P.clickTaskEl('设计数据库', '.pa-fly');
  await sleep(300);
  await P.eval(`(() => { const ta = __e2e.q('.pa-modal textarea'); __e2e.setVal(ta, '请只回复：第二次'); return true; })()`);
  await P.eval(`(() => { const b = __e2e.q('.pa-modal .pa-btn.primary'); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);

  const t1 = await poll(async () => {
    const t = (await P.tasks()).find((x) => x.title === '设计数据库');
    return t && t.dels.length > n0 ? t : null;
  }, { timeout: 30000, label: '第二条子行' });
  const done = await poll(async () => {
    const t = (await P.tasks()).find((x) => x.title === '设计数据库');
    const ok = t.dels.filter((d) => d.state === '完成').length;
    return t.dels.length > n0 && ok >= 2 ? t : null;
  }, { timeout: 300000, interval: 3000, label: '两次均完成' });
  eq(done.dels.filter((d) => d.state === '完成').length >= 2, true, '应有两条完成子行：' + JSON.stringify(done.dels));
  const txt = await P.read(F.LoopForge);
  const ids = [...txt.matchAll(/⚡ t3:(\S+)/g)].map((m) => m[1]);
  const uniq = new Set(ids.filter((x) => x));
  assert(uniq.size >= 2, 'md 里应有两个不同的会话 id：' + JSON.stringify(ids));
  return `${uniq.size} 条独立会话`;
}));

// ---------- 反向同步：外部起来自 T3 Code 的会话 ----------

async function t3ProjectAdd(dir) {
  try { await execT3(['project', 'add', dir, '--title', 'dada-e2e-sandbox'], { cwd: VAULT }); }
  catch (e) { if (!/already|exists|已存在/i.test(e.message)) throw e; }
}

async function t3ProjectRemove(dir) {
  try { await execT3(['project', 'remove', dir, '--force'], { cwd: VAULT }); } catch (e) { console.warn('清理测试项目失败：', e.message); }
}

async function execT3(args, opts = {}) {
  const { execFile } = await import('node:child_process');
  // t3 的命令要求在某个 T3 项目目录内执行；库根就是已登记项目
  return await new Promise((res, rej) => {
    execFile('t3', args, { cwd: opts.cwd || CFG.cwd, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => {
      if (e && !out) return rej(new Error('t3 ' + args.join(' ') + ' 失败：' + ((err || '').trim() || (e.message || '').trim())));
      res(out);
    });
  });
}

async function t3CwdOf(threadId) {
  const { execFile } = await import('node:child_process');
  const { homedir } = await import('node:os');
  const db = `${homedir()}/.t3/userdata/statev2.sqlite`;
  const sql = `select coalesce(p.workspace_root, '') from orchestration_v2_projection_threads t left join projection_projects p on p.project_id = t.project_id where t.thread_id = '${String(threadId).replace(/'/g, "''")}' limit 1;`;
  return await new Promise((res, rej) => {
    execFile('sqlite3', ['-readonly', db, sql], (e, out) => (e ? rej(e) : res(String(out).trim())));
  });
}

// T3 Code 把会话的 cwd 记成「所在 T3 项目的根目录」：库根就是已登记项目，
// 所以在库根起的会话会被记成库根。测试据此把项目 cwd 设成库根来验证归属。
const externalThreadIds = [];

async function startExternalThread(cwd, prompt) {
  // 直接把提示词当参数传：'-' 表示从 stdin 读，而 execFile 的 stdin 是空的
  const flags = MODEL.model ? ['--provider', MODEL.provider, '--model', MODEL.model] : [];
  const out = await execT3(['thread', 'start', cwd, prompt, ...flags, '--json', '--wait']);
  let parsed = null;
  try { parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch {}
  const id = parsed && (parsed.threadId || (parsed.thread && parsed.thread.id));
  if (!id) throw new Error('外部会话没有拿到 threadId：' + out.slice(0, 300));
  externalThreadIds.push(id);
  return id;
}

await runCase(12, '反向同步：外部会话按 cwd 归属到项目', real(async () => {
  // T3 把会话 cwd 记成项目根，所以沙盒里起的会话只有「项目 cwd = 沙盒根」才归属得上。
  // 兜底 cwd 改成别处，避免其它没设 cwd 的项目也继承沙盒根、抢走归属
  await P.projSettings({ projectDefaultCwd: `${SANDBOX}/none` });
  await P.selectProject('LoopForge');
  await P.openNodeMenu('LoopForge');
  await sleep(150);
  await P.prompt([SANDBOX]);
  await P.clickInline('设置 cwd');
  await poll(async () => (await P.header()).cwd === SANDBOX, { timeout: 8000, label: '项目 cwd 设为沙盒根' });

  const id = await startExternalThread(SANDBOX, '反向同步用例：请只回复 OK');
  const hit = await poll(async () => (await P.read(F.LoopForge)).includes(id), { timeout: 90000, interval: 2000, label: '同步进项目文件' });
  const txt = await P.read(F.LoopForge);
  const lines = txt.split('\n');
  const at = lines.findIndex((l) => l.includes(id));
  assert(at > 0, '会话行应位于任务下方');
  // 委派子行是缩进的任务行，挂在自动生成的同名父任务下面
  assert(/^[ \t]+- \[.\]/.test(lines[at]), '委派记录应是缩进的任务行：' + lines[at]);
  const parent = lines.slice(0, at).reverse().find((l) => /^- \[.\]/.test(l));
  assert(parent && /反向同步用例/.test(parent), '应生成一条同名父任务：' + parent);
  return `会话 ${id.slice(0, 8)} → task-LoopForge.md`;
}));

await runCase(13, '反向同步：cwd 不命中项目时进当天日记', real(async () => {
  // 把项目 cwd 指到沙盒下的子目录，同一个沙盒根会话就对不上了 → 落到当天日记
  await P.selectProject('LoopForge');
  await P.openNodeMenu('LoopForge');
  await sleep(150);
  await P.prompt([`${SANDBOX}/nested`]);
  await P.clickInline('设置 cwd');
  await poll(async () => (await P.header()).cwd === `${SANDBOX}/nested`, { timeout: 8000, label: '项目 cwd 改到子目录' });

  const id = await startExternalThread(SANDBOX, '日记归属用例：请只回复 OK');
  const findJournal = async () => ev(`(async () => {
    const f = __e2e.app.vault.getFolderByPath(${J(CFG.journal)});
    if (!f) return null;
    const files = [];
    const walk = (n) => { for (const c of n.children || []) { if (c.children) walk(c); else files.push(c.path); } };
    walk(f);
    for (const p of files) { const t = await __e2e.read(p); if (t && t.includes(${J(id)})) return { path: p, text: t }; }
    return null;
  })()`);
  const hit = await poll(findJournal, { timeout: 90000, interval: 2000, label: '同步进日记' });
  assert(hit.text.includes('日记归属用例'), '日记里应有同名任务：' + hit.text.slice(0, 400));
  return hit.path;
}));

await runCase(14, '已由插件的委派不会被反向同步重复创建', real(async () => {
  const txt = await P.read(F.LoopForge);
  const ids = [...txt.matchAll(/⚡ t3:(\S+)/g)].map((m) => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  eq(dup.length, 0, '同一会话 id 不应出现两次：' + JSON.stringify(ids));
  const before = (await P.read(F.LoopForge)).split('\n').filter((l) => /^- \[.\]/.test(l)).length;
  await P.sleep(20000);
  const after = (await P.read(F.LoopForge)).split('\n').filter((l) => /^- \[.\]/.test(l)).length;
  eq(after, before, '多跑一个同步周期后任务行数不应变化');
  return '会话 id 唯一，任务行数稳定';
}));

await runCase(15, '删除自动同步来的任务后，后续扫描不再生成', real(async () => {
  const txt = await P.read(F.LoopForge);
  const lines = txt.split('\n');
  const parentIdx = lines.findIndex((l) => /^- \[.\] 反向同步用例/.test(l));
  assert(parentIdx >= 0, '前置：应已有反向同步生成的任务');
  const prefix = '反向同步用例';
  await P.selectProject('LoopForge');
  await sleep(300);
  await ev(`(() => {
    const row = Array.from(__e2e.root().querySelectorAll('.pa-task')).find((el) => ((el.querySelector('.pa-task-title') || {}).textContent || '').trim().startsWith(${J(prefix)}));
    if (!row) throw new Error('找不到同步生成的任务行');
    row.querySelector('.pa-del').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await poll(async () => !(await P.read(F.LoopForge)).includes('反向同步用例'), { timeout: 8000, label: '删除同步任务' });
  await P.sleep(20000);
  assert(!(await P.read(F.LoopForge)).includes('反向同步用例'), '后续同步不应重新生成该任务');
  return '删除后不再回灌';
}));

// ---------- 收尾 ----------
const errors = await P.errors();
const errLines = errors.filter((e) => !/ResizeObserver|Failed to load resource/i.test(e));

// 删掉沙盒对应的 T3 项目：本项目下的会话一并消失，不留测试痕迹
if (!skipSlow) await t3ProjectRemove(CFG.cwd);
const ignoredAfter = Array.from(new Set([...(backup.projectIgnoredThreads || []), ...externalThreadIds]));

await ev(`(async () => {
  const p = window.app.plugins.plugins['dada-todo-agent'];
  p.settings.journalFolder = ${J(backup.journalFolder)};
  Object.assign(p.settings.project, ${J(backup.project)});
  p.settings.projectIgnoredThreads = ${J(ignoredAfter)};
  p.settings.menuHiddenViews = ${J(backup.menuHiddenViews || [])};
  await p.saveSettings();
  if (!${J(!!process.env.E2E_KEEP)}) await __e2e.rm(${J(CFG.base)});
  __e2e.restorePrompt();
  return true;
})()`);

await runCase(19, '工程：插件加载无控制台报错、版本与构建产物一致', async () => {
  eq(plugin.version, '0.13.0', '插件版本');
  eq(plugin.viewType, 'dada-todo-agent-view', '视图类型');
  assert(errLines.length === 0, '控制台不应有报错：' + errLines.join(' || '));
  return `版本 ${plugin.version}，零控制台错误`;
});

close();

const pass = results.filter((r) => r.status === 'PASS').length;
const skip = results.filter((r) => r.status === 'SKIP').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
console.log('\n' + '='.repeat(60));
for (const r of results) {
  console.log(`${r.status.padEnd(4)} ${String(r.id).padStart(2)}. ${r.title}${r.note ? '\n       ' + r.note : ''}`);
}
console.log('='.repeat(60));
console.log(`通过 ${pass} / 跳过 ${skip} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
