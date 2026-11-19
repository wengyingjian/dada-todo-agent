// 委派总结 LLM 模块纯函数测试：transcript 组装与截断、prompt 构建、响应解析、会话新鲜度判断
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTranscript, buildSummaryPrompt, parseSummaryReply,
  shouldResummarize, countUserPrompts
} from './summarize-llm.js';

const MSGS = [
  { role: 'user', text: '帮我修一下登录页的 bug' },
  { role: 'assistant', text: '我看了下，是 token 过期判断写反了。\n\n修复思路：1. 调整判断顺序 2. 加回归测试' },
  { role: 'user', text: '顺便把样式也调一下' },
  { role: 'assistant', text: '样式已调整为暗色适配。' }
];

test('buildTranscript：只留 user/assistant 文本，带角色前缀', () => {
  const t = buildTranscript(MSGS, { maxChars: 10000 });
  assert.match(t, /用户: 帮我修一下登录页的 bug/);
  assert.match(t, /助手: 我看了下/);
  assert.doesNotMatch(t, /tool|system/i);
});

test('buildTranscript：过滤工具注入的用户消息（createdBy!=="user"）', () => {
  const msgs = [...MSGS, { role: 'user', text: '[系统注入] 本地命令输出……', createdBy: 'tool' }];
  const t = buildTranscript(msgs, { maxChars: 10000 });
  assert.doesNotMatch(t, /系统注入/);
});

test('buildTranscript：超预算时保留尾部（最新消息优先）', () => {
  const long = { role: 'user', text: 'x'.repeat(5000) };
  const t = buildTranscript([long, ...MSGS], { maxChars: 1000 });
  assert.ok(t.length <= 1100, `长度 ${t.length} 应约 ≤ 预算`);
  assert.match(t, /样式已调整/); // 尾部消息必须在
  assert.doesNotMatch(t, /xxxxx/); // 头部长消息应被截掉
});

test('buildSummaryPrompt：包含 transcript 与输出格式要求', () => {
  const { system, user } = buildSummaryPrompt('帮我修登录页 bug', buildTranscript(MSGS, { maxChars: 10000 }));
  assert.match(system, /标题/);
  assert.match(system, /分点|1234|\d+\.|要点/);
  assert.match(user, /帮我修一下登录页的 bug/);
});

test('parseSummaryReply：解析「标题:」与分点行', () => {
  const reply = '标题: 修复登录页 token 过期判断\n1. 调整了 token 过期判断顺序\n2. 补充回归测试\n3. 暗色样式适配';
  const r = parseSummaryReply(reply);
  assert.equal(r.title, '修复登录页 token 过期判断');
  assert.deepEqual(r.points, ['调整了 token 过期判断顺序', '补充回归测试', '暗色样式适配']);
});

test('parseSummaryReply：无分点/怪格式也能兜底出标题', () => {
  const r = parseSummaryReply('就一个标题，没有分点');
  assert.equal(r.title, '就一个标题，没有分点');
  assert.deepEqual(r.points, []);
});

test('parseSummaryReply：超长分点截断到上限', () => {
  const reply = ['标题: t', ...Array.from({ length: 10 }, (_, i) => `${i + 1}. 第${i + 1}点`)].join('\n');
  const r = parseSummaryReply(reply, { maxPoints: 5 });
  assert.equal(r.points.length, 5);
});

test('countUserPrompts：数真实用户消息数', () => {
  const msgs = [...MSGS, { role: 'user', text: '注入', createdBy: 'tool' }];
  assert.equal(countUserPrompts(msgs), 2);
});

test('shouldResummarize：completed 且静默超时且计数增加才总结', () => {
  const now = Date.now();
  const opts = { now, silentMs: 30 * 60000 };
  assert.equal(shouldResummarize({ state: 'completed', summarizedPromptCount: 2, currentPromptCount: 3, updatedAt: now - 31 * 60000, ...opts }), true);
  // 计数没变：不需要
  assert.equal(shouldResummarize({ state: 'completed', summarizedPromptCount: 3, currentPromptCount: 3, updatedAt: now - 31 * 60000, ...opts }), false);
  // 未静默 30 分钟：不总结
  assert.equal(shouldResummarize({ state: 'completed', summarizedPromptCount: 2, currentPromptCount: 3, updatedAt: now - 10 * 60000, ...opts }), false);
  // 从未总结过（null）但已静默：要总结第一轮
  assert.equal(shouldResummarize({ state: 'completed', summarizedPromptCount: null, currentPromptCount: 2, updatedAt: now - 31 * 60000, ...opts }), true);
  // 还在进行中：不总结
  assert.equal(shouldResummarize({ state: 'running', summarizedPromptCount: 2, currentPromptCount: 3, updatedAt: now - 31 * 60000, ...opts }), false);
});
