// 会话对话弹窗：外壳照 obsidian-agent-deck 的 ConversationModal，
// 正文与提问换成 T3 本机 MCP 的可写通道（读最新一页、发消息、答提问）。
import { Component, MarkdownRenderer, Modal, Notice, setIcon } from 'obsidian';
import * as rt from './runtime.js';
import { threadTitleOf } from './reverse-sync.js';
import { workspaceLabel } from './session-groups.js';
import { buildAnswers, isActiveStatus, isSendKey, normalizeMessages, shouldStickToBottom } from './conversation.js';
import { getT3Client } from './t3-obsidian.js';
import { isModeEscalation } from './t3-client.js';
import { T3AuthModal } from './auth-modal.js';
import { T3_ICON } from './assets/t3code-icon.js';
import { t } from '../core/i18n/index.js';

const POLL_MS = 1500;
const MESSAGE_LIMIT = 50;
const AGENT_COLOR = '#6f8ab8';

function setLucide(el, name) {
  el.textContent = '';
  try { setIcon(el, name); } catch { /* 图标缺失时留空 */ }
  el.classList.add('ad-icon');
  return el;
}

function actionButton(parent, label, iconName, cls) {
  const btn = parent.createEl('button', { cls, attr: { type: 'button' } });
  setLucide(btn.createSpan({ cls: 'ad-btn__ico' }), iconName);
  btn.createSpan({ text: label });
  return btn;
}

export class ConversationModal extends Modal {
  constructor(app, plugin, thread) {
    super(app);
    this.plugin = plugin;
    this.thread = thread;
    this.client = getT3Client(plugin);
    this.messages = [];
    this.pending = [];
    this.drafts = {};
    this.status = thread.state || null;
    this.error = null;
    this.loading = false;
    this.sending = false;
    this.stick = true;
    this.signature = '';
    this.pendingSignature = '';
    this.timer = null;
    this.closed = false;
  }

  async onOpen() {
    const el = this.contentEl;
    el.addClass('dada-conversation');
    this.modalEl.addClass('dada-conversation-modal');
    el.style.setProperty('--ad-agent', AGENT_COLOR);

    this.buildHeader(el);
    this.messagesEl = el.createDiv({ cls: 'ad-conversation__messages', attr: { 'data-role': 'messages' } });
    this.messagesEl.addEventListener('scroll', () => {
      this.stick = shouldStickToBottom(this.messagesEl);
    });
    this.questionsEl = el.createDiv({ cls: 'dada-questions' });
    this.buildComposer(el);

    await this.load();
    this.timer = window.setInterval(() => {
      if (this.closed) return;
      if (this.modalEl && !this.modalEl.isShown()) return;
      this.load();
    }, POLL_MS);
  }

  buildHeader(el) {
    const head = el.createDiv({ cls: 'ad-conv-head' });
    const meta = head.createDiv({ cls: 'ad-conv-meta' });
    const pill = meta.createSpan({ cls: 'ad-conv-agent' });
    const mark = pill.createSpan({ cls: 'ad-conv-agent__mark' });
    const img = document.createElement('img');
    img.src = T3_ICON;
    img.alt = '';
    img.draggable = false;
    mark.appendChild(img);
    pill.createSpan({ text: 'T3 Code' });

    const parts = [];
    const ws = workspaceLabel(this.thread.cwd);
    if (ws.name) parts.push(ws.opaque ? t('sessions.sessionWorkspace') : ws.name);
    parts.push(String(this.thread.threadId || '').slice(0, 8));
    meta.createSpan({ cls: 'ad-conv-sub', text: parts.join(' · ') });

    this.titleEl = head.createDiv({
      cls: 'ad-modalhead__title ad-conv-title',
      text: threadTitleOf(this.thread) || t('conversation.title')
    });

    const actions = el.createDiv({ cls: 'ad-btnrow ad-conv-actions' });
    const open = actionButton(actions, t('conversation.openInT3'), 'arrow-up-right', 'ad-btn ad-btn--soft');
    open.onclick = () => this.openInT3();
    const refresh = actionButton(actions, t('conversation.refresh'), 'refresh-cw', 'ad-btn ad-btn--ghost ad-conv-refresh');
    refresh.onclick = () => this.load();
  }

