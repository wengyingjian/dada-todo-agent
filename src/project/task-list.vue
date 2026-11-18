<template>
  <div class="pa-tasks">
    <div v-for="t in tasks" :key="t.guid" class="pa-task" :class="{ done: t.completed }">
      <div class="pa-task-line">
        <input class="pa-check" type="checkbox" :checked="t.completed" @change="$emit('toggle', t, !t.completed)" />
        <span class="pa-task-title" :title="t.description || ''">{{ t.summary }}</span>
        <button class="pa-act pa-fly" title="委派给 T3 Code" @click="$emit('delegate', t)">✈</button>
        <button class="pa-act" title="归档" @click="$emit('archive', t)">⤓</button>
        <button class="pa-act pa-del" title="删除" @click="$emit('remove', t)">×</button>
      </div>
      <div v-for="d in delsOf(t)" :key="d.threadId || d.line" class="pa-delegation" :class="'st-' + d.state">
        <span class="pa-delegation-state">{{ stateText(d.state) }}</span>
        <span class="pa-delegation-sum">{{ d.summary }}</span>
        <a v-if="d.threadId" class="pa-pill" title="打开 T3 Code 会话" @click.stop="$emit('open-thread', d.threadId)">
          ⚡ {{ short(d.threadId) }}
        </a>
      </div>
    </div>
    <div v-if="!tasks.length" class="pa-empty">还没有任务，回车添加第一条</div>
  </div>
</template>

<script>
import { shortId } from './delegate-line.js';

export default {
  name: 'ProjectTaskList',
  props: {
    tasks: { type: Array, default: () => [] },
    delsByLine: { type: Object, default: () => ({}) }
  },
  emits: ['toggle', 'delegate', 'archive', 'remove', 'open-thread'],
  methods: {
    short(id) { return shortId(id); },
    delsOf(t) { return this.delsByLine[t.lineNo] || []; },
    stateText(s) {
      return ({ running: '进行中', awaiting: '待回答', completed: '完成', failed: '失败', cancelled: '已取消' })[s] || s;
    }
  }
};
</script>
