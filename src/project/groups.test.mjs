import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS, groupOfState, ensureGroupHeadings, collectGroupHeadings, groupOfLine, mergeHeadingRows
} from './groups.js';

test('状态 → 分组映射：五态全覆盖，未知返回空串', () => {
  assert.equal(groupOfState('running'), '进行中');
  assert.equal(groupOfState('awaiting'), '待处理');
  assert.equal(groupOfState('completed'), '已完成');
  assert.equal(groupOfState('failed'), '已完成');
  assert.equal(groupOfState('cancelled'), '已完成');
  assert.equal(groupOfState(''), '');
  assert.equal(groupOfState('whatever'), '');
});

test('无标题文件：三个分组插到正文最前，老任务沉到最后一组下方', () => {
  const { lines, added } = ensureGroupHeadings(['- [ ] 普通任务', '', '']);
  assert.deepEqual(added, ['进行中', '待处理', '已完成']);
  assert.deepEqual(lines, [
    '### 进行中',
    '',
    '### 待处理',
    '',
    '### 已完成',
    '- [ ] 普通任务'
  ]);
});

test('部分缺失：缺失组插到正文最前（保持组序），已有组与任务块不移动', () => {
  const lines = [
    '- [ ] 老任务',
    '',
    '### 已完成',
    '- [x] 完成的会话'
  ];
  const { lines: out, added } = ensureGroupHeadings(lines);
  assert.deepEqual(added, ['进行中', '待处理']);
  // 缺失组插在最前（按固定顺序），已有「### 已完成」与任务块不动
  assert.deepEqual(out, [
    '### 进行中',
    '',
    '### 待处理',
    '',
    '### 已完成',
    '- [x] 完成的会话',
    '- [ ] 老任务'
  ]);
});

test('无标题且文件全空：只建三个空分组', () => {
  const { lines, added } = ensureGroupHeadings([]);
  assert.deepEqual(added, ['进行中', '待处理', '已完成']);
  assert.deepEqual(lines, ['### 进行中', '', '### 待处理', '', '### 已完成']);
});

test('三个分组齐全：原样返回，不追加任何内容', () => {
  const lines = [
    '- [ ] 未分组任务',
    '',
    '### 进行中',
    '- [/] 会话A',
    '',
    '### 待处理',
    '',
    '### 已完成',
    '- [x] 会话B',
    '',
    ''
  ];
  const { lines: out, added } = ensureGroupHeadings(lines);
  assert.deepEqual(added, []);
  assert.deepEqual(out, lines);
});

test('收集标题：只认三级标题，记录行号与标题文字', () => {
  const lines = [
    '- [ ] 未分组',
    '',
    '### 进行中',
    '- [/] 会话A',
    '## 二级标题不算',
    '#### 四级也不算',
    '',
    '### 已完成',
    '- [x] 会话B'
  ];
  const hs = collectGroupHeadings(lines);
  assert.deepEqual(hs, [
    { lineNo: 2, title: '进行中' },
    { lineNo: 7, title: '已完成' }
  ]);
});

test('任务行归属：归入其上方最近的标题，标题之前为未分组', () => {
  const lines = [
    '- [ ] 未分组任务',
    '### 进行中',
    '- [/] 会话A',
    '### 已完成',
    '- [x] 会话B'
  ];
  assert.equal(groupOfLine(lines, 0), '');
  assert.equal(groupOfLine(lines, 2), '进行中');
  assert.equal(groupOfLine(lines, 4), '已完成');
  assert.equal(groupOfLine(lines, 99), '已完成'); // 超界回落最后一组
});

test('平铺任务合并标题行：### 位置插入标题占位项，顺序保持', () => {
  const tasks = [
    { guid: 'a', lineNo: 0, summary: '未分组任务' },
    { guid: 'b', lineNo: 2, summary: '会话A' },
    { guid: 'c', lineNo: 4, summary: '会话B' }
  ];
  const lines2 = [
    '- [ ] 未分组任务',
    '### 进行中',
    '- [/] 会话A',
    '### 已完成',
    '- [x] 会话B'
  ];
  const rows = mergeHeadingRows(tasks, lines2);
  assert.deepEqual(rows.map((r) => r.kind), ['task', 'heading', 'task', 'heading', 'task']);
  assert.equal(rows[0].task.guid, 'a');
  assert.equal(rows[1].title, '进行中');
  assert.equal(rows[2].task.guid, 'b');
  assert.equal(rows[3].title, '已完成');
  assert.equal(rows[4].task.guid, 'c');
});

test('平铺任务合并标题行：无标题时全部为 task 行', () => {
  const tasks = [{ guid: 'a', lineNo: 0 }, { guid: 'b', lineNo: 1 }];
  const rows = mergeHeadingRows(tasks, ['- [ ] a', '- [ ] b']);
  assert.deepEqual(rows.map((r) => r.kind), ['task', 'task']);
});
