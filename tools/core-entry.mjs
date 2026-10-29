// CLI 的核心包入口：把插件真实的 api/tasks.js 与纯逻辑层一起打进一个文件，
// 外部通过 boot(settings) 注入插件设置（读自 vault 的 data.json）。
// 只导出 CLI 用得到的函数；签名与插件内完全一致，不在这里做任何格式转换。
import { app } from 'obsidian';
import {
  initTasksApi, ensureInboxFile, createChecklist, createGroup, renameGroup, deleteGroup,
  createTask, createChecklistTask, createSubtask,
  updateTask, toggleTask, setChecklistStatus, deleteTask, moveTaskToGroup, moveChecklistTask,
  loadAll, loadByDate, loadByList, loadChecklists, loadInboxGroups, loadChecklistGroups,
  getDetail, listSubtasks, taskFilePath,
} from '../src/core/api/tasks.js';
import { setDryRun, takeOps } from './obsidian-mock.mjs';

export {
  app, setDryRun, takeOps,
  ensureInboxFile, createChecklist, createGroup, renameGroup, deleteGroup,
  createTask, createChecklistTask, createSubtask,
  updateTask, toggleTask, setChecklistStatus, deleteTask, moveTaskToGroup, moveChecklistTask,
  loadAll, loadByDate, loadByList, loadChecklists, loadInboxGroups, loadChecklistGroups,
  getDetail, listSubtasks, taskFilePath,
};

/** 注入插件设置（等价于 Obsidian 里加载 data.json 后的 plugin.settings） */
export function boot(settings) {
  initTasksApi({ settings: settings || {}, app });
}
