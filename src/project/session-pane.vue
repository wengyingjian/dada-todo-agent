<template>
  <aside class="pa-sessions">
    <div class="pa-sessions-head">
      <span>会话</span>
      <button class="pa-act" title="刷新" @click="$emit('refresh')">↻</button>
    </div>
    <div v-for="g in groups" :key="g.key" class="pa-session-group">
      <div class="pa-session-group-h">{{ g.title }} <span class="pa-cnt">{{ g.items.length }}</span></div>
      <div v-for="t in g.items" :key="t.threadId" class="pa-session" @click="$emit('open-thread', t.threadId)">
        <div class="pa-session-title">{{ t.title }}</div>
        <div class="pa-session-meta">{{ shortCwd(t.cwd) }} · {{ ago(t.updatedAt) }}</div>
      </div>
      <div v-if="!g.items.length" class="pa-empty small">无</div>
    </div>
  </aside>
</template>

<script>
export default {
  name: 'SessionPane',
  props: { threads: { type: Array, default: () => [] } },
  emits: ['open-thread', 'refresh'],
  computed: {
    groups() {
      const run = [];
      const wait = [];
      const done = [];
      for (const t of this.threads) {
        if (t.state === 'running') run.push(t);
        else if (t.state === 'awaiting') wait.push(t);
        else if (t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled') done.push(t);
      }
      const byTime = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
      return [
        { key: 'run', title: '进行中', items: run.sort(byTime) },
        { key: 'wait', title: '待你处理', items: wait.sort(byTime) },
        { key: 'done', title: '已完成', items: done.slice(0, 20).sort(byTime) }
      ];
    }
  },
  methods: {
    shortCwd(cwd) {
      const s = String(cwd || '');
      if (!s) return '未知目录';
      const parts = s.split('/');
      return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : s;
    },
    ago(ms) {
      if (!ms) return '';
      const d = Math.max(0, Date.now() - ms);
      const m = Math.floor(d / 60000);
      if (m < 1) return '刚刚';
      if (m < 60) return m + ' 分钟前';
      const h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时前';
      return Math.floor(h / 24) + ' 天前';
    }
  }
};
</script>
