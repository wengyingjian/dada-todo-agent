import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDelegationLine, parseDelegationLine, stateFromRun, extractDelegations, shortId, renderSummaryBlock, countSummaryDescLines, planDelegationInsert, findThreadLinks, threadIdFromToken
} from './delegate-line.js';

const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';

test('生成子行：四种状态', () => {
  assert.equal(formatDelegationLine({ state: 'running', threadId: ID }), `\t- [/] 进行中…  ⚡ t3:${ID}`);
  assert.equal(formatDelegationLine({ state: 'awaiting', threadId: ID }), `\t- [/] 等你回答…  ⚡ t3:${ID}`);
  assert.equal(formatDelegationLine({ state: 'completed', summary: '改完了', threadId: ID }), `\t- [x] 改完了  ⚡ t3:${ID}`);
  assert.equal(formatDelegationLine({ state: 'failed', summary: '连接超时', threadId: ID }), `\t- [-] 连接超时  ⚡ t3:${ID}`);
});

test('解析子行：状态、摘要、会话 id', () => {
  const p = parseDelegationLine(`\t- [x] 注册视图与会话扫描  ⚡ t3:${ID}`);
  assert.equal(p.state, 'completed');
  assert.equal(p.summary, '注册视图与会话扫描');
  assert.equal(p.threadId, ID);
  assert.equal(p.indent, '\t');
});

test('解析子行：保留 mcp: 前缀的会话 id', () => {
  const p = parseDelegationLine(`\t- [x] 完成  ⚡ t3:mcp:${ID}`);
  assert.equal(p.threadId, `mcp:${ID}`);
  assert.equal(p.state, 'completed');
});

test('解析子行：没有会话 id 的占位/失败行也认得', () => {
  const p = parseDelegationLine(`\t- [/] 进行中…  ⚡ t3:`);
  assert.equal(p.threadId, '');
  assert.equal(p.state, 'running');
  const f = parseDelegationLine(`\t- [-] spawn t3 ENOENT  ⚡ t3:`);
  assert.equal(f.state, 'failed');
  assert.equal(f.threadId, '');
});

test('非委派行返回 null', () => {
  assert.equal(parseDelegationLine('- [ ] 普通任务'), null);
  assert.equal(parseDelegationLine('\t- [x] 普通子任务'), null);
});

test('run 状态 → 子行状态', () => {
  assert.equal(stateFromRun('running', []), 'running');
  assert.equal(stateFromRun('waiting', []), 'running');
  assert.equal(stateFromRun('completed', []), 'completed');
  assert.equal(stateFromRun('failed', []), 'failed');
  assert.equal(stateFromRun('completed', ['user_input']), 'awaiting');
  assert.equal(stateFromRun('running', ['command']), 'awaiting');
  assert.equal(stateFromRun('interrupted', []), 'cancelled');
  assert.equal(stateFromRun('cancelled', []), 'cancelled');
  assert.equal(stateFromRun('', []), null);
});

test('从文件内容提取全部委派', () => {
  const lines = [
    '- [ ] 父任务',
    `\t- [x] 第一轮  ⚡ t3:${ID}`,
    `\t- [/] 进行中…  ⚡ t3:11111111-2222-3333-4444-555555555555`
  ];
  const out = extractDelegations(lines);
  assert.equal(out.length, 2);
  assert.equal(out[0].threadId, ID);
  assert.equal(out[0].parentLine, 0);
  assert.equal(out[1].state, 'running');
});

test('shortId 取前 6 位', () => {
  assert.equal(shortId(ID), '3f2a9b');
});

// ---------- LLM 总结：标记版本 #count 与描述行 ----------

test('格式化子行：带 #count 版本标记', () => {
  const line = formatDelegationLine({ state: 'completed', summary: '总结标题', threadId: ID, summarizedPromptCount: 3 });
  assert.equal(line, `\t- [x] 总结标题  ⚡ t3:${ID}#3`);
  const p = parseDelegationLine(line);
  assert.equal(p.threadId, ID);
  assert.equal(p.summarizedPromptCount, 3);
});

test('解析旧格式：无 #count 时 summarizedPromptCount 为 null', () => {
  const p = parseDelegationLine(`\t- [x] 完成  ⚡ t3:${ID}`);
  assert.equal(p.threadId, ID);
  assert.equal(p.summarizedPromptCount, null);
});

test('解析子行：#count 后面跟杂字符不影响提取', () => {
  const p = parseDelegationLine(`\t- [x] 完成  ⚡ t3:${ID}#5 （备注）`);
  assert.equal(p.threadId, ID);
  assert.equal(p.summarizedPromptCount, 5);
});

