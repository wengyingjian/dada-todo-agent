// 编辑器会话标记：文本编辑器里的 `⚡ t3:<id>` 可点击，点击打开对应的 T3 Code 会话。
// 装饰构建在 editor-thread-link.js（纯逻辑，可单测）；本文件只做 CM6 注册与点击处理。
// 与项目页 task-list.vue 的「⚡ 会话 pill」同一口径：pointer + hint + 单击打开。
// 阅读模式（Reading View）不在此扩展覆盖范围内，只处理编辑器（源码 / 实时预览）。

import { ViewPlugin, EditorView } from '@codemirror/view';
import { Notice } from 'obsidian';
import { threadDecorations, LINK_CLASS, THREAD_ATTR } from './editor-thread-link.js';
import { t3DeepLink, openExternal } from './runtime.js';

export function openThread(threadId) {
  const url = t3DeepLink(threadId);
  if (!url) { new Notice('找不到 T3 Code environment-id'); return; }
  openExternal(url);
}

export const editorThreadLinkExtension = () => [
  ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = threadDecorations(view); }
      update(u) {
        if (u.docChanged || u.viewportChanged) this.decorations = threadDecorations(u.view);
      }
    },
    { decorations: (v) => v.decorations }
  ),
  EditorView.domEventHandlers({
    // mousedown 里拦掉默认行为：光标不跳到标记中间，单击即打开
    mousedown(e, view) {
      if (e.button !== 0) return false;
      const el = e.target instanceof Element ? e.target.closest('.' + LINK_CLASS) : null;
      if (!el || !view.contentDOM.contains(el)) return false;
      const threadId = el.getAttribute(THREAD_ATTR) || '';
      e.preventDefault();
      e.stopPropagation();
      if (threadId) openThread(threadId);
      return true;
    }
  })
];
