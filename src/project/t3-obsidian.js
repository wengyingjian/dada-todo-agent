// Obsidian 侧的 T3 连接：用 requestUrl 绕开渲染进程的 CORS 限制。
// 单独成文件，保证 t3-client.js 保持纯 node，可直接被 node --test 引入。
import { requestUrl } from 'obsidian';
import { T3Client, issueTokenViaCli } from './t3-client.js';

export async function obsidianRequest({ url, method, headers, body }) {
  const res = await requestUrl({ url, method, headers, body, throw: false });
  return { status: res.status, headers: res.headers, text: res.text };
}

// 授权过的全权限 token（OAuth 拿到的，30 天）；过期前 1 分钟就不再用。
export function storedT3Token(plugin) {
  const auth = plugin.settings?.t3Auth;
  if (!auth?.token) return null;
  const expiresAt = Date.parse(auth.expiresAt || '');
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60 * 1000) return null;
  return auth.token;
}

export class T3AuthStore {
  constructor(plugin) { this.plugin = plugin; }

  get() { return this.plugin.settings?.t3Auth || null; }

  async save(auth) {
    this.plugin.settings.t3Auth = auth;
    await this.plugin.saveSettings();
  }

  async clear() {
    if (!this.plugin.settings?.t3Auth) return;
    this.plugin.settings.t3Auth = null;
    await this.plugin.saveSettings();
  }
}

export function getT3Client(plugin) {
  const stored = storedT3Token(plugin);
  // 已有客户端但手里的 token 和存储的不一致（比如在设置页重新授权了）：
  // 丢弃旧客户端，保证拿到的永远是存储里那把钥匙。
  if (plugin._t3Client && stored && plugin._t3Client.token !== stored) {
    dropT3Client(plugin);
  }
  if (plugin._t3Client) return plugin._t3Client;
  // 存的 token 只在第一次 initialize 时用；被 T3 拒掉（401）说明已撤销/过期，
  // 清掉存储并静默退回 CLI 临时 token，日常读写不受影响。
  let seeded = Boolean(stored);
  plugin._t3Client = new T3Client({
    request: obsidianRequest,
    binary: plugin.settings?.project?.t3Binary || null,
    issueToken: async (binary) => {
      if (seeded) {
        seeded = false;
        await new T3AuthStore(plugin).clear();
      }
      return issueTokenViaCli(binary || plugin.settings?.project?.t3Binary || null);
    }
  });
  if (stored) plugin._t3Client.token = stored;
  return plugin._t3Client;
}

// 授权成功后重建客户端：下次取用时会把新 token 作为初始 token 种进去。
export function applyT3Auth(plugin, auth) {
  plugin.settings.t3Auth = auth;
  dropT3Client(plugin);
}

// 撤销授权：清本地 token 并重建客户端（避免继续用旧会话）。
export function dropT3Client(plugin) {
  try { plugin._t3Client?.reset(); } catch { /* 忽略 */ }
  plugin._t3Client = null;
}
