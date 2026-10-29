---
name: task-data-todo
description: 当用户要记待办、加任务、登记一件事、给事情排日期或时间，或说「记一下」「提醒我」「放进 todo」「加到清单」「帮我排个期」时调用；当需要查任务、改任务（改标题/描述/优先级/日期）、勾选完成或取消、移动清单/分组、删除、加子任务、建清单或分组时也调用。
---

# 任务读写：task CLI

用 `task` 命令读写任务。它内部就是插件真实的 `api/tasks.js`（esbuild + fs mock 打包），
格式与在插件里手动操作完全一致，不需要读插件源码，也不需要自己拼 Markdown。

## 前置

```bash
task --help                 # 命令不存在？见「未安装时」
```

- **未安装时**：在插件仓库目录下执行一次 `node tools/task.mjs install`（会装好 `task` 命令和本 skill），
  重开 shell 后可用。安装前也可以直接在插件仓库里用 `node tools/task.mjs <子命令>`。
- **库的定位**：自动用 Obsidian 当前打开的库；同时开着多个库时加 `--vault <库根路径>`
  （或环境变量 `TASK_VAULT`）。

## 怎么指一条任务

```bash
task ls --json                            # 全库未完成，拿 guid + summary
task show "交周报"                         # 关键词唯一匹配
task show "inbox#3#00-收件箱/InBox.md"     # 直接给 guid
```

- 关键词匹配标题或描述，**命中多条会报 `ambiguous_task` 并列出候选**，换更长关键词或直接用 guid。
- guid 是 `日期/清单#行号#文件`，**行号会漂移**（自己改、外部编辑都会），所以别缓存 guid 跨操作；
  修改类命令会带 summary/完成态校验，定位不上返回 `task_not_found` 而不是改错行。
- `--list` 可缩小范围（`--list 收件箱` / `--list 清单名`）；`move` 里的 `--list` 指**目标**。

## 命令

```bash
# 查询
task ls                                  # 未完成（默认先优先级、后截止日）
task ls --status done --limit 5          # 已完成；--limit 0 不限
task ls --date today | tomorrow | week | 2026-11-05
task ls --list "产品改进" --group P0      # 某清单的某个 ### 分组
task ls --tag 文档 --match 预算           # 行内 #标签 / 标题描述关键词
task ls --all-levels                     # 连子任务一起列
task show "补英文 README"                 # 详情：描述 / 归属 / 子任务

# 新建
task add "整理 Q4 预算表" --json                          # 收件箱、无日期
task add "交周报" --due tomorrow                          # 行内 📅，不建日记文件
task add "评审会" --due 2026-11-03 --time 14:30
task add "补英文 README" --list "产品改进" --group P0 --priority high --desc "翻译首页"

# 修改
task edit "体检预约" --due 2026-11-06 --priority high
task edit "体检预约" --desc "带医保卡"          # 改描述；--desc "" 清空
task edit "体检预约" --summary "体检（含复查）"  # 改标题
task edit "体检预约" --clear-due               # 清日期
task status "评审会" done                      # todo / done / cancelled 三态互转
task move "加暗色适配" --group P0               # 同文件换分组
task move "补英文 README" --list 收件箱          # 跨文件到「未分组」
task move "复盘会" --list 产品改进 --group P1 --keep-date   # 跨文件保留日期
task rm "临时任务" --yes                        # 删除（连同描述行与子任务）；无 --yes 不执行

# 子任务
task sub ls "交周报"
task sub add "交周报" "整理数据源" --desc "来自 BI 导出"

# 清单 / 分组
task lists                                     # 清单名 / key / 未完成数
task cl add "新清单"                            # 建清单（tags 自动写好）
task groups --list "新清单"                      # 列 ### 分组
task group add "新清单" "待排期"                  # 新建分组（落在文件末尾）
```

`--dry-run` 只打印会写什么，不落盘；`--json` 输出机器可读结果（成功/失败都有）。

## 语义要点

- **缺省落收件箱、未分组**（第一个 `###` 之前）。用户没指定清单就不自己挑。
- **清单 / 分组先查再写**：`lists` 拿真名，`groups` 拿分组标题；写错会报错并回传候选。
- **分组只有一层**（`###` 标题），没有子分组；`####` 不算分组。清单文件里的任务归到其上方最近的 `###`。
- **日期是行内标记**：`📅` 截止日、`🛫` 开始日。只给日期时不加 `--time`。
- **改期语义与插件一致**：把已有截止日的任务改到更晚日期，会把原截止日变成开始日（`🛫 原日 📅 新日`）；
  只想单纯换一天，就先 `--clear-due` 再 `--due`。日记任务改期 = 文件开始日不动、`📅` 改到新日。
- **跨文件移动**默认按拖拽语义清空日期，`--keep-date` 才把日记文件名里的日期物化成行内标记。
- **已完成记录**：`status done` 会写 `✅ 当天`；CLI 不支持「已完成 + 具体时间区间」那种记录（要插件侧改）。
- Obsidian 开着时约 500ms 自动刷新；关着也会写进 Markdown，下次打开可见。

## 输出契约

加 `--json` 时 stdout 恒为 JSON，退出码 0 / 1：

```json
{"ok":true,"cmd":"ls","total":3,"shown":3,"items":[
  {"guid":"inbox#3#00-收件箱/InBox.md","summary":"交周报","status":"todo",
   "due":"2026-10-30","time":"","priority":"🔺","tags":[],"group":"工作",
   "list":{"key":"inbox","name":"收件箱","type":"inbox"},"subtaskCount":1,"lineNo":3}
]}
```

失败时 `{"ok":false,"reason":"...","message":"..."}`，按 reason 自愈：

| reason | 怎么办 |
|---|---|
| `ambiguous_task` | 从返回的 `candidates` 里挑 guid，或换更精确关键词 |
| `task_not_found` | 任务可能被外部改动/已删：重新 `ls` 拿 guid 再操作 |
| `list_not_found` | 用返回的 `lists` 挑一个；或省略 `--list` 用收件箱 |
| `group_not_found` | 用返回的 `groups` 挑一个；或先 `task group add` |
| `ambiguous_vault` / `no_vault` | 用返回的 `vaults` 或用户给的库根加 `--vault` |
| `no_settings` | 该库没装/没启用插件，或 `--vault` 指错了库 |
| `confirm_required` | 删除要加 `--yes`；先跟用户确认 |
| `bad_date` / `bad_time` / `bad_priority` / `missing_summary` / `bad_status` | 按提示改参数 |

## 纪律

1. **先查后写**：涉及具体任务先 `ls`/`show` 拿 guid；涉及清单/分组先 `lists`/`groups`，别猜名字。
2. **删除要确认**：`rm` 必须带 `--yes`；用户没明确说要删就先问。
3. **改期说明白**：会变成 `🛫..📅` 区间时在回复里讲清楚，别只说「已改」。
4. **防重复**：重试前确认上次是否已写入（看 `--json` 的 guid，或 `grep` 目标文件）；同一件事不连发两次 `add`。
5. **一次一件事**：用户没要求时不要把整段纪要拆成一堆待办，先问一句。
6. **不改插件设置**：不要动 `<库>/.obsidian/plugins/dada-todo-list/data.json`；也不手写/重排 Markdown 代替命令。
