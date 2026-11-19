<!-- 手动同步弹窗（设置页入口）：全量拉取 T3 库会话按 cwd 分组展示归属状态。
     每组可操作：未归属 → 创建项目（可带导入）/ 放入日记 / 忽略；
     有 unbound 且已归属 → 导入到项目；已归属且无未绑定 → 只读。
     与弹窗提醒（UnmatchedWorkspaceModal）共用操作协议，数据来自 fullSyncSummary。 -->
<template>
  <div class="da-unmatched da-manual-sync">
    <h4>手动同步 T3 Code 会话</h4>
    <p class="da-unmatched-hint" v-if="!loaded">正在读取 T3 库…</p>
    <p class="da-unmatched-hint" v-else-if="!groups.length">T3 库里没有会话</p>
    <p class="da-unmatched-hint" v-else>共 {{ totalThreads }} 条会话，按工作目录分组：</p>
    <div v-for="g in groups" :key="g.cwd" class="da-unmatched-item">
      <div class="da-unmatched-cwd" :title="g.cwd">
        {{ g.cwd }}
        <span class="da-ms-badges">
          <span class="da-ms-badge">{{ g.total }} 条</span>
          <span v-if="g.unbound" class="da-ms-badge warn">{{ g.unbound }} 条未入库</span>
          <span v-if="g.ignored" class="da-ms-badge muted">已忽略</span>
          <span v-else-if="g.projectDir" class="da-ms-badge ok">→ {{ projectName(g.projectDir) }}</span>
          <span v-else-if="g.journalOnly" class="da-ms-badge muted">放入日记</span>
          <span v-else class="da-ms-badge warn">未归属</span>
        </span>
      </div>
      <div class="da-unmatched-row" v-if="!g.ignored && !g.projectDir">
        <input v-model="names[g.cwd]" placeholder="项目名称" />
        <button class="pa-btn primary" @click="create(g)">创建项目</button>
      </div>
      <div class="da-unmatched-row da-unmatched-sub" v-if="!g.ignored && !g.projectDir">
        <button class="pa-btn" @click="journal(g)">放入日记</button>
        <button class="pa-btn" @click="ignore(g)">忽略工作区</button>
      </div>
      <div class="da-unmatched-row da-unmatched-sub" v-else-if="g.projectDir && g.unbound">
        <button class="pa-btn primary" @click="importTo(g)">导入 {{ g.unbound }} 条到项目</button>
      </div>
      <div class="da-unmatched-row da-unmatched-sub" v-if="g.ignored || g.journalOnly">
        <button class="pa-btn" @click="reset(g)">重置为未归属</button>
      </div>
      <div v-if="errors[g.cwd]" class="da-unmatched-err">{{ errors[g.cwd] }}</div>
    </div>
    <div class="pa-modal-actions">
      <button class="pa-btn" @click="close">关闭</button>
    </div>
  </div>
</template>

<script>
import { Notice } from 'obsidian';

export default {
  name: 'ManualSyncModal',
  props: {
    // fullSyncSummary(plugin) 的返回值（调用方预先取好再开弹窗；也可传 null 由组件自取）
    groups: { type: Array, default: null },
    total: { type: Number, default: 0 },
    onCreate: { type: Function, default: null },   // ({ name, cwd, importHistory: true })
    onIgnore: { type: Function, default: null },   // ({ cwd })
    onJournal: { type: Function, default: null },  // ({ cwd })
    onImport: { type: Function, default: null },   // ({ cwd }) → { imported, moved }
    onReset: { type: Function, default: null },    // ({ cwd })——重置为未归属
    onRefresh: { type: Function, default: null }   // 操作后重新取汇总
  },
  emits: ['update:open'],
  data() {
    return {
      items: this.groups ? this.groups.slice() : [],
      loaded: !!this.groups,
      totalThreads: this.total || 0,
      names: {}, errors: {}
    };
  },
  async mounted() {
    if (!this.loaded && this.onRefresh) {
      try {
        const r = await this.onRefresh();
        this.items = (r && r.groups) || [];
        this.totalThreads = (r && r.total) || 0;
      } catch { this.items = []; }
      this.loaded = true;
    }
    for (const g of this.items) this.names[g.cwd] = g.name || '';
  },
  methods: {
    close() { this.$emit('update:open', false); },
    projectName(dir) { return String(dir || '').split('/').pop(); },
    async reload() {
      if (!this.onRefresh) return;
      try {
        const r = await this.onRefresh();
        this.items = (r && r.groups) || [];
        this.totalThreads = (r && r.total) || 0;
      } catch { /* 保留现状 */ }
    },
    async create(g) {
      const name = String(this.names[g.cwd] || '').trim();
      if (!name) { this.errors[g.cwd] = '请填写项目名称'; return; }
      try {
        const r = this.onCreate ? await this.onCreate({ name, cwd: g.cwd, importHistory: true }) : null;
        if (!r || r.ok === false) { this.errors[g.cwd] = '创建失败：' + ((r && r.reason) || 'unknown'); return; }
        new Notice(`已创建项目「${name}」并导入 ${r.imported || 0} 条、搬回 ${r.moved || 0} 条`);
        await this.reload();
      } catch (e) { this.errors[g.cwd] = '创建失败：' + String((e && e.message) || e); }
    },
    async journal(g) {
      try {
        if (this.onJournal) await this.onJournal({ cwd: g.cwd });
        new Notice('已放入日记，该工作区不再提醒');
        await this.reload();
      } catch (e) { this.errors[g.cwd] = '操作失败：' + String((e && e.message) || e); }
    },
    async ignore(g) {
      try {
        if (this.onIgnore) await this.onIgnore({ cwd: g.cwd });
        new Notice('已忽略该工作区');
        await this.reload();
      } catch (e) { this.errors[g.cwd] = '操作失败：' + String((e && e.message) || e); }
    },
    async importTo(g) {
      try {
        const r = this.onImport ? await this.onImport({ cwd: g.cwd }) : null;
        if (!r || r.ok === false) { this.errors[g.cwd] = '导入失败：' + ((r && r.reason) || 'unknown'); return; }
        new Notice(`已导入 ${r.imported || 0} 条、搬回 ${r.moved || 0} 条`);
        await this.reload();
      } catch (e) { this.errors[g.cwd] = '导入失败：' + String((e && e.message) || e); }
    },
    async reset(g) {
      try {
        if (this.onReset) await this.onReset({ cwd: g.cwd });
        new Notice('已重置为未归属，可重新选择创建项目 / 放入日记 / 忽略');
        await this.reload();
      } catch (e) { this.errors[g.cwd] = '操作失败：' + String((e && e.message) || e); }
    }
  }
};
</script>

<style>
/* 与 UnmatchedWorkspaceModal 同一套视觉（unscoped，类名复用） */
.da-manual-sync .da-ms-badges { display: inline-flex; gap: 4px; margin-left: 6px; }
.da-manual-sync .da-ms-badge {
  font-size: 11px; padding: 1px 6px; border-radius: 8px;
  background: var(--background-secondary); border: 1px solid var(--background-modifier-border);
}
.da-manual-sync .da-ms-badge.warn { color: var(--text-warning, #b98a00); }
.da-manual-sync .da-ms-badge.ok { color: var(--text-success, #4a8b3a); }
.da-manual-sync .da-ms-badge.muted { opacity: 0.6; }
</style>
