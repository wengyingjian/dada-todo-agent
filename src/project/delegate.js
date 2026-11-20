// 委派执行：spawn `t3 thread start <cwd> - --json --wait`，结果回写到任务下的子行。
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as API from '../core/api/tasks.js';
import { rewriteSessionLine, locateSessionLine } from './session-line.js';
import { applySummaryToLines } from './summarize-apply.js';
import { buildTranscript, buildSummaryPrompt, countUserPrompts } from './summarize-llm.js';
import { callSummaryLlm } from './summarize-llm-io.js';
import { fetchThreadMessages } from './summarize-io.js';
import { t3DbPath } from './t3-paths.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function findT3Binary(configured = '') {
  const custom = String(configured || '').trim();
  if (custom) return custom;
  const candidates = [
    path.join(homedir(), '.local/bin/t3'),
    path.join(homedir(), '.t3/bin/t3'),
    '/opt/homebrew/bin/t3',
    '/usr/local/bin/t3'
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* next */ }
  }
  return 't3';
}

// 全文档行号（含 frontmatter）→ 正文行号。编辑器 CM6 给的是前者，落盘按后者。
async function toBodyLineNo(plugin, filePath, lineNo, basis) {
  if (basis !== 'document' || !filePath) return lineNo;
  const doc = await API.readListDoc(filePath);
  if (!doc) return lineNo;
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(doc.head);
  const fmLines = m ? m[0].split('\n').length - 1 : 0;
  return Math.max(0, lineNo - fmLines);
}

export function parseT3Output(text) {
  const raw = String(text || '').trim();
  const out = { threadId: '', reply: '' };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    out.threadId = String(parsed?.threadId || parsed?.thread?.id || parsed?.id || '');
    out.reply = String(parsed?.reply || parsed?.result || parsed?.text || parsed?.thread?.lastText || '');
    if (out.threadId || out.reply) return out;
  } catch { /* not json */ }
  out.threadId = (UUID_RE.exec(raw) || [])[0] || '';
  return out;
}

export function summarize(text, maxChars = 200) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > maxChars ? one.slice(0, maxChars - 1) + '…' : one;
}

// opts: { binary, cwd, prompt, provider, model, extraArgs, timeoutMs }
// 返回 Promise<{ code, threadId, reply, stderr }>
export function runT3({ binary, cwd, prompt, provider = '', model = '', extraArgs = [], timeoutMs = 30 * 60000 }) {
  return new Promise((resolve) => {
    const args = ['thread', 'start', cwd, '-', '--json', '--wait'];
    if (provider) args.push('--provider', provider);
    if (model) args.push('--model', model);
    for (const a of extraArgs || []) args.push(a);

    let child;
    try {
      child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, threadId: '', reply: '', stderr: String(e && e.message || e) });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      const parsed = parseT3Output(out);
      resolve({ code, threadId: parsed.threadId, reply: parsed.reply || out.trim(), stderr: err });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish(-2);
    }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); if (err.length > 8000) err = err.slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); err += String(e && e.message || e); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
    try { child.stdin.end(prompt); } catch { /* closed */ }
  });
}

// 子行生命周期：先插入占位（显示委派 prompt 摘要），拿到 threadId 后补标记，
// 最后落状态；completed/failed 时取全会话 transcript 交 LLM 总结（标题+分点）。
export async function startDelegation(plugin, rt, opts) {
  const { node, task, prompt, cwd } = opts;
  const settings = rt.projectSettings(plugin);
  const binary = findT3Binary(settings.t3Binary);
  const maxChars = Number(settings.summaryMaxChars) || 200;

  // 编辑器纸飞机传的是「含 frontmatter 的全文档行号」，项目页传的已经是正文行号；
  // 落盘统一按正文行号，否则子行会整体下移 frontmatter 行数、甚至被追加到文件末尾。
  const parentLineNo = await toBodyLineNo(plugin, node.filePath, task.lineNo, opts.lineNoBasis);
  // 占位行的临时 id：会话 id 要等 CLI 跑起来才有，回填前靠它唯一定位，避免并发委派串行
  const pendingId = Math.random().toString(36).slice(2, 10);
  // 委派发出即显示委派内容摘要，而不是「进行中…」——发出去就能看到委派了什么
  const debut = await rt.appendDelegation(plugin, node, parentLineNo, {
    state: 'running', summary: summarize(prompt, maxChars) || '进行中…', threadId: '', pendingId
  });
  const lineNo = debut.lineNo;

  // 定位本委派的子行：真实 threadId → 占位 id → 插入时行号。
  // 不再按「进行中」文本认领——占位行显示的是 prompt 摘要，旧条件永远匹配不上。
  const locateOwnLine = (lines, threadId) => locateSessionLine(lines, { threadId, pendingId, cachedLineNo: lineNo });

  const finishLine = async (threadId, state, summary) => {
    const doc = await API.readListDoc(node.filePath);
    if (!doc) return;
    const at = locateOwnLine(doc.lines, threadId);
    if (at < 0) return;
    // 只改状态/摘要/标记，保留缩进与父行类型
    const next = rewriteSessionLine(doc.lines[at], { state, title: summary, threadId });
    await API.replaceListLines(node.filePath, at, [next]);
  };

  // 1.5s 后尝试从数据库回填 threadId（CLI 结束时才输出，长会话期间靠扫描回填）。
  // 归属判定：最近 2 分钟内、同 cwd、且数据库 title 与委派 prompt 同源的会话才回填；
  // 无法唯一确定时不回填（子行保留占位，反向同步稍后按 cwd 兜底归属）。
  const backfill = setInterval(async () => {
    try {
      const map = await rt.rebuildDelegationMap(plugin);
      const recent = await rt.recentThreads(plugin, { minutes: 2 });
      const candidates = recent.filter((t) => !map.has(t.threadId) && t.cwd === cwd);
      if (candidates.length === 1) {
        await finishLine(candidates[0].threadId, 'running', summarize(prompt, maxChars) || '进行中…');
        clearInterval(backfill);
      } else if (candidates.length > 1) {
        // 多个候选：按首条用户消息与委派 prompt 的前缀匹配锁定
        const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 40);
        const hit = candidates.find((t) => norm(t.firstUser) === norm(prompt) || norm(prompt).startsWith(norm(t.firstUser)));
        if (hit) {
          await finishLine(hit.threadId, 'running', summarize(prompt, maxChars) || '进行中…');
          clearInterval(backfill);
        }
      }
    } catch { /* ignore */ }
  }, 1500);

  const result = await runT3({
    binary,
    cwd,
    prompt,
    provider: opts.provider || settings.t3Provider || '',
    model: opts.model || settings.t3Model || ''
  });
  clearInterval(backfill);

  let threadId = result.threadId || '';
  // CLI 偶尔只给回复不给 id：从数据库补一次最近同 cwd 的线程，避免子行失去跳转
  if (!threadId && rt && typeof rt.recentThreads === 'function') {
    try {
      const recent = await rt.recentThreads(plugin, { minutes: 5 });
      const hit = recent.find((t) => t.cwd === cwd);
      if (hit) threadId = hit.threadId;
    } catch { /* ignore */ }
  }
  if (result.code === 0) {
    await finishWithSummary(plugin, rt, node, lineNo, threadId, 'completed', { prompt, fallback: summarize(result.reply, maxChars) || '完成', settings, dbPath: t3DbPath(), pendingId });
  } else if (result.code === 2) {
    await finishLine(threadId, 'awaiting', '等你回答…');
  } else {
    await finishWithSummary(plugin, rt, node, lineNo, threadId, 'failed', { prompt, fallback: summarize(result.stderr || result.reply, maxChars) || '失败', settings, dbPath: t3DbPath(), pendingId });
  }
  // 承载文件登记：普通笔记不在项目根/日记夹，反向同步也要能回到这一行
  try { if (typeof rt.registerDelegationFile === 'function') await rt.registerDelegationFile(plugin, node.filePath); } catch { /* 登记失败不影响委派 */ }
  return { threadId, code: result.code };
}

