import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS, groupOfState, ensureGroupHeadings, collectGroupHeadings, groupOfLine, mergeHeadingRows, parentLineOf, isTaskLine, groupBlockLineOf, shouldMoveToGroup
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

test('parentLineOf：从委派行向上找最近的顶层任务行（含第 0 行，falsy-0 不误判）', () => {
  const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';
  const lines = [
    '- [ ] 首行父任务',
    `\t- [/] 进行中…  ⚡ t3:${ID}`
  ];
  assert.equal(parentLineOf(lines, 1), 0);
});

test('parentLineOf：跳过描述行与兄弟子行，落到真正的父任务', () => {
  const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';
  const lines = [
    '- [ ] 父任务',
    '\t- [x] 上一轮总结  ⚡ t3:11111111-2222-3333-4444-555555555555#3',
    '\t  1. 分点描述',
    '\t  2. 另一个分点',
    `\t- [/] 新会话  ⚡ t3:${ID}`
  ];
  assert.equal(parentLineOf(lines, 4), 0);
});

test('parentLineOf：跨任务块——本块无父任务时向上穿过标题找前一块的父任务', () => {
  const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';
  const lines = [
    '### 已完成',
    '- [x] 前一个父任务',
    `\t- [x] 已结束  ⚡ t3:${ID}`
  ];
  assert.equal(parentLineOf(lines, 2), 1);
});

test('parentLineOf：找不到顶层列表项返回 -1', () => {
  const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';
  const lines = ['### 已完成', `\t- [/] 孤儿子行  ⚡ t3:${ID}`];
  assert.equal(parentLineOf(lines, 1), -1);
  assert.equal(parentLineOf(lines, -1), -1);
});

test('parentLineOf：父行可以是普通列表项（用户随手写的 - xxx / 空项 -）', () => {
  const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';
  assert.equal(parentLineOf(['- [ ] 上一个任务', '- hello', '', `\t- [/] hi  ⚡ t3:${ID}`], 3), 1);
  assert.equal(parentLineOf(['- [ ] 任务', '-', `\t- [/] hi  ⚡ t3:${ID}`], 2), 1);
});

test('isTaskLine：只有 checkbox 任务行算任务，普通列表项不算', () => {
  assert.equal(isTaskLine('- [ ] 任务'), true);
  assert.equal(isTaskLine('- [x] 完成'), true);
  assert.equal(isTaskLine('\t- [-] 取消'), true);
  assert.equal(isTaskLine('- hello'), false);
  assert.equal(isTaskLine('-'), false);
  assert.equal(isTaskLine('### 标题'), false);
});

test('groupBlockLineOf：self 行搬自己；子行搬父任务；父行是普通列表项不搬', () => {
  const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';
  assert.equal(groupBlockLineOf(['### 已完成', `- [x] 同步任务  ⚡ t3:${ID}`], 1), 1);
  assert.equal(groupBlockLineOf(['- [ ] 父任务', `\t- [x] 委派  ⚡ t3:${ID}`], 1), 0);
  assert.equal(groupBlockLineOf(['- hello', `\t- [x] 委派  ⚡ t3:${ID}`], 1), -1);
});

test('shouldMoveToGroup：状态对应的组与当前组不同才搬，不可搬块/未知状态不搬', () => {
  // 已完成但还留在「进行中」：必须搬（历史搬组失败的自愈路径）
  assert.equal(shouldMoveToGroup({ movable: true, group: '进行中', state: 'completed' }), true);
  // 已在目标组：幂等跳过
  assert.equal(shouldMoveToGroup({ movable: true, group: '已完成', state: 'completed' }), false);
  // running → 进行中，同组不搬
  assert.equal(shouldMoveToGroup({ movable: true, group: '进行中', state: 'running' }), false);
  // 父行是普通列表项：没有分组归属
  assert.equal(shouldMoveToGroup({ movable: false, group: '进行中', state: 'completed' }), false);
  // 未知状态 / 空参数
  assert.equal(shouldMoveToGroup({ movable: true, group: '进行中', state: 'weird' }), false);
  assert.equal(shouldMoveToGroup(), false);
});
