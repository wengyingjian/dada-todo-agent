<template>
  <div class="pa-tasks">
    <template v-for="row in rows" :key="row.kind === 'heading' ? 'h:' + row.lineNo : row.task.guid">
      <div v-if="row.kind === 'heading'" class="pa-group-h">{{ row.title }}</div>
      <div v-else class="pa-task" :class="{ done: row.task.completed }">
      <div class="pa-task-line">
        <input class="pa-check" type="checkbox" :checked="row.task.completed" @change="$emit('toggle', row.task, !row.task.completed)" />
        <span class="pa-task-title" :title="(row.task.description || '') + '（双击修改）'" @dblclick="$emit('edit', row.task)">{{ displayTitle(row.task) }}</span>
        <button class="pa-act pa-fly" title="委派给 T3 Code" @click="$emit('delegate', row.task)">✈</button>
        <button class="pa-act" title="归档" @click="$emit('archive', row.task)">⤓</button>
        <button class="pa-act pa-del" title="删除" @click="$emit('remove', row.task)">×</button>
      </div>
      <div v-for="d in delsOf(row.task)" :key="d.threadId || d.line" class="pa-delegation" :class="'st-' + d.state">
        <span class="pa-delegation-state">{{ stateText(d.state) }}</span>
        <span class="pa-delegation-sum">{{ d.summary }}</span>
        <a v-if="d.threadId" class="pa-pill" title="打开 T3 Code 会话" @click.stop="$emit('open-thread', d.threadId)">
          ⚡ {{ short(d.threadId) }}
        </a>
      </div>
      </div>
    </template>
    <div v-if="!tasks.length" class="pa-empty">还没有任务，回车添加第一条</div>
  </div>
</template>

<script>
import { shortId } from './delegate-line.js';
import { stripSessionMark } from './session-line.js';
import { mergeHeadingRows } from './groups.js';

export default {
  name: 'ProjectTaskList',
  props: {
    tasks: { type: Array, default: () => [] },
    delsByLine: { type: Object, default: () => ({}) },
    lines: { type: Array, default: () => [] }
  },
  emits: ['toggle', 'edit', 'delegate', 'archive', 'remove', 'open-thread'],
  computed: {
    // ### 标题行以占位行插入平铺任务之间（lineNo 归位），视图只渲染分隔标题
    rows() { return mergeHeadingRows(this.tasks, this.lines); }
  },
  methods: {
    short(id) { return shortId(id); },
    // 同步任务行尾带 ⚡ t3: 绑定标记，项目视图只显示标题
    displayTitle(t) { return stripSessionMark(t.summary); },
    delsOf(t) { return this.delsByLine[t.lineNo] || []; },
    stateText(s) {
      return ({ running: '进行中', awaiting: '待回答', completed: '完成', failed: '失败', cancelled: '已取消' })[s] || s;
    }
  }
};
</script>
