import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSessionLine, rewriteSessionLine, stripSessionMark, sessionMarkOf, sessionThreadIdOf, locateSessionLine
} from './session-line.js';

const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';

test('拆行：时间前缀 / 标题 / 日期后缀 / 标记各归各位', () => {
  const s = splitSessionLine(`- [x] 19:48-19:48 修复嵌套技能识别 📅 2026-11-19  ⚡ t3:${ID}#3`);
  assert.equal(s.indent, '');
  assert.equal(s.box, 'x');
  assert.equal(s.timePrefix, '19:48-19:48 ');
  assert.equal(s.title, '修复嵌套技能识别');
  assert.equal(s.dateSuffix, ' 📅 2026-11-19');
  assert.equal(s.parsed.threadId, ID);
  assert.equal(s.parsed.summarizedPromptCount, 3);
});

test('改写：只换状态，时间/日期/缩进/标记全部保留', () => {
  const line = `\t- [/] 19:48 修复识别 📅 2026-11-19  ⚡ t3:${ID}#2`;
  assert.equal(
    rewriteSessionLine(line, { state: 'completed' }),
    `\t- [x] 19:48 修复识别 📅 2026-11-19  ⚡ t3:${ID}#2`
  );
});

test('改写：占位行回填真实 threadId（p! 临时 id 被替换）', () => {
  assert.equal(
    rewriteSessionLine('\t- [/] hello  ⚡ t3:p!abcd1234', { state: 'running', threadId: ID }),
    `\t- [/] hello  ⚡ t3:${ID}`
  );
});

test('改写：无标记的普通任务行可落标记（同步新建第一步）', () => {
  const line = '- [ ] 19:48 hello 📅 2026-11-19';
  assert.equal(
    rewriteSessionLine(line, { state: 'completed', threadId: ID, summarizedPromptCount: 1, title: 'LLM 标题' }),
    `- [x] 19:48 LLM 标题 📅 2026-11-19  ⚡ t3:${ID}#1`
  );
});

test('改写：子行保持缩进，父行类型不受影响', () => {
  const line = '\t- [/] 等你回答…  ⚡ t3:p!abcd1234';
  assert.equal(rewriteSessionLine(line, { state: 'awaiting' }), '\t- [/] 等你回答…  ⚡ t3:p!abcd1234');
});

test('标题展示：剥离标记但保留时间与日期', () => {
  const summary = `19:48-19:48 修复嵌套技能识别 📅 2026-11-19  ⚡ t3:${ID}#3`;
  assert.equal(stripSessionMark(summary), '19:48-19:48 修复嵌套技能识别 📅 2026-11-19');
  assert.equal(sessionMarkOf(summary), `⚡ t3:${ID}#3`);
  assert.equal(sessionThreadIdOf(summary), ID);
  assert.equal(stripSessionMark('普通任务'), '普通任务');
  assert.equal(sessionMarkOf('普通任务'), '');
});

test('locateSessionLine：threadId → pendingId → 缓存行号三级定位', () => {
  const lines = [
    '- [ ] 任务',
    `\t- [x] 旧  ⚡ t3:${ID}#1`,
    '\t- [/] hello  ⚡ t3:p!abcd1234'
  ];
  assert.equal(locateSessionLine(lines, { threadId: ID }), 1);
  assert.equal(locateSessionLine(lines, { pendingId: 'abcd1234' }), 2);
  // 行号漂移时 threadId 仍优先
  assert.equal(locateSessionLine(lines, { threadId: ID, cachedLineNo: 2 }), 1);
  assert.equal(locateSessionLine(lines, { cachedLineNo: -1 }), -1);
});
