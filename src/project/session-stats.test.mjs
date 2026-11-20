import test from 'node:test';
import assert from 'node:assert/strict';
import { unionSegs, fmtMin, computeTodayStats, weekComparison } from './session-stats.js';

// 构造一个会话：firstMsgAt/lastMsgAt 为毫秒时间戳（以 2026-11-20 当天为基准）
// 当天 0 点 = 2026-11-20T00:00:00 本地时间
const DAY = new Date(2026, 10, 20).getTime();
const min = (m) => DAY + m * 60000; // 当天第 m 分钟
const th = (id, cwd, startMin, endMin, promptCount = 1) => ({
  threadId: id,
  cwd,
  firstMsgAt: min(startMin),
  lastMsgAt: min(endMin),
  promptCount
});

test('unionSegs 合并重叠与相邻区间', () => {
  assert.deepEqual(unionSegs([[0, 10], [8, 20], [20, 25]]), [[0, 25]]);
});

test('unionSegs 保留有间隔的区间并排序无序输入', () => {
  assert.deepEqual(unionSegs([[30, 40], [0, 10]]), [[0, 10], [30, 40]]);
});

test('unionSegs 空输入返回空数组', () => {
  assert.deepEqual(unionSegs([]), []);
});

test('fmtMin：45 分钟 → 45m，200 → 3h 20m，180 → 3h', () => {
  assert.equal(fmtMin(45), '45m');
  assert.equal(fmtMin(200), '3h 20m');
  assert.equal(fmtMin(180), '3h');
  assert.equal(fmtMin(0), '0m');
});

test('computeTodayStats：只统计今天 0 点以后的会话', () => {
  const threads = [
    th('today', '/a/proj', 100, 120),
    th('yesterday', '/a/proj', DAY - 60000 - 3600000, DAY - 60000) // 昨天的区间
  ];
  const s = computeTodayStats(threads, min(200));
  assert.equal(s.sessions, 1);
});

test('computeTodayStats：wall 是跨会话区间并集，重叠不重复计时', () => {
  const threads = [
    th('a', '/a/p1', 60, 120),
    th('b', '/a/p2', 100, 180)
  ];
  const s = computeTodayStats(threads, min(300));
  assert.equal(s.wall, 120); // 60–180 分钟 = 120 分钟
});

test('computeTodayStats：跨午夜开始的会话裁剪到今天 0 点', () => {
  const threads = [{
    threadId: 'span',
    cwd: '/a/p',
    firstMsgAt: DAY - 2 * 60000, // 昨天 23:58
    lastMsgAt: min(30),
    promptCount: 1
  }];
  const s = computeTodayStats(threads, min(200));
  assert.equal(s.wall, 30);
});

test('computeTodayStats：会话数与提问数为各会话之和', () => {
  const threads = [
    th('a', '/a/p1', 10, 20, 3),
    th('b', '/a/p1', 40, 50, 5)
  ];
  const s = computeTodayStats(threads, min(200));
  assert.equal(s.sessions, 2);
  assert.equal(s.prompts, 8);
});

test('computeTodayStats：项目按 cwd 分组、时长倒序、名称取路径末段', () => {
  const threads = [
    th('a', '/w/dada-todo-agent', 0, 30, 1),
    th('b', '/w/obsidian-DadaTodoList', 0, 60, 1),
    th('c', '/w/dada-todo-agent', 40, 50, 1)
  ];
  const s = computeTodayStats(threads, min(200));
  assert.deepEqual(
    s.projects.map((p) => [p.name, p.min]),
    [['obsidian-DadaTodoList', 60], ['dada-todo-agent', 40]]
  );
  assert.deepEqual(s.projects[1].segs, [[0, 30], [40, 50]]);
});

test('computeTodayStats：时间轴窗口从首段活动整点到现在，至少 180 分钟', () => {
  const threads = [th('a', '/a/p', 65, 90)];
  const s = computeTodayStats(threads, min(100));
  assert.deepEqual(s.timeline, { from: 60, to: 240, nowMin: 100 });

  const late = computeTodayStats([th('b', '/a/p', 10, 20)], min(700));
  assert.deepEqual(late.timeline, { from: 0, to: 720, nowMin: 700 });
});

test('computeTodayStats：今天没有会话时全为零、无项目', () => {
  const s = computeTodayStats([], min(300));
  assert.equal(s.wall, 0);
  assert.equal(s.sessions, 0);
  assert.equal(s.prompts, 0);
  assert.deepEqual(s.projects, []);
});

test('weekComparison：前 7 天有 ≥3 天用量时返回相对 7 日均的百分比', () => {
  const threads = [];
  for (let d = 1; d <= 3; d++) {
    threads.push(th(`d${d}`, '/a/p', -d * 1440, -d * 1440 + 60)); // 昨天起每天 0:00–1:00 各 60 分钟
  }
  threads.push(th('today', '/a/p', 0, 120));
  const cmp = weekComparison(threads, min(300));
  assert.ok(cmp);
  assert.equal(cmp.avgMin, 60);
  assert.equal(cmp.pct, 100); // 120 / 60 - 1 = +100%
});

test('weekComparison：有用量天数不足 3 天返回 null', () => {
  const threads = [th('today', '/a/p', 0, 60)];
  assert.equal(weekComparison(threads, min(300)), null);
});

test('weekComparison：只看今天之前的 7 天，更早的用量不参与', () => {
  const threads = [
    th('d1', '/a/p', -1440, -1440 + 60),
    th('d2', '/a/p', -2880, -2880 + 60),
    th('d8', '/a/p', -8 * 1440, -8 * 1440 + 60),
    th('today', '/a/p', 0, 60)
  ];
  assert.equal(weekComparison(threads, min(300)), null); // 只有 2 天在窗口内
});
