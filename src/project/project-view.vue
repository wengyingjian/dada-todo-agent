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

    <div v-if="modal" class="pa-modal-mask" @click.self="modal = null">
      <div class="pa-modal">
        <h4>委派给 T3 Code</h4>
        <label>内容</label>
        <textarea v-model="modal.prompt" rows="4"></textarea>
        <label>工作目录</label>
        <input v-model="modal.cwd" />
        <div class="pa-modal-actions">
          <button class="pa-btn" @click="modal = null">取消</button>
          <button class="pa-btn primary" @click="confirmDelegate">发送</button>
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
      modal: null,
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
    openDelegate(task) {
      const node = this.activeNode;
      if (!node) return;
      this.modal = { task, prompt: task.summary, cwd: node.cwd || '' };
    },
    async confirmDelegate() {
      const m = this.modal;
      const node = this.activeNode;
      this.modal = null;
      if (!m || !node) return;
      if (!m.cwd) { new Notice('请先为项目设置 cwd'); return; }
      new Notice('已发送到 T3 Code，运行中…');
      try {
        await startDelegation(this.plugin, rt, { node, task: m.task, prompt: m.prompt, cwd: m.cwd });
      } catch (e) {
        new Notice('委派失败：' + String(e.message || e));
      }
      await this.refreshActive();
      await this.loadThreads();
    },
    openThread(threadId) {
      const url = rt.t3DeepLink(threadId);
      if (!url) { new Notice('找不到 T3 Code environment-id'); return; }
      rt.openExternal(url);
    },
    async onTreeAction(action, node) {
      if (action === 'new-child') {
        const name = window.prompt('子项目名称', '');
        if (!name) return;
        const r = await rt.createProject(this.plugin, node.dirPath, name);
        if (!r.ok) new Notice('创建失败：' + r.reason);
        await this.refresh();
      } else if (action === 'rename') {
        const name = window.prompt('新的项目名', node.name);
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
        const v = window.prompt('项目 cwd（留空则继承）', node.ownCwd || '');
        if (v == null) return;
        const r = await rt.setProjectCwd(this.plugin, node, v);
        if (!r.ok) new Notice('写入失败');
        await this.refresh();
      }
    },
    async newRootProject() {
      const name = window.prompt('项目名称', '');
      if (!name) return;
      const r = await rt.createProject(this.plugin, '', name);
      if (!r.ok) new Notice('创建失败：' + r.reason);
      await this.refresh();
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
.pa-view.tiny .pa-tree { position: absolute; z-index: 20; background: var(--background-primary); height: 100%; box-shadow: 0 0 12px rgba(0,0,0,.2); }
.pa-view.tiny .pa-sessions { display: none; }
</style>
