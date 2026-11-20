import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessages,
  buildAnswers,
  shouldStickToBottom,
  isActiveStatus,
  isSendKey
} from './conversation.js';

// MCP t3_thread_read 的 messages 是 newest-first，且带 position。
const msg = (position, type, text) => ({ position, type, text, runId: `run-${position}` });

test('消息从 newest-first 还原成时间正序', () => {
  const out = normalizeMessages([
    msg(3, 'assistant_message', '第三'),
    msg(2, 'user_message', '第二'),
    msg(1, 'assistant_message', '第一')
  ]);
  assert.deepEqual(out.map((m) => m.text), ['第一', '第二', '第三']);
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'user', 'assistant']);
});

test('过滤空文本与非消息类型，位置和 runId 保留', () => {
  const out = normalizeMessages([
    msg(4, 'assistant_message', '有内容'),
    msg(3, 'assistant_message', '   '),
    msg(2, 'tool_call', '不该出现'),
    msg(1, 'user_message', '开头')
  ]);
  assert.deepEqual(out.map((m) => m.text), ['开头', '有内容']);
  assert.deepEqual(out.map((m) => m.position), [1, 4]);
  assert.deepEqual(out.map((m) => m.runId), ['run-1', 'run-4']);
});

test('同位置同文本重复项只保留一条', () => {
  const out = normalizeMessages([
    msg(2, 'user_message', '重复'),
    msg(2, 'user_message', '重复'),
    msg(1, 'user_message', '唯一')
  ]);
  assert.deepEqual(out.map((m) => m.text), ['唯一', '重复']);
});

test('超过上限时取最新的 N 条，且仍按时间正序', () => {
  const items = [];
  for (let i = 10; i >= 1; i--) items.push(msg(i, 'assistant_message', `第${i}条`));
  const out = normalizeMessages(items, { limit: 3 });
  assert.deepEqual(out.map((m) => m.text), ['第8条', '第9条', '第10条']);
});

test('单选：选中项取 value，没有 value 时退回 label', () => {
  const questions = [
    { id: 'q1', question: '颜色', options: [{ label: '红', value: 'red' }, { label: '蓝' }] }
  ];
  const { answers, missing } = buildAnswers(questions, { q1: { selections: ['red'] } });
  assert.deepEqual(answers, { q1: 'red' });
  assert.deepEqual(missing, []);

  const second = buildAnswers(questions, { q1: { selections: ['蓝'] } });
  assert.deepEqual(second.answers, { q1: '蓝' });
});

test('多选：提交数组，按选项顺序而不是点击顺序', () => {
  const questions = [
    { id: 'q1', question: '颜色', multiSelect: true, options: [{ label: '红' }, { label: '蓝' }, { label: '绿' }] }
  ];
  const { answers } = buildAnswers(questions, { q1: { selections: ['绿', '红'] } });
  assert.deepEqual(answers, { q1: ['红', '绿'] });
});

test('自定义回答：单选时覆盖选项，多选时追加进数组', () => {
  const single = [{ id: 'q1', question: '颜色', allowCustomAnswer: true, options: [{ label: '红' }] }];
  assert.deepEqual(
    buildAnswers(single, { q1: { selections: ['红'], custom: '  酒红  ' } }).answers,
    { q1: '酒红' }
  );

  const multi = [{ id: 'q1', question: '颜色', multiSelect: true, allowCustomAnswer: true, options: [{ label: '红' }] }];
  assert.deepEqual(
    buildAnswers(multi, { q1: { selections: ['红'], custom: '酒红' } }).answers,
    { q1: ['红', '酒红'] }
  );
});

test('未声明 required 视为必答：T3 下发的提问通常不带这个字段', () => {
  const questions = [{ id: 'q1', question: '颜色', options: [{ label: '红' }] }];
  const { answers, missing } = buildAnswers(questions, {});
  assert.deepEqual(missing, ['q1']);
  assert.deepEqual(answers, {});
});

test('显式 required: false 才允许空回答', () => {
  const questions = [{ id: 'q1', question: '备注', required: false, options: [{ label: '红' }] }];
  const { answers, missing } = buildAnswers(questions, {});
  assert.deepEqual(missing, []);
  assert.deepEqual(answers, { q1: '' });
});

test('只输入自定义文字、不点选项，也算已回答', () => {
  const questions = [{ id: 'q1', question: '颜色', options: [{ label: '红' }] }];
  const { answers, missing } = buildAnswers(questions, { q1: { selections: [], custom: '  酒红 ' } });
  assert.deepEqual(missing, []);
  assert.deepEqual(answers, { q1: '酒红' });
});

test('必答与多选空数组都算未回答', () => {
  const questions = [
    { id: 'q1', question: '必答', required: true, multiSelect: true, options: [{ label: '红' }] }
  ];
  assert.deepEqual(buildAnswers(questions, { q1: { selections: [] } }).missing, ['q1']);
  assert.deepEqual(buildAnswers(questions, { q1: { selections: ['红'] } }).missing, []);
});

test('滚动判定：距底 80px 内视为贴底，超过则视为用户上翻了', () => {
  assert.equal(shouldStickToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(shouldStickToBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(shouldStickToBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 }), false);
});

test('回车发送：修饰键换行，输入法组字不发送', () => {
  assert.equal(isSendKey({ key: 'Enter' }), true);
  assert.equal(isSendKey({ key: 'Enter', metaKey: true }), false);
  assert.equal(isSendKey({ key: 'Enter', ctrlKey: true }), false);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(isSendKey({ key: 'Enter', isComposing: true }), false);
  assert.equal(isSendKey({ key: 'a' }), false);
  assert.equal(isSendKey(null), false);
});

test('活跃状态决定是否显示「正在回复…」', () => {
  for (const status of ['running', 'waiting', 'starting', 'preparing', 'queued']) {
    assert.equal(isActiveStatus(status), true, `${status} 是活跃状态`);
  }
  for (const status of ['idle', 'completed', 'failed', 'cancelled', undefined, null]) {
    assert.equal(isActiveStatus(status), false, `${status} 不是活跃状态`);
  }
});
