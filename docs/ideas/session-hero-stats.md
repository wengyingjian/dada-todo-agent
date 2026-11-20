# 会话侧边栏顶部统计区（照抄 obsidian-agent-deck）

## Problem Statement
如何在 dada-todo-agent 的会话侧边栏顶部，照抄 obsidian-agent-deck 的「搜索栏 + 图标按钮 + 今日统计摘要 + 项目时间轴」，让本机 T3 会话一眼可见「今天和 agent 协作了多久、做了哪些项目」，并且时间轴可点击筛选会话卡片。

## 已确认的决策
- **统计窗口 = 今天**（本地 0 点起）：协作时长、会话数、时间轴全部只算今天。
- **顶部栏**：左搜索框（占位「搜会话：标题、项目…」，实时过滤下方卡片，空格分词 AND，处理输入法组字，Esc 清空）+ 右侧三个 28×28 图标按钮：任务面板（**toggle**：未开→打开聚焦，已开→关闭）、刷新 `refresh-cw`、设置 `settings-2`（打开本插件设置页）。
- **任务面板按钮图标**：沿用 AgentDeck 的 `chart-no-axes-combined`，照抄外观。
- **摘要数字**：两项网格——协作时长（`fmtMin`：`3h 20m` 风格，区间并集口径，带「较 7 日均 ±x%」小注）+ 会话数（小注「{n} 次提问」）。样式照抄 `.ad-hero` 卡（18px 圆角、径向渐变、右上光晕）与 `.ad-num__v/l/sub`。
- **项目时间轴（合并版，替代 AgentDeck 的 dayTimeline+topProjects 两条）**：一行 = 项目名（左，超长省略号，title 显示全名）+ 该项目今天的活动段 lane（段=区间并集，颜色统一 accent，hover 显示时段）+ 右侧时长（`fmtMin`）。多行按时长倒序；整块底部共用刻度（起点时刻 / 中点 / 「现在」）+「现在」竖线；窗口 = 今天首段活动所在整点 → 现在，最少 3 小时。
- **点击筛选**：点击某项目行 → 下方会话卡片只显示该项目（按 cwd 匹配）的会话，行加选中态；再点同一行取消，恢复全部。与搜索框叠加（搜索在筛选结果内搜）。

## Recommended Direction
纯搬运 + 一个合并改动。数据层新增纯函数 `computeTodayStats(threads, now, dayStart)`：从 `queryThreads`（floor 改为今天 0 点，另跑一次 7 天窗口算 vsWeek）聚合 `wall`（所有 `[firstMsgAt, lastMsgAt]` 排序去重叠求和）、`sessions`、`prompts`（`promptCount` 求和）、`proj[cwd] = { min, segs[] }`。UI 层改 `sessions-view.js` render()：头部 `.dada-head`、hero 卡、合并版时间轴（`ad-day__lane` 样式复用，项目名/时长借用 `ad-proj__name/__min`），全部点击态类名新起 `.is-selected`。CSS 从 obsidian-agent-deck `styles.css` 对应段落复制，根选择器换 `.dada-sessions`。i18n 三份 locale 补 key。

## Key Assumptions to Validate
- [ ] `firstMsgAt/lastMsgAt` 粒度够用：没有逐事件时间戳，一段挂机很久的会话会把时长算大——先用会话区间并集，观感不对再收紧（比如限最近 5 分钟消息粒度，需加一条消息表查询）。
- [ ] 7 天窗口查询对 statev2.sqlite 的开销可接受（现扫描已是同类查询，量级一致）。
- [ ] Obsidian 里「打开任务面板」能拿到 leaf 并 detach（复用插件现有任务面板 view type）。

## MVP Scope
1. `session-stats.js` + 测试：`computeTodayStats`、区间并集 `unionSegs`、`fmtMin`、`vsWeek`、项目名截断。
2. `sessions-view.js`：顶部栏（搜索 + 3 按钮）+ hero + 合并时间轴 + 项目筛选状态；`refresh` 后保留筛选。
3. `sessions.css`：复制 hero/head/lane 样式段，根选择器替换，新增选中态与省略号规则。
4. i18n：`sessions.search*`、`sessions.stats.*`、`sessions.timeline.*`。
5. `node scripts/install.mjs` 部署 + Obsidian 重载提醒；UI 层 E2E 挂到现有 `e2e-modal-cdp.mjs` 思路。

## Not Doing（及原因）
- **产出 token 卡片** —— 只点名「协作时长、会话数」，且 T3 sqlite 拿不到 token 数据。
- **逐事件级活动段（≤5 分钟合并）** —— 现有查询没有逐事件时间戳，先用会话区间并集。
- **点击轴跳转/打开会话之外的新交互** —— 只做筛选，不加悬停浮层编辑等。
- **dashboard 式独立回顾页** —— 替换成了 toggle 任务面板。

## Open Questions
- （已定）任务面板按钮图标：沿用 AgentDeck 的 `chart-no-axes-combined`。

## 参考来源
- AgentDeck 真身：`/Users/wengyingjian/Documents/ObsidianWork/git-projects/obsidian-agent-deck`
  - 顶部栏 `src/view.js:140-172`；hero `view.js:202-213`；时间轴 `view.js:545-590`（dayTimeline + topProjects）
  - CSS `styles.css`：`.ad-head` 1010-1030、`.ad-hero` 1031-1097、`.ad-day` 1098-1136、`.ad-projs` 1137-1174
  - 数据聚合 `src/readers.js:1180-1272`（summary：segs/wall/by/proj）
