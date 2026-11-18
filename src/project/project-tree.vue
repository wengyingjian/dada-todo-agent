<template>
  <ul class="pa-nodes" :style="{ paddingLeft: depth ? '12px' : '0' }">
    <li v-for="n in nodes" :key="n.dirPath">
      <div class="pa-node" :class="{ active: n.dirPath === active }" @click="select(n)" @contextmenu.prevent="openMenu(n, $event)">
        <span class="pa-caret" @click.stop="toggle(n.dirPath)">{{ openSet.has(n.dirPath) ? '▾' : '▸' }}</span>
        <span class="pa-node-name">{{ n.name }}</span>
        <span v-if="n.unfinished" class="pa-cnt">{{ n.unfinished }}</span>
      </div>
      <project-tree
        v-if="n.children && n.children.length && openSet.has(n.dirPath)"
        :nodes="n.children"
        :active="active"
        :open-set="openSet"
        :depth="(depth || 0) + 1"
        @select="$emit('select', $event)"
        @toggle="$emit('toggle', $event)"
        @action="(a, node) => $emit('action', a, node)"
      />
    </li>
  </ul>
</template>

<script>
import { Menu } from 'obsidian';

export default {
  name: 'ProjectTree',
  props: {
    nodes: { type: Array, default: () => [] },
    active: { type: String, default: '' },
    openSet: { type: Object, default: () => new Set() },
    depth: { type: Number, default: 0 }
  },
  emits: ['select', 'toggle', 'action'],
  methods: {
    select(n) {
      this.$emit('toggle', n.dirPath);
      this.$emit('select', n);
    },
    toggle(path) {
      this.$emit('toggle', path);
    },
    openMenu(n, ev) {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('新建子项目').setIcon('folder-plus')
        .onClick(() => this.$emit('action', 'new-child', n)));
      menu.addItem((i) => i.setTitle('重命名项目').setIcon('pencil')
        .onClick(() => this.$emit('action', 'rename', n)));
      menu.addItem((i) => i.setTitle('打开项目文件').setIcon('file-text')
        .onClick(() => this.$emit('action', 'open', n)));
      menu.addItem((i) => i.setTitle('设置 cwd').setIcon('folder-cog')
        .onClick(() => this.$emit('action', 'cwd', n)));
      menu.showAtMouseEvent(ev);
    }
  }
};
</script>
