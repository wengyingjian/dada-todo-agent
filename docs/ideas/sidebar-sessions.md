# 会话侧边栏（T3 Sessions Sidebar）

## Problem Statement
如何在不重做视觉的前提下，把 AgentDeck 右栏的会话卡片原样搬进 dada-todo-agent，并按「待处理 / 进行中 / 已完成」三段展示本机 T3 Code 会话？

## 已确认的决策
- 独立右侧栏 `ItemView`，ribbon + 命令打开，可与任务面板并存。
- 待处理 = 仅 `state === 'awaiting'`；进行中 = `running`；已完成 = `completed | failed | cancelled`。
- 组内按 `updatedAt` 倒序；已完成**先排序再取前 20 条**。
- 卡片 DOM、CSS、交互逐条搬运 AgentDeck，不改版式。
- 已完成里的 `failed / cancelled` **不单独标红计数**，只靠状态 chip 区分。
- 三段都为空时显示**一个统一空态**，不每组各留一行「无」。

## Recommended Direction
搬运，不重设计。

- 视觉：1:1 复制 AgentDeck 的 `.ad-sess` 卡片结构：左侧 agent 图标块（T3 蓝 `#6f8ab8` / soft `rgba(111,138,184,.13)`）、标题行（12px/650 标题 + 9px 状态 chip）、副行（T3 Code · 工作目录 · 提问数 · 相对时间）、右侧 `arrow-up-right` 按钮；hover 上浮 1px、边框染色、左侧 2px 强调条；running 卡片 `.is-live` 边框 + chip 呼吸动画；chip 里的 running 图标用 AgentDeck 的 3×3 `orbit` 点阵。
- 作用域：CSS 声明原样复制，根选择器由 `.ad-view` 换成 `.dada-sessions`，内部类名保持 `.ad-sess` / `.ad-state` / `.ad-lattice` 不变，避免与 AgentDeck 同装时互相污染。T3 图标复制 `assets/agents/t3code.png`。
- 数据：复用 `reverse-sync.js:queryThreads(dbPath, 0)` 全量查询。
- 分组：抽成纯函数 `src/project/session-groups.js`，配 `session-groups.test.mjs`。
- 刷新：`onOpen` 拉一次 + 视图头 `addAction('refresh-cw')` + 可见时 30–60s 轮询；`onClose` 清 timer。
- 打开：整卡点击 / 箭头 / 右键「打开会话」都走 `rt.t3DeepLink(threadId)` → `rt.openExternal`；deep link 为空时 `new Notice`。

## Key Assumptions to Validate
- [ ] T3 的 `awaiting` 足以代表「等你处理」；失败/取消放进已完成不会让用户漏看 —— 实跑一周确认。
- [ ] 侧边栏宽度 260–340px 时卡片副行不折行、不溢出 —— 在 Obsidian 右侧栏实测三种宽度。
- [ ] `queryThreads(..., 0)` 在会话量上千时仍在可接受耗时内 —— 首次拉取计时。
- [ ] 与 AgentDeck 同装时样式零串扰 —— 两插件同时启用后并排截图对比。

## MVP Scope
1. `SessionsView`（ItemView，type `dada-todo-agent-sessions-view`），Vue 挂载，注册 ribbon 图标与 `open-sessions` 命令，固定开在 `getRightLeaf(false)`。
2. `session-groups.js` + 测试：分组、倒序、已完成 20 条；状态 chip 映射；标题/目录/相对时间格式化。
3. `SessionList.vue`：三段 `ad-sechead` 标题（含条数）+ `ad-sessionlist` 卡片，完全照搬 `sessionCard` 的 DOM 层级与类名。
4. `sessions.css`：从 AgentDeck `styles.css` 复制 `.ad-sess`、`.ad-state`、`.ad-arrow`、`.ad-lattice`、`.ad-empty`、`.ad-sechead`、light-theme 阴影、`@keyframes ad-pulse/ad-ll-on`，只改根选择器；文件头注明来源与 Apache-2.0。
5. 状态 chip 映射：`awaiting→等你(is-wait)`、`running→在跑(is-live + orbit)`、`completed→完成(is-done)`、`failed→出错(is-error)`、`cancelled→已取消(is-quiet)`。
6. i18n：`待处理/进行中/已完成/在跑/等你/完成/出错/已取消/还没有 T3 会话` 进三份 locale。
7. 按 `AGENTS.md` 跑 `node scripts/install.mjs`，提醒重载插件。

## Not Doing（及原因）
- **token / 子代理 / side chat / 进度文本** —— `buildScanSql` 没有这些字段；不伪造占位。
- **「查看对话」弹窗按钮** —— 本插件没有对话弹窗；保留会点出空功能。
- **把卡片拖进笔记 / 把笔记项拖到卡片绑定** —— 超出「只要会话列表」。
- **搜索、按 agent 筛选、时间范围 chip** —— 加了反而离开「简单版本」。
- **改现有项目视图里的 `SessionPane`** —— 两处并存，先不动旧的。
- **failed / cancelled 单独标红计数** —— 用户确认不需要，chip 已能区分。

## Open Questions
无。

## 实现落点
- `src/project/session-groups.js`：分组、状态 chip、相对时间、工作区标签（纯函数）。
- `src/project/session-groups.test.mjs`：10 条测试，含「先排序再取 10 条」的回归断言。
- `src/project/sessions-view.js`：右侧栏 ItemView，卡片 DOM 对齐 AgentDeck `sessionCard`。
- `src/project/sessions.css`：从 AgentDeck `styles.css` 原样搬运，根选择器改为 `.dada-sessions`。
- `src/project/lattice.js` + `src/project/assets/t3code-icon.js`：running 点阵动画与内联 T3 图标。
- `src/core/main.js`：注册视图、ribbon 图标、`open-sessions` 命令，固定开在右侧栏。
- `src/core/i18n/locales/{zh-cn,zh-tw,en}.json`：`sessions.*` 文案。
