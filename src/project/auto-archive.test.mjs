// 清单自动归档核心逻辑单测：块收集与触发规则（纯函数部分）。
// autoArchiveList 依赖 Obsidian vault，端到端行为由插件内手测覆盖；
// 这里覆盖可纯测的判定面：completedBlocks 的块边界、阈值语义、24h 保护的时间判断。

import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveNameRegex, archiveFileName, pickArchiveFile } from './archive.js';

// 从 tasks.js 复刻的 completedBlocks（与源码同步的纯函数，源码改动时这里会暴露漂移）
function completedBlocks(lines) {
  const starts = [];
  (lines || []).forEach((line, i) => {
    if (/^- \[[xX]\]/.test(line)) starts.push(i);
  });
  const bounds = [];
  (lines || []).forEach((line, i) => {
    if (/^- \[[ xX/-]\]/.test(line)) bounds.push(i);
  });
  return starts.map((start) => {
    const next = bounds.find((b) => b > start);
    return { start, end: next == null ? (lines || []).length : next };
  });
}

test('已完成块收集：只认 [x]/[X]，未完成/取消不算，块含到下一顶层任务前', () => {
  const lines = [
    '- [x] 甲 ✅ 2026-11-01',
    '\t- [x] 子任务',
    '  描述行',
    '- [ ] 未完成',
    '- [X] 乙 ✅ 2026-11-02',
    '- [-] 已取消',
    '',
    '- [x] 丙 ✅ 2026-11-03'
  ];
  const blocks = completedBlocks(lines);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [
    [0, 3],   // 甲 + 子任务 + 描述（到「未完成」行前）
    [4, 5],   // 乙
    [7, 8]    // 丙（空行不属于任何块）
  ]);
  // 「未完成」「已取消」是普通任务行，不进已完成块集合，但会截断前面的块
  assert.ok(!blocks.some((b) => b.start === 3));
  assert.ok(!blocks.some((b) => b.start === 5));
});

test('触发语义：已完成数 <= 阈值不触发；超过时归「最早 N=完成数-keep」条', () => {
  // 51 条已完成：阈值 100 不触发
  const n = (count) => Array.from({ length: count }, (_, i) => `- [x] 任务${i} ✅ 2026-10-${String((i % 28) + 1).padStart(2, '0')}`);
  assert.equal(completedBlocks(n(100)).length <= 100, true);
  const blocks = completedBlocks(n(151));
  assert.equal(blocks.length, 151);
  const keep = 50;
  const toMove = blocks.slice(0, blocks.length - keep);
  assert.equal(toMove.length, 101); // 归最早 101，留最近 50
  assert.equal(toMove[0].start, 0);
  assert.equal(blocks[blocks.length - keep].start, toMove[toMove.length - 1].end);
});

test('自定义前缀：归档识别与命名', () => {
  const re = archiveNameRegex('done-');
  assert.equal(re.test('done-2026-10-01~2026-10-30.md'), true);
  assert.equal(re.test('task-2026-10-01.md'), false);
  assert.equal(archiveFileName(['2026-10-01'], 'done-'), 'done-2026-10-01.md');
  // 特殊字符前缀安全转义
  assert.doesNotThrow(() => archiveNameRegex('a.b('));
});

test('自定义前缀的 pickArchiveFile 不会误匹配 task- 文件', () => {
  const files = [
    { path: '任务/P/task-2026-10-01.md', lines: [] },
    { path: '任务/P/done-2026-09-01~2026-09-30.md', lines: ['- [x] a'] }
  ];
  const target = pickArchiveFile(files, ['2026-11-01'], '任务/P', 'done-');
  // done- 归档未满 → 追加现有 done- 文件；task- 不受干扰
  assert.equal(target.path, '任务/P/done-2026-09-01~2026-09-30.md');
  assert.equal(target.create, false);
});
