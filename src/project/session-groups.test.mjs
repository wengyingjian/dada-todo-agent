import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSessions, stateChipOf, timeAgoParts, workspaceLabel, isT3DbFile } from './session-groups.js';

const th = (id, state, updatedAt) => ({ threadId: id, state, updatedAt, title: id });

test('三段顺序固定：待处理 → 进行中 → 已完成', () => {
  const groups = groupSessions([
    th('done-1', 'completed', 3),
    th('run-1', 'running', 2),
    th('wait-1', 'awaiting', 1)
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['wait', 'run', 'done']);
});

test('状态归组：awaiting→wait，running→run，completed/failed/cancelled→done，未知忽略', () => {
  const groups = groupSessions([
    th('a', 'awaiting', 1),
    th('b', 'running', 2),
    th('c', 'completed', 3),
    th('d', 'failed', 4),
    th('e', 'cancelled', 5),
    th('f', 'idle', 6)
  ]);
  const ids = (key) => groups.find((g) => g.key === key).items.map((t) => t.threadId);
  assert.deepEqual(ids('wait'), ['a']);
  assert.deepEqual(ids('run'), ['b']);
  assert.deepEqual(ids('done'), ['e', 'd', 'c']);
});

test('组内按 updatedAt 从近到远排序', () => {
  const groups = groupSessions([
    th('old', 'running', 100),
    th('new', 'running', 300),
    th('mid', 'running', 200)
  ]);
  assert.deepEqual(groups.find((g) => g.key === 'run').items.map((t) => t.threadId), ['new', 'mid', 'old']);
});

test('已完成先排序再截断：25 条里取最近的 20 条，而不是前 20 条里排序', () => {
  const threads = [];
  for (let i = 1; i <= 25; i++) threads.push(th(`t${i}`, 'completed', i));
  const done = groupSessions(threads).find((g) => g.key === 'done').items;
  assert.equal(done.length, 20);
  assert.deepEqual(
    done.map((t) => t.threadId),
    Array.from({ length: 20 }, (_, i) => `t${25 - i}`)
  );
});

test('已完成条数可配置', () => {
  const threads = [];
  for (let i = 1; i <= 5; i++) threads.push(th(`t${i}`, 'completed', i));
  const done = groupSessions(threads, { doneLimit: 2 }).find((g) => g.key === 'done').items;
  assert.deepEqual(done.map((t) => t.threadId), ['t5', 't4']);
});

test('缺失时间戳的会话排在组末，不破坏倒序', () => {
  const groups = groupSessions([
    th('no-time', 'running', 0),
    th('old', 'running', 100),
    th('new', 'running', 200)
  ]);
  assert.deepEqual(groups.find((g) => g.key === 'run').items.map((t) => t.threadId), ['new', 'old', 'no-time']);
});

test('不修改传入的线程数组', () => {
  const threads = [th('a', 'running', 1), th('b', 'completed', 2)];
  const before = threads.map((t) => t.threadId);
  groupSessions(threads);
  assert.deepEqual(threads.map((t) => t.threadId), before);
});

test('状态 chip：五态映射到 AgentDeck 的样式类与文案 key，未知返回 null', () => {
  assert.deepEqual(stateChipOf('running'), { cls: 'is-live', key: 'live' });
  assert.deepEqual(stateChipOf('awaiting'), { cls: 'is-wait', key: 'wait' });
  assert.deepEqual(stateChipOf('completed'), { cls: 'is-done', key: 'done' });
  assert.deepEqual(stateChipOf('failed'), { cls: 'is-error', key: 'error' });
  assert.deepEqual(stateChipOf('cancelled'), { cls: 'is-quiet', key: 'cancelled' });
  assert.equal(stateChipOf('idle'), null);
});

test('相对时间：45 秒内算刚刚，之后分/时/天四舍五入，未来时间也算刚刚', () => {
  const now = 1_000_000_000;
  assert.deepEqual(timeAgoParts(now - 30_000, now), { unit: 'now' });
  assert.deepEqual(timeAgoParts(now - 300_000, now), { unit: 'min', n: 5 });
  assert.deepEqual(timeAgoParts(now - 3 * 3600_000, now), { unit: 'hour', n: 3 });
  assert.deepEqual(timeAgoParts(now - 2 * 86400_000, now), { unit: 'day', n: 2 });
  assert.deepEqual(timeAgoParts(now + 60_000, now), { unit: 'now' });
  assert.equal(timeAgoParts(0, now), null);
});

test('只认 T3 数据库文件变更：主库/WAL/SHM 触发刷新，其它文件忽略', () => {
  assert.equal(isT3DbFile('statev2.sqlite'), true);
  assert.equal(isT3DbFile('statev2.sqlite-wal'), true);
  assert.equal(isT3DbFile('statev2.sqlite-shm'), true);
  assert.equal(isT3DbFile('statev2.sqlite-journal'), false);
  assert.equal(isT3DbFile('client-settings.json'), false);
  assert.equal(isT3DbFile(''), false);
});

test('工作区标签取最后一级目录；UUID 目录标记为不透明；空值返回空', () => {
  assert.deepEqual(workspaceLabel('/Users/me/github/dada-todo-agent'), { name: 'dada-todo-agent', opaque: false });
  assert.deepEqual(workspaceLabel('/Users/me/proj/'), { name: 'proj', opaque: false });
  assert.deepEqual(workspaceLabel(''), { name: '', opaque: false });
  assert.deepEqual(workspaceLabel('/tmp/3cbd251d-9c41-4267-90c6-c2ca170034a5'), {
    name: '3cbd251d-9c41-4267-90c6-c2ca170034a5',
    opaque: true
  });
});
