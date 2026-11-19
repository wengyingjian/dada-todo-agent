// 编辑器会话标记的纯逻辑：扫可视区里的 `⚡ t3:<id>`，产出可点的 mark 装饰。
// 不依赖 obsidian，可在 Node 下用真实 EditorState 单测；ViewPlugin / 点击打开见 editor-thread-link-ui.js。

import { Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { findThreadLinks } from './delegate-line.js';

export const LINK_TITLE = '打开 T3 Code 会话';
export const LINK_CLASS = 'dada-thread-link';
export const THREAD_ATTR = 'data-dada-thread';

// 每个会话 id 一个 mark：title 出原生 hint，data 属性给点击处理取 id
const markCache = new Map();
export function linkMark(threadId) {
  let mark = markCache.get(threadId);
  if (!mark) {
    mark = Decoration.mark({
      class: LINK_CLASS,
      attributes: { title: LINK_TITLE, [THREAD_ATTR]: threadId }
    });
    markCache.set(threadId, mark);
  }
  return mark;
}

// 只扫可视区；visibleRanges 不保证整行边界，同一行可能被相邻 range 各扫一次，按行首去重
export function threadDecorations(view) {
  const builder = new RangeSetBuilder();
  const seen = new Set();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        for (const link of findThreadLinks(line.text)) {
          builder.add(line.from + link.from, line.from + link.to, linkMark(link.threadId));
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}
