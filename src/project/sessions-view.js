// 右侧栏「会话」视图：T3 Code 会话按待处理 / 进行中 / 已完成三段展示。
// 卡片 DOM 与样式原样取自 obsidian-agent-deck 的 sessionCard（Apache-2.0），
// 只把数据源换成 dada-todo-agent 自己的 T3 只读查询。
import fs from 'node:fs';
import path from 'node:path';
import { ItemView, Menu, Notice, setIcon } from 'obsidian';
import * as rt from './runtime.js';
import { queryThreads, threadTitleOf } from './reverse-sync.js';
import { groupSessions, isT3DbFile, stateChipOf, timeAgoParts, workspaceLabel } from './session-groups.js';
import { lattice } from './lattice.js';
import { T3_ICON } from './assets/t3code-icon.js';
import { t } from '../core/i18n/index.js';

export const SESSIONS_VIEW_TYPE = 'dada-todo-agent-sessions-view';
export const SESSIONS_RIBBON_ICON = 'messages-square';

// AgentDeck 里 T3 Code 的配色（constants.js: t3code）
const AGENT_COLOR = '#6f8ab8';
const AGENT_SOFT = 'rgba(111,138,184,.13)';
// WAL 写入后 400ms 防抖刷新；20 秒轮询只做兜底（与 AgentDeck 的 pollSeconds 默认值一致）
const REFRESH_MS = 20 * 1000;
const DB_WATCH_DEBOUNCE_MS = 400;

const STATE_ICONS = {
  awaiting: 'hand',
  completed: 'check',
  failed: 'triangle-alert',
  cancelled: 'circle-x'
};

function setLucide(el, name) {
  el.textContent = '';
  try { setIcon(el, name); } catch { /* 图标缺失时留空 */ }
  el.classList.add('ad-icon');
  return el;
}

