// 任务纯函数（周计算 / 分组，与视图共用）+ 数据访问（指向插件 vault API）。
// 与网页版同名文件保持 API 形状一致，UI 层无需感知存储差异。
import { t } from '../i18n/index.js';
import {
  loadAll, loadChecklists, loadByList, loadByDate, getDetail,
  loadChecklistGroups, collectTags,
  createTask, createChecklistTask, updateTask, deleteTask, toggleTask, setChecklistStatus, createSubtask, listSubtasks,
  moveChecklistTask, createChecklist, setChecklistArchived, moveTaskToList
} from '../api/tasks.js';

// ---------- 纯函数 ----------
import { getWeekStart } from './tasks-logic.js';

export function startOfWeek(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const ws = getWeekStart(); // 0=周日 … 6=周六
  const day = (date.getDay() - ws + 7) % 7; // 回退到本周起始日
  date.setDate(date.getDate() - day);
  return date;
}
export function weekDays(weekStart) {
  const arr = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    arr.push(d);
  }
  return arr;
}

// ---------- 数据访问（形状与网页版一致，但抛错形式统一为 Error） ----------
async function unwrap(p) {
  const r = await p;
  if (r.status >= 400 || r.body.ok === false) {
    const reason = r.body.reason || String(r.status);
    // bad_date 表示「有日期任务需要日记插件，但日记插件未启用」：给出明确引导而非裸错误码
    const msg = reason === 'bad_date' ? t('common.dailyDisabledHint') : (t('common.apiError') + reason);
    const err = new Error(msg);
    err.reason = reason;
    throw err;
  }
  return r.body;
}

const api = {
  async loadAll() { return (await unwrap(loadAll())).items || []; },
  async loadChecklists() { return (await unwrap(loadChecklists())).items || []; },
  async loadByList(listKey) { return (await unwrap(loadByList(listKey))).items || []; },
  async loadChecklistGroups(listKey) { return await unwrap(loadChecklistGroups(listKey)); },
  // 新建清单：名称必填、cwd 可选。返回 { key:'cl:相对路径', name, total:0, done:0 }，形状与 loadChecklists 的项一致
  async createChecklist(name, opts = {}) { return (await unwrap(createChecklist(name, opts))).item; },
  // 归档 / 取消归档整份清单（frontmatter tags 增删 archived）
  async setChecklistArchived(listKey, archived = true) { return await unwrap(setChecklistArchived(listKey, archived)); },
  async loadByDate(dateKey) { return (await unwrap(loadByDate(dateKey))).items || []; },
  async getDetail(guid) {
    const items = await this.loadByDate(String(guid || '').split('#')[0]);
    return items.find((t) => t.guid === guid) || null;
  },
  async createTask(task) { return (await unwrap(createTask(task))).task; },
  async createChecklistTask(listKey, groupTitle, task) {
    return (await unwrap(createChecklistTask(listKey, groupTitle, task))).task;
  },
  async updateTask(guid, patch) { return (await unwrap(updateTask(guid, patch))).task; },
  async deleteTask(guid) { await unwrap(deleteTask(guid)); },
  async toggleComplete(guid, done) { return (await unwrap(toggleTask(guid, done))).task; },
  async setChecklistStatus(guid, status) { return (await unwrap(setChecklistStatus(guid, status))).task; },
  async listSubtasks(parentGuid) { return (await unwrap(listSubtasks(parentGuid))).items || []; },
  async createSubtask(parentGuid, task) { return (await unwrap(createSubtask(parentGuid, task))).task; },
  async moveChecklistTask(listKey, guid, targetGroupTitle) { return await unwrap(moveChecklistTask(listKey, guid, targetGroupTitle)); },
  // 任务跨清单移动（编辑弹窗改归属用）：targetKey 为 cl: 键或 INBOX_KEY
  async moveTaskToList(guid, targetKey) { return (await unwrap(moveTaskToList(guid, targetKey))).task; },
  // 全库历史标签（按频次倒序）：编辑弹窗添加标签时的智能提示数据源（issue #22）
  async collectTags() { return await collectTags(); }
};

// 聚合命名空间导出，供组件以 Tasks.xxx 调用
export const Tasks = Object.assign({
  startOfWeek, weekDays
}, api);
