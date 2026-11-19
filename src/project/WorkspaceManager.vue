<!-- 工作区管理（设置页「项目」tab）：每个 cwd 一行，三态归属自由切换。
     项目：关联/新建项目目录，可改名、可同步历史（导入未绑定会话 + 搬回日记里的委派块）
     日记：新会话写进当天日记；同步历史按会话日期写入对应日记
     忽略：默认状态，不进入任何文件
     每行可单独关闭 LLM 总结（默认跟随全局配置）。 -->
<template>
  <div class="dt-ws">
    <div class="dt-ws-head">
      <span class="dt-ws-hint">
        按工作目录管理归属；未列出的 cwd 默认忽略、不回传。切换状态即时生效。
        <template v-if="!llmReady"> LLM 尚未配置，「使用 LLM」暂时不生效。</template>
      </span>
      <button class="dt-ws-btn" :disabled="loading" @click="reload">刷新</button>
    </div>

    <div v-if="loading" class="dt-ws-empty">正在读取 T3 会话…</div>
    <div v-else-if="!rows.length" class="dt-ws-empty">T3 库里没有会话，也没有已归属的工作区。</div>

    <div v-for="r in rows" :key="r.cwd" class="dt-ws-row" :class="'is-' + r.kind">
      <div class="dt-ws-line">
        <span class="dt-ws-cwd" :title="r.cwd">{{ r.cwd }}</span>
        <span class="dt-ws-badge">{{ r.total }} 条</span>
        <span v-if="r.unbound" class="dt-ws-badge warn">{{ r.unbound }} 未入库</span>
        <span v-if="r.kind === 'project'" class="dt-ws-badge ok">→ {{ r.projectName }}</span>
      </div>

      <div class="dt-ws-line dt-ws-actions">
        <select class="dt-ws-select" :value="draftOf(r)" @change="onKind(r, $event.target.value)">
          <option value="project">项目</option>
          <option value="journal">日记</option>
          <option value="ignored">忽略</option>
        </select>

        <template v-if="r.kind === 'project' && r.ownProject">
          <input v-model="names[r.cwd]" class="dt-ws-input" placeholder="项目名称" @keydown.enter.prevent="rename(r)" />
          <button class="dt-ws-btn" :disabled="busy[r.cwd]" @click="rename(r)">重命名</button>
        </template>

        <button
          v-if="r.kind !== 'ignored'"
          class="dt-ws-btn"
          :disabled="busy[r.cwd]"
          :title="r.kind === 'project' ? '导入未绑定会话，并把日记里的委派块搬回项目' : '按会话日期导入历史会话到日记'"
          @click="syncHistory(r)"
        >{{ busy[r.cwd] ? '同步中…' : '同步历史' }}</button>

        <label v-if="r.kind !== 'ignored'" class="dt-ws-llm" title="关闭后该工作区不再调用 LLM 总结">
          <input type="checkbox" :checked="r.llm" @change="toggleLlm(r, $event.target.checked)" />
          使用 LLM
        </label>
      </div>

      <div v-if="pendingCreate === r.cwd" class="dt-ws-line dt-ws-create">
        <input v-model="newNames[r.cwd]" class="dt-ws-input" placeholder="新项目名称" @keydown.enter.prevent="createProject(r)" />
        <button class="dt-ws-btn primary" :disabled="busy[r.cwd]" @click="createProject(r)">创建项目</button>
        <button class="dt-ws-btn" @click="cancelCreate(r)">取消</button>
      </div>

      <div v-if="errors[r.cwd]" class="dt-ws-err">{{ errors[r.cwd] }}</div>
    </div>
  </div>
</template>

<script>
import { Notice } from 'obsidian';
import * as rt from './runtime.js';