  buildComposer(el) {
    const wrap = el.createDiv({ cls: 'dada-composer' });
    this.inputEl = wrap.createEl('textarea', {
      cls: 'dada-composer__input',
      attr: { placeholder: t('conversation.placeholder'), rows: '3' }
    });
    this.inputEl.addEventListener('keydown', (event) => {
      if (!isSendKey(event)) return;
      event.preventDefault();
      this.send();
    });
    const row = wrap.createDiv({ cls: 'dada-composer__row' });
    row.createSpan({ cls: 'dada-composer__hint', text: t('conversation.sendHint') });
    // 说明靠右，紧挨发送按钮左侧，不再单独占一行
    const foot = row.createSpan({ cls: 'dada-composer__foot' });
    setLucide(foot.createSpan({ cls: 'ad-conv-foot__ico' }), 'info');
    this.footTextEl = foot.createSpan({ text: t('conversation.foot') });
    this.sendBtn = row.createEl('button', {
      cls: 'ad-btn ad-btn--cta dada-composer__send',
      text: t('conversation.send'),
      attr: { type: 'button' }
    });
    this.sendBtn.onclick = () => this.send();
  }

  async load() {
    if (this.loading || this.closed) return;
    this.loading = true;
    try {
      const res = await this.client.readMessages(this.thread.threadId, { limit: MESSAGE_LIMIT });
      if (this.closed) return;
      this.status = res?.thread?.status || this.status;
      this.messages = normalizeMessages(res?.items, { limit: MESSAGE_LIMIT });
      await this.loadPending();
      this.error = null;
    } catch (error) {
      if (this.closed) return;
      this.error = error;
    } finally {
      this.loading = false;
      if (!this.closed) this.render();
    }
  }

  async loadPending() {
    const list = await this.client.listPending(this.thread.threadId);
    const ids = Array.isArray(list?.requestIds) ? list.requestIds : [];
    const next = [];
    for (const requestId of ids) {
      const detail = await this.client.readPending(this.thread.threadId, requestId);
      if (!detail || !Array.isArray(detail.questions)) continue;
      next.push({ requestId: detail.requestId || requestId, questions: detail.questions });
      for (const q of detail.questions) {
        if (!this.drafts[q.id]) this.drafts[q.id] = { selections: [], custom: '' };
      }
    }
    this.pending = next;
  }

  render() {
    this.renderMessages();
    this.renderQuestions();
    this.renderFoot();
  }

  renderMessages(force = false) {
    const signature = JSON.stringify([
      this.status,
      this.error ? String(this.error.message || this.error) : '',
      this.pending.map((p) => p.requestId).join(','),
      this.messages.map((m) => [m.position, m.role, m.text.length, m.local ? m.failed : 0])
    ]);
    if (!force && signature === this.signature) return;
    this.signature = signature;

    const el = this.messagesEl;
    const keep = force ? true : this.stick;
    el.empty();

    this._md?.unload();
    this._md = new Component();
    this._md.load();

    if (!this.messages.length && !this.error) {
      el.createDiv({ cls: 'ad-conv-empty', text: t('conversation.empty') });
    }
    for (const message of this.messages) {
      this.renderMessage(el, message);
    }
    if (this.error) {
      el.createDiv({
        cls: 'ad-conv-status is-error',
        text: t('conversation.loadFailed', { error: this.error.message || String(this.error) })
      });
    } else if (this.pending.length) {
      el.createDiv({ cls: 'ad-conv-status is-warn', text: t('conversation.waiting') });
    } else if (this.isActive()) {
      el.createDiv({ cls: 'ad-conv-status is-live', text: t('conversation.running') });
    }

    if (keep) {
      el.scrollTop = el.scrollHeight;
      this.stick = true;
    }
  }

