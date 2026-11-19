# 回传任务分组 + 历史导入 LLM 总结（可选）

## Problem Statement
回传/导入的 T3 会话任务在项目任务文件里平铺堆积，看不出哪些还在跑、哪些在等你回答、哪些已结束；历史导入的摘要只是文本截断（`summarize()` 截 `lastAssistant`），质量明显低于在线会话静默后的 LLM 重总结。

## Recommended Direction
**在项目任务文件里引入三个 `###` 分组，同步时自动搬动；历史导入在手动同步弹窗里加「LLM 总结」开关。**

分组语义与会话侧栏（`session-pane.vue`）对齐：

| 分组 | 状态 | 时机 |
|---|---|---|
| `### 进行中` | running | 委派发出 / 回传新会话 |
| `### 待处理` | awaiting | 会话等待你回答 |
| `### 已完成` | completed / failed / cancelled | 会话结束 |

四个改动面：

1. **确保分组存在**（新函数，runtime 层）：`syncOnce` / 导入前扫描项目文件，缺哪个 `###` 标题就按「进行中 → 待处理 → 已完成」的顺序补建。底层 `createChecklistTask` 对不存在的分组返回 404（`group_not_found`），所以必须先补标题再插入。
2. **写入即入组**：`syncOnce` 新建回传任务和 `importThreadsToProject` 导入时，`createChecklistTask` 的 `groupTitle` 按会话当前状态映射（不再是空串）。
3. **同步自动搬**：`syncOnce` 里检测到 `t.state !== loc.state` 时，除了现有的 `updateDelegation`（状态行更新），再调 `moveChecklistTask` 把整块（父任务 + 委派子行 + 总结描述行）搬到目标分组末尾。
4. **导入 LLM 开关**：`importThreadsToProject(plugin, node, { llm: boolean })`——`llm: true` 时逐会话调 `summarizeThread`（复用 summarize-llm 链路），失败回落截断摘要；ManualSyncModal 加一个勾选项，默认关。

**视图保持平铺**：`task-list.vue` 在 `###` 标题处渲染一行分隔标题（纯文字，不可交互），分组归属由读取层带上或视图侧现场扫描。手动建的未分组任务显示在「未分组」区（文件顶部、首个 `###` 之前）。

## Key Assumptions to Validate
- [ ] `moveChecklistTask` 搬整块时委派子行一起走且 threadId 绑定不丢——代码注释声称如此，需用一次真实 running→completed 流转验证
- [ ] 自动搬动与用户手动编辑不产生行号竞态（现有代码靠现场重扫定位，理论安全）——观察 `updateTask 定位失败` 日志是否增多
- [ ] 已存在的无分组老任务不被自动搬动（只在状态变化时才搬；首次建组后老任务留在未分组区直到手动归档）——已确认为刻意设计

## MVP Scope
- 三个固定分组名硬编码（`进行中` / `待处理` / `已完成`），不做配置项
- `syncOnce`：新建入组 + 状态变化自动搬 + 缺组补建标题
- `importThreadsToProject` LLM 开关 + ManualSyncModal 勾选项
- 平铺视图渲染 `###` 标题分隔行

## Not Doing (and Why)
- **失败/取消单独分组** — 三组已够用，失败信息在委派子行总结里有，需要时再加
- **手动拖拽分组** — 先验证自动搬好用，交互成本高
- **分组名可配置** — 固定三组语义清晰，配置化是过度设计
- **视图改成分组渲染（折叠/计数/拖拽）** — 用户选择保持平铺，改动最小
- **老任务建组时一次性归位** — 已确认不动老任务，清理走已有「归档已完成」按钮
- **历史导入批量后台 LLM / 进度条 / 断点续传** — 开关是手动的、一次性的

## Open Questions
- 导入 LLM 全量跑上百会话时是否需要简单的进度提示（Notice 计数）？实现时视耗时决定。
