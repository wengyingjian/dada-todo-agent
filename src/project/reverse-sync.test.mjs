import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScanSql, mapThreadRow, chooseOwner, threadTitleOf, taskDateMeta, classifyWorkspace, collectUnmatched, summarizeThreadsByCwd } from './reverse-sync.js';
import { buildProjectIndex } from './index.js';

// summarizeThreadsByCwd：全量分组 + 最长前缀归属 + 忽略标注
test('全量会话按 cwd 汇总：无 cwd 归一组，归属取最长前缀', () => {
  const threads = [
    { threadId: 'a', cwd: '/repos/a', title: 'x' },
    { threadId: 'b', cwd: '/repos/a/sub', title: 'y' },
    { threadId: 'c', cwd: '/repos', title: 'z' },
    { threadId: 'd', cwd: '', title: 'w' },
    { threadId: 'e', cwd: '/tmp/scratch', title: 'v' }
  ];
  const nodes = [
    { dirPath: '任务/A', cwd: '/repos/a' },
    { dirPath: '任务/根', cwd: '/repos' }
  ];
  const groups = summarizeThreadsByCwd(threads, nodes, ['/tmp/scratch']);
  const byCwd = Object.fromEntries(groups.map((g) => [g.cwd, g]));
  // 分组按原始 cwd 精确归组（子目录单独成组），归属才做最长前缀
  assert.equal(byCwd['/repos/a'].total, 1);
  assert.equal(byCwd['/repos/a/sub'].total, 1);
  assert.equal(byCwd['/repos/a'].projectDir, '任务/A');
  assert.equal(byCwd['/repos/a/sub'].projectDir, '任务/A'); // 子目录归属父项目
  assert.equal(byCwd['/repos'].projectDir, '任务/根');
  assert.equal(byCwd['(无 cwd)'].total, 1);
  assert.equal(byCwd['/tmp/scratch'].ignored, true);
});

test('扫描 SQL 覆盖所需表并排除内部线程', () => {
  const sql = buildScanSql('2026-11-18T00:00:00.000Z');
  assert.match(sql, /projection_projects/);
  assert.match(sql, /workspace_root/);
  assert.match(sql, /runtime_requests/);
  assert.match(sql, /import:%/);
  assert.match(sql, /thread:provider:%/);
  assert.match(sql, /2026-11-18T00:00:00\.000Z/);
});

test('行映射：状态与待处理类型', () => {
  const t = mapThreadRow({
    thread_id: 'a', title: '写插件', cwd: '/repos/x', run_status: 'running',
    pending_kinds: 'user_input', created_at: '2026-11-18T10:00:00.000Z',
    updated_at: '2026-11-18T10:30:00.000Z', first_user: '帮我做个东西', last_assistant: '好的'
  });
  assert.equal(t.threadId, 'a');
  assert.equal(t.title, '写插件');
  assert.equal(t.cwd, '/repos/x');
  assert.deepEqual(t.pendingKinds, ['user_input']);
  assert.equal(t.state, 'awaiting');
});

test('空标题回退到首条用户消息', () => {
  assert.equal(threadTitleOf({ title: '', firstUser: '  先看看这个项目  ' }), '先看看这个项目');
  assert.equal(threadTitleOf({ title: 'placeholder', firstUser: '真正的任务' }), '真正的任务');
  assert.equal(threadTitleOf({ title: '正常标题', firstUser: 'x' }), '正常标题');
  assert.equal(threadTitleOf({ title: '', firstUser: '', threadId: 'abcdef12-3456' }), 'T3 会话 abcdef');
});

test('归属：cwd 命中项目否则日记', () => {
  const idx = buildProjectIndex(
    [{ path: '任务/工作' }, { path: '任务/工作/A' }],
    [
      { path: '任务/工作/task-工作.md', frontmatter: { cwd: '/repos' } },
      { path: '任务/工作/A/task-A.md', frontmatter: { cwd: '/repos/a' } }
    ],
    { root: '任务' }
  );
  assert.equal(chooseOwner('/repos/a/src', idx.nodes).node.name, 'A');
  assert.equal(chooseOwner('/repos/other', idx.nodes).node.name, '工作');
  assert.equal(chooseOwner('/tmp/x', idx.nodes), null);
});

