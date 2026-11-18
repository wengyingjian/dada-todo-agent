import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDelegationLine, parseDelegationLine, stateFromRun, extractDelegations, shortId
} from './delegate-line.js';

const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';

test('生成子行：四种状态', () => {
  assert.equal(formatDelegationLine({ state: 'running', threadId: ID }), `\t- [/] 进行中…  ⚡ t3:${ID}`);
  assert.equal(formatDelegationLine({ state: 'awaiting', threadId: ID }), `\t- [/] 等你回答…  ⚡ t3:${ID}`);
  assert.equal(formatDelegationLine({ state: 'completed', summary: '改完了', threadId: ID }), `\t- [x] 改完了  ⚡ t3:${ID}`);
  assert.equal(formatDelegationLine({ state: 'failed', summary: '连接超时', threadId: ID }), `\t- [-] 连接超时  ⚡ t3:${ID}`);
});

test('解析子行：状态、摘要、会话 id', () => {
  const p = parseDelegationLine(`\t- [x] 注册视图与会话扫描  ⚡ t3:${ID}`);
  assert.equal(p.state, 'completed');
  assert.equal(p.summary, '注册视图与会话扫描');
  assert.equal(p.threadId, ID);
  assert.equal(p.indent, '\t');
});

test('非委派行返回 null', () => {
  assert.equal(parseDelegationLine('- [ ] 普通任务'), null);
  assert.equal(parseDelegationLine('\t- [x] 普通子任务'), null);
});

test('run 状态 → 子行状态', () => {
  assert.equal(stateFromRun('running', []), 'running');
  assert.equal(stateFromRun('waiting', []), 'running');
  assert.equal(stateFromRun('completed', []), 'completed');
  assert.equal(stateFromRun('failed', []), 'failed');
  assert.equal(stateFromRun('completed', ['user_input']), 'awaiting');
  assert.equal(stateFromRun('running', ['command']), 'awaiting');
  assert.equal(stateFromRun('interrupted', []), 'cancelled');
  assert.equal(stateFromRun('cancelled', []), 'cancelled');
  assert.equal(stateFromRun('', []), null);
});

test('从文件内容提取全部委派', () => {
  const lines = [
    '- [ ] 父任务',
    `\t- [x] 第一轮  ⚡ t3:${ID}`,
    `\t- [/] 进行中…  ⚡ t3:11111111-2222-3333-4444-555555555555`
  ];
  const out = extractDelegations(lines);
  assert.equal(out.length, 2);
  assert.equal(out[0].threadId, ID);
  assert.equal(out[0].parentLine, 0);
  assert.equal(out[1].state, 'running');
});

test('shortId 取前 6 位', () => {
  assert.equal(shortId(ID), '3f2a9b');
});
