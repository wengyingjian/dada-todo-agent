// 接线层测试：把 LLM 总结应用进任务文件行数组（纯行变换，无 vault I/O）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySummaryToLines, replaceSummaryInLines, locateDelegationLine } from './summarize-apply.js';

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

test('applySummaryToLines：行号越界 / 非任务行返回 ok:false；无标记任务行可落标记', () => {
  assert.equal(applySummaryToLines(['- [ ] x'], 5, { threadId: ID }).ok, false);
  assert.equal(applySummaryToLines(['普通正文行'], 0, { threadId: ID }).ok, false);
  // 同步新建的单级任务：先建普通任务行，再由总结块补上标记与描述
  const lines = ['- [ ] 19:48 hello 📅 2026-11-19'];
  const r = applySummaryToLines(lines, 0, {
    state: 'completed', threadId: ID, summarizedPromptCount: 1, title: '总结标题', points: ['要点']
  });
  assert.equal(r.ok, true);
  // 时间前缀与日期徽标必须保留
  assert.equal(lines[0], `- [x] 19:48 总结标题 📅 2026-11-19  ⚡ t3:${ID}#1`);
  assert.equal(lines[1], '  1. 要点');
});

// ---------- bugfix 回归: 行号漂移下按 threadId 现场定位 ----------

test('locateDelegationLine: 按 threadId 现场扫文件定位,不依赖缓存行号', () => {
  const A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const C = 'cccccccc-1111-2222-3333-444444444444';
  const lines = [
    '- [ ] 任务A',
    `\t- [x] 旧总结  ⚡ t3:${A}#1`,
    '- [ ] 任务B',
    `\t- [x] 另一会话  ⚡ t3:${C}`
  ];
  // 缓存说在 1（已漂移），threadId=C 的行实际在第 3 行
  const at = locateDelegationLine(lines, C, 1);
  assert.equal(at, 3);
});

test('locateDelegationLine: 缓存行号仍然准确时直接命中', () => {
  const T = 'aaaaaaaa-1111-2222-3333-444444444444';
  const lines = ['- [ ] A', `\t- [x] s  ⚡ t3:${T}#1`, '- [ ] B'];
  assert.equal(locateDelegationLine(lines, T, 1), 1);
});

test('locateDelegationLine: threadId 不存在返回 -1', () => {
  assert.equal(locateDelegationLine(['- [ ] A'], 'aaaaaaaa-1111-2222-3333-444444444444', 0), -1);
});

test('replaceSummaryInLines：搬组后分点行变成「- 1. …」也能识别并整体替换', () => {
  // 块经 core serializeBlock 搬组后，描述行会写成 `\t- 1. …`；旧正则认不出会留残行
  const lines = [
    `- [x] 旧标题  ⚡ t3:${ID}#2`,
    '\t- 1. 旧要点一',
    '\t- 2. 旧要点二',
    '### 待处理'
  ];
  const r = replaceSummaryInLines(lines, 0, {
    state: 'completed', threadId: ID, summarizedPromptCount: 3,
    title: '新标题', points: ['新要点']
  });
  assert.equal(r.ok, true);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `- [x] 新标题  ⚡ t3:${ID}#3`);
  assert.equal(lines[1], '  1. 新要点');
  assert.equal(lines[2], '### 待处理');
});
