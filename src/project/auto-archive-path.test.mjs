// 清单归档文件夹与自动归档目标路径的纯逻辑规格（TDD RED 起步）。
// autoArchiveTarget 是这次结构调整新增的核心导出：给定清单路径，算出
// <清单文件夹>/归档/<清单名>/归档-<清单名>-<日期>.md 及其前缀正则。
// 依赖 vault 的完整流程无法在 Node 纯测；这里覆盖可纯测的路径计算面。

import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveNameRegex } from './archive.js';
import { computeAutoArchiveTarget } from './auto-archive-path.js';

test('目标路径：<清单文件夹>/归档/<清单名>/归档-<清单名>-<最早日期>.md', () => {
  const t = computeAutoArchiveTarget('清单/工作.md', ['2026-10-01', '2026-10-30']);
  assert.equal(t.dir, '清单/归档/工作');
  assert.equal(t.prefix, '归档-工作-');
  assert.equal(t.path, '清单/归档/工作/归档-工作-2026-10-01.md');
  assert.equal(t.nameRegex.test('归档-工作-2026-10-01.md'), true);
  assert.equal(t.nameRegex.test('归档-其他-2026-10-01.md'), false);
});

test('日期取本批最早（排序后首个），库根清单时归档文件夹为「归档」', () => {
  const t = computeAutoArchiveTarget('工作.md', ['2026-10-30', '2026-10-01']);
  assert.equal(t.dir, '归档/工作');
  assert.equal(t.path, '归档/工作/归档-工作-2026-10-01.md');
});

test('清单名含特殊字符时原样使用（yamlScalar 由 createListFile 负责，路径不转义）', () => {
  const t = computeAutoArchiveTarget('清单/我的 项目#1.md', ['2026-01-01']);
  assert.equal(t.dir, '清单/归档/我的 项目#1');
  assert.equal(t.path, '清单/归档/我的 项目#1/归档-我的 项目#1-2026-01-01.md');
});

test('前缀正则与 archiveNameRegex 一致：区间名也匹配，非法名不匹配', () => {
  const t = computeAutoArchiveTarget('清单/工作.md', ['2026-01-01']);
  assert.equal(t.nameRegex.test('归档-工作-2026-01-01~2026-02-01.md'), true);
  assert.equal(t.nameRegex.test('归档-工作-尾.md'), false);
  // 与 project/archive.js 的通用构造一致
  assert.deepEqual(
    String(t.nameRegex), String(archiveNameRegex('归档-工作-'))
  );
});
