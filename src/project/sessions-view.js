// 右侧栏「会话」视图：T3 Code 会话按待处理 / 进行中 / 已完成三段展示。
// 卡片 DOM 与样式原样取自 obsidian-agent-deck 的 sessionCard（Apache-2.0），
// 只把数据源换成 dada-todo-agent 自己的 T3 只读查询。
import fs from 'node:fs';
import path from 'node:path';
import { ItemView, Menu, Notice, setIcon } from 'obsidian';
import * as rt from './runtime.js';
import { queryThreads, threadTitleOf } from './reverse-sync.js';
import { groupSessions, isT3DbFile, stateChipOf, timeAgoParts, workspaceLabel } from './session-groups.js';
import { computeTodayStats, fmtMin, weekComparison } from './session-stats.js';
import { searchMatches, filterByProject } from './session-search.js';
import { lattice } from './lattice.js';
import { T3_ICON } from './assets/t3code-icon.js';
import { ConversationModal } from './conversation-modal.js';
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
    this.search = '';
    this._composing = false;
    this.selectedCwd = null; // 项目时间轴点击筛选：null = 全部
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
    const hadFocus = root.querySelector?.('.dada-search__input') === document.activeElement;
    root.empty();
    root.classList.add('dada-sessions');

    this.renderHead(root);
    if (hadFocus) this._refocusSearch = true;

    // 搜索词替换整个仪表盘（同 AgentDeck）：只显示结果列表
    if (this.search) {
      this.renderSearchResults(root);
      return;
    }

    this.renderHero(root);

    const visible = filterByProject(this.threads, this.selectedCwd);
    const groups = groupSessions(visible).filter((g) => g.items.length);
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

  // 顶部栏：搜索框 + 任务面板 toggle / 刷新 / 设置（布局与按钮同 AgentDeck .ad-head）
  renderHead(root) {
    const head = root.createDiv({ cls: 'dada-head' });
    const search = head.createDiv({ cls: 'dada-search' });
    setLucide(search.createSpan({ cls: 'dada-search__icon' }), 'search');
    const input = search.createEl('input', {
      cls: 'dada-search__input',
      type: 'text',
      attr: { placeholder: t('sessions.searchPlaceholder'), spellcheck: false }
    });
    input.value = this.search;
    if (this._refocusSearch) {
      this._refocusSearch = false;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    input.addEventListener('compositionstart', () => { this._composing = true; });
    input.addEventListener('compositionend', () => {
      this._composing = false;
      this.search = input.value;
      this._refocusSearch = true;
      this.render();
    });
    input.addEventListener('input', () => {
      if (this._composing) return;
      const had = !!this.search;
      this.search = input.value;
      if (!!this.search !== had) this.render(); // 有词/无词切换才整页重画
      else if (this.search) this.renderSearchResults(root, true);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.search = '';
        this.render();
      }
    });

    const actions = head.createDiv({ cls: 'dada-head__actions' });
    const panel = actions.createEl('button', {
      cls: 'dada-iconbtn',
      attr: { 'aria-label': t('sessions.openTaskPanel') }
    });
    setLucide(panel.createSpan({ cls: 'dada-iconbtn__icon' }), 'chart-no-axes-combined');
    panel.onclick = () => this.toggleTaskPanel();

    const scan = actions.createEl('button', { cls: 'dada-iconbtn', attr: { 'aria-label': t('sessions.rescan') } });
    setLucide(scan.createSpan({ cls: 'dada-iconbtn__icon' }), 'refresh-cw');
    scan.onclick = () => this.refresh();

    const gear = actions.createEl('button', { cls: 'dada-iconbtn', attr: { 'aria-label': t('sessions.settings') } });
    setLucide(gear.createSpan({ cls: 'dada-iconbtn__icon' }), 'settings-2');
    gear.onclick = () => this.openSettings();
  }

  // 搜索结果区（同 AgentDeck：搜索时替换整个仪表盘）
  renderSearchResults(root, incremental = false) {
    let sec = root.querySelector('.ad-sec--search');
    if (!sec || !incremental) {
      root.querySelectorAll('.ad-sec--search, .ad-hero, .ad-sec, .ad-empty').forEach((el) => el.remove());
      sec = root.createDiv({ cls: 'ad-sec ad-sec--search' });
      const head = sec.createDiv({ cls: 'ad-sechead' });
      const title = head.createDiv({ cls: 'ad-sechead__title' });
      title.createSpan({ text: t('sessions.searchTitle') });
    }
    sec.querySelectorAll('.ad-sessionlist, .ad-sechead__sub, .ad-empty').forEach((el) => el.remove());
    const hits = searchMatches(filterByProject(this.threads, this.selectedCwd), this.search);
    const sub = sec.querySelector('.ad-sechead__title');
    if (sub) sub.createSpan({ cls: 'ad-sechead__sub', text: t('sessions.searchCount', { n: hits.length }) });
    if (!hits.length) {
      const empty = sec.createDiv({ cls: 'ad-empty' });
      empty.createDiv({ cls: 'ad-empty__title', text: t('sessions.searchEmpty') });
      return;
    }
    const list = sec.createDiv({ cls: 'ad-sessionlist' });
    for (const thread of hits) this.sessionCard(list, thread);
  }

  // 摘要面板：协作时长 + 会话数 + 项目时间轴（合并版，替代 AgentDeck 的 dayTimeline + topProjects）
  renderHero(root) {
    const now = Date.now();
    const stats = computeTodayStats(this.threads, now);
    const cmp = weekComparison(this.threads, now);

    const hero = root.createDiv({ cls: 'dada-hero' });
    const nums = hero.createDiv({ cls: 'dada-hero__nums' });

    const wallBox = nums.createDiv({ cls: 'dada-num' });
    wallBox.createDiv({ cls: 'dada-num__v', text: fmtMin(stats.wall) });
    wallBox.createDiv({ cls: 'dada-num__l', text: t('sessions.stats.collab') });
    if (cmp) wallBox.createDiv({ cls: 'dada-num__sub', text: t('sessions.stats.vsWeek', { pct: cmp.pct > 0 ? `+${cmp.pct}` : String(cmp.pct) }) });

    const sessBox = nums.createDiv({ cls: 'dada-num' });
    sessBox.createDiv({ cls: 'dada-num__v', text: String(stats.sessions) });
    sessBox.createDiv({ cls: 'dada-num__l', text: t('sessions.stats.sessions') });
    if (stats.prompts) sessBox.createDiv({ cls: 'dada-num__sub', text: t('sessions.stats.prompts', { n: stats.prompts }) });

    if (!stats.projects.length) {
      hero.createDiv({ cls: 'dada-hero__hint', text: t('sessions.stats.noSessions') });
      return;
    }
    this.renderProjectTimeline(hero, stats);
  }

  // 项目时间轴：一行 = 项目名（超长省略）+ 活动段 lane + 时长；点击行筛选下方卡片，再点取消
  renderProjectTimeline(hero, stats) {
    const tl = stats.timeline;
    const span = Math.max(1, tl.to - tl.from);
    const clock = (m) => {
      const d = new Date(this._dayStartTs() + m * 60000);
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const box = hero.createDiv({ cls: 'dada-day' });
    for (const proj of stats.projects) {
      const selected = this.selectedCwd !== null && proj.cwd === this.selectedCwd;
      const row = box.createDiv({ cls: 'dada-day__row' + (selected ? ' is-selected' : '') });
      row.setAttr('title', `${proj.name} · ${fmtMin(proj.min)}`);
      row.createSpan({ cls: 'dada-day__name', text: proj.name });
      const lane = row.createDiv({ cls: 'dada-day__lane' });
      for (const [s, e] of proj.segs) {
        const seg = lane.createDiv({ cls: 'dada-day__seg' });
        seg.style.left = `${Math.max(0, ((s - tl.from) / span) * 100)}%`;
        seg.style.width = `${Math.min(100, (Math.max(e - s, 2) / span) * 100)}%`;
        seg.title = `${clock(s)}–${clock(e)}`;
      }
      row.createSpan({ cls: 'dada-day__min', text: fmtMin(proj.min) });
      row.onclick = () => {
        this.selectedCwd = this.selectedCwd === proj.cwd ? null : proj.cwd;
        this.render();
      };
    }

    // 「现在」竖线与刻度都放进中间列（第 2 列），与各项目 lane 天然对齐
    const now = box.createDiv({ cls: 'dada-day__now' });
    now.style.gridRow = `1 / ${stats.projects.length + 1}`;
    const nowline = now.createDiv({ cls: 'dada-day__nowline' });
    nowline.style.left = `${Math.min(100, Math.max(0, ((tl.nowMin - tl.from) / span) * 100))}%`;
    const ticks = box.createDiv({ cls: 'dada-day__ticks' });
    ticks.createSpan({ text: clock(tl.from) });
    ticks.createSpan({ text: clock(Math.round((tl.from + tl.to) / 2)) });
    ticks.createSpan({ text: t('sessions.timeline.now') });
  }

  _dayStartTs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  toggleTaskPanel() {
    const { workspace } = this.app.workspace ? this.app : {};
    if (!workspace) return;
    const existing = workspace.getLeavesOfType(this.plugin.viewType);
    if (existing.length) {
      this.app.workspace.detachLeavesOfType(this.plugin.viewType);
      return;
    }
    this.plugin.activateView();
  }

  openSettings() {
    const setting = this.app.setting;
    if (!setting) return;
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }

  // 与 AgentDeck view.js::sessionCard 的 DOM 层级逐行对齐；只删掉本插件没有的数据
  // （token / 子代理 / side chat / 进度文本）。对话按钮与 AgentDeck 一致：
  // 整卡和箭头跳 T3 Code，messages-square 打开对话弹窗。
  sessionCard(parent, thread) {
    const state = thread.state;
    const card = parent.createDiv({
      cls: 'ad-sess has-conversation',
      attr: { 'data-thread-id': thread.threadId }
    });
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

    const conversation = card.createEl('button', {
      cls: 'ad-arrow',
      attr: { 'aria-label': t('conversation.open'), 'data-action': 'conversation' }
    });
    setLucide(conversation.createSpan({ cls: 'ad-arrow__icon' }), 'messages-square');
    conversation.onclick = (e) => { e.stopPropagation(); this.openConversation(thread); };

    const go = card.createEl('button', { cls: 'ad-arrow', attr: { 'aria-label': t('sessions.openSession') } });
    setLucide(go.createSpan({ cls: 'ad-arrow__icon' }), 'arrow-up-right');
    go.onclick = (e) => { e.stopPropagation(); this.openThread(thread); };
    card.onclick = (e) => {
      if (e.target.closest?.('[data-action="conversation"]')) return;
      this.openThread(thread);
    };
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item
        .setTitle(t('conversation.open'))
        .setIcon('messages-square')
        .onClick(() => this.openConversation(thread)));
      menu.addItem((item) => item
        .setTitle(t('sessions.openSession'))
        .setIcon('arrow-up-right')
        .onClick(() => this.openThread(thread)));
      menu.showAtMouseEvent(e);
    });
  }

  openConversation(thread) {
    new ConversationModal(this.app, this.plugin, thread).open();
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
