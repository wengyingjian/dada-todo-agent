import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScanSql, mapThreadRow, chooseOwner, threadTitleOf, taskDateMeta, classifyWorkspace, unboundTarget } from './reverse-sync.js';
import { buildProjectIndex } from './index.js';

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
    [
      { path: '清单/工作.md', frontmatter: { cwd: '/repos' } },
      { path: '清单/A.md', frontmatter: { cwd: '/repos/a' } }
    ],
    { root: '清单' }
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

// classifyWorkspace：只有 project / journal / ignored 三态，未记录默认 ignored
test('归属分类：三态与默认忽略', () => {
  const idx = buildProjectIndex([{ path: '清单/工作.md', frontmatter: { cwd: '/repos' } }], { root: '清单' });
  // 没在任何列表 = 默认忽略（implicit 标记便于 UI 区分显式设置）
  const def = classifyWorkspace('/tmp/x', idx.nodes, [], []);
  assert.equal(def.type, 'ignored');
  assert.equal(def.implicit, true);
  // 显式忽略 / 日记（含子目录、尾斜杠/空白归一化）
  assert.equal(classifyWorkspace('/tmp/x', idx.nodes, ['/tmp'], []).type, 'ignored');
  assert.equal(classifyWorkspace('/tmp/x/sub', idx.nodes, ['/tmp'], []).type, 'ignored');
  assert.equal(classifyWorkspace('/tmp/x', idx.nodes, [], ['/tmp']).type, 'journal');
  assert.equal(classifyWorkspace('/tmp/x', idx.nodes, [], ['/tmp/ ']).type, 'journal');
  // 同一前缀显式状态压过项目（切换状态时靠这条生效）
  assert.equal(classifyWorkspace('/repos/a', idx.nodes, ['/repos/a'], []).type, 'ignored');
  // 项目前缀更具体时项目胜出
  const deep = buildProjectIndex([{ path: '清单/深.md', frontmatter: { cwd: '/repos/a' } }], { root: '清单' });
  assert.equal(classifyWorkspace('/repos/a/src', deep.nodes, ['/repos'], []).type, 'project');
  // 空 cwd 永远默认忽略
  assert.equal(classifyWorkspace('', idx.nodes, [], ['/tmp']).type, 'ignored');
});

test('归属分类：最长前缀胜出，三种状态可互相覆盖', () => {
  const idx = buildProjectIndex([{ path: '清单/工作.md', frontmatter: { cwd: '/repos' } }], { root: '清单' });
  // 父目录是项目，子目录显式设为日记 → 子目录按日记（更具体）
  assert.equal(classifyWorkspace('/repos/sub', idx.nodes, [], ['/repos/sub']).type, 'journal');
  // 子目录显式忽略同理
  assert.equal(classifyWorkspace('/repos/sub', idx.nodes, ['/repos/sub'], []).type, 'ignored');
  // 父目录日记、子目录是更具体的项目 → 子目录归项目
  const deep = buildProjectIndex([{ path: '清单/深.md', frontmatter: { cwd: '/repos/a' } }], { root: '清单' });
  assert.equal(classifyWorkspace('/repos/a', deep.nodes, [], ['/repos']).type, 'project');
  // 同一前缀撞车：显式忽略 > 显式日记 > 自有项目 > 继承型项目。
  // 显式状态压过项目，切换状态时无需清空项目 cwd（切回项目直接清列表即可，不重复建目录）
  assert.equal(classifyWorkspace('/tmp/x', idx.nodes, ['/tmp'], ['/tmp']).type, 'ignored');
  const own = [{ dirPath: '任务/根', cwd: '/repos', ownCwd: '/repos' }];
  assert.equal(classifyWorkspace('/repos', own, [], []).type, 'project');
  assert.equal(classifyWorkspace('/repos', own, [], ['/repos']).type, 'journal');
  assert.equal(classifyWorkspace('/repos', own, ['/repos'], []).type, 'ignored');
  // 继承 cwd 的项目（ownCwd 为空）同理，显式列表覆盖后立即生效
  const inherited = [{ dirPath: '任务/根', cwd: '/repos', ownCwd: '' }];
  assert.equal(classifyWorkspace('/repos', inherited, [], []).type, 'project');
  assert.equal(classifyWorkspace('/repos', inherited, [], ['/repos']).type, 'journal');
  assert.equal(classifyWorkspace('/repos', inherited, ['/repos'], []).type, 'ignored');
});

test('未绑定会话去向：只有项目 / 日记进入，忽略一律跳过', () => {
  assert.equal(unboundTarget({ type: 'project' }), 'project');
  assert.equal(unboundTarget({ type: 'journal' }), 'journal');
  assert.equal(unboundTarget({ type: 'ignored' }), 'skip');
  assert.equal(unboundTarget(null), 'skip');
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
