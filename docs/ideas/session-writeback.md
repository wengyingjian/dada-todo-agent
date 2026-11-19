# 会话回写：就地更新，或单级新建

## Problem Statement
如何让 T3 会话回写任务文件时做到「有记录就就地更新、没有记录就单级新建」，并且永远不改变用户原有行的类型？

## 根因（用真实任务文件确认）
1. **行号基底错位**：编辑器纸飞机传的是含 frontmatter 的全文档行号，`appendDelegation` 却按正文行号使用；子行整体下移、越界时被追加到文件末尾。
2. **占位行永远回填不上**：占位行写的是 prompt 摘要，认领条件却要求行内包含「进行中」/「等你回答」。`finishWithSummary` 还引用了作用域外的 `locateOwnLine`。结果 threadId 从未落到文件，同步认为会话未绑定，新建重复任务。
3. **两级结构是写死的**：`syncOnce` / 导入都是 `createChecklistTask`（`- [ ]` 父任务）+ `appendDelegation`（子行）。
4. **组内插入不跳过组尾空行**：`createChecklistTask` / `moveChecklistTask` 插在「下一个 ### 标题」之前，组标题下留空行。
5. **父行只认 checkbox 任务**：普通列表项（`- hello`）下的委派会挂到更早的任务上。

## Recommended Direction
统一「会话行」模型 + 三步决策树 + 单一改写函数。

文件里所有 T3 记录都带 `⚡ t3:<id>`，按缩进区分形态：

| 形态 | 例子 |
|---|---|
| 委派子行 | `\t- [x] 标题  ⚡ t3:<id>`（父行保持原样，任务或普通列表项都行） |
| 同步任务行 | `- [x] 19:48-19:48 标题 📅 2026-11-19  ⚡ t3:<id>` + 下方 `  1.` 描述 |

同步时按此顺序判断：
1. 找到 threadId → 就地改那一行（状态/标题/描述），父行与父行类型不动。
2. 命中 pending 占位行（`p!<临时 id>` + prompt 摘要匹配）→ 认领并回填，不新建。
3. 都没有 → 新建单级任务（一级任务行 + 描述分点，标记在行尾）。

### 落地改动
1. `editor-grip-ui.js` 传 `lineNoBasis: 'document'`；`delegate.js::toBodyLineNo` 按 frontmatter 行数换算成正文行号。
2. `delegate-line.js` 新增占位 id（`⚡ t3:p!xxxxxxxx`）：`formatDelegationLine` / `parseDelegationLine` 支持 `pendingId`；`extractDelegations` 区分 `self`（顶层任务自带标记）与子行，父行栈放宽到任意列表项。
3. `session-line.js`（新）：`splitSessionLine` / `rewriteSessionLine` 统一改写，保留时间前缀与 📅/🛫 日期徽标；`locateSessionLine` 三级定位；`stripSessionMark` 供视图显示。
4. `runtime.js`：
   - `scanDelegationRecords` 同时返回绑定表与 pending 列表；`registerDelegationFile` 登记项目根/日记夹之外的委派承载文件。
   - `syncOnce` 未绑定分支先认领 pending，再按单级 `createThreadTask` 新建。
   - `createThreadTask`：一级任务行（状态按会话真实状态）+ 分点描述 + 行尾标记；标题 = 时间 + LLM 标题 + 日期，LLM 失败回退线程标题。
   - `moveDelegationToGroup` 用 `groupBlockLineOf`：self 行搬自己，子行搬父任务，父行是普通列表项不搬。
   - `importThreadsToProject` 改走 `createThreadTask`（LLM 开关仍然生效）。
5. `delegate.js`：占位行带 pendingId；`locateOwnLine` 按 threadId → pendingId → 行号定位；回填与总结都走 `rewriteSessionLine`。
6. `core/api/tasks.js`：`createChecklistTask` / `moveChecklistTask` 的组内插入点回退到组内最后一个非空行之后。
7. `task-list.vue` / `project-view.vue`：显示剥离标记；编辑时保留标记；删除同步任务时把会话加入忽略列表。

## Key Assumptions to Validate
- [ ] 子行紧贴父行、空行落在子行之后，仍渲染为子项（需在 Obsidian 里实测一次）
- [ ] `p!` 临时 id 与真实 threadId 不会冲突（格式上已隔离）
- [ ] 父行是普通列表项时没有 `###` 归属，跳过搬组是正确取舍
- [ ] LLM 超时回退线程标题 + 截断描述可接受

## MVP Scope
上述 1-7 全部实现；历史脏数据不做自动清理。

## Not Doing
- **历史重复行自动合并** — 用户选择手动删除
- **把普通列表项改造成 `- [ ]` 任务** — 父行类型永远不动
- **失败/取消单独分组** — 统一进 `### 已完成`
- **每轮全库扫描** — 用承载文件登记代替

## 已确认的决策
- 同步任务行的绑定标记放**任务行尾**
- 父行不是 checkbox 任务时，不改造父行、不改父行状态；只更新委派子行
- 标题格式：**时间 + LLM 标题 + 📅 日期**
- failed / cancelled 的同步任务行写 `- [-]`
