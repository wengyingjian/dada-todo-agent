// T3 Code 本机 MCP 客户端：读消息、发消息、取/答用户提问。
// 传输细节与业务解耦：request / issueToken 都可注入，插件里用 Obsidian 的 requestUrl，
// node 脚本里用 fetch，单测里用假函数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_LABEL = 'obsidian-dada-todo-agent';
const DEFAULT_TTL = '12h';
const REQUEST_TIMEOUT_MS = 15000;
const PROTOCOL_VERSION = '2025-06-18';

// ---------- 纯解析 ----------

// MCP 可能返回普通 JSON，也可能返回 SSE（event: message + data: {...}）。
export function parseMcpBody(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  const events = [];
  let data = [];
  const flush = () => {
    if (!data.length) return;
    const joined = data.join('\n');
    data = [];
    try { events.push(JSON.parse(joined)); } catch { /* 跳过坏事件 */ }
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    else if (!line.trim()) flush();
  }
  flush();
  return events.length ? events[events.length - 1] : null;
}

export function pickSessionId(headers) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === 'mcp-session-id' && value) return String(value);
  }
  return null;
}

// tools/call 的返回值：文本里通常是 JSON，解析不了就当纯文本。
export function parseToolResult(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  const text = content.find((c) => c && c.type === 'text')?.text ?? '';
  if (result && result.isError) throw new Error(text || 'T3 MCP 调用失败');
  if (!text) return result ?? null;
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- 本机环境 ----------

export function t3Origin() {
  try {
    const file = path.join(os.homedir(), '.t3', 'userdata', 'server-runtime.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof raw.origin === 'string' && raw.origin ? raw.origin : null;
  } catch {
    return null;
  }
}

export function t3BinaryCandidates(configured) {
  return [
    configured,
    path.join(os.homedir(), '.local', 'bin', 't3'),
    path.join(os.homedir(), '.t3', 'bin', 't3'),
    '/opt/homebrew/bin/t3',
    '/usr/local/bin/t3',
    't3'
  ].filter(Boolean);
}

function newClientRequestId() {
  try { return globalThis.crypto.randomUUID(); } catch { /* 老环境兜底 */ }
  return `dada-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function searchPath() {
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.t3', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
  return [...new Set([...extra, process.env.PATH || ''])].filter(Boolean).join(':');
}

async function issueTokenWithCli(binary, { label, ttl }) {
  const args = [
    'auth', 'session', 'issue',
    '--subject', 'mcp-client',
    '--scope', 'orchestration:read',
    '--scope', 'orchestration:operate',
    '--ttl', ttl,
    '--token-only',
    '--label', label
  ];
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(binary, args, {
      timeout: REQUEST_TIMEOUT_MS,
      env: { ...process.env, PATH: searchPath() }
    }, (error, out, err) => {
      if (error) reject(new Error(String(err || error.message || '').trim() || '无法执行 t3 命令'));
      else resolve({ stdout: String(out || '') });
    });
  });
  const token = stdout.trim().split(/\r?\n/).pop().trim();
  if (token.length < 20) throw new Error('t3 没有返回可用的 token');
  return token;
}

// ---------- 客户端 ----------

export class T3Client {
  // request({ url, method, headers, body, timeoutMs }) => { status, headers, text }
  constructor({ request, issueToken, origin, binary, label = DEFAULT_LABEL, ttl = DEFAULT_TTL } = {}) {
    if (typeof request !== 'function') throw new Error('T3Client 需要 request 实现');
    this.request = request;
    this.binary = binary || null;
    this.origin = origin || null;
    this.label = label;
    this.ttl = ttl;
    this.issueToken = issueToken || ((bin) => issueTokenWithCli(bin || this._findBinary(), { label, ttl }));
    this.token = null;
    this.sessionId = null;
    this.nextId = 1;
  }

  get baseUrl() {
    return `${(this.origin || t3Origin() || 'http://127.0.0.1:3773').replace(/\/+$/, '')}/mcp`;
  }

  reset() {
    this.token = null;
    this.sessionId = null;
  }

  _findBinary() {
    for (const candidate of t3BinaryCandidates(this.binary)) {
      if (candidate === 't3') continue;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        this.binary = candidate;
        return candidate;
      } catch { /* 继续找 */ }
    }
    this.binary = 't3';
    return this.binary;
  }

  async _post(body, { withSession = true } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`
    };
    if (withSession && this.sessionId) headers['mcp-session-id'] = this.sessionId;
    let res;
    try {
      res = await this.request({
        url: this.baseUrl,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeoutMs: REQUEST_TIMEOUT_MS
      });
    } catch (cause) {
      // 本机回环也可能偶发 ECONNRESET / 超时；当作可重试，且不重签 token。
      const error = new Error(`T3 连接失败：${cause?.message || cause}`);
      error.retryable = true;
      throw error;
    }
    const parsed = parseMcpBody(res.text);
    if (res.status === 401 || res.status === 403) {
      const error = new Error('T3 MCP 鉴权失败');
      error.retryable = true;
      error.resetSession = true;
      throw error;
    }
    if (res.status >= 400) throw new Error(parsed?.error?.message || `T3 MCP 返回 ${res.status}`);
    if (parsed && parsed.error) {
      const error = new Error(parsed.error.message || 'T3 MCP 调用失败');
      const message = String(parsed.error.message || '');
      error.retryable = /credential|session|unauthor/i.test(message);
      error.resetSession = error.retryable;
      throw error;
    }
    return { res, parsed };
  }

  // 初始化必须串行：弹窗的轮询与发送可能同时进来，并发 initialize 会互相覆盖 session id。
  async _ensureSession() {
    if (this.token && this.sessionId) return;
    if (!this._initPromise) {
      this._initPromise = this._initialize().finally(() => { this._initPromise = null; });
    }
    return this._initPromise;
  }

  async _initialize() {
    if (!this.token) this.token = await this.issueToken(this.binary || this._findBinary());
    const { res } = await this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dada-todo-agent', version: '1.0.0' }
      }
    }, { withSession: false });
    this.sessionId = pickSessionId(res.headers);
    if (!this.sessionId) throw new Error('T3 MCP 没有返回会话 id');
    await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async callTool(name, args = {}) {
    try {
      return await this._callTool(name, args);
    } catch (error) {
      if (!error.retryable) throw error;
      if (error.resetSession) this.reset();
      return this._callTool(name, args);
    }
  }

  async _callTool(name, args) {
    await this._ensureSession();
    const { parsed } = await this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args }
    });
    return parseToolResult(parsed?.result);
  }

  // 不传 beforePosition 时，T3 会从最早一条开始返回；传一个极大的位置才拿到最后一页，
  // 再用返回的 earlierPosition 继续往前翻。页内顺序是 position 升序。
  async readMessages(threadId, { limit = 50, beforePosition } = {}) {
    return this.callTool('t3_thread_read', {
      threadId,
      limit,
      view: 'messages',
      beforePosition: beforePosition ?? 999999999
    });
  }

  // clientRequestId 让「网络失败后重试」不会重复发一条：T3 按它去重。
  async sendMessage(threadId, message, { mode = 'auto', clientRequestId } = {}) {
    return this.callTool('t3_thread_send', {
      threadId,
      message,
      mode,
      clientRequestId: clientRequestId || newClientRequestId()
    });
  }

  async listPending(threadId) {
    return this.callTool('t3_pending_request', { action: 'list', threadId });
  }

  async readPending(threadId, requestId) {
    return this.callTool('t3_pending_request', { action: 'read', threadId, requestId });
  }

  async respondPending(threadId, requestId, answers) {
    return this.callTool('t3_pending_request', { action: 'respond', threadId, requestId, answers });
  }
}
