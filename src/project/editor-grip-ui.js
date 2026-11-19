// 编辑器纸飞机委派：CM6 扩展 + 委派弹窗（依赖 obsidian / @codemirror，不进单测）。
// 纯函数部分见 editor-grip.js（isGripLine / extractTaskText / resolveEditorCwd）。
// 交互口径见 Vault 规格《规格-编辑器纸飞机委派》：光标所在列表项行尾挂把手，
// 单击弹「内容 + 工作目录」modal，确认后走 startDelegation 全链路。

import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { Modal, Notice, Setting } from 'obsidian';
import { isGripLine, extractTaskText, resolveEditorCwd } from './editor-grip.js';
import * as rt from './runtime.js';
import { startDelegation } from './delegate.js';

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
      new EditorDelegateModal(this.plugin, this.lineNo, this.text).open();
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

// 委派弹窗：与任务中心同款（内容 + 工作目录），cwd 按项目节点 → 仓库根两级预填
class EditorDelegateModal extends Modal {
  constructor(plugin, lineNo, lineText) {
    super(plugin.app);
    this.plugin = plugin;
    this.lineNo = lineNo; // 0 基
    this.lineText = lineText;
  }
  onOpen() {
    const { contentEl } = this;
    const file = this.plugin.app.workspace.getActiveFile();
    const filePath = file ? file.path : '';
    const nodes = rt.scanProjects(this.plugin).nodes;
    const prompt0 = extractTaskText(this.lineText);
    const cwd0 = resolveEditorCwd(filePath, nodes, this.plugin.app.vault.adapter.basePath);
    let promptVal = prompt0, cwdVal = cwd0;
    new Setting(contentEl).setName('委派给 T3 Code').setHeading();
    new Setting(contentEl).setName('内容').addText((t) => t.setValue(prompt0).onChange((v) => (promptVal = v)));
    new Setting(contentEl).setName('工作目录').addText((t) => t.setValue(cwd0).onChange((v) => (cwdVal = v)));
    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
    actions.addButton((b) => b.setCta().setButtonText('发送').onClick(async () => {
      this.close();
      if (!cwdVal.trim()) { new Notice('请填写工作目录'); return; }
      if (!promptVal.trim()) { new Notice('请填写委派内容'); return; }
      new Notice('已发送到 T3 Code，运行中…');
      try {
        await startDelegation(this.plugin, rt, {
          node: { filePath },
          task: { lineNo: this.lineNo },
          prompt: promptVal.trim(),
          cwd: cwdVal.trim()
        });
      } catch (e) {
        new Notice('委派失败：' + String(e.message || e));
      }
    }));
  }
  onClose() { this.contentEl.empty(); }
}
