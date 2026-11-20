// 项目索引层（扁平版）单测：项目 = 一份清单文件，平铺无层级，cwd 不继承（无父级可继承）。
// 规格基准：docs/ideas/file-io-unification.md 与 2026-11-20 结构调整决定。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectIndex, matchProjectByCwd, normalizeRoot } from './index.js';

test('项目即清单文件：每个文件一个节点，dirPath 为所在文件夹', () => {
  const idx = buildProjectIndex(
    [
      { path: '清单/工作.md', frontmatter: { cwd: '/repos/work' } },
      { path: '清单/子目录/侧项目.md', frontmatter: { cwd: '/repos/side' } }
    ],
    { root: '清单' }
  );
  assert.equal(idx.nodes.length, 2);
  const work = idx.byPath.get('清单/工作.md');
  assert.equal(work.name, '工作');
  assert.equal(work.filePath, '清单/工作.md');
  assert.equal(work.dirPath, '清单'); // 兼容旧字段：文件所在文件夹
  assert.equal(work.cwd, '/repos/work');
  assert.equal(work.depth, 1);
  assert.deepEqual(work.children, []);
});

test('frontmatter cwd 缺失时用默认 cwd，无默认则为空', () => {
  const idx = buildProjectIndex(
    [{ path: '清单/A.md', frontmatter: {} }],
    { root: '清单', defaultCwd: '/fallback' }
  );
  assert.equal(idx.nodes[0].cwd, '/fallback');
  assert.equal(idx.nodes[0].ownCwd, '');
  const none = buildProjectIndex([{ path: '清单/A.md', frontmatter: {} }], { root: '清单' });
  assert.equal(none.nodes[0].cwd, '');
});

test('排序：sort 优先，其次名称（zh-Hans-CN）', () => {
  const idx = buildProjectIndex(
    [
      { path: '清单/a.md', frontmatter: { sort: 20 } },
      { path: '清单/b.md', frontmatter: { sort: 5 } },
      { path: '清单/c.md', frontmatter: {} }
    ],
    { root: '清单' }
  );
  assert.deepEqual(idx.roots.map((n) => n.name), ['b', 'a', 'c']);
});

test('cwd 归属取最长匹配，不命中返回 null', () => {
  const idx = buildProjectIndex(
    [
      { path: '清单/工作.md', frontmatter: { cwd: '/repos' } },
      { path: '清单/子.md', frontmatter: { cwd: '/repos/sub' } }
    ],
    { root: '清单' }
  );
  assert.equal(matchProjectByCwd('/repos/sub/x', idx.nodes).name, '子');
  assert.equal(matchProjectByCwd('/repos/other', idx.nodes).name, '工作');
  assert.equal(matchProjectByCwd('/elsewhere', idx.nodes), null);
  assert.equal(matchProjectByCwd('', idx.nodes), null);
});

test('忽略非 md 与空路径条目', () => {
  const idx = buildProjectIndex(
    [{ path: '清单/A.md', frontmatter: {} }, { path: '清单/B.txt', frontmatter: {} }, { path: '', frontmatter: {} }],
    { root: '清单' }
  );
  assert.equal(idx.nodes.length, 1);
});

test('normalizeRoot 去首尾斜杠', () => {
  assert.equal(normalizeRoot(' /清单/ '), '清单');
  assert.equal(normalizeRoot('清单//子'), '清单/子');
});