test('渲染总结块：标题行 + 分点描述行（描述是普通缩进行，非任务）', () => {
  const lines = renderSummaryBlock({
    indent: '\t', state: 'completed', threadId: ID,
    summarizedPromptCount: 2, title: '修复委派总结', points: ['改了 A', '改了 B', '改了 C']
  });
  assert.equal(lines[0], `\t- [x] 修复委派总结  ⚡ t3:${ID}#2`);
  assert.equal(lines[1], `\t  1. 改了 A`);
  assert.equal(lines[2], `\t  2. 改了 B`);
  assert.equal(lines[3], `\t  3. 改了 C`);
});

test('渲染总结块：无分点时只渲染标题行', () => {
  const lines = renderSummaryBlock({ indent: '\t', state: 'completed', threadId: ID, summarizedPromptCount: 1, title: '完成', points: [] });
  assert.equal(lines.length, 1);
});

test('解析子行时剥掉分点描述行,返回其行数以便调用方替换整块', () => {
  // 描述行格式：比任务行更深的缩进 + 非任务标记
  const block = [
    `\t- [x] 总结标题  ⚡ t3:${ID}#2`,
    `\t  1. 第一点`,
    `\t  2. 第二点`
  ];
  const consumed = countSummaryDescLines(block, 0);
  assert.equal(consumed, 2);
  assert.equal(countSummaryDescLines(['\t- [ ] 另一个任务'], 0), 0);
  assert.equal(countSummaryDescLines(['普通正文行'], 0), 0);
});

// ---------- bugfix 回归: 任务行与子行之间不得夹空行 ----------

test('delegationInsertAt: 任务行后紧跟尾部空串时,子行应紧贴任务行且删掉途中的空行', () => {
  // 真实场景: createChecklistTask 建父任务后, body 以 \n 结尾 → 尾部空串
  const lines = ['前文', '- [ ] 任务X', '- [ ] 做个游戏', ''];
  const r = planDelegationInsert(lines, 2);
  // 期望: 插在 3(紧贴任务行),并删除 3 位置的空串
  assert.deepEqual(r, { at: 3, removeEmpty: 1 });
});
test('delegationInsertAt: 任务行后有多个空行时全部跳过并计数', () => {
  const lines = ['- [ ] 任务', '', '', '后续'];
  const r = planDelegationInsert(lines, 0);
  assert.deepEqual(r, { at: 1, removeEmpty: 2 });
});
test('delegationInsertAt: 任务行后紧跟其他内容(无空行)时不动', () => {
  const lines = ['- [ ] 任务', '	- [x] 已有子行'];
  assert.deepEqual(planDelegationInsert(lines, 0), { at: 1, removeEmpty: 0 });
});

// ---------- 编辑器可点会话标记：⚡ t3:<id> ----------

test('findThreadLinks: 定位标记范围与会话 id（含 #count 版本号）', () => {
  const line = `\t- [x] 改完了  ⚡ t3:${ID}#2`;
  const links = findThreadLinks(line);
  assert.equal(links.length, 1);
  assert.equal(links[0].threadId, ID);
  assert.equal(line.slice(links[0].from, links[0].to), `⚡ t3:${ID}#2`);
});

test('findThreadLinks: 保留 mcp: 前缀的会话 id', () => {
  const links = findThreadLinks(`\t- [x] 完成  ⚡ t3:mcp:${ID}`);
  assert.equal(links.length, 1);
  assert.equal(links[0].threadId, `mcp:${ID}`);
});

test('findThreadLinks: 无会话 id 的占位行 / 失败行不可点', () => {
  assert.deepEqual(findThreadLinks(`\t- [/] 进行中…  ⚡ t3:`), []);
  assert.deepEqual(findThreadLinks(`\t- [-] spawn t3 ENOENT  ⚡ t3:`), []);
});

test('findThreadLinks: 一行多个标记全部命中，普通文本不受影响', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  const line = `⚡ t3:${ID} 和 ⚡ t3:${other}#3`;
  const links = findThreadLinks(line);
  assert.deepEqual(links.map((l) => l.threadId), [ID, other]);
  assert.deepEqual(findThreadLinks('- [ ] 普通任务'), []);
});

test('threadIdFromToken: 截到 uuid 结尾，忽略前缀与版本号', () => {
  assert.equal(threadIdFromToken(`mcp:${ID}#5`), `mcp:${ID}`);
  assert.equal(threadIdFromToken(`p!a1b2c3d4`), '');
  assert.equal(threadIdFromToken(''), '');
});
