<template>
  <div ref="root" class="pa-view" :class="{ narrow, tiny }">
    <aside class="pa-tree" v-show="!tiny || showTree">
      <div class="pa-tree-head">
        <span>项目</span>
        <button class="pa-act" title="新建项目" @click="newRootProject">＋</button>
      </div>
      <project-tree
        :nodes="index.roots"
        :active="activeDir"
        :open-set="openSet"
        @select="onSelect"
        @toggle="toggleOpen"
        @action="onTreeAction"
      />
      <div v-if="!index.roots.length" class="pa-empty small">在「{{ rootName }}」下建一个文件夹开始</div>
    </aside>

    <section class="pa-main">
      <header class="pa-main-head">
        <div class="pa-main-title">
          <button v-if="tiny" class="pa-act" @click="showTree = !showTree">☰</button>
          <span>{{ activeNode ? activeNode.name : '未选择项目' }}</span>
        </div>
        <div v-if="activeNode" class="pa-cwd" :title="activeNode.cwd">{{ activeNode.cwd || '未设置 cwd（继承父级或默认）' }}</div>
        <div class="pa-head-actions">
          <button class="pa-btn" @click="archiveDone" :disabled="!doneCount">归档已完成</button>
          <button class="pa-btn" @click="showSessions = !showSessions">{{ showSessions ? '隐藏会话' : '显示会话' }}</button>
        </div>
      </header>

      <div class="pa-new">
        <input v-model="draft" class="pa-new-input" placeholder="新任务，回车添加" @keydown.enter="addTask" />
        <button class="pa-btn" @click="addTask">添加</button>
      </div>

      <project-task-list
        v-if="activeNode"
        :tasks="tasks"
        :dels-by-line="delsByLine"
        @toggle="onToggle"
        @edit="onEdit"
        @delegate="openDelegate"
        @archive="onArchive"
        @remove="onRemove"
        @open-thread="openThread"
      />
      <div v-else class="pa-empty">左侧选择一个项目</div>
    </section>

    <session-pane
      v-if="showSessions"
      :threads="threads"
      @open-thread="openThread"
      @refresh="loadThreads"
    />

    <!-- 委派弹窗改走 VueModal（DelegateModal，与编辑器纸飞机共用），不再内联 -->

    <!-- 输入框弹窗：Electron 不支持 window.prompt，只能用自绘的。
         fields 为空是单输入框；有 fields 时逐行收集多个字段（如建项目时的名称+cwd） -->
    <div v-if="askState" class="pa-modal-mask" @click.self="closeAsk(null)">
      <div class="pa-modal pa-ask">
        <h4>{{ askState.title }}</h4>
        <template v-if="askState.fields && askState.fields.length">
          <label v-for="(f, i) in askState.fields" :key="f.key" class="pa-ask-field">
            <span>{{ f.label }}</span>
            <input
              :ref="(el) => (askRefs[i] = el)"
              v-model="askState.values[f.key]"
              :placeholder="f.placeholder || ''"
              @keydown.enter.prevent="closeAsk(askState.values)"
              @keydown.esc.prevent="closeAsk(null)"
            />
            <button
              v-if="f.pick === 'folder'"
              type="button"
              class="pa-btn pa-ask-browse"
              title="从系统文件夹选择"
              @click="browseFolder(i)"
            >浏览…</button>
          </label>
        </template>
        <input
          v-else
          ref="askInput"
          v-model="askState.value"
          class="pa-ask-input"
          :placeholder="askState.placeholder || ''"
          @keydown.enter.prevent="closeAsk(askState.value)"
          @keydown.esc.prevent="closeAsk(null)"
        />
        <div class="pa-modal-actions">
          <button class="pa-btn" @click="closeAsk(null)">取消</button>
          <button class="pa-btn primary pa-ask-ok" @click="closeAsk(askState.fields ? askState.values : askState.value)">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { Notice } from 'obsidian';
