// 侧栏渲染回归：sessions-view.js 在重构中丢过模块级常量（AGENT_COLOR/AGENT_SOFT），
// 于是 sessionCard 建出空 div 后抛 ReferenceError，render() 中途中断——侧栏只剩空壳卡片、
// 没有对话按钮，用户看到的就是「侧栏对话打不开」。
// 这里用最小 DOM shim + obsidian 桩直接跑 render()，锁住「每张卡片都完整渲染且带对话按钮」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// ---------- 最小 DOM shim ----------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._cls = new Set();
    this._text = '';
    this.classList = {
      add: (...c) => c.forEach((x) => x && this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      contains: (c) => this._cls.has(c),
      toggle: (c) => (this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c))
    };
    this.style = { setProperty() {}, removeProperty() {} };
    this.attrs = {};
    this.dataset = {};
    this.value = '';
    this.scrollTop = 0;
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) {
    this._cls.clear();
    String(v || '').split(/\s+/).filter(Boolean).forEach((c) => this._cls.add(c));
  }
  get textContent() { return this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get innerText() {
    return this._text + this.children.map((c) => c.innerText).join('');
  }
  setAttr(k, v) { this.attrs[k] = v; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  empty() { this.children = []; this._text = ''; }
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  _mk(tag, o) {
    const el = new El(tag);
    if (typeof o === 'string') el.className = o;
    else if (o) {
      if (o.cls) el.className = o.cls;
      if (o.text != null) el.textContent = o.text;
      if (o.type) el.attrs.type = o.type;
      if (o.attr) Object.assign(el.attrs, o.attr);
    }
    this.appendChild(el);
    return el;
  }
  createDiv(o) { return this._mk('div', o); }
  createSpan(o) { return this._mk('span', o); }
  createEl(tag, o) { return this._mk(tag, o); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let e = this;
    while (e) { if (matches(e, sel)) return e; e = e.parentNode; }
    return null;
  }
}

// 只支持测试里用到的选择器：类名、[attr="v"]、标签名，可组合
function matches(el, sel) {
  const tokens = sel.match(/\.[\w-]+|\[[^\]]+\]|^[A-Za-z][\w-]*/g) || [];
  return tokens.every((tok) => {
    if (tok.startsWith('.')) return el._cls.has(tok.slice(1));
    if (tok.startsWith('[')) {
      const m = tok.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!m) return false;
      if (m[2] === undefined) return m[1] in el.attrs;
      return el.attrs[m[1]] === m[2];
    }
    return el.tagName === tok.toUpperCase();
  });
}

globalThis.document = {
  activeElement: null,
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  querySelectorAll: () => []
};

// ---------- obsidian 桩 ----------
const obsidianStub = `
export class Component {}
export class ItemView { constructor(leaf) { this.leaf = leaf; } }
export class Modal { constructor(app, plugin) { this.app = app; this.plugin = plugin; } open() {} close() {} }
export class Menu { addItem() { return this; } showAtMouseEvent() {} }
export class Notice { constructor() {} }
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class AbstractInputSuggest {}
export class MarkdownRenderer { static async render() {} }
export class TFile {}
export class TFolder {}
export const setIcon = (el) => el;
export const setTooltip = () => {};
export const requestUrl = async () => ({ status: 200, text: '', json: {} });
export const moment = () => { throw new Error('moment not available in test'); };
export default {};
`;
const STUB_URL = pathToFileURL('/tmp/dada-stub-obsidian-sessions.mjs').href;

// runtime.js 只对 sessions-view.js 换成记录版桩：用来锁住 subscribeThreads 的实参形态。
// （曾把签名改成 (plugin, fn) 后侧栏仍按单参调用，回调被当成 plugin，hub 里
//  plugin.registerInterval 直接抛 TypeError，侧栏一打开就是空的。）
const rtCalls = [];
const runtimeStub = `
const calls = globalThis.__dadaRtCalls;
export function subscribeThreads(plugin, fn) {
  calls.push({ name: 'subscribeThreads', args: [plugin, fn] });
  return () => {};
}
export function requestThreadRefresh() { calls.push({ name: 'requestThreadRefresh', args: [] }); }
export function t3DbPath() { return ''; }
export function t3DeepLink() { return ''; }
export function openExternal() { return true; }
export default {};
`;
const RT_STUB_URL = pathToFileURL('/tmp/dada-stub-runtime.mjs').href;
globalThis.__dadaRtCalls = rtCalls;

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'obsidian') return { url: STUB_URL, shortCircuit: true };
    if (spec === './runtime.js' && String(context.parentURL || '').endsWith('/sessions-view.js')) {
      return { url: RT_STUB_URL, shortCircuit: true };
    }
    return next(spec, context);
  },
  load(url, context, next) {
    if (url === STUB_URL) return { format: 'module', source: obsidianStub, shortCircuit: true };
    if (url === RT_STUB_URL) return { format: 'module', source: runtimeStub, shortCircuit: true };
    if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
    return next(url, context);
  }
});

const { SessionsView } = await import('./sessions-view.js');

// 用原型手搓实例：不走 ItemView 构造（桩里没有 Obsidian 的 DOM 扩展）
function makeView(threads) {
  const view = Object.create(SessionsView.prototype);
  view.plugin = { app: {}, viewType: 'dada-todo-agent-view', manifest: { id: 'dada-todo-agent' } };
  view.app = { workspace: {} };
  view.contentEl = new El('div');
  view.threads = threads;
  view.search = '';
  view.selectedCwd = null;
  return view;
}

const T = (id, state, extra = {}) => ({
  threadId: id,
  state,
  cwd: '/Users/me/code/demo',
  updatedAt: Date.now() - 60_000,
  promptCount: 2,
  title: `会话 ${id}`,
  ...extra
});

test('render：每个分组卡片完整渲染，且都带「打开对话」按钮', () => {
  const view = makeView([
    T('run-1', 'running'),
    T('wait-1', 'awaiting'),
    T('done-1', 'completed')
  ]);
  view.render();

  const cards = view.contentEl.querySelectorAll('.ad-sess');
  assert.equal(cards.length, 3, '三个会话都应渲染成卡片');
  for (const card of cards) {
    assert.ok(card.children.length > 0, `卡片 ${card.attrs['data-thread-id']} 不能是空壳（渲染中途抛错的症状）`);
  }
  const buttons = view.contentEl.querySelectorAll('[data-action="conversation"]');
  assert.equal(buttons.length, 3, '每张卡片都必须有对话按钮，否则侧栏「打开对话」无从点起');
});

test('onOpen：订阅中央会话源时必须把 plugin 作为第一个实参传进去', async () => {
  rtCalls.length = 0;
  const view = makeView([]);
  view.addAction = () => {};
  await view.onOpen();
  const sub = rtCalls.find((c) => c.name === 'subscribeThreads');
  assert.ok(sub, 'onOpen 必须订阅 thread-hub');
  assert.equal(sub.args[0], view.plugin, '第一个实参必须是 plugin 实例（传成回调会让 hub 启动时抛 TypeError）');
  assert.equal(typeof sub.args[1], 'function', '第二个实参必须是快照回调');
});

test('render：空列表渲染空态而不是抛错', () => {
  const view = makeView([]);
  assert.doesNotThrow(() => view.render());
  assert.equal(view.contentEl.querySelectorAll('.ad-sess').length, 0);
  assert.ok(view.contentEl.querySelector('.ad-empty'), '应为空态');
});