  renderMessage(parent, message) {
    const cls = [
      'ad-conversation__message',
      message.role === 'user' ? 'is-user' : 'is-assistant',
      message.local ? 'is-local' : '',
      message.failed ? 'is-failed' : ''
    ].filter(Boolean).join(' ');
    const card = parent.createDiv({ cls, attr: { 'data-role': message.role } });
    const roleRow = card.createDiv({ cls: 'ad-conv-msg__role' });
    if (message.role === 'user') {
      setLucide(roleRow.createSpan(), 'user');
      roleRow.createSpan({ text: t('conversation.you') });
    } else {
      const ico = roleRow.createSpan();
      const img = document.createElement('img');
      img.src = T3_ICON;
      img.alt = '';
      img.draggable = false;
      img.style.width = '13px';
      img.style.height = '13px';
      img.style.borderRadius = '24%';
      ico.appendChild(img);
      roleRow.createSpan({ text: t('conversation.assistant') });
    }
    const body = card.createDiv({ cls: 'ad-conv-msg__body' });
    if (message.role === 'user') {
      body.createDiv({ text: message.text });
    } else {
      MarkdownRenderer.render(this.app, message.text, body, '', this._md).catch(() => {
        body.textContent = message.text;
      });
    }
    if (message.failed) {
      card.createDiv({ cls: 'ad-conv-status is-error', text: t('conversation.sendFailedShort') });
    }
  }

  renderQuestions() {
    const signature = JSON.stringify(this.pending.map((p) => p.requestId));
    if (signature === this.pendingSignature) return;
    this.pendingSignature = signature;
    const el = this.questionsEl;
    el.empty();
    for (const request of this.pending) {
      this.renderRequest(el, request);
    }
  }

  renderRequest(parent, request) {
    const card = parent.createDiv({ cls: 'dada-question', attr: { 'data-request-id': request.requestId } });
    let submit = null;
    const refreshSubmit = () => {
      const { missing } = buildAnswers(request.questions, this.drafts);
      if (submit) submit.disabled = missing.length > 0;
    };
    for (const question of request.questions) {
      const head = card.createDiv({ cls: 'dada-question__header' });
      head.createSpan({ text: question.header || t('conversation.question') });
      if (question.required) head.createSpan({ cls: 'dada-question__required', text: '*' });
      card.createDiv({ cls: 'dada-question__text', text: question.question });
      const options = card.createDiv({ cls: 'dada-question__options' });
      for (const option of question.options || []) {
        const value = option.value ?? option.label;
        const btn = options.createEl('button', {
          cls: 'dada-option',
          attr: { type: 'button', 'data-value': value }
        });
        btn.createSpan({ cls: 'dada-option__label', text: option.label });
        if (option.description) btn.createDiv({ cls: 'dada-option__desc', text: option.description });
        btn.onclick = () => {
          const draft = this.drafts[question.id];
          if (question.multiSelect) {
            draft.selections = draft.selections.includes(value)
              ? draft.selections.filter((v) => v !== value)
              : [...draft.selections, value];
          } else {
            draft.selections = draft.selections[0] === value ? [] : [value];
          }
          this.syncOptionState(card, request);
          refreshSubmit();
        };
        btn.classList.toggle('is-selected', (this.drafts[question.id]?.selections || []).includes(value));
      }
      // T3 实际下发的提问不带 allowCustomAnswer，桌面端也始终提供「Other」，
      // 所以这里无条件给一个自定义输入框；没有选项时它就是唯一的回答方式。
      const input = card.createEl('input', {
        cls: 'dada-question__custom',
        attr: { type: 'text', placeholder: t('conversation.customPlaceholder') }
      });
      input.value = this.drafts[question.id]?.custom || '';
      input.oninput = () => {
        this.drafts[question.id].custom = input.value;
        refreshSubmit();
      };
    }
    const foot = card.createDiv({ cls: 'dada-question__foot' });
    foot.createSpan({ cls: 'dada-question__hint', text: t('conversation.submitHint') });
    submit = foot.createEl('button', {
      cls: 'ad-btn ad-btn--cta dada-question__submit',
      text: t('conversation.submit'),
      attr: { type: 'button' }
    });
    submit.onclick = () => this.submitRequest(request, card, submit);
    refreshSubmit();
  }

  syncOptionState(card, request) {
    const buttons = card.querySelectorAll('.dada-option');
    let i = 0;
    for (const question of request.questions) {
      const selections = this.drafts[question.id]?.selections || [];
      for (const option of question.options || []) {
        const btn = buttons[i++];
        if (!btn) break;
        btn.classList.toggle('is-selected', selections.includes(option.value ?? option.label));
      }
    }
  }

