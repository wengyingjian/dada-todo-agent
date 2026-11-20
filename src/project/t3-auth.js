// T3 Code 的 MCP OAuth（授权码 + PKCE）。
// 插件用 CLI 签到的是 approval-required 的 token，写不了 full-access 会话；
// 走一次 T3 自己的授权页，把插件升级成 full-access 客户端，就能代答提问。
//
// 流程：本地回环端口收回调 → 动态注册客户端 → 打开 /oauth/mcp/authorize
// → 用户在页面上选 Full access（必要时粘贴一次性配对码）→ 浏览器回跳
// → 用 code + code_verifier 换 30 天的 bearer token。
//
// 纯函数（PKCE / URL / 回调解析 / token 会话 id）可单测；网络与子进程都注入。
import crypto from 'node:crypto';
import http from 'node:http';

export const AUTH_CLIENT_NAME = 'Obsidian Dada Todo Agent';
export const CALLBACK_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PAIRING_TTL = '10m';

export function createPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ origin, clientId, redirectUri, challenge, state }) {
  const url = new URL('/oauth/mcp/authorize', origin);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: `${String(origin).replace(/\/+$/, '')}/mcp`
  }).toString();
  return url.toString();
}

// 回调只接受 code / error 二选一；state 由调用方校验。
export function parseCallback(searchParams) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams || '');
  const state = params.get('state') || '';
  const error = params.get('error');
  if (error) return { error, state };
  const code = params.get('code');
  if (!code) return { error: 'missing_code', state };
  return { code, state };
}

// T3 的 bearer token 是 base64url(JSON) + 签名；会话 id 在载荷的 sid 里。
export function parseSessionId(token) {
  const head = String(token || '').split('.')[0];
  if (!head) return null;
  try {
    const data = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    return typeof data?.sid === 'string' && data.sid ? data.sid : null;
  } catch {
    return null;
  }
}

export class T3AuthFlow {
  // request: obsidianRequest；runCli: runT3Cli；openUrl: 打开系统浏览器
  constructor({
    request, runCli, binary, openUrl,
    clientName = AUTH_CLIENT_NAME,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    if (typeof request !== 'function') throw new Error('T3AuthFlow 需要 request 实现');
    if (typeof runCli !== 'function') throw new Error('T3AuthFlow 需要 runCli 实现');
    if (typeof openUrl !== 'function') throw new Error('T3AuthFlow 需要 openUrl 实现');
    this.request = request;
    this.runCli = runCli;
    this.binary = binary || 't3';
    this.openUrl = openUrl;
    this.clientName = clientName;
    this.timeoutMs = timeoutMs;
  }

  // 返回 { token, expiresAt, origin }。
  async authorize(origin, { onProgress, signal } = {}) {
    const base = String(origin || '').replace(/\/+$/, '');
    if (!base) throw new Error('找不到 T3 Code 的本机地址');
    const { verifier, challenge } = createPkce();
    const state = crypto.randomBytes(16).toString('base64url');
    const server = await this._startServer(state);
    let pairing = null;
    const timer = setTimeout(() => server.cancel(new Error('授权超时，请重试')), this.timeoutMs);
    const onAbort = () => server.cancel(new Error('已取消授权'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      pairing = await this._createPairingCode();
      const clientId = await this._register(base, server.redirectUri);
      const url = buildAuthorizeUrl({ origin: base, clientId, redirectUri: server.redirectUri, challenge, state });
      onProgress?.({ pairingCode: pairing?.credential || '', url });
      this.openUrl(url);

      const result = await server.result;
      if (result.error) throw new Error(callbackError(result.error));
      const grant = await this._exchange(base, {
        code: result.code,
        verifier,
        clientId,
        redirectUri: server.redirectUri
      });
      const expiresAt = new Date(Date.now() + Math.max(0, Number(grant.expires_in) || 0) * 1000).toISOString();
      return { token: grant.access_token, expiresAt, origin: base };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.close();
      if (pairing?.id) await this._revokePairingCode(pairing.id).catch(() => {});
    }
  }

  async _requestJson(url, { body, headers } = {}) {
    const res = await this.request({ url, method: 'POST', headers, body });
    const text = String(res?.text || '');
    if (!res || res.status >= 400) {
      let detail = text;
      try { detail = JSON.parse(text).error_description || detail; } catch { /* 原样 */ }
      throw new Error(String(detail || `T3 授权服务返回 ${res?.status}`).slice(0, 300));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('T3 授权服务返回了无法解析的内容');
    }
  }

  async _createPairingCode() {
    const stdout = await this.runCli(
      this.binary,
      ['auth', 'pairing', 'create', '--ttl', PAIRING_TTL, '--label', this.clientName, '--json'],
      ''
    );
    const raw = String(stdout || '').trim();
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return data?.id && data?.credential ? { id: data.id, credential: data.credential } : null;
    } catch {
      return null;
    }
  }

  async _revokePairingCode(id) {
    await this.runCli(this.binary, ['auth', 'pairing', 'revoke', id], '');
  }

  async _register(base, redirectUri) {
    const registered = await this._requestJson(`${base}/oauth/mcp/register`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: this.clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none'
      })
    });
    if (!registered?.client_id) throw new Error('T3 没有返回 client_id');
    return registered.client_id;
  }

  async _exchange(base, { code, verifier, clientId, redirectUri }) {
    const grant = await this._requestJson(`${base}/oauth/mcp/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier
      }).toString()
    });
    if (!grant?.access_token) throw new Error('T3 没有返回 access_token');
    return grant;
  }

  _startServer(expectedState) {
    let settle;
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const parsed = parseCallback(url.searchParams);
      if (parsed.state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('state mismatch');
        return;
      }
      const ok = !parsed.error;
      res.writeHead(ok ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(resultPage(ok));
      settle.resolve(parsed);
    });

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({
          result,
          redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
          cancel: (error) => settle.reject(error),
          close: () => { try { server.close(); } catch { /* 已关闭 */ } }
        });
      });
    });
  }
}

function callbackError(code) {
  if (code === 'access_denied') return '你在 T3 的授权页里取消了授权';
  if (code === 'missing_code') return 'T3 回调里没有授权码';
  return `T3 授权失败：${code}`;
}

function resultPage(ok) {
  const title = ok ? '已授权' : '授权没有完成';
  const text = ok
    ? '可以关闭这个页面，回到 Obsidian 继续。'
    : '回到 Obsidian 重试，或检查 T3 Code 是否在运行。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:ui-sans-serif,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#17191f}main{text-align:center}h1{font-size:20px}p{color:#4b5060}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}
