import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMatches, filterByProject } from './session-search.js';

// 搜索：空格分词 AND，haystack = 标题 / cwd / 状态等，与 AgentDeck 口径一致
const th = (id, title, cwd) => ({
  threadId: id, title, cwd,
  firstUser: '', lastAssistant: '', state: 'completed'
});

test('searchMatches：空词返回全部', () => {
  const threads = [th('a', '实现登录', '/home/proj')];
  assert.deepEqual(searchMatches(threads, ''), threads);
  assert.deepEqual(searchMatches(threads, '   '), threads);
});

test('searchMatches：单词命中标题（不区分大小写）', () => {
  const threads = [th('a', 'Implement Login', '/x')];
  assert.deepEqual(searchMatches(threads, 'login'), [threads[0]]);
  assert.equal(searchMatches(threads, 'logout').length, 0);
});

test('searchMatches：多词是 AND——两词各命中不同字段也算命中', () => {
  const threads = [th('a', '实现登录页', '/home/alpha')];
  assert.deepEqual(searchMatches(threads, '登录 alpha'), [threads[0]]);
  assert.equal(searchMatches(threads, '登录 beta').length, 0);
});

test('searchMatches：命中 cwd 或 threadId 也算', () => {
  const threads = [th('abc123', '随便', '/home/alpha')];
  assert.deepEqual(searchMatches(threads, 'abc'), [threads[0]]);
  assert.deepEqual(searchMatches(threads, 'alpha'), [threads[0]]);
});

test('filterByProject：按 cwd 精确匹配', () => {
  const threads = [
    th('a', 'x', '/w/one'),
    th('b', 'y', '/w/two'),
    th('c', 'z', '/w/one')
  ];
  assert.deepEqual(filterByProject(threads, '/w/one').map((t) => t.threadId), ['a', 'c']);
  assert.deepEqual(filterByProject(threads, null), threads);
});

test('filterByProject：cwd 为空的会话在任何项目筛选下都不显示（无法归属）', () => {
  const threads = [th('a', 'x', ''), th('b', 'y', '/w/one')];
  assert.deepEqual(filterByProject(threads, '/w/one').map((t) => t.threadId), ['b']);
});

test('搜索叠加项目筛选：先按 cwd 过滤再搜', () => {
  const threads = [
    th('a', '登录', '/w/one'),
    th('b', '登录', '/w/two'),
    th('c', '其他', '/w/one')
  ];
  const scoped = filterByProject(threads, '/w/one');
  assert.deepEqual(searchMatches(scoped, '登录').map((t) => t.threadId), ['a']);
});
