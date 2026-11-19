// 委派执行：spawn `t3 thread start <cwd> - --json --wait`，结果回写到任务下的子行。
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { formatDelegationLine, parseDelegationLine, T3_MARK } from './delegate-line.js';

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

// 子行生命周期：先插入占位，拿到 threadId 后补标记，最后落状态
export async function startDelegation(plugin, rt, opts) {
  const { node, task, prompt, cwd } = opts;
  const settings = rt.projectSettings(plugin);
  const binary = findT3Binary(settings.t3Binary);
  const maxChars = Number(settings.summaryMaxChars) || 200;

  const debut = await rt.appendDelegation(plugin, node, task.lineNo, {
    state: 'running', summary: '进行中…', threadId: ''
  });
  const lineNo = debut.lineNo;

  const finishLine = async (threadId, state, summary) => {
    const f = plugin.app.vault.getAbstractFileByPath(node.filePath);
    if (!f) return;
    const { head, lines } = (rt.splitFile ? rt.splitFile(await plugin.app.vault.read(f)) : { head: '', lines: String(await plugin.app.vault.read(f)).split('\n') });
    const target = formatDelegationLine({ state, summary, threadId });
    if (lines[lineNo] != null && /进行中|等你回答/.test(lines[lineNo])) {
      lines[lineNo] = target;
    } else {
      // 行号漂移：找同一 threadId 或占位行
      const idx = lines.findIndex((l) => {
        const d = parseDelegationLine(l);
        return d && d.threadId === threadId;
      });
      const placeholder = lines.findIndex((l) => /进行中…\s*$/.test(l));
      const at = idx >= 0 ? idx : placeholder;
      if (at < 0) return;
      lines[at] = target;
    }
    await plugin.app.vault.modify(f, rt.joinFile ? rt.joinFile(head, lines) : lines.join('\n'));
  };

  // 1.5s 后尝试从数据库回填 threadId（CLI 结束时才输出，长会话期间靠扫描回填）
  const backfill = setInterval(async () => {
    try {
      const map = await rt.rebuildDelegationMap(plugin);
      const recent = await rt.recentThreads(plugin, { minutes: 2 });
      const hit = recent.find((t) => !map.has(t.threadId) && t.cwd === cwd);
      if (hit) {
        await finishLine(hit.threadId, 'running', '进行中…');
        clearInterval(backfill);
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
    await finishLine(threadId, 'completed', summarize(result.reply, maxChars) || '完成');
  } else if (result.code === 2) {
    await finishLine(threadId, 'awaiting', '等你回答…');
  } else {
    await finishLine(threadId, 'failed', summarize(result.stderr || result.reply, maxChars) || '失败');
  }
  return { threadId, code: result.code };
}
