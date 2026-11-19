import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { threadDecorations, LINK_CLASS, THREAD_ATTR, LINK_TITLE } from './editor-thread-link.js';

const ID = '3f2a9b1c-4d5e-6f70-8192-a3b4c5d6e7f8';
const ID2 = '11111111-2222-3333-4444-555555555555';

// 用真实 EditorState + 伪造 view 驱动（ViewPlugin 需要 DOM，这里只测装饰构建）
function decoOf(doc, ranges) {
  const state = EditorState.create({ doc });
  const set = threadDecorations({ state, visibleRanges: ranges || [{ from: 0, to: state.doc.length }] });
  const out = [];
  set.between(0, state.doc.length, (from, to, value) => {
    out.push({ from, to, text: state.sliceDoc(from, to), spec: value.spec });
  });
  return out;
}

test('装饰构建：只覆盖 ⚡ t3:<id> 标记本身', () => {
  const line = `\t- [x] 改完了  ⚡ t3:${ID}#2`;
  const out = decoOf(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, `⚡ t3:${ID}#2`);
  assert.equal(out[0].spec.class, LINK_CLASS);
  assert.equal(out[0].spec.attributes.title, LINK_TITLE);
  assert.equal(out[0].spec.attributes[THREAD_ATTR], ID);
});

test('装饰构建：无会话 id 的占位行不产生装饰', () => {
  assert.deepEqual(decoOf(`\t- [/] 进行中…  ⚡ t3:`), []);
  assert.deepEqual(decoOf(`\t- [-] spawn t3 ENOENT  ⚡ t3:p!a1b2c3d4`), []);
});

test('装饰构建：多行 / 一行多个标记都按顺序命中', () => {
  const doc = [
    '- [ ] 普通任务',
    `\t- [x] 完成  ⚡ t3:${ID}`,
    `\t- [/] 进行中…  ⚡ t3:${ID2}#3`
  ].join('\n');
  const out = decoOf(doc);
  assert.deepEqual(out.map((d) => d.text), [`⚡ t3:${ID}`, `⚡ t3:${ID2}#3`]);
  assert.deepEqual(out.map((d) => d.spec.attributes[THREAD_ATTR]), [ID, ID2]);
});

test('装饰构建：相邻可视区把同一行切两半时不重复添加', () => {
  const doc = `\t- [x] 改完了  ⚡ t3:${ID}\n- [ ] 下一行`;
  const mark = doc.indexOf('⚡');
  // 两个 range 都包含同一行（第二个从标记中间开始）
  const out = decoOf(doc, [
    { from: 0, to: mark + 2 },
    { from: mark + 3, to: doc.length }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].spec.attributes[THREAD_ATTR], ID);
});
