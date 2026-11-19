#!/usr/bin/env node
// 协议层 E2E：不打 Obsidian，直接驱动本机 T3 MCP，验证对话弹窗依赖的四条链路。
//   node scripts/e2e-conversation.mjs --live
// 会真实创建/复用一条 [E2E] 会话并让 agent 跑两轮，消耗模型额度；跑完归档。
import { execFile } from 'node:child_process';
import { T3Client } from '../src/project/t3-client.js';

const LIVE = process.argv.includes('--live');
const TITLE = '[E2E] 对话弹窗';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(step, detail = '') {
  console.log(`[e2e] ${step}${detail ? ` — ${detail}` : ''}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function poll(fn, { timeoutMs = 60000, intervalMs = 1500, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
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

function sqliteJson(sql) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', `${process.env.HOME}/.t3/userdata/statev2.sqlite`, sql], (error, out) => {
      if (error) reject(error);
      else {
        try { resolve(JSON.parse(out || '[]')); } catch (e) { reject(e); }
      }
    });
  });
}

async function main() {
  if (!LIVE) {
    console.log('这是真实调用 T3 的 E2E，请加 --live 再跑：node scripts/e2e-conversation.mjs --live');
    process.exit(2);
  }

  const client = new T3Client({ request: fetchRequest });
  const nonce = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let threadId = null;

  try {
    log('1/7 找到项目并复用测试会话');
    const projects = await client.callTool('t3_project_list', {});
    const project = (projects?.projects || []).find((p) => p.workspaceRoot === process.cwd());
    assert(project, `T3 里找不到项目 ${process.cwd()}`);
    const found = await client.callTool('t3_thread_list', { projectId: project.id, titleContains: 'E2E' });
    const existing = (found?.threads || []).find((t) => t.title === TITLE && !t.archived);
    if (existing) {
      threadId = existing.threadId || existing.id;
      log('复用会话', threadId);
    } else {
      const caps = await client.callTool('orchestrator_capabilities', {});
      const provider = (caps?.providers || []).find((p) => p.providerInstanceId === 'claudeAgent' && p.models?.length);
      assert(provider, '没有可用的 claudeAgent provider');
      const model = provider.models.find((m) => m.id === 'claude-haiku-5-5') || provider.models[0];
      const launched = await client.callTool('t3_thread_launch', {
        projectId: project.id,
        title: TITLE,
        modelSelection: { instanceId: provider.providerInstanceId, model: model.id },
        message: `这是对话弹窗的 E2E 会话。请只回复一句：E2E 会话已就绪（nonce: ${nonce}）。`
      });
      threadId = launched?.threadId || launched?.thread?.threadId;
      log('新建会话', threadId);
    }
    assert(threadId, '没有拿到 threadId');

    log('2/7 读最后一页并校验有序');
    await waitIdle(client, threadId);
    const latest = await client.readMessages(threadId, { limit: 20 });
    const items = latest?.items || [];
    assert(items.length > 0, '最后一页没有消息');
    const positions = items.map((i) => i.position);
    assert(positions.every((p, i) => i === 0 || p >= positions[i - 1]), '页内 position 不是升序');
    assert(positions[positions.length - 1] > 0, '最后一页停在了最早的位置');
    const latestAssistant = [...items].reverse().find((i) => i.type === 'assistant_message');
    assert(latestAssistant, '最后一页没有 assistant 消息');
    log('最新 assistant', latestAssistant.text.slice(0, 40));

    log('3/7 发送消息并等待 T3 收到');
    const sent = `e2e-send-${nonce}`;
    await client.sendMessage(threadId, sent, { mode: 'queue' });
    const receipt = await poll(async () => {
      const page = await client.readMessages(threadId, { limit: 20 });
      return (page?.items || []).find((i) => i.type === 'user_message' && i.text.includes(sent));
    }, { timeoutMs: 15000, label: 'T3 收到消息' });
    log('T3 已收到', `position ${receipt.position}`);

    log('4/7 等待 agent 回复');
    const reply = await poll(async () => {
      const page = await client.readMessages(threadId, { limit: 20 });
      const after = (page?.items || []).filter((i) => i.position > receipt.position);
      return after.find((i) => i.type === 'assistant_message');
    }, { timeoutMs: 120000, intervalMs: 3000, label: 'agent 回复' });
    log('收到回复', reply.text.slice(0, 40));

    log('5/7 让 agent 发起两个提问');
    await client.sendMessage(threadId, [
      '只做一件事：调用 AskUserQuestion 提出两个问题，然后停下等待回答。',
      '第一题 header「E2E 选择」、question「选一个颜色」、options 红/蓝/绿，单选，required 为 true。',
      '第二题 header「E2E 自定义」、question「用一句话描述这个测试」，allowCustomAnswer 设为 true。'
    ].join('\n'), { mode: 'queue' });

    const requestId = await poll(async () => {
      const list = await client.listPending(threadId);
      return (list?.requestIds || [])[0] || null;
    }, { timeoutMs: 120000, intervalMs: 3000, label: 'T3 提问' });
    log('拿到提问', requestId);

    log('6/7 读取并回答提问');
    const detail = await client.readPending(threadId, requestId);
    const questions = detail?.questions || [];
    assert(questions.length === 2, `应有 2 个问题，实际 ${questions.length}`);
    assert(questions.every((q) => Array.isArray(q.options)), '问题缺少 options');
    // 实测 T3 的 AskUserQuestion 不暴露 allowCustomAnswer / required，
    // 桌面端的「Other」与必答都是隐式行为；这里按同样口径断言。
    const choice = questions.find((q) => (q.options || []).length >= 3);
    const custom = questions.find((q) => q !== choice);
    assert(choice, '没有找到带三个选项的问题');
    assert(custom, '没有找到第二个问题');

    const answers = {};
    const firstOption = choice.options[0];
    answers[choice.id] = firstOption.value ?? firstOption.label;
    answers[custom.id] = `e2e-custom-${nonce}`;
    log('提交回答', JSON.stringify(answers));

    await client.respondPending(threadId, requestId, answers);
    await poll(async () => {
      const list = await client.listPending(threadId);
      return (list?.requestIds || []).length === 0;
    }, { timeoutMs: 20000, label: '提问被消费' });
    log('提问已提交');

    const rows = await sqliteJson(
      `select payload_json from orchestration_v2_projection_runtime_requests where runtime_request_id = '${requestId.replace(/'/g, "''")}'`
    );
    const payload = rows[0] ? JSON.parse(rows[0].payload_json) : null;
    assert(payload?.answers, '数据库里没有记录 answers');
    assert(payload.answers[choice.id] === answers[choice.id], `选择答案不匹配：${JSON.stringify(payload.answers)}`);
    assert(payload.answers[custom.id] === answers[custom.id], `自定义答案不匹配：${JSON.stringify(payload.answers)}`);
    log('落库答案', JSON.stringify(payload.answers));

    log('7/7 等待后续回复');
    const followUp = await poll(async () => {
      const page = await client.readMessages(threadId, { limit: 20 });
      return (page?.items || []).find((i) => i.position > reply.position && i.type === 'assistant_message'
        && !i.text.includes('E2E 会话已就绪'));
    }, { timeoutMs: 120000, intervalMs: 3000, label: '回答后的回复' });
    log('后续回复', followUp.text.slice(0, 40));

    console.log(`\n[e2e] 全部通过。threadId=${threadId}`);
  } finally {
    if (threadId) {
      try {
        // 还在等回答或还在跑时归档会掐断 provider 流，必须等它停稳。
        const page = await client.readMessages(threadId, { limit: 1 });
        if (ACTIVE.has(page?.thread?.status) || page?.thread?.pendingRequestCount > 0) {
          console.warn('[e2e] 会话仍在运行或等待回答，跳过归档：', threadId);
        } else {
          await client.callTool('t3_thread_organize', { action: 'archive', threadId });
          log('已归档测试会话', threadId);
        }
      } catch (error) {
        console.warn('[e2e] 归档失败：', error.message);
      }
    }
  }
}

async function waitIdle(client, threadId, timeoutMs = 120000) {
  await poll(async () => {
    const page = await client.readMessages(threadId, { limit: 1 });
    return !ACTIVE.has(page?.thread?.status);
  }, { timeoutMs, intervalMs: 3000, label: '会话空闲' });
}

main().catch((error) => {
  console.error('\n[e2e] 失败：', error.message);
  process.exit(1);
});
