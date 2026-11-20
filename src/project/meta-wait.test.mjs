// waitForFrontmatter 单测：新建清单文件后 metadataCache 解析有延迟，
// 立即重扫会扫不到（误报 no_node）。这里用注入的 getCache 验证轮询语义。

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForFrontmatter } from './meta-wait.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('缓存立即可用：直接返回 true，不等待', async () => {
  let calls = 0;
  const ok = await waitForFrontmatter(() => { calls += 1; return { frontmatter: { tags: ['todoList'] } }; }, 'x.md');
  assert.equal(ok, true);
  assert.equal(calls, 1);
});

test('缓存延迟就绪：轮询到 frontmatter 出现为止', async () => {
  let calls = 0;
  const ok = await waitForFrontmatter(() => {
    calls += 1;
    return calls >= 3 ? { frontmatter: { tags: ['todoList'] } } : null;
  }, 'x.md', { intervalMs: 10, timeoutMs: 2000 });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('超时仍无 frontmatter：返回 false，不抛错', async () => {
  const ok = await waitForFrontmatter(() => null, 'x.md', { intervalMs: 10, timeoutMs: 80 });
  assert.equal(ok, false);
});

test('缓存有内容但还没解析出 frontmatter：继续等', async () => {
  let calls = 0;
  const ok = await waitForFrontmatter(() => {
    calls += 1;
    return calls >= 2 ? { frontmatter: {} } : { sections: [] };
  }, 'x.md', { intervalMs: 10, timeoutMs: 2000 });
  assert.equal(ok, true);
  assert.equal(calls, 2);
});
