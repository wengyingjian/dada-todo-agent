<!-- 未知工作区提醒弹窗：反向同步扫到 cwd 匹配不到项目的会话时弹出（经 VueModal 桥挂载）。
     每个工作区三选一：
     - 创建项目（名称预填 cwd basename，可改；可勾选同时导入该 cwd 的全部历史会话）
     - 忽略工作区（此后该 cwd 的会话整条跳过，用于测试等噪音场景）
     - 放入日记（保持兜底行为；此后该 cwd 不再弹提醒，新会话直接进日记）
     关闭弹窗 = 本轮任务已写日记，之后该 cwd 不再提醒（与「放入日记」效果一致）。 -->
<template>
  <div class="da-unmatched">
    <h4>发现未知工作区</h4>
    <p class="da-unmatched-hint">以下会话的工作目录没有对应项目，本次已写入当天日记。为它们选择归属：</p>
    <div v-for="it in items" :key="it.cwd" class="da-unmatched-item">
      <div class="da-unmatched-cwd" :title="it.cwd">{{ it.cwd }}</div>
      <div class="da-unmatched-row">
        <input v-model="names[it.cwd]" placeholder="项目名称" />
        <button class="pa-btn primary" @click="create(it)">创建项目</button>
      </div>
      <label class="da-unmatched-import" v-if="!done_[it.cwd]">
        <input type="checkbox" v-model="importHistory[it.cwd]" />
        同时导入该工作区的全部历史会话（{{ it.count }} 条范围内，按 T3 库全量扫描）
      </label>
      <div class="da-unmatched-row da-unmatched-sub">
        <button class="pa-btn" @click="keepJournal(it)">放入日记，不再提醒</button>
        <button class="pa-btn" @click="ignore(it)">忽略工作区</button>
      </div>
      <div v-if="errors[it.cwd]" class="da-unmatched-err">{{ errors[it.cwd] }}</div>
    </div>
    <div class="pa-modal-actions">
      <button class="pa-btn" @click="close">关闭</button>
    </div>
  </div>
</template>

<script>
import { Notice } from 'obsidian';

export default {
  name: 'UnmatchedWorkspaceModal',
  props: {
    // [{ cwd, name, count }]，name 预填 cwd 的 basename
    items: { type: Array, default: () => [] },
    // 调用方注入的操作
    onCreate: { type: Function, default: null },      // ({ name, cwd, importHistory }) → { ok, ... }
    onIgnore: { type: Function, default: null },      // ({ cwd })
    onJournal: { type: Function, default: null },     // ({ cwd })——放入日记并停止提醒
    onNotified: { type: Function, default: null }     // 弹窗已展示（记已提醒）
  },
  emits: ['update:open'],
  data() {
    const names = {};
    const importHistory = {};
    for (const it of this.items || []) {
      names[it.cwd] = it.name || '';
      importHistory[it.cwd] = false;
    }
    return { names, importHistory, errors: {}, done_: {} };
  },
  mounted() {
    if (this.onNotified) this.onNotified();
  },
  methods: {
    close() { this.$emit('update:open', false); },
    async create(it) {
      const name = String(this.names[it.cwd] || '').trim();
      if (!name) { this.errors[it.cwd] = '请填写项目名称'; return; }
      try {
        const r = this.onCreate
          ? await this.onCreate({ name, cwd: it.cwd, importHistory: !!this.importHistory[it.cwd] })
          : null;
        if (!r || r.ok === false) {
          this.errors[it.cwd] = '创建失败：' + ((r && r.reason) || 'unknown');
          return;
        }
        const imported = Number(r.imported) || 0;
        new Notice(imported
          ? `已创建项目「${name}」并导入 ${imported} 条历史会话`
          : `已创建项目「${name}」`);
        this.done(it);
      } catch (e) {
        this.errors[it.cwd] = '创建失败：' + String((e && e.message) || e);
      }
    },
    async ignore(it) {
      try {
        if (this.onIgnore) await this.onIgnore({ cwd: it.cwd });
        new Notice('已忽略该工作区，此后会话不再回传');
        this.done(it);
      } catch (e) {
        this.errors[it.cwd] = '操作失败：' + String((e && e.message) || e);
      }
    },
    async keepJournal(it) {
      try {
        if (this.onJournal) await this.onJournal({ cwd: it.cwd });
        new Notice('已放入日记，该工作区此后不再提醒');
        this.done(it);
      } catch (e) {
        this.errors[it.cwd] = '操作失败：' + String((e && e.message) || e);
      }
    },
    done(it) {
      const rest = (this.items || []).filter((x) => x.cwd !== it.cwd);
      if (!rest.length) { this.close(); return; }
      // 原地收敛列表：剩余项继续留在弹窗里处理
      this.items.splice(0, this.items.length, ...rest);
    }
  }
};
</script>

<style>
/* 沿用项目页 pa-btn / pa-modal-actions 视觉（unscoped）。
   这份兜底复制自 project-view.vue：弹窗可能先于项目视图打开，届时 pa-btn 尚未注入。
   类名相同，两处规则一致不会打架。 */
.da-unmatched .pa-btn {
  font-size: 12px; padding: 3px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--background-modifier-border); background: var(--background-secondary);
}
.da-unmatched .pa-btn.primary { background: var(--interactive-accent); color: var(--text-on-accent); border-color: transparent; }
.da-unmatched .pa-modal-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.da-unmatched { display: flex; flex-direction: column; gap: 10px; }
.da-unmatched h4 { margin: 0 0 2px; }
.da-unmatched-hint { margin: 0; font-size: 12px; opacity: 0.75; }
.da-unmatched-item {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px; border-radius: 8px;
  border: 1px solid var(--background-modifier-border);
}
.da-unmatched-cwd { font-size: 12px; opacity: 0.8; word-break: break-all; }
.da-unmatched-row { display: flex; gap: 6px; align-items: center; }
.da-unmatched-row input[type="text"], .da-unmatched-row input:not([type]) {
  flex: 1; min-width: 0; border-radius: 6px; padding: 6px;
  border: 1px solid var(--background-modifier-border); background: var(--background-primary);
}
.da-unmatched-sub { gap: 6px; }
.da-unmatched-import { display: flex; gap: 6px; align-items: center; font-size: 12px; opacity: 0.85; }
.da-unmatched-err { color: var(--text-error); font-size: 12px; }
</style>
