// T3 Code 本机 MCP 客户端：读消息、发消息、取/答用户提问。
// 传输细节与业务解耦：request / issueToken 都可注入，插件里用 Obsidian 的 requestUrl，
// node 脚本里用 fetch，单测里用假函数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const DEFAULT_LABEL = 'obsidian-dada-todo-agent';
const DEFAULT_TTL = '12h';
const REQUEST_TIMEOUT_MS = 15000;
const PROTOCOL_VERSION = '2025-06-18';
// t3_thread_read 默认每条只给 500 字（长回复会被截断），这里直接要到上限；
// 超过上限的再用 itemId + textOffset 续读拼接。
const MAX_CHARS_PER_ITEM = 20000;
const MAX_TEXT_PAGES = 20;

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

// 设置项 → 实际可执行的 t3；都找不到时交给 PATH。
export function findT3Binary(configured) {
  for (const candidate of t3BinaryCandidates(configured)) {
    if (candidate === 't3') continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 继续找 */ }
  }
  return 't3';
}

// 全权限（full-access）会话不允许插件这种外部 MCP 客户端代发/代答：
// T3 会返回 runtime_mode_escalation_denied。CLI 走的是它自己的 full-access 会话，不受限。
export function isModeEscalation(error) {
  return /runtime_mode_escalation_denied/i.test(String(error?.message || error || ''));
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

export async function issueTokenViaCli(binary, { label = DEFAULT_LABEL, ttl = DEFAULT_TTL } = {}) {
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

const CLI_TIMEOUT_MS = 30000;

export function runT3Cli(binary, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, PATH: searchPath() },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('t3 命令超时'));
    }, CLI_TIMEOUT_MS);
    child.on('error', (error) => finish(new Error(`无法执行 t3 命令：${error.message}`)));
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(stderr.trim() || `t3 退出码 ${code}`));
    });
    child.stdin.on('error', () => { /* 进程提前退出时忽略写失败 */ });
    child.stdin.end(input ?? '');
  });
}

// ---------- 客户端 ----------

export class T3Client {
  // request({ url, method, headers, body, timeoutMs }) => { status, headers, text }
  constructor({ request, issueToken, runCli, origin, binary, label = DEFAULT_LABEL, ttl = DEFAULT_TTL } = {}) {
    if (typeof request !== 'function') throw new Error('T3Client 需要 request 实现');
    this.request = request;
    this.binary = binary || null;
    this.origin = origin || null;
    this.label = label;
    this.ttl = ttl;
    this.issueToken = issueToken || ((bin) => issueTokenViaCli(bin || this._findBinary(), { label, ttl }));
    this.runCli = runCli || runT3Cli;
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
    this.binary = findT3Binary(this.binary);
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
  async readMessages(threadId, { limit = 50, beforePosition, maxCharsPerItem = MAX_CHARS_PER_ITEM } = {}) {
    const page = await this.callTool('t3_thread_read', {
      threadId,
      limit,
      view: 'messages',
      beforePosition: beforePosition ?? 999999999,
      maxCharsPerItem
    });
    if (!Array.isArray(page?.items)) return page;
    const items = [];
    for (const item of page.items) {
      items.push(await this._completeItemText(threadId, item, maxCharsPerItem));
    }
    return { ...page, items };
  }

  // T3 对单条内容有上限：超出时返回 textTruncated + nextTextOffset，
  // 用 itemId + textOffset 从断点继续取，拼成完整一条再交给 UI。
  async _completeItemText(threadId, item, maxCharsPerItem) {
    if (!item?.textTruncated || !item.itemId || item.nextTextOffset == null) return item;
    let text = item.text || '';
    let offset = item.nextTextOffset;
    for (let i = 0; i < MAX_TEXT_PAGES; i++) {
      const page = await this.callTool('t3_thread_read', {
        threadId,
        itemId: item.itemId,
        textOffset: offset,
        maxCharsPerItem
      });
      const chunk = Array.isArray(page?.items) ? page.items[0] : null;
      if (!chunk) break;
      text += chunk.text || '';
      if (!chunk.textTruncated || chunk.nextTextOffset == null) break;
      offset = chunk.nextTextOffset;
    }
    return { ...item, text, textTruncated: false, nextTextOffset: null };
  }

  // clientRequestId 让「网络失败后重试」不会重复发一条：T3 按它去重。
  // 仅适用于客户端权限覆盖得住的会话（approval-required）；全权限会话请用 sendMessageCli。
  async sendMessage(threadId, message, { mode = 'auto', clientRequestId } = {}) {
    return this.callTool('t3_thread_send', {
      threadId,
      message,
      mode,
      clientRequestId: clientRequestId || newClientRequestId()
    });
  }

  // 发送消息走 CLI 而不是 MCP：MCP token 最高只能拿到 approval-required，
  // 往 full-access 会话里写会报 runtime_mode_escalation_denied；
  // `t3 thread send` 内部用它自己的 full-access MCP 会话，能覆盖。
  // 消息从 stdin 传入，避免长文本和特殊字符和 argv 纠缠。
  async sendMessageCli(threadId, message) {
    const stdout = await this.runCli(
      this.binary || this._findBinary(),
      ['thread', 'send', threadId, '-', '--json'],
      message
    );
    const raw = String(stdout || '').trim();
    if (!raw) return null;
    try { return JSON.parse(raw.split(/\r?\n/).pop()); } catch { return raw; }
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
