import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpBody, pickSessionId, parseToolResult } from './t3-client.js';

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
