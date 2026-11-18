import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isArchiveFile, archiveFileName, countTopLevelTasks, pickArchiveFile, extendArchiveRange
} from './archive.js';

test('识别归档文件（单日期与区间）', () => {
  assert.equal(isArchiveFile('task-2026-11-18.md'), true);
  assert.equal(isArchiveFile('task-2026-10-01~2026-11-18.md'), true);
  assert.equal(isArchiveFile('task-LoopForge.md'), false);
  assert.equal(isArchiveFile('task-2026-1-1.md'), false);
});

test('归档文件名：区间与单日期', () => {
  assert.equal(archiveFileName(['2026-10-01', '2026-11-18']), 'task-2026-10-01~2026-11-18.md');
  assert.equal(archiveFileName(['2026-11-18']), 'task-2026-11-18.md');
  assert.equal(archiveFileName([]), 'task-1970-01-01.md');
});

test('只统计顶层任务，子行不计', () => {
  const lines = [
    '- [ ] 甲',
    '\t- [x] 子行一',
    '\t- [-] 子行二',
    '- [x] 乙',
    '  - [/] 子行三',
    '',
    '### 分组',
    '- [ ] 丙'
  ];
  assert.equal(countTopLevelTasks(lines), 3);
});

test('未满 100 追加当前归档文件', () => {
  const files = [
    { path: '任务/P/task-P.md', lines: [] },
    { path: '任务/P/task-2026-10-01~2026-10-30.md', lines: ['- [ ] a'] }
  ];
  const target = pickArchiveFile(files, ['2026-11-01', '2026-11-18']);
  assert.equal(target.path, '任务/P/task-2026-10-01~2026-10-30.md');
  assert.equal(target.create, false);
});

test('当前归档已满 100 时新建，文件名取本批日期', () => {
  const full = Array.from({ length: 100 }, (_, i) => `- [ ] t${i}`);
  const files = [{ path: '任务/P/task-2026-10-01~2026-10-30.md', lines: full }];
  const target = pickArchiveFile(files, ['2026-11-01', '2026-11-18']);
  assert.equal(target.path, '任务/P/task-2026-11-01~2026-11-18.md');
  assert.equal(target.create, true);
});

test('没有归档文件时新建', () => {
  const target = pickArchiveFile([{ path: '任务/P/task-P.md', lines: [] }], ['2026-11-18']);
  assert.equal(target.path, '任务/P/task-2026-11-18.md');
  assert.equal(target.create, true);
});

test('区间扩展：文件名随新任务日期扩宽', () => {
  assert.equal(
    extendArchiveRange('task-2026-10-01~2026-10-30.md', ['2026-09-20', '2026-11-02']),
    'task-2026-09-20~2026-11-02.md'
  );
});