import ProjectTree from './project-tree.vue';
import ProjectTaskList from './task-list.vue';
import SessionPane from './session-pane.vue';
import * as rt from './runtime.js';
import { startDelegation } from './delegate.js';
import { VueModal } from '../core/ui/VueModal.js';
import DelegateModal from './DelegateModal.vue';
import { pickFolder } from './electron-dialog.js';

export default {
  name: 'ProjectView',
  components: { ProjectTree, ProjectTaskList, SessionPane },
  props: { plugin: { type: Object, required: true } },
  data() {
    return {
      index: { roots: [], nodes: [], byDir: new Map() },
      activeDir: '',
      tasks: [],
      delsByLine: {},
      threads: [],
      draft: '',
      openSet: new Set(),
      width: 1000,
      showSessions: true,
      showTree: false,
      askState: null,
      askRefs: {},
      refreshing: false
    };
  },
  computed: {
    rootName() { return rt.rootOf(this.plugin); },
    narrow() { return this.width < 720; },
    tiny() { return this.width < 520; },
    activeNode() { return this.index.byDir.get(this.activeDir) || null; },
    doneCount() { return this.tasks.filter((t) => t.completed).length; }
  },
  async mounted() {
    // e2e 调试口：仅在脚本显式打开时挂到 window，正常使用不产生任何行为
    if (typeof window !== 'undefined' && window.__dadaE2E) window.__pa = { rt, view: this };
    await this.refresh();
    this.ro = new ResizeObserver((entries) => {
      const w = entries[0] && entries[0].contentRect && entries[0].contentRect.width;
      if (!w) return;
      const wasNarrow = this.width < 720;
      this.width = w;
      // [project-view] 进入窄容器时自动收起会话栏（用户可手动再开）
      if (!wasNarrow && w < 720) this.showSessions = false;
    });
    this.ro.observe(this.$refs.root);
    this.timer = setInterval(() => {
      if (this.refreshing) return;
      this.refreshActive().catch(() => {});
      this.loadThreads().catch(() => {});
    }, 10000);
  },
  beforeUnmount() {
    if (this.ro) this.ro.disconnect();
    if (this.timer) clearInterval(this.timer);
  },
  methods: {
    async refresh() {
      this.refreshing = true;
      try {
        this.index = rt.scanProjects(this.plugin);
        await this.fillCounts();
        if (!this.index.byDir.has(this.activeDir)) {
          this.activeDir = this.index.roots[0] ? this.index.roots[0].dirPath : '';
          if (this.activeDir) this.openSet.add(this.activeDir);
        }
        await this.refreshActive();
        await this.loadThreads();
      } finally {
        this.refreshing = false;
      }
    },
    async fillCounts() {
      const nodes = this.index.nodes;
      await Promise.all(nodes.map(async (n) => {
        if (!n.filePath) { n.unfinished = 0; return; }
        try {
          const lines = await rt.readProjectLines(this.plugin, n);
          n.unfinished = lines.filter((l) => /^- \[ \]/.test(l)).length;
        } catch { n.unfinished = 0; }
      }));
    },
    async refreshActive() {
      const node = this.activeNode;
      if (!node) { this.tasks = []; this.delsByLine = {}; return; }
      this.tasks = await rt.loadProjectTasks(this.plugin, node);
      const map = await rt.loadDelegations(this.plugin, node);
      const obj = {};
      for (const [line, arr] of map.entries()) obj[line] = arr;
      this.delsByLine = obj;
    },
    async loadThreads() {
      try { this.threads = await rt.recentThreads(this.plugin, { minutes: 1440 }); }
      catch { this.threads = []; }
    },
    toggleOpen(path) {
      const s = new Set(this.openSet);
      if (s.has(path)) s.delete(path); else s.add(path);
      this.openSet = s;
    },
    // 系统文件夹选择对话框（Electron，共享 pickFolder）；选完填回对应字段
    async browseFolder(i) {
      const f = this.askState && this.askState.fields && this.askState.fields[i];
      if (!f) return;
      try {
        const picked = await pickFolder();
        if (picked) this.askState.values[f.key] = picked;
      } catch (e) {
        new Notice('打不开文件夹选择：' + String(e.message || e));
      }
    },
    // 自绘输入弹窗（Electron 里 window.prompt 不可用）：
    //  - ask(title, initial, placeholder) 返回字符串或 null
    //  - askFields(title, [{key,label,placeholder,value}]) 返回 {key: 值} 或 null
    ask(title, initial = '', placeholder = '') {
      return this.askFields(title, [{ key: 'value', value: initial, placeholder }]).then(
        (r) => (r == null ? null : r.value)
      );
    },
    askFields(title, fields) {
      // fields: [{ key, label, value, placeholder, pick?: 'folder' }]
      return new Promise((resolve) => {
        const values = {};
        for (const f of fields) values[f.key] = String(f.value == null ? '' : f.value);
        this.askState = { title, fields, values, resolve };
        this.$nextTick(() => {
          const el = (this.askRefs && this.askRefs[0]) || this.$refs.askInput;
          if (el) { el.focus(); if (el.select) el.select(); }
        });
      });
    },
    closeAsk(v) {
      const s = this.askState;
      if (!s) return;
      this.askState = null;
      this.askRefs = {};
      s.resolve(v == null ? null : v);
    },
    onSelect(n) {
      this.activeDir = n.dirPath;
      this.refreshActive().catch((e) => new Notice(String(e.message || e)));
    },
    async addTask() {
      const text = String(this.draft || '').trim();
      if (!text || !this.activeNode) return;
      this.draft = '';
      const r = await rt.createTask(this.plugin, this.activeNode, text);
      if (!r || !r.ok) new Notice('添加失败：' + (r && r.reason || 'unknown'));
      await this.refresh();
    },
    async onToggle(task, done) {
      const r = await rt.toggleTask(this.plugin, task, done);
      if (!r || !r.ok) new Notice('更新失败：' + (r && r.reason || 'unknown'));
      await this.refreshActive();
    },
    async onEdit(task) {
      const next = await this.ask('修改任务', task.summary);
      if (next == null) return;
      const text = String(next).trim();
      if (!text || text === task.summary) return;
      const r = await rt.editTask(this.plugin, task, { summary: text });
      if (!r || !r.ok) new Notice('修改失败：' + (r && r.reason || 'unknown'));
      await this.refreshActive();
    },
    async onRemove(task) {
      const dels = this.delsByLine[task.lineNo] || [];
      for (const d of dels) if (d.threadId) await rt.ignoreThread(this.plugin, d.threadId);
      const r = await rt.removeTask(this.plugin, task);
      if (!r || !r.ok) new Notice('删除失败：' + (r && r.reason || 'unknown'));
      await this.refresh();
    },
    async onArchive(task) {
      await this.archiveLines([task.lineNo]);
    },
    async archiveDone() {
      const lines = this.tasks.filter((t) => t.completed).map((t) => t.lineNo);
      if (!lines.length) return;
      await this.archiveLines(lines);
    },
    async archiveLines(lines) {
      const node = this.activeNode;
      if (!node || !node.filePath) return;
      const r = await rt.archiveTasks(this.plugin, node, lines);
      if (!r || !r.ok) new Notice('归档失败：' + (r && r.reason || 'unknown'));
      else if (r.archivePath) new Notice(`已归档 ${r.moved} 条 → ${r.archivePath.split('/').pop()}`);
      await this.refresh();
    },
    // 全量导入/搬回已统一到设置页「手动同步」入口（ManualSyncModal）
    openDelegate(task) {
      const node = this.activeNode;
      if (!node) return;
      // 委派弹窗：DelegateModal 经 VueModal 挂载，与编辑器纸飞机共用同一组件
      new VueModal(this.plugin.app, DelegateModal, {
        open: true,
        prompt: task.summary,
        cwd: node.cwd || '',
        onConfirm: async ({ prompt, cwd }) => {
          if (!cwd) { new Notice('请先为项目设置 cwd'); return; }
          new Notice('已发送到 T3 Code，运行中…');
          try {
            await startDelegation(this.plugin, rt, { node, task, prompt, cwd });
          } catch (e) {
            new Notice('委派失败：' + String(e.message || e));
          }
          await this.refreshActive();
          await this.loadThreads();
        }
      }).open();
    },
    openThread(threadId) {
      const url = rt.t3DeepLink(threadId);
      if (!url) { new Notice('找不到 T3 Code environment-id'); return; }
      rt.openExternal(url);
    },
    async onTreeAction(action, node) {
      if (action === 'new-child') {
        await this.createProjectFlow(node.dirPath);
      } else if (action === 'rename') {
        const name = await this.ask('新的项目名', node.name);
        if (!name || name === node.name) return;
        const r = await rt.renameProject(this.plugin, node, name);
        if (!r.ok) new Notice('重命名失败：' + r.reason);
        else this.activeDir = r.dirPath;
        await this.refresh();
      } else if (action === 'open') {
        if (node.filePath) {
          const f = this.plugin.app.vault.getAbstractFileByPath(node.filePath);
          if (f) this.plugin.app.workspace.getLeaf(false).openFile(f);
        }
      } else if (action === 'cwd') {
        const v = await this.askFields('项目 cwd（留空则继承）', [
          { key: 'cwd', value: node.ownCwd || '', placeholder: '/path/to/repo，留空则继承父级或默认', pick: 'folder' }
        ]);
        if (v == null) return;
        const r = await rt.setProjectCwd(this.plugin, node, v.cwd);
        if (!r.ok) new Notice('写入失败');
        await this.refresh();
        if (r.ok) this.applyCwd(node.dirPath, r.cwd);
      }
    },
    // 建项目：名称 + 可选 cwd 一起填；cwd 留空走继承
    async createProjectFlow(parentDirPath) {
      const vals = await this.askFields('新建项目', [
        { key: 'name', label: '项目名称', placeholder: '例如 LoopForge' },
        { key: 'cwd', label: '工作目录 cwd（可留空）', placeholder: '/path/to/repo，留空则继承父级或默认', pick: 'folder' }
      ]);
      if (!vals || !String(vals.name || '').trim()) return;
      const r = await rt.createProject(this.plugin, parentDirPath, vals.name);
      if (!r.ok) { new Notice('创建失败：' + r.reason); return; }
      if (String(vals.cwd || '').trim()) {
        const node = rt.nodeOf(this.plugin, r.dirPath);
        const cw = await rt.setProjectCwd(this.plugin, node, vals.cwd);
        if (!cw.ok) new Notice('cwd 写入失败');
      }
      await this.refresh();
      const hit = this.index.byDir.get(r.dirPath);
      if (hit) { this.activeDir = r.dirPath; this.applyCwd(r.dirPath, String(vals.cwd || '').trim()); }
    },
    // 元数据缓存还没刷新时，先在内存里把 cwd 生效，避免界面要等下一轮扫描
    applyCwd(dirPath, ownCwd) {
      const hit = this.index.byDir.get(dirPath);
      if (!hit) return;
      hit.ownCwd = ownCwd || '';
      const def = rt.projectSettings(this.plugin).projectDefaultCwd || '';
      const walk = (n, inherited) => {
        n.cwd = n.ownCwd || inherited || def;
        for (const c of n.children) walk(c, n.cwd);
      };
      for (const r of this.index.roots) walk(r, '');
    },
    async newRootProject() {
      await this.createProjectFlow('');
    }
  }
};
</script>

