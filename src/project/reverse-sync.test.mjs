import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScanSql, mapThreadRow, chooseOwner, threadTitleOf } from './reverse-sync.js';
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