// 完成路径：优先 LLM 总结（标题+分点），失败回退到截断文本。
// 统计已总结的 user prompt 数记进 #count，反向同步据此判断是否需要再总结。
async function finishWithSummary(plugin, rt, node, lineNo, threadId, state, { prompt, fallback, settings, dbPath, pendingId = '' }) {
  let summary = null;
  if (threadId) {
    summary = await summarizeThread(plugin, {
      threadId, dbPath,
      settings,
      delegationPrompt: prompt
    });
  }
  const doc = await API.readListDoc(node.filePath);
  if (!doc) return;
  const { head, lines } = doc;
  // 行号漂移安全定位（与 finishLine 同规则：threadId → 占位 id → 插入行号）
  const at = locateSessionLine(lines, { threadId, pendingId, cachedLineNo: lineNo });
  if (at < 0) return;
  const payload = summary
    ? { state, threadId, summarizedPromptCount: summary.promptCount, title: summary.title, points: summary.points }
    : { state, threadId, summarizedPromptCount: null };
  const title = summary ? summary.title : fallback;
  const r = applySummaryToLines(lines, at, { ...payload, title });
  if (!r.ok) {
    lines[at] = rewriteSessionLine(lines[at], { state, title: fallback, threadId });
  }
  await API.writeListDoc(node.filePath, head, lines);
}

// Electron 主进程网络栈通路：渲染进程 fetch 走 Chromium 栈，对系统代理/内网证书站点
// 会 Failed to fetch；主进程 net.fetch 用系统网络栈，这类站点能通。取不到返回 null。
export function mainProcessFetch() {
  try {
    const { remote } = require('electron');
    const net = remote && remote.net;
    if (net && typeof net.fetch === 'function') return (url, init) => net.fetch(url, init);
  } catch { /* 非 electron 环境 */ }
  return null;
}

// 取会话消息 → 构建 prompt → 调 LLM → 解析。任何一步失败返回 null（调用方回退）。
// LLM 调用失败（网络抖动等）时 3 秒后重试一次；仍失败交给反向同步的静默兜底重总结。
export async function summarizeThread(plugin, { threadId, dbPath, settings, delegationPrompt = '' }) {
  const summarizeOnce = async () => {
    const msgs = await fetchThreadMessages(dbPath || t3DbPath(), threadId);
    if (!msgs.length) return null;
    const promptCount = countUserPrompts(msgs);
    const transcript = buildTranscript(msgs, { maxChars: 24000 });
    const { system, user } = buildSummaryPrompt(delegationPrompt, transcript, settings.summaryPromptTemplate);
    return callSummaryLlm({
      baseUrl: settings.summaryLlmBaseUrl,
      model: settings.summaryLlmModel,
      apiKey: settings.summaryLlmApiKey,
      system, user,
      timeoutMs: (Number(settings.summaryTimeoutSeconds) || 30) * 1000,
      fallbackFetchers: [mainProcessFetch()]
    }).then((llm) => (llm ? { ...llm, promptCount } : null));
  };
  try {
    const first = await summarizeOnce();
    if (first) return first;
    await new Promise((r) => setTimeout(r, 3000));
    return await summarizeOnce();
  } catch {
    return null;
  }
}
