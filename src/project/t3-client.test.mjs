import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpBody, pickSessionId, parseToolResult, isModeEscalation, T3Client } from './t3-client.js';

const noopRequest = async () => ({ status: 200, headers: {}, text: '{}' });

// 最小 MCP 服务：只应答 initialize / tools/call，记录每次调用参数。
function mcpServer(handler) {
  const calls = [];
  const request = async ({ body }) => {
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      return { status: 200, headers: { 'mcp-session-id': 's1' }, text: '{"jsonrpc":"2.0","id":1,"result":{}}' };
    }
    if (msg.method === 'tools/call') {
      calls.push({ name: msg.params.name, args: msg.params.arguments });
      const result = handler(msg.params.name, msg.params.arguments);
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
        })
      };
    }
    return { status: 200, headers: {}, text: '' };
  };
  return { request, calls };
}

test('普通 JSON 响应直接解析', () => {
  assert.deepEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'), {
    jsonrpc: '2.0', id: 1, result: { ok: true }
  });
});

test('SSE 响应取最后一条 data 事件', () => {
  const body = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}',
    ''
  ].join('\n');
  assert.deepEqual(parseMcpBody(body), { jsonrpc: '2.0', id: 7, result: { tools: [] } });
});

test('跨多行 data 的 SSE 事件会拼回一条', () => {
  const body = 'event: message\ndata: {"jsonrpc":"2.0","id":2,\ndata: "result":{"a":1}}\n\n';
  assert.deepEqual(parseMcpBody(body), { jsonrpc: '2.0', id: 2, result: { a: 1 } });
});

test('空响应与坏 JSON 返回 null，交给调用方报错', () => {
  assert.equal(parseMcpBody(''), null);
  assert.equal(parseMcpBody('   '), null);
  assert.equal(parseMcpBody('not json'), null);
});

test('会话头大小写不敏感', () => {
  assert.equal(pickSessionId({ 'mcp-session-id': 'abc' }), 'abc');
  assert.equal(pickSessionId({ 'MCP-Session-Id': 'def' }), 'def');
  assert.equal(pickSessionId({}), null);
});

test('tools/call 的文本内容按 JSON 解析', () => {
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: '{"requestIds":["r1"]}' }] }), {
    requestIds: ['r1']
  });
});

test('tools/call 的纯文本内容原样返回', () => {
  assert.equal(parseToolResult({ content: [{ type: 'text', text: 'done' }] }), 'done');
});

test('isError 抛错，带上服务端文案', () => {
  assert.throws(
    () => parseToolResult({ isError: true, content: [{ type: 'text', text: 'thread not found' }] }),
    /thread not found/
  );
});

test('读取消息不截断：请求上限并按 offset 续读拼完整', async () => {
  const { request, calls } = mcpServer((name, args) => {
    if (args.itemId) {
      return { items: [{ itemId: args.itemId, text: '后半段', textTruncated: false, nextTextOffset: null }] };
    }
    return {
      items: [
        { position: 1, type: 'assistant_message', itemId: 'i1', text: '前半段', textTruncated: true, nextTextOffset: 90 },
        { position: 2, type: 'user_message', itemId: 'i2', text: '好的', textTruncated: false, nextTextOffset: null }
      ]
    };
  });
  const client = new T3Client({ request, issueToken: async () => 'token', binary: 't3' });
  const page = await client.readMessages('th1', { limit: 10 });

  assert.equal(page.items[0].text, '前半段后半段');
  assert.equal(page.items[0].textTruncated, false);
  assert.equal(page.items[0].nextTextOffset, null);
  assert.equal(page.items[1].text, '好的');
  assert.equal(calls.length, 2, '只有被截断的那条需要补读');
  assert.equal(calls[0].args.maxCharsPerItem, 20000);
  assert.deepEqual(calls[1].args, {
    threadId: 'th1', itemId: 'i1', textOffset: 90, maxCharsPerItem: 20000
  });
});

test('读取消息一次就能拿到全文时不多发请求', async () => {
  const { request, calls } = mcpServer(() => ({
    items: [{ position: 1, type: 'assistant_message', itemId: 'i1', text: '完整内容', textTruncated: false, nextTextOffset: null }]
  }));
  const client = new T3Client({ request, issueToken: async () => 'token', binary: 't3' });
  const page = await client.readMessages('th1', { limit: 10 });
  assert.equal(page.items[0].text, '完整内容');
  assert.equal(calls.length, 1);
});

test('识别全权限会话的权限拒绝', () => {
  assert.equal(isModeEscalation(new Error('runtime_mode_escalation_denied: approval-required -> full-access')), true);
  assert.equal(isModeEscalation(new Error('thread not found')), false);
  assert.equal(isModeEscalation(null), false);
});

test('CLI 发送把消息写进 stdin，并取最后一行 JSON', async () => {
  const calls = [];
  const client = new T3Client({
    request: noopRequest,
    binary: '/fake/t3',
    runCli: async (binary, args, input) => {
      calls.push({ binary, args, input });
      return 'writing…\n{"status":"queued","delivery":"queued"}\n';
    }
  });
  const result = await client.sendMessageCli('thread-1', '第一行\n第二行');
  assert.deepEqual(calls, [{
    binary: '/fake/t3',
    args: ['thread', 'send', 'thread-1', '-', '--json'],
    input: '第一行\n第二行'
  }]);
  assert.deepEqual(result, { status: 'queued', delivery: 'queued' });
});

test('CLI 发送没有输出时返回 null，CLI 报错则原样抛出', async () => {
  const quiet = new T3Client({ request: noopRequest, binary: '/fake/t3', runCli: async () => '   \n' });
  assert.equal(await quiet.sendMessageCli('thread-1', 'hi'), null);

  const failing = new T3Client({
    request: noopRequest,
    binary: '/fake/t3',
    runCli: async () => { throw new Error('t3: thread not found'); }
  });
  await assert.rejects(() => failing.sendMessageCli('thread-1', 'hi'), /thread not found/);
});
