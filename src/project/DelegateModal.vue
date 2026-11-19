<!-- 委派给 T3 Code 弹窗：项目页与编辑器纸飞机共用（经 VueModal 桥挂载）。
     props: prompt / cwd 预填值；emit 'confirm'({ prompt, cwd }) 由调用方执行委派。 -->
<template>
  <div class="da-delegate">
    <h4>委派给 T3 Code</h4>
    <label>内容</label>
    <textarea v-model="promptVal" rows="4"></textarea>
    <label>工作目录</label>
    <div class="da-delegate-cwd">
      <input v-model="cwdVal" />
      <button class="pa-btn" title="选择文件夹" @click="browse">📁</button>
    </div>
    <div class="pa-modal-actions">
      <button class="pa-btn" @click="close">取消</button>
      <button class="pa-btn primary" @click="confirm">发送</button>
    </div>
  </div>
</template>

<script>
import { Notice } from 'obsidian';
import { pickFolder } from './electron-dialog.js';

export default {
  name: 'DelegateModal',
  props: {
    prompt: { type: String, default: '' },
    cwd: { type: String, default: '' }
  },
  emits: ['confirm', 'update:open'],
  data() {
    return { promptVal: this.prompt, cwdVal: this.cwd };
  },
  methods: {
    close() { this.$emit('update:open', false); },
    async browse() {
      try {
        const picked = await pickFolder();
        if (picked) this.cwdVal = picked;
      } catch (e) {
        new Notice('打不开文件夹选择：' + String(e.message || e));
      }
    },
    confirm() {
      if (!this.cwdVal.trim()) { new Notice('请填写工作目录'); return; }
      if (!this.promptVal.trim()) { new Notice('请填写委派内容'); return; }
      this.$emit('confirm', { prompt: this.promptVal.trim(), cwd: this.cwdVal.trim() });
      this.close();
    }
  }
};
</script>

<style>
/* 委派弹窗：沿用项目页 pa-modal 视觉（unscoped，两处挂载点样式一致） */
.da-delegate { display: flex; flex-direction: column; gap: 6px; }
.da-delegate h4 { margin: 0 0 4px; }
.da-delegate textarea, .da-delegate input {
  width: 100%; border-radius: 6px; padding: 6px;
  border: 1px solid var(--background-modifier-border); background: var(--background-primary);
}
.da-delegate-cwd { display: flex; gap: 6px; align-items: center; }
.da-delegate-cwd input { flex: 1; }
</style>
