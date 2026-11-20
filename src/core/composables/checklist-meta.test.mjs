import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checklistNameError, frontmatterTags, hasFrontmatterTag, yamlScalar
} from './checklist-meta.js';

test('清单名称校验：空名 / 非法字符 / 点开头结尾 / Windows 保留名 / 超长', () => {
  assert.equal(checklistNameError(''), 'missing_name');
  assert.equal(checklistNameError('   '), 'missing_name');
  assert.equal(checklistNameError(null), 'missing_name');
  assert.equal(checklistNameError('工作清单'), '');
  assert.equal(checklistNameError('a/b'), 'bad_name');
  assert.equal(checklistNameError('a\\b'), 'bad_name');
  assert.equal(checklistNameError('a:b'), 'bad_name');
  assert.equal(checklistNameError('.hidden'), 'bad_name');
  assert.equal(checklistNameError('name.'), 'bad_name');
  assert.equal(checklistNameError('CON'), 'bad_name');
  assert.equal(checklistNameError('nul.txt'), 'bad_name');
  assert.equal(checklistNameError('x'.repeat(121)), 'bad_name');
  assert.equal(checklistNameError('x'.repeat(120)), '');
});

test('frontmatter tags 归一化：数组过滤空值、字符串按逗号拆分', () => {
  assert.deepEqual(frontmatterTags(['todoList', null, ' archived ']), ['todoList', 'archived']);
  assert.deepEqual(frontmatterTags('todoList, archived'), ['todoList', 'archived']);
  assert.deepEqual(frontmatterTags(undefined), []);
  assert.deepEqual(frontmatterTags(42), []);
});

test('归档判定已迁移：不再用 frontmatter archived 标签（改落在归档文件夹内即归档）', () => {
  // hasFrontmatterTag 仍是通用标签判定，清单识别用它
  assert.equal(hasFrontmatterTag(['todoList'], 'todoList'), true);
  assert.equal(hasFrontmatterTag(['todoList/子项'], 'todoList'), false);
});

test('yamlScalar：安全字符原样，其余加双引号转义', () => {
  assert.equal(yamlScalar('todoList'), 'todoList');
  assert.equal(yamlScalar('/Users/me/repo'), '/Users/me/repo');
  assert.equal(yamlScalar('/Users/me/my repo'), '"/Users/me/my repo"');
  assert.equal(yamlScalar('a#b'), '"a#b"');
  assert.equal(yamlScalar('C:\\repo'), '"C:\\\\repo"');
});