  async submitRequest(request, card, button) {
    const { answers, missing } = buildAnswers(request.questions, this.drafts);
    if (missing.length) return;
    button.disabled = true;
    try {
      // 提交前重取客户端：授权刚完成时，旧 client 里还是 approval-required 的临时 token。
      this.client = getT3Client(this.plugin);
      await this.client.respondPending(this.thread.threadId, request.requestId, answers);
      this.pending = this.pending.filter((p) => p.requestId !== request.requestId);
      this.pendingSignature = '';
      this.render();
      this.load();
    } catch (error) {
      button.disabled = false;
      if (isModeEscalation(error)) {
        this.showAnswerBlocked(card);
        return;
      }
      console.warn('[DadaAgent] 提交回答失败：', error);
      new Notice(t('conversation.answerFailed'));
    }
  }

  // 全权限会话不允许外部客户端代答：给一个明确的就地提示和出口，别只弹一条看不懂的报错。
  showAnswerBlocked(card) {
    if (!card || card.querySelector('.dada-question__blocked')) return;
    const box = card.createDiv({ cls: 'dada-question__blocked' });
    box.createDiv({ cls: 'dada-question__blocked-text', text: t('conversation.answerNeedsApp') });
    const authorize = box.createEl('button', {
      cls: 'ad-btn ad-btn--cta dada-question__authorize',
      text: t('conversation.authorizeAnswer'),
      attr: { type: 'button' }
    });
    authorize.onclick = () => new T3AuthModal(this.app, this.plugin, {
      onDone: () => {
        // 授权成功：换用新客户端，拆掉拦截提示并放开提交按钮，让用户直接补交这次回答。
        this.client = getT3Client(this.plugin);
        card.querySelector('.dada-question__blocked')?.remove();
        const submit = card.querySelector('.dada-question__submit');
        if (submit) submit.disabled = false;
      }
    }).open();
    const open = box.createEl('button', {
      cls: 'ad-btn ad-btn--soft dada-question__open',
      text: t('conversation.openInT3'),
      attr: { type: 'button' }
    });
    open.onclick = () => this.openInT3();
    const submit = card.querySelector('.dada-question__submit');
    if (submit) submit.disabled = true;
  }

  async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.sending) return;
    this.sending = true;
    this.sendBtn.disabled = true;
    const local = { role: 'user', text, local: true, failed: false, position: Number.MAX_SAFE_INTEGER };
    this.messages = [...this.messages, local];
    this.stick = true;
    this.renderMessages(true);
    // 先清空再等 CLI：正好赶上用户接着打字时，不要把新输入一起清掉。
    this.inputEl.value = '';
    try {
      await this.client.sendMessageCli(this.thread.threadId, text);
      window.setTimeout(() => this.load(), 400);
    } catch (error) {
      local.failed = true;
      this.renderMessages(true);
      if (!this.inputEl.value.trim()) this.inputEl.value = text;
      console.warn('[DadaAgent] 发送消息失败：', error);
      new Notice(t('conversation.sendFailed'));
    } finally {
      this.sending = false;
      if (!this.closed) this.sendBtn.disabled = false;
    }
  }

  isActive() {
    return isActiveStatus(this.status);
  }

  renderFoot() {
    if (!this.footTextEl) return;
    if (this.error) {
      this.footTextEl.textContent = t('conversation.t3Down');
      this.inputEl.disabled = true;
      this.sendBtn.disabled = true;
      return;
    }
    this.inputEl.disabled = false;
    this.sendBtn.disabled = this.sending;
    this.footTextEl.textContent = t('conversation.foot');
  }

  openInT3() {
    const url = rt.t3DeepLink(this.thread.threadId);
    if (!url) { new Notice(t('sessions.noDeepLink')); return; }
    if (!rt.openExternal(url)) new Notice(t('sessions.openFailed'));
  }

  onClose() {
    this.closed = true;
    if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
    this._md?.unload();
    this.contentEl.empty();
  }
}
