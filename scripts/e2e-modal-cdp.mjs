#!/usr/bin/env node
// UI 层 E2E：通过 Chrome DevTools Protocol 驱动真实 Obsidian。
//   open -a Obsidian --args --remote-debugging-port=9223
//   node scripts/e2e-modal-cdp.mjs --live [--keep]
// 覆盖：点开弹窗 / 打开即最新且滚到底 / 发送并被 T3 响应 / 提问选项与自定义回答提交。
// 脚本会自建一条 [E2E] 会话，跑完归档；不修改 vault 内容。
import { T3Client } from '../src/project/t3-client.js';

const LIVE = process.argv.includes('--live');
const KEEP = process.argv.includes('--keep');
const PORT = Number(process.env.OBSIDIAN_CDP_PORT || 9223);
const TITLE = `[E2E] 弹窗 UI ${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(step, detail = '') {
  console.log(`[e2e:ui] ${step}${detail ? ` — ${detail}` : ''}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchRequest({ url, method, headers, body, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

const ACTIVE = new Set(['preparing', 'starting', 'running', 'waiting', 'queued']);

async function poll(fn, { timeoutMs = 60000, intervalMs = 500, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

class Cdp {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const entry = message.id ? this.pending.get(message.id) : null;
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }

  close() { this.ws?.close(); }
}

async function findObsidianTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && /obsidian/i.test(`${t.title} ${t.url}`));
  assert(page, `9223 上没有 Obsidian 页面。请先退出 Obsidian，再用 --remote-debugging-port=${PORT} 启动。`);
  return page.webSocketDebuggerUrl;
}

async function main() {
  if (!LIVE) {
    console.log('这会驱动真实 Obsidian 并让 T3 跑两轮，请加 --live 再跑。');
    process.exit(2);
  }

  const client = new T3Client({ request: fetchRequest });
  const nonce = `e2e-ui-${Date.now()}`;
  let threadId = null;
  let cdp = null;

  try {
    log('1/8 连接 Obsidian（CDP）');
    cdp = new Cdp();
    await cdp.connect(await findObsidianTarget());
    await cdp.send('Runtime.enable');
    const pluginLoaded = await cdp.eval("!!app.plugins.plugins['dada-todo-agent']");
    assert(pluginLoaded, 'Obsidian 里没有加载 dada-todo-agent 插件');

    log('2/8 建一条临时 E2E 会话');
    const projects = await client.callTool('t3_project_list', {});
    const project = (projects?.projects || []).find((p) => p.workspaceRoot === process.cwd());
    assert(project, `T3 里找不到项目 ${process.cwd()}`);
    const caps = await client.callTool('orchestrator_capabilities', {});
    const provider = (caps?.providers || []).find((p) => p.providerInstanceId === 'claudeAgent' && p.models?.length);
    assert(provider, '没有可用的 claudeAgent provider');
    const model = provider.models.find((m) => m.id === 'claude-haiku-5-5') || provider.models[0];
    const launched = await client.callTool('t3_thread_launch', {
      projectId: project.id,
      title: TITLE,
      modelSelection: { instanceId: provider.providerInstanceId, model: model.id },
      message: `E2E 会话：请只回复一句「弹窗测试会话已就绪（${nonce}）」，不要调用工具。`
    });
    threadId = launched?.threadId || launched?.thread?.threadId;
    assert(threadId, '没有拿到 threadId');

    const ready = await poll(async () => {
      const page = await client.readMessages(threadId, { limit: 10 });
      if (ACTIVE.has(page?.thread?.status)) return null;
      return [...(page?.items || [])].reverse().find((i) => i.type === 'assistant_message') || null;
    }, { timeoutMs: 120000, intervalMs: 2000, label: '会话首条回复' });
    log('会话就绪', ready.position);

    log('3/8 打开会话侧栏并等待卡片');
    await cdp.eval("app.commands.executeCommandById('dada-todo-agent:open-sessions'); true");
    const selector = `[data-thread-id="${threadId.replace(/"/g, '\\"')}"]`;
    await poll(() => cdp.eval(`!!document.querySelector('${selector}')`), {
      timeoutMs: 20000, label: '侧栏出现测试卡片'
    });

    log('4/8 点击对话按钮打开弹窗');
    const clicked = await cdp.eval(`(() => {
      const btn = document.querySelector('${selector} [data-action="conversation"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    assert(clicked, '没找到对话按钮');
    await poll(() => cdp.eval("!!document.querySelector('.modal-container .dada-conversation')"), {
      timeoutMs: 10000, label: '弹窗打开'
    });
    log('弹窗已打开');

    log('5/8 断言打开即最新且滚到底');
    await poll(async () => {
      const dom = await cdp.eval(`(() => {
        const m = document.querySelector('.dada-conversation .ad-conversation__messages');
        const cards = [...document.querySelectorAll('.dada-conversation .ad-conversation__message.is-assistant .ad-conv-msg__body')];
        const last = cards[cards.length - 1];
        return {
          hasMessages: !!last,
          last: (last?.innerText || '').replace(/\\s+/g, ' ').trim(),
          gap: m ? m.scrollHeight - m.scrollTop - m.clientHeight : 9999
        };
      })()`);
      return dom.hasMessages && dom.gap <= 4 ? dom : null;
    }, { timeoutMs: 15000, label: '消息渲染并滚到底' });

    const page = await client.readMessages(threadId, { limit: 20 });
    const latest = [...(page?.items || [])].reverse().find((i) => i.type === 'assistant_message');
    const needle = latest.text.replace(/\s+/g, ' ').trim().slice(0, 12);
    const domLast = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.dada-conversation .ad-conversation__message.is-assistant .ad-conv-msg__body')];
      return (cards[cards.length - 1]?.innerText || '').replace(/\\s+/g, ' ').trim();
    })()`);
    assert(domLast.includes(needle), `弹窗末条不是最新回复：dom=${domLast.slice(0, 40)} latest=${latest.text.slice(0, 40)}`);
    log('末条与 T3 最新回复一致');

    log('6/8 在弹窗里发消息');
    const sent = `e2e-ui-send-${nonce}`;
    await cdp.eval(`(() => {
      const input = document.querySelector('.dada-conversation .dada-composer__input');
      input.value = ${JSON.stringify(sent)};
      document.querySelector('.dada-conversation .dada-composer__send').click();
      return true;
    })()`);
    await poll(() => cdp.eval(`(() => {
      const bubbles = [...document.querySelectorAll('.dada-conversation .ad-conversation__message.is-user')];
      return bubbles.some((b) => (b.innerText || '').includes(${JSON.stringify(sent)}));
    })()`), { timeoutMs: 2000, label: '乐观用户气泡' });
    let receipt;
    try {
      receipt = await poll(async () => {
        const p = await client.readMessages(threadId, { limit: 20 });
        return (p?.items || []).find((i) => i.type === 'user_message' && i.text.includes(sent)) || null;
      }, { timeoutMs: 30000, label: 'T3 收到 UI 消息' });
    } catch (error) {
      const ui = await cdp.eval(`(() => ({
        notices: [...document.querySelectorAll('.notice')].map((n) => n.innerText).join(' | '),
        failed: [...document.querySelectorAll('.ad-conversation__message.is-failed')].map((n) => n.innerText).join(' | ')
      }))()`);
      throw new Error(`${error.message}；notices=${ui.notices || '无'}；failed=${ui.failed || '无'}`);
    }
    log('T3 已收到', `position ${receipt.position}`);

    const reply = await poll(async () => {
      const p = await client.readMessages(threadId, { limit: 20 });
      return (p?.items || []).find((i) => i.type === 'assistant_message' && i.position > receipt.position) || null;
    }, { timeoutMs: 120000, intervalMs: 2000, label: 'T3 回复 UI 消息' });
    const replyNeedle = reply.text.replace(/\s+/g, ' ').trim().slice(0, 10);
    await poll(() => cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.dada-conversation .ad-conversation__message.is-assistant .ad-conv-msg__body')];
      const text = (cards[cards.length - 1]?.innerText || '').replace(/\\s+/g, ' ').trim();
      return text.includes(${JSON.stringify(replyNeedle)});
    })()`), { timeoutMs: 15000, label: '弹窗显示新回复' });
    log('弹窗已更新到新回复');

    log('7/8 让 T3 发起提问并检查选项渲染');
    await client.sendMessage(threadId, [
      '只做一件事：调用 AskUserQuestion 提出两个问题，然后停下等待回答。',
      '第一题 header「UI 选择」、question「选一个颜色」、options 红/蓝/绿。',
      '第二题 header「UI 自定义」、question「用一句话描述这个测试」，options 甲/乙。'
    ].join('\n'), { mode: 'queue' });

    const requestId = await poll(async () => {
      const list = await client.listPending(threadId);
      return (list?.requestIds || [])[0] || null;
    }, { timeoutMs: 120000, intervalMs: 2000, label: 'T3 提问' });
    const detail = await client.readPending(threadId, requestId);
    assert(detail?.questions?.length === 2, `应有 2 个问题，实际 ${detail?.questions?.length}`);

    // 一个待答请求渲染成一张卡片，卡片里按问题逐个排；所以断言「问题数」而不是卡片数。
    const rendered = await poll(() => cdp.eval(`(() => {
      const texts = [...document.querySelectorAll('.dada-conversation .dada-question__text')];
      if (texts.length < 2) return null;
      const first = texts[0].closest('.dada-question');
      return {
        questions: texts.length,
        options: first ? first.querySelectorAll('.dada-option').length : 0,
        customInputs: document.querySelectorAll('.dada-question__custom').length
      };
    })()`), { timeoutMs: 30000, label: '提问卡片渲染' });
    assert(rendered.options >= 3, `第一题应渲染 3 个选项，实际 ${rendered.options}`);
    assert(rendered.customInputs >= 2, '每个问题都应提供自定义输入框');
    log('提问渲染正常', JSON.stringify(rendered));

    log('8/8 选择选项 + 输入自定义回答并提交');
    const submitted = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.dada-conversation .dada-question')];
      const option = cards[0].querySelector('.dada-option');
      if (!option) return 'no-option';
      option.click();
      const inputs = [...document.querySelectorAll('.dada-question__custom')];
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[1], ${JSON.stringify(`e2e-ui-custom-${nonce}`)});
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      const submit = cards[0].querySelector('.dada-question__submit');
      if (!submit || submit.disabled) return 'submit-disabled';
      submit.click();
      return 'ok';
    })()`);
    assert(submitted === 'ok', `提交动作失败：${submitted}`);

    await poll(async () => {
      const list = await client.listPending(threadId);
      return (list?.requestIds || []).length === 0;
    }, { timeoutMs: 20000, label: '提问被消费' });
    await poll(() => cdp.eval("!document.querySelector('.dada-conversation .dada-question')"), {
      timeoutMs: 10000, label: '提问卡片消失'
    });
    log('回答已提交，卡片已移除');

    console.log(`\n[e2e:ui] 全部通过。threadId=${threadId}`);
  } finally {
    if (cdp) {
      if (!KEEP) await cdp.eval("document.querySelector('.modal-container .modal-close-button')?.click(); true").catch(() => {});
      cdp.close();
    }
    if (threadId) {
      try {
        const p = await client.readMessages(threadId, { limit: 1 });
        if (ACTIVE.has(p?.thread?.status) || p?.thread?.pendingRequestCount > 0) {
          console.warn('[e2e:ui] 会话仍在运行或等待回答，跳过归档：', threadId);
        } else {
          await client.callTool('t3_thread_organize', { action: 'archive', threadId });
          log('已归档测试会话', threadId);
        }
      } catch (error) {
        console.warn('[e2e:ui] 归档失败：', error.message);
      }
    }
  }
}

main().catch((error) => {
  console.error('\n[e2e:ui] 失败：', error.message);
  process.exit(1);
});