test('mapThreadRow: 任一 run running 时状态覆盖为 running（agent-deck 口径回归）', () => {
  const r = mapThreadRow({ thread_id: 't1', run_status: 'completed', running_runs: 2, pending_kinds: '' });
  assert.equal(r.state, 'running');
  const r2 = mapThreadRow({ thread_id: 't2', run_status: 'completed', running_runs: 0, pending_kinds: '' });
  assert.equal(r2.state, 'completed');
});

// classifyWorkspace：project / ignored / unknown 三态，忽略口径与项目匹配一致（前缀 + /）
test('归属分类：ignored 命中（含子目录）优先于 unknown，但让位于项目命中', () => {
  const idx = buildProjectIndex([{ path: '任务/工作' }], [{ path: '任务/工作/task-工作.md', frontmatter: { cwd: '/repos' } }], { root: '任务' });
  assert.equal(classifyWorkspace('/tmp/x', idx.nodes, []).type, 'unknown');
  assert.equal(classifyWorkspace('/tmp/x', idx.nodes, ['/tmp']).type, 'ignored');
  assert.equal(classifyWorkspace('/tmp/x/sub', idx.nodes, ['/tmp']).type, 'ignored');
  // 命中项目时不因忽略列表误伤（项目 cwd 前缀 > 忽略前缀时仍归项目）
  assert.equal(classifyWorkspace('/repos/a', idx.nodes, ['/repos']).type, 'project');
  assert.equal(classifyWorkspace('', idx.nodes, []).type, 'unknown');
  // 尾斜杠与空白归一化
  assert.equal(classifyWorkspace('/tmp/x', idx.nodes, ['/tmp/ ']).type, 'ignored');
});

// collectUnmatched：去重、空 cwd 过滤、名称取 basename、count 透传（兼容纯字符串项）
test('未知工作区去重：首次见到的才进弹窗', () => {
  const r1 = collectUnmatched(['/repos/a', '/repos/a/', ' ', '/repos/b', { cwd: '/repos/c', count: 3 }], []);
  assert.deepEqual(r1.items.map((x) => x.cwd), ['/repos/a', '/repos/b', '/repos/c']);
  assert.deepEqual(r1.newCwds, ['/repos/a', '/repos/b', '/repos/c']);
  assert.equal(r1.items[0].name, 'a');
  assert.equal(r1.items[2].count, 3);
  // 已提醒过的不再出现
  const r2 = collectUnmatched(['/repos/a', '/repos/c'], ['/repos/a']);
  assert.deepEqual(r2.items.map((x) => x.cwd), ['/repos/c']);
});

// taskDateMeta：跨天 → 🛫+📅；同天 → HH:MM-HH:MM 前缀 + 📅；无时间 → 空片段
test('任务日期片段：跨天与同天两种写法', () => {
  // 用本地时间构造数据（实现按本地时区判断跨天，与 dada 面板口径一致）
  const mk = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
  // 同天：09:30-11:45 + 📅 当天
  const same = taskDateMeta({ firstMsgAt: mk(2026, 11, 19, 9, 30), lastMsgAt: mk(2026, 11, 19, 11, 45) });
  assert.deepEqual(same, { timePrefix: '09:30-11:45 ', dateSuffix: ' 📅 2026-11-19' });
  // 跨天：🛫 开始日 + 📅 结束日
  const cross = taskDateMeta({ firstMsgAt: mk(2026, 11, 21, 23, 0), lastMsgAt: mk(2026, 11, 22, 1, 0) });
  assert.equal(cross.timePrefix, '');
  assert.equal(cross.dateSuffix, ' 🛫 2026-11-21 📅 2026-11-22');
  // 无时间 → 空
  assert.deepEqual(taskDateMeta({}), { timePrefix: '', dateSuffix: '' });
});

test('扫描 SQL 带首末消息时间', () => {
  const sql = buildScanSql('2026-11-18T00:00:00.000Z');
  assert.match(sql, /first_msg_at/);
  assert.match(sql, /last_msg_at/);
});
