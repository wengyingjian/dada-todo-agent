// 编辑器纸飞机委派：CM6 扩展 + 委派弹窗（依赖 obsidian / @codemirror，不进单测）。
// 纯函数部分见 editor-grip.js（isGripLine / extractTaskText / resolveEditorCwd）。
// 交互口径见 Vault 规格《规格-编辑器纸飞机委派》：光标所在列表项行尾挂把手，
// 单击弹「内容 + 工作目录」modal（DelegateModal，与项目页共用），确认后走
// startDelegation 全链路。

import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { Notice } from 'obsidian';
import { isGripLine, extractTaskText, resolveEditorCwd } from './editor-grip.js';
import * as rt from './runtime.js';
import { startDelegation } from './delegate.js';
import { VueModal } from '../core/ui/VueModal.js';
import DelegateModal from './DelegateModal.vue';

// 行尾小把手：纸飞机，单击弹委派弹窗
class GripWidget extends WidgetType {
  constructor(plugin, lineNo, text) {
    super();
    this.plugin = plugin;
    this.lineNo = lineNo;
    this.text = text;
  }
  eq(o) { return o.lineNo === this.lineNo && o.text === this.text; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'dada-grip';
    el.setAttribute('contenteditable', 'false');
    el.title = '委派给 T3 Code';
    el.textContent = '✈';
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditorDelegate(this.plugin, this.lineNo, this.text);
    });
    return el;
  }
  ignoreEvent() { return true; }
}

// 光标所在行是列表项时，行尾挂把手 widget（lineNo 用 0 基，对齐 startDelegation）
function gripDecorations(view, plugin) {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  const builder = new RangeSetBuilder();
  if (isGripLine(line.text)) {
    builder.add(line.to, line.to, Decoration.widget({ widget: new GripWidget(plugin, line.number - 1, line.text), side: 1 }));
  }
  return builder.finish();
}

export const editorGripExtension = (plugin) => ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = gripDecorations(view, plugin); }
    update(u) {
      if (u.selectionSet || u.docChanged || u.viewportChanged) {
        this.decorations = gripDecorations(u.view, plugin);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// 编辑器侧委派入口：cwd 按项目节点 → 仓库根两级预填，弹窗与项目页共用 DelegateModal
export function openEditorDelegate(plugin, lineNo, lineText) {
  const file = plugin.app.workspace.getActiveFile();
  const filePath = file ? file.path : '';
  const nodes = rt.scanProjects(plugin).nodes;
  const prompt = extractTaskText(lineText);
  const cwd = resolveEditorCwd(filePath, nodes, plugin.app.vault.adapter.basePath);
  new VueModal(plugin.app, DelegateModal, {
    open: true,
    prompt,
    cwd,
    onConfirm: async ({ prompt: p, cwd: c }) => {
      new Notice('已发送到 T3 Code，运行中…');
      try {
        await startDelegation(plugin, rt, {
          node: { filePath },
          // CM6 的 lineNo 是含 frontmatter 的全文档行号，落盘时按正文行号换算
          task: { lineNo },
          lineNoBasis: 'document',
          prompt: p,
          cwd: c
        });
      } catch (e) {
        new Notice('委派失败：' + String(e.message || e));
      }
    }
  }).open();
}