<style>
.pa-view {
  display: flex;
  height: 100%;
  min-height: 0;
  gap: 10px;
  padding: 8px;
  overflow: hidden;
}
.pa-tree {
  flex: 0 0 230px;
  min-width: 0;
  overflow: auto;
  border-right: 1px solid var(--background-modifier-border);
  padding-right: 8px;
}
.pa-view.narrow .pa-tree { flex-basis: 180px; }
.pa-tree-head, .pa-sessions-head {
  display: flex; align-items: center; justify-content: space-between;
  font-weight: 600; padding: 4px 2px 8px;
}
.pa-nodes { list-style: none; margin: 0; padding: 0; }
.pa-node {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 6px; border-radius: 5px; cursor: pointer; font-size: 13px;
}
.pa-node:hover { background: var(--background-modifier-hover); }
.pa-node.active { background: var(--background-modifier-active-hover); font-weight: 600; }
.pa-caret { width: 12px; color: var(--text-muted); font-size: 10px; }
.pa-node-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-cnt {
  font-size: 11px; color: var(--text-muted);
  background: var(--background-secondary); border-radius: 8px; padding: 0 6px;
}
.pa-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.pa-main-head { display: flex; flex-direction: column; gap: 2px; }
.pa-main-title { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 600; }
.pa-cwd { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-head-actions { display: flex; gap: 6px; margin-top: 4px; }
.pa-new { display: flex; gap: 6px; }
.pa-new-input {
  flex: 1; padding: 5px 8px; border-radius: 6px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
}
.pa-tasks { flex: 1; overflow: auto; min-height: 0; }
.pa-task { padding: 4px 0; border-bottom: 1px solid var(--background-modifier-border); }
.pa-task-line { display: flex; align-items: center; gap: 6px; }
.pa-task.done .pa-task-title { text-decoration: line-through; color: var(--text-muted); }
.pa-task-title { flex: 1; font-size: 13px; }
.pa-act {
  border: none; background: transparent; cursor: pointer;
  color: var(--text-muted); font-size: 12px; padding: 2px 4px; border-radius: 4px;
}
.pa-act:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.pa-fly { color: var(--text-accent); }
.pa-delegation {
  display: flex; align-items: center; gap: 6px;
  margin-left: 22px; padding: 2px 0; font-size: 11px; color: var(--text-muted);
}
.pa-delegation-state { flex: 0 0 auto; }
.pa-delegation-sum { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-delegation.st-running .pa-delegation-state { color: var(--text-accent); }
.pa-delegation.st-awaiting .pa-delegation-state { color: var(--text-warning); }
.pa-delegation.st-failed .pa-delegation-state { color: var(--text-error); }
.pa-pill {
  flex: 0 0 auto; cursor: pointer; color: var(--text-accent);
  border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 0 5px;
}
.pa-sessions {
  flex: 0 0 280px; min-width: 0; overflow: auto;
  border-left: 1px solid var(--background-modifier-border); padding-left: 8px;
}
.pa-view.narrow .pa-sessions { flex-basis: 220px; }
.pa-session-group-h { font-size: 12px; font-weight: 600; padding: 6px 0 3px; color: var(--text-muted); }
.pa-session { padding: 4px 6px; border-radius: 5px; cursor: pointer; }
.pa-session:hover { background: var(--background-modifier-hover); }
.pa-session-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-session-meta { font-size: 10px; color: var(--text-muted); }
.pa-empty { color: var(--text-muted); font-size: 12px; padding: 12px 4px; }
.pa-empty.small { padding: 6px 2px; font-size: 11px; }
.pa-btn {
  font-size: 12px; padding: 3px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--background-modifier-border); background: var(--background-secondary);
}
.pa-btn.primary { background: var(--interactive-accent); color: var(--text-on-accent); border-color: transparent; }
.pa-modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.35);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.pa-modal {
  width: 460px; max-width: 90vw; background: var(--background-primary);
  border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 6px;
  box-shadow: 0 8px 30px rgba(0,0,0,.3);
}
.pa-modal textarea, .pa-modal input {
  width: 100%; border-radius: 6px; padding: 6px;
  border: 1px solid var(--background-modifier-border); background: var(--background-primary);
}
.pa-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.pa-ask h4 { margin: 0 0 10px; font-size: 15px; }
.pa-ask input { width: 100%; }
.pa-ask-field { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.pa-ask-field > span { flex: 0 0 auto; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.pa-ask-field input { flex: 1 1 auto; }
.pa-ask-browse { flex: 0 0 auto; }
.pa-view.tiny .pa-tree { position: absolute; z-index: 20; background: var(--background-primary); height: 100%; box-shadow: 0 0 12px rgba(0,0,0,.2); }
.pa-view.tiny .pa-sessions { display: none; }
</style>
