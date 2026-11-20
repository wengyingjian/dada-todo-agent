import test from 'node:test';
import assert from 'node:assert/strict';
import { isGripLine, extractTaskText, resolveEditorCwd } from './editor-grip.js';

// isGripLine：光标所在行是不是可委派的列表项（带不带 checkbox 都算）
test('isGripLine: 无 checkbox 的 - 列表项算', () => {
  assert.equal(isGripLine('- 买菜'), true);
});
test('isGripLine: 带 checkbox 的任务行算', () => {
  assert.equal(isGripLine('- [ ] 写周报'), true);
});
test('isGripLine: 已完成任务也算（仍可委派）', () => {
  assert.equal(isGripLine('- [x] 买菜'), true);
});
test('isGripLine: * + 与有序列表 1. 都算', () => {
  assert.equal(isGripLine('* 星号项'), true);
  assert.equal(isGripLine('+ 加号项'), true);
  assert.equal(isGripLine('1. 有序项'), true);
});
test('isGripLine: 缩进的子项也算', () => {
  assert.equal(isGripLine('  - 缩进子项'), true);
});
test('isGripLine: 普通段落不算', () => {
  assert.equal(isGripLine('这是普通文字'), false);
});
test('isGripLine: 空行与标题不算', () => {
  assert.equal(isGripLine(''), false);
  assert.equal(isGripLine('   '), false);
  assert.equal(isGripLine('# 标题'), false);
});
test('isGripLine: 引用块不算', () => {
  assert.equal(isGripLine('> 引用'), false);
});

// extractTaskText：去掉列表前缀与 checkbox，取任务正文
test('extractTaskText: 去 - 前缀', () => {
  assert.equal(extractTaskText('- 买菜'), '买菜');
});
test('extractTaskText: 去 checkbox', () => {
  assert.equal(extractTaskText('- [ ] 写周报'), '写周报');
});
test('extractTaskText: 去缩进与有序前缀', () => {
  assert.equal(extractTaskText('  1. 有序任务'), '有序任务');
});
test('extractTaskText: 带内嵌日期 emoji 的行保留正文', () => {
  assert.equal(extractTaskText('- [ ] 修 bug 📅 2026-11-20'), '修 bug 📅 2026-11-20');
});
test('extractTaskText: 空正文返回空串', () => {
  assert.equal(extractTaskText('- [ ] '), '');
});

// resolveEditorCwd：项目文件走项目 cwd，否则回退仓库根
test('resolveEditorCwd: 文件属于项目节点时用项目 cwd', () => {
  const nodes = [
    { dirPath: '任务/web', filePath: '任务/web/项目信息.md', cwd: '/code/web' },
    { dirPath: '任务/web/子项目', filePath: '任务/web/子项目/项目信息.md', cwd: '/code/web/sub' },
  ];
  assert.equal(resolveEditorCwd('任务/web/子项目/项目信息.md', nodes, '/vault'), '/code/web/sub');
});
test('resolveEditorCwd: 项目节点按 filePath 精确匹配（扁平索引）', () => {
  const nodes = [
    { dirPath: '任务', filePath: '任务/web.md', cwd: '/code/web' },
    { dirPath: '任务', filePath: '任务/a.md', cwd: '/code/a' },
  ];
  assert.equal(resolveEditorCwd('任务/web.md', nodes, '/vault'), '/code/web');
  // 非项目文件（同目录其他文件）不匹配
  assert.equal(resolveEditorCwd('任务/web/notes.md', nodes, '/vault'), '/vault');
});
test('resolveEditorCwd: 非项目文件回退仓库根', () => {
  const nodes = [{ dirPath: '任务', filePath: '', cwd: '/code/a' }];
  assert.equal(resolveEditorCwd('10-时间轴/日记/2026/2026-11-19.md', nodes, '/vault'), '/vault');
});
test('resolveEditorCwd: 无项目节点回退仓库根', () => {
  assert.equal(resolveEditorCwd('任意.md', [], '/vault'), '/vault');
});
test('resolveEditorCwd: 项目节点 cwd 为空时跳过继续匹配', () => {
  const nodes = [{ dirPath: '任务', filePath: '', cwd: '' }];
  assert.equal(resolveEditorCwd('任务/x.md', nodes, '/vault'), '/vault');
});
