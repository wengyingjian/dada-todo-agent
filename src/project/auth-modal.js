// T3 授权弹窗：走 T3 自己的 OAuth 授权页，把插件升级成 full-access 客户端。
// 用户在页面上选「Full access」；如果页面没有登录态，会要求粘贴这里显示的一次性配对码。
import { Modal, Notice } from 'obsidian';
import * as rt from './runtime.js';
import { t } from '../core/i18n/index.js';
import { T3AuthFlow, parseSessionId } from './t3-auth.js';
import { findT3Binary, runT3Cli, t3Origin } from './t3-client.js';
import { applyT3Auth, dropT3Client, obsidianRequest, storedT3Token, T3AuthStore } from './t3-obsidian.js';

export class T3AuthModal extends Modal {
  constructor(app, plugin, { onDone } = {}) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.busy = false;
    this.state = 'idle'; // idle | waiting | done | failed
    this.error = null;
    this.pairingCode = '';
    this.authorizeUrl = '';
    this.abort = new AbortController();
    this.closed = false;
  }

  onOpen() {
    this.contentEl.addClass('dada-conversation');
    this.contentEl.addClass('dada-auth');
    this.modalEl.addClass('dada-auth-modal');
    this.render();
  }

  binaryPath() {
    return this.plugin.settings?.project?.t3Binary || null;
  }

  authorized() {
    return Boolean(storedT3Token(this.plugin));
  }

  render() {
    const el = this.contentEl;
    el.empty();
    el.createEl('h3', { cls: 'dada-auth__title', text: t('t3auth.title') });
    el.createEl('p', { cls: 'dada-auth__intro', text: t('t3auth.intro') });

    const status = el.createDiv({ cls: 'dada-auth__status' });
    if (this.state === 'waiting') {
      status.setText(t('t3auth.waiting'));
      status.addClass('is-waiting');
    } else if (this.state === 'failed') {
      status.setText(t('t3auth.failed'));
      status.addClass('is-error');
    } else if (this.authorized()) {
      const expiresAt = Date.parse(this.plugin.settings?.t3Auth?.expiresAt || '');
      const date = Number.isFinite(expiresAt) ? new Date(expiresAt).toLocaleDateString() : '';
      status.setText(t('t3auth.authorizedUntil', { date }));
      status.addClass('is-ok');
    } else {
      status.setText(t('t3auth.notAuthorized'));
    }

    if (this.pairingCode) {
      const box = el.createDiv({ cls: 'dada-auth__code' });
      box.createDiv({ cls: 'dada-auth__codehint', text: t('t3auth.codeHint') });
      const row = box.createDiv({ cls: 'dada-auth__coderow' });
      row.createEl('code', { cls: 'dada-auth__codevalue', text: this.pairingCode });
      const copy = row.createEl('button', {
        cls: 'ad-btn ad-btn--soft',
        text: t('t3auth.copy'),
        attr: { type: 'button' }
      });
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(this.pairingCode);
          new Notice(t('t3auth.copied'));
        } catch {
          new Notice(t('t3auth.copyFailed'));
        }
      };
    }

    if (this.authorizeUrl) {
      const links = el.createDiv({ cls: 'dada-auth__links' });
      const reopen = links.createEl('button', {
        cls: 'ad-btn ad-btn--ghost',
        text: t('t3auth.reopen'),
        attr: { type: 'button' }
      });
      reopen.onclick = () => this.openUrl(this.authorizeUrl);
    }

    const actions = el.createDiv({ cls: 'dada-auth__actions' });
    if (this.authorized()) {
      const revoke = actions.createEl('button', {
        cls: 'ad-btn ad-btn--ghost',
        text: t('t3auth.revoke'),
        attr: { type: 'button' }
      });
      revoke.disabled = this.busy;
      revoke.onclick = () => this.revoke();
    }
    const start = actions.createEl('button', {
      cls: 'ad-btn ad-btn--cta',
      text: this.authorized() ? t('t3auth.reauthorize') : t('t3auth.start'),
      attr: { type: 'button' }
    });
    start.disabled = this.busy || this.state === 'waiting';
    start.onclick = () => this.run();
    const close = actions.createEl('button', {
      cls: 'ad-btn ad-btn--ghost',
      text: t('t3auth.close'),
      attr: { type: 'button' }
    });
    close.onclick = () => this.close();
  }

  openUrl(url) {
    if (!url) return;
    if (!rt.openExternal(url)) new Notice(t('t3auth.openFailed'));
  }

  async run() {
    if (this.busy) return;
    const origin = t3Origin();
    if (!origin) {
      this.state = 'failed';
      console.warn('[DadaAgent] 找不到 T3 Code 的本机地址');
      this.render();
      return;
    }
    this.busy = true;
    this.state = 'waiting';
    this.error = null;
    this.pairingCode = '';
    this.authorizeUrl = '';
    this.abort = new AbortController();
    this.render();
    const flow = new T3AuthFlow({
      request: obsidianRequest,
      runCli: runT3Cli,
      binary: findT3Binary(this.binaryPath()),
      openUrl: (url) => {
        if (!rt.openExternal(url)) throw new Error(t('t3auth.openFailed'));
      }
    });
    try {
      const auth = await flow.authorize(origin, {
        signal: this.abort.signal,
        onProgress: ({ pairingCode, url }) => {
          if (this.closed) return;
          this.pairingCode = pairingCode || '';
          this.authorizeUrl = url || '';
          this.render();
        }
      });
      applyT3Auth(this.plugin, auth);
      await this.plugin.saveSettings();
      this.state = 'done';
      this.onDone?.();
      this.busy = false;
      this.render();
      window.setTimeout(() => { if (!this.closed) this.close(); }, 900);
      return;
    } catch (error) {
      if (!this.closed) {
        console.warn('[DadaAgent] T3 授权失败：', error);
        this.state = 'failed';
        this.error = error;
      }
    } finally {
      this.busy = false;
      if (!this.closed) this.render();
    }
  }

  async revoke() {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const token = this.plugin.settings?.t3Auth?.token;
    const sessionId = parseSessionId(token);
    if (sessionId) {
      try {
        await runT3Cli(findT3Binary(this.binaryPath()), ['auth', 'session', 'revoke', sessionId], '');
      } catch (error) {
        console.warn('[DadaAgent] 撤销 T3 授权会话失败：', error);
      }
    }
    await new T3AuthStore(this.plugin).clear();
    dropT3Client(this.plugin);
    this.pairingCode = '';
    this.authorizeUrl = '';
    this.state = 'idle';
    this.busy = false;
    new Notice(t('t3auth.revoked'));
    this.render();
  }

  onClose() {
    this.closed = true;
    this.abort.abort();
    this.contentEl.empty();
  }
}
