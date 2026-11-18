import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectIndex, matchProjectByCwd, projectDirOf, projectFilePath, normalizeRoot
} from './index.js';

const ROOT = '任务';

test('识别项目文件并与目录同名', () => {
  assert.equal(projectDirOf('任务/工作/task-工作.md', ROOT), '任务/工作');
  assert.equal(projectDirOf('任务/工作/LoopForge/task-LoopForge.md', ROOT), '任务/工作/LoopForge');
  assert.equal(projectDirOf('任务/工作/其它.md', ROOT), null);
  assert.equal(projectDirOf('任务/工作/task-别的名字.md', ROOT), null);
  assert.equal(projectFilePath('任务/工作/LoopForge'), '任务/工作/LoopForge/task-LoopForge.md');
});

test('构建层级：父项目与子项目', () => {
  const idx = buildProjectIndex(
    [{ path: '任务/工作' }, { path: '任务/工作/LoopForge' }],
    [
      { path: '任务/工作/task-工作.md', frontmatter: { type: 'project' } },
      { path: '任务/工作/LoopForge/task-LoopForge.md', frontmatter: { type: 'project' } }
    ],
    { root: ROOT }
  );
  assert.equal(idx.roots.length, 1);
  assert.equal(idx.roots[0].name, '工作');
  assert.equal(idx.roots[0].children.length, 1);
  assert.equal(idx.roots[0].children[0].name, 'LoopForge');
  assert.equal(idx.roots[0].children[0].depth, 2);
});

test('目录即项目：没有项目文件的目录也存在', () => {
  const idx = buildProjectIndex(
    [{ path: '任务/空项目' }],
    [],
    { root: ROOT }
  );
  assert.equal(idx.nodes.length, 1);
  assert.equal(idx.nodes[0].filePath, '');
});

test('cwd 继承父级并可覆盖', () => {
  const idx = buildProjectIndex(
    [{ path: '任务/工作' }, { path: '任务/工作/A' }, { path: '任务/工作/B' }],
    [
      { path: '任务/工作/task-工作.md', frontmatter: { cwd: '/repos/company' } },
      { path: '任务/工作/A/task-A.md', frontmatter: {} },
      { path: '任务/工作/B/task-B.md', frontmatter: { cwd: '/repos/b' } }
    ],
    { root: ROOT, defaultCwd: '/fallback' }
  );
  const work = idx.byDir.get('任务/工作');
  assert.equal(work.cwd, '/repos/company');
  assert.equal(idx.byDir.get('任务/工作/A').cwd, '/repos/company');
  assert.equal(idx.byDir.get('任务/工作/B').cwd, '/repos/b');
});

test('无 cwd 时用默认值', () => {
  const idx = buildProjectIndex([{ path: '任务/X' }], [], { root: ROOT, defaultCwd: '/default' });
  assert.equal(idx.byDir.get('任务/X').cwd, '/default');
});

test('排序：sort 优先，其次名称', () => {
  const idx = buildProjectIndex(
    [{ path: '任务/a' }, { path: '任务/b' }, { path: '任务/c' }],
    [
      { path: '任务/a/task-a.md', frontmatter: { sort: 20 } },
      { path: '任务/b/task-b.md', frontmatter: { sort: 5 } },
      { path: '任务/c/task-c.md', frontmatter: {} }
    ],
    { root: ROOT }
  );
  assert.deepEqual(idx.roots.map((n) => n.name), ['b', 'a', 'c']);
});

test('忽略隐藏目录与根本身', () => {
  const idx = buildProjectIndex(
    [{ path: '任务/.trash' }, { path: '任务' }, { path: '其它/x' }],
    [],
    { root: ROOT }
  );
  assert.equal(idx.nodes.length, 0);
});

test('cwd 归属取最长匹配', () => {
  const idx = buildProjectIndex(
    [{ path: '任务/工作' }, { path: '任务/工作/子' }],
    [
      { path: '任务/工作/task-工作.md', frontmatter: { cwd: '/repos' } },
      { path: '任务/工作/子/task-子.md', frontmatter: { cwd: '/repos/sub' } }
    ],
    { root: ROOT }
  );
  assert.equal(matchProjectByCwd('/repos/sub/x', idx.nodes).name, '子');
  assert.equal(matchProjectByCwd('/repos/other', idx.nodes).name, '工作');
  assert.equal(matchProjectByCwd('/elsewhere', idx.nodes), null);
});

test('normalizeRoot 去首尾斜杠', () => {
  assert.equal(normalizeRoot(' /任务/ '), '任务');
  assert.equal(normalizeRoot('任务//子'), '任务/子');
});
