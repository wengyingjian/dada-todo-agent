// 接线层测试：把 LLM 总结应用进任务文件行数组（纯行变换，无 vault I/O）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySummaryToLines, replaceSummaryInLines } from './summarize-apply.js';

const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';

const makeFile = () => [
  '---',
  'type: project',
  'tags: [todoList]',
  '---',
  '',
  '- [ ] 修登录页 bug',
  '\t- [/] 进行中…  ⚡ t3:'
];

test('applySummaryToLines：占位子行替换为「标题+分点」块', () => {
  const lines = makeFile();
  const r = applySummaryToLines(lines, 6, {
    state: 'completed', threadId: ID, summarizedPromptCount: 2,
    title: '修复登录页 token 过期', points: ['调整判断顺序', '补回归测试']
  });
  assert.equal(r.ok, true);
  assert.equal(lines[6], `\t- [x] 修复登录页 token 过期  ⚡ t3:${ID}#2`);
  assert.equal(lines[7], '\t  1. 调整判断顺序');
  assert.equal(lines[8], '\t  2. 补回归测试');
});

test('applySummaryToLines：无分点时只替换标题行,不留空行', () => {
  const lines = makeFile();
  const r = applySummaryToLines(lines, 6, { state: 'failed', threadId: ID, summarizedPromptCount: 1, title: 'spawn 失败', points: [] });
  assert.equal(r.ok, true);
  assert.equal(lines[6], `\t- [-] spawn 失败  ⚡ t3:${ID}#1`);
  assert.equal(lines.length, 7); // 无分点不产生额外行
});

test('replaceSummaryInLines：旧总结块(带分点)整体替换为新块,不残留旧分点', () => {
  const lines = [
    '- [ ] 修登录页 bug',
    `\t- [x] 旧标题  ⚡ t3:${ID}#2`,
    '\t  1. 旧要点一',
    '\t  2. 旧要点二',
    '- [ ] 下一个任务'
  ];
  const r = replaceSummaryInLines(lines, 1, {
    state: 'completed', threadId: ID, summarizedPromptCount: 4,
    title: '新标题', points: ['新要点']
  });
  assert.equal(r.ok, true);
  assert.equal(lines[1], `\t- [x] 新标题  ⚡ t3:${ID}#4`);
  assert.equal(lines[2], '\t  1. 新要点');
  assert.equal(lines[3], '- [ ] 下一个任务');
});

test('replaceSummaryInLines：旧块无分点、新块有分点,正确插入不吞后续行', () => {
  const lines = [
    `- [x] 旧标题  ⚡ t3:${ID}#1`,
    '- [ ] 下一个任务'
  ];
  replaceSummaryInLines(lines, 0, {
    state: 'completed', threadId: ID, summarizedPromptCount: 3,
    title: '新标题', points: ['a', 'b']
  });
  assert.deepEqual(lines, [
    `- [x] 新标题  ⚡ t3:${ID}#3`,
    '  1. a',
    '  2. b',
    '- [ ] 下一个任务'
  ]);
});

test('applySummaryToLines：行号越界/非委派行返回 ok:false', () => {
  assert.equal(applySummaryToLines(['- [ ] x'], 5, { threadId: ID }).ok, false);
  assert.equal(applySummaryToLines(['- [ ] 无标记行'], 0, { threadId: ID }).ok, false);
});
