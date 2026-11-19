// I/O 层测试：sqlite 消息读取（注入 execFile）与 LLM 调用（注入 fetch）。不打真库、不真调网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessagesSql, mapMessageRows, fetchThreadMessages } from './summarize-io.js';
import { callSummaryLlm } from './summarize-llm-io.js';

test('buildMessagesSql：取全会话 user/assistant 文本消息，按时间正序', () => {
  const sql = buildMessagesSql('thread-1');
  assert.match(sql, /role IN \('user','assistant'\)/);
  assert.match(sql, /streaming = 0/);
  assert.match(sql, /ORDER BY m\.created_at, m\.message_id/);
  assert.match(sql, /'thread-1'/);
  // 真实用户消息过滤条件存在（createdBy）
  assert.match(sql, /createdBy/);
});

test('mapMessageRows：映射出 role/text/createdBy，tool 注入的 user 消息保留 createdBy 供上层过滤', () => {
  const rows = [
    { role: 'user', payload_json: JSON.stringify({ text: '你好', createdBy: 'user' }) },
    { role: 'user', payload_json: JSON.stringify({ text: '<command-name>foo</command-name>', createdBy: 'tool' }) },
    { role: 'assistant', payload_json: JSON.stringify({ text: '回复' }) },
    { role: 'user', payload_json: '不是json' }
  ];
  const msgs = mapMessageRows(rows);
  assert.deepEqual(msgs, [
    { role: 'user', text: '你好', createdBy: 'user' },
    { role: 'user', text: '<command-name>foo</command-name>', createdBy: 'tool' },
    { role: 'assistant', text: '回复', createdBy: null }
  ]);
});

test('fetchThreadMessages：execFile 失败返回空数组不抛错', async () => {
  const fakeExec = (cmd, args, opts, cb) => cb(new Error('db locked'), '');
  const msgs = await fetchThreadMessages('/db/path', 'thread-1', { execFile: fakeExec });
  assert.deepEqual(msgs, []);
});

test('fetchThreadMessages：正常路径解析 stdout JSON', async () => {
  const rows = [{ role: 'user', payload_json: JSON.stringify({ text: 'hi', createdBy: 'user' }) }];
  const fakeExec = (cmd, args, opts, cb) => cb(null, JSON.stringify(rows));
  const msgs = await fetchThreadMessages('/db/path', 'thread-1', { execFile: fakeExec });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'hi');
});

test('callSummaryLlm：OpenAI 兼容 POST，解析 choices[0].message.content', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '标题: 完成\n1. 第一点' } }] }) };
  };
  const r = await callSummaryLlm({
    baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test',
    system: 'sys', user: 'usr', fetchImpl: fakeFetch, timeoutMs: 5000
  });
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(r.title, '完成');
  assert.deepEqual(r.points, ['第一点']);
});

test('callSummaryLlm：baseUrl 尾部带斜杠也能拼对', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '标题: t' } }] }) });
  const r = await callSummaryLlm({ baseUrl: 'https://api.example.com/v1/', model: 'm', apiKey: 'k', system: 's', user: 'u', fetchImpl: fakeFetch, timeoutMs: 1000 });
  assert.equal(r.title, 't');
});

test('callSummaryLlm：HTTP 失败 / 超时返回 null（调用方回退截断行为）', async () => {
  const failFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r1 = await callSummaryLlm({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', system: 's', user: 'u', fetchImpl: failFetch, timeoutMs: 1000 });
  assert.equal(r1, null);
  const hangFetch = () => new Promise(() => {});
  const r2 = await callSummaryLlm({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', system: 's', user: 'u', fetchImpl: hangFetch, timeoutMs: 50 });
  assert.equal(r2, null);
});

test('callSummaryLlm：未配置（缺 baseUrl 或 key）直接返回 null', async () => {
  const r = await callSummaryLlm({ baseUrl: '', model: 'm', apiKey: '', system: 's', user: 'u' });
  assert.equal(r, null);
});

test('默认 fetch 挂掉时依次尝试 fallback fetchers（Obsidian 渲染进程代理站修复回归）', async () => {
  // 模拟: 全局 fetch 对代理站抛 TypeError（系统代理拦截），Electron 主进程 net.fetch 可通
  const brokenGlobalFetch = async () => { throw new TypeError('Failed to fetch'); };
  const netFetch = async (url, init) => ({ ok: true, json: async () => ({ choices: [{ message: { content: '标题: 主进程通路\n1. 要点' } }] }) });
  const r = await callSummaryLlm({
    baseUrl: 'https://internal.example/v1', model: 'm', apiKey: 'k', system: 's', user: 'u',
    globalFetch: brokenGlobalFetch, fallbackFetchers: [netFetch], timeoutMs: 5000
  });
  assert.ok(r, '全局 fetch 失败后应走 fallback');
  assert.equal(r.title, '主进程通路');
});

test('默认 fetch 正常时不碰 fallback（不增加无谓调用）', async () => {
  let fallbackCalled = 0;
  const goodGlobal = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '标题: 主通路' } }] }) });
  const r = await callSummaryLlm({
    baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', system: 's', user: 'u',
    globalFetch: goodGlobal, fallbackFetchers: [async () => { fallbackCalled++; return null; }], timeoutMs: 5000
  });
  assert.equal(r.title, '主通路');
  assert.equal(fallbackCalled, 0);
});