export default {
  name: 'WorkspaceManager',
  props: { plugin: { type: Object, required: true } },
  data() {
    return {
      rows: [],
      loading: true,
      drafts: {},
      names: {},
      newNames: {},
      pendingCreate: '',
      busy: {},
      errors: {}
    };
  },
  computed: {
    llmReady() {
      const s = (this.plugin.settings && this.plugin.settings.project) || {};
      return !!(s.summaryLlmBaseUrl && s.summaryLlmApiKey && s.summaryLlmModel);
    }
  },
  async mounted() { await this.reload(); },
  methods: {
    draftOf(r) { return this.drafts[r.cwd] || r.kind; },
    async reload() {
      this.loading = true;
      try {
        this.rows = await rt.workspaceRows(this.plugin);
        const names = {};
        for (const r of this.rows) names[r.cwd] = r.projectName || r.name;
        this.names = names;
        this.drafts = {};
        this.errors = {};
      } catch (e) {
        new Notice('读取工作区失败：' + String((e && e.message) || e));
        this.rows = [];
      } finally {
        this.loading = false;
      }
    },
    async onKind(r, value) {
      if (value === r.kind) return;
      if (value === 'project') {
        // 「切到项目」先填名称再创建（已有关联项目时服务端会直接复用）
        this.pendingCreate = r.cwd;
        this.drafts = { ...this.drafts, [r.cwd]: 'project' };
        if (!this.newNames[r.cwd]) this.newNames = { ...this.newNames, [r.cwd]: r.name || '' };
        return;
      }
      this.drafts = { ...this.drafts, [r.cwd]: value };
      await this.apply(r, () => rt.setWorkspaceKind(this.plugin, r.cwd, value));
    },
    cancelCreate(r) {
      this.pendingCreate = '';
      const drafts = { ...this.drafts };
      delete drafts[r.cwd];
      this.drafts = drafts;
    },
    async createProject(r) {
      const name = String(this.newNames[r.cwd] || '').trim();
      if (!name) { this.errors = { ...this.errors, [r.cwd]: '请填写项目名称' }; return; }
      await this.apply(r, async () => {
        const res = await rt.setWorkspaceKind(this.plugin, r.cwd, 'project', { name });
        this.pendingCreate = '';
        return res;
      });
    },
    async rename(r) {
      const name = String(this.names[r.cwd] || '').trim();
      if (!name) { this.errors = { ...this.errors, [r.cwd]: '请填写项目名称' }; return; }
      await this.apply(r, () => rt.renameProjectByCwd(this.plugin, r.cwd, name));
    },
    async toggleLlm(r, checked) {
      const res = await rt.setWorkspaceLlm(this.plugin, r.cwd, checked);
      if (!res || res.ok === false) { new Notice('保存 LLM 开关失败'); return; }
      r.llm = checked;
    },
    async syncHistory(r) {
      await this.apply(r, async () => {
        const res = await rt.syncWorkspaceHistory(this.plugin, r.cwd, { llm: !!r.llm });
        if (res && res.ok !== false) {
          const moved = Number(res.moved) || 0;
          new Notice(`同步完成：导入 ${Number(res.imported) || 0} 条${moved ? `，搬回 ${moved} 条` : ''}`);
        }
        return res;
      });
    },
    async apply(r, fn) {
      this.busy = { ...this.busy, [r.cwd]: true };
      this.errors = { ...this.errors, [r.cwd]: '' };
      try {
        const res = await fn();
        if (res && res.ok === false) {
          this.errors = { ...this.errors, [r.cwd]: this.reasonOf(res.reason) };
          return;
        }
        await this.reload();
      } catch (e) {
        this.errors = { ...this.errors, [r.cwd]: String((e && e.message) || e) };
      } finally {
        const busy = { ...this.busy };
        delete busy[r.cwd];
        this.busy = busy;
      }
    },
    reasonOf(reason) {
      return ({
        empty: 'cwd 为空',
        bad_kind: '未知的归属类型',
        exists: '同名项目已存在',
        bad_name: '项目名称包含非法字符',
        no_project: '找不到关联项目',
        ignored: '已忽略的工作区不同步',
        no_cwd: '项目未设置 cwd',
        cwd_failed: '写入项目 cwd 失败'
      })[reason] || ('操作失败：' + String(reason || 'unknown'));
    }
  }
};
</script>

<style scoped>
.dt-ws { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.dt-ws-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dt-ws-hint { font-size: 12px; opacity: 0.7; }
.dt-ws-empty { font-size: 12px; opacity: 0.6; padding: 8px 0; }
.dt-ws-row {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
}
.dt-ws-row.is-project { border-left: 3px solid var(--interactive-accent); }
.dt-ws-row.is-journal { border-left: 3px solid var(--text-success, #4a8b3a); }
.dt-ws-row.is-ignored { opacity: 0.75; }
.dt-ws-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dt-ws-cwd { font-size: 12px; font-family: var(--font-monospace); word-break: break-all; }
.dt-ws-badge {
  font-size: 11px; padding: 1px 6px; border-radius: 8px;
  background: var(--background-primary); border: 1px solid var(--background-modifier-border);
}
.dt-ws-badge.warn { color: var(--text-warning, #b98a00); }
.dt-ws-badge.ok { color: var(--text-success, #4a8b3a); }
.dt-ws-actions { gap: 6px; }
.dt-ws-select, .dt-ws-input {
  font-size: 12px; padding: 3px 6px; border-radius: 5px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-primary); color: var(--text-normal);
}
.dt-ws-input { flex: 1 1 160px; min-width: 120px; }
.dt-ws-btn {
  font-size: 12px; padding: 3px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-primary); color: var(--text-normal);
}
.dt-ws-btn.primary { background: var(--interactive-accent); color: var(--text-on-accent); border-color: transparent; }
.dt-ws-btn:disabled { opacity: 0.5; cursor: default; }
.dt-ws-llm { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; opacity: 0.85; cursor: pointer; }
.dt-ws-create { padding-top: 2px; }
.dt-ws-err { font-size: 12px; color: var(--text-error); }
</style>