export class SessionsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.threads = [];
    this._loading = false;
    this._timer = null;
    this._watcher = null;
    this._watchTimer = null;
  }

  getViewType() { return SESSIONS_VIEW_TYPE; }
  getDisplayText() { return t('sessions.title'); }
  getIcon() { return SESSIONS_RIBBON_ICON; }

  async onOpen() {
    this.contentEl.classList.add('dada-sessions');
    this.addAction('refresh-cw', t('sessions.refresh'), () => this.refresh());
    await this.refresh();
    this.startDbWatch();
    this._timer = window.setInterval(() => {
      if (this.containerEl && this.containerEl.isShown && !this.containerEl.isShown()) return;
      this.refresh();
    }, REFRESH_MS);
  }

  async onClose() {
    if (this._timer) { window.clearInterval(this._timer); this._timer = null; }
    this.stopDbWatch();
  }

  // T3 用 WAL 写库，会话状态一变 -wal 就会更新；监听目录比定时全量查询更快，
  // 也不会在空闲时反复 fork sqlite3。
  startDbWatch() {
    this.stopDbWatch();
    const db = rt.t3DbPath();
    if (!db) return;
    try {
      this._watcher = fs.watch(path.dirname(db), { persistent: false }, (_event, name) => {
        if (name && !isT3DbFile(name)) return;
        if (this._watchTimer) window.clearTimeout(this._watchTimer);
        this._watchTimer = window.setTimeout(() => {
          this._watchTimer = null;
          this.refresh();
        }, DB_WATCH_DEBOUNCE_MS);
      });
      this._watcher.on?.('error', () => this.stopDbWatch());
    } catch {
      this._watcher = null;
    }
  }

  stopDbWatch() {
    if (this._watchTimer) { window.clearTimeout(this._watchTimer); this._watchTimer = null; }
    try { this._watcher?.close(); } catch { /* 已关闭 */ }
    this._watcher = null;
  }

  async refresh() {
    if (this._loading) return;
    this._loading = true;
    try {
      const db = rt.t3DbPath();
      this.threads = db ? await queryThreads(db, 0).catch(() => []) : [];
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    const root = this.contentEl;
    const scroll = root.scrollTop || 0;
    root.empty();
    root.classList.add('dada-sessions');

    const groups = groupSessions(this.threads).filter((g) => g.items.length);
    if (!groups.length) {
      const empty = root.createDiv({ cls: 'ad-empty' });
      empty.createDiv({ cls: 'ad-empty__title', text: t('sessions.empty') });
      return;
    }

    for (const group of groups) {
      const sec = root.createDiv({ cls: 'ad-sec' });
      const head = sec.createDiv({ cls: 'ad-sechead' });
      const title = head.createDiv({ cls: 'ad-sechead__title' });
      title.createSpan({ text: t(`sessions.groups.${group.key}`) });
      title.createSpan({ cls: 'ad-sechead__sub', text: t('sessions.count', { n: group.items.length }) });
      const list = sec.createDiv({ cls: 'ad-sessionlist' });
      for (const thread of group.items) this.sessionCard(list, thread);
    }
    root.scrollTop = scroll;
  }

  // 与 AgentDeck view.js::sessionCard 的 DOM 层级逐行对齐；只删掉本插件没有的数据
  // （token / 子代理 / side chat / 进度文本）和「查看对话」入口。
  sessionCard(parent, thread) {
    const state = thread.state;
    const card = parent.createDiv({ cls: 'ad-sess' });
    card.style.setProperty('--ad-agent', AGENT_COLOR);
    card.style.setProperty('--ad-agent-soft', AGENT_SOFT);
    if (state === 'running') card.classList.add('is-live');

    const mark = card.createDiv({ cls: 'ad-sess__mark' });
    const glyph = mark.createSpan({ cls: 'ad-glyph ad-glyph--img' });
    const img = document.createElement('img');
    img.src = T3_ICON;
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.className = 'ad-agentimg';
    glyph.appendChild(img);

    const body = card.createDiv({ cls: 'ad-sess__body' });
    const titleRow = body.createDiv({ cls: 'ad-sess__title' });
    titleRow.createSpan({ cls: 'ad-sess__name', text: threadTitleOf(thread) });

    const chipInfo = stateChipOf(state);
    if (chipInfo) {
      const chip = titleRow.createSpan({ cls: `ad-state ${chipInfo.cls}` });
      const icon = chip.createSpan({ cls: 'ad-state__icon' });
      if (state === 'running') lattice(icon, 'orbit');
      else setLucide(icon, STATE_ICONS[state]);
      chip.createSpan({ text: t(`sessions.states.${chipInfo.key}`) });
    }

    const sub = body.createDiv({ cls: 'ad-sess__sub' });
    sub.createSpan({ text: 'T3 Code' });
    const ws = workspaceLabel(thread.cwd);
    if (thread.cwd) {
      sub.createSpan({ text: '·' });
      const label = ws.opaque ? t('sessions.sessionWorkspace') : ws.name;
      sub.createSpan({ cls: 'ad-sess__cwd', text: label, attr: { title: thread.cwd } });
    }
    if (thread.promptCount) {
      sub.createSpan({ text: '·' });
      sub.createSpan({ cls: 'ad-sess__prog', text: t('sessions.prompts', { n: thread.promptCount }) });
    }
    const ago = timeAgoParts(thread.updatedAt);
    if (ago) {
      // 时间单独占第三行，排版沿用 AgentDeck 的 .ad-sess__kin 第三行样式
      const timeLine = body.createDiv({ cls: 'ad-sess__time' });
      timeLine.createSpan({ text: agoText(ago) });
    }

    const go = card.createEl('button', { cls: 'ad-arrow', attr: { 'aria-label': t('sessions.openSession') } });
    setLucide(go.createSpan({ cls: 'ad-arrow__icon' }), 'arrow-up-right');
    go.onclick = (e) => { e.stopPropagation(); this.openThread(thread); };
    card.onclick = () => this.openThread(thread);
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item
        .setTitle(t('sessions.openSession'))
        .setIcon('arrow-up-right')
        .onClick(() => this.openThread(thread)));
      menu.showAtMouseEvent(e);
    });
  }

  openThread(thread) {
    const url = rt.t3DeepLink(thread.threadId);
    if (!url) { new Notice(t('sessions.noDeepLink')); return; }
    if (!rt.openExternal(url)) new Notice(t('sessions.openFailed'));
  }
}

function agoText(parts) {
  if (parts.unit === 'now') return t('sessions.ago.now');
  if (parts.unit === 'min') return t('sessions.ago.min', { n: parts.n });
  if (parts.unit === 'hour') return t('sessions.ago.hour', { n: parts.n });
  return t('sessions.ago.day', { n: parts.n });
}
