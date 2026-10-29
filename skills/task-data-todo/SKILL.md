---
name: task-data-todo
description: 当用户要记待办、加任务、登记一件事、给事情排日期或时间，或说「记一下」「提醒我」「放进 todo」「加到清单」「帮我排个期」时调用；当新任务的归属（清单 / 分组）不确定、需要先查已有清单或分组时也调用。
---

# 任务写入：dada CLI

用 `dada` 命令写任务。它内部就是插件真实的 `api/tasks.js`（esbuild + fs mock 打包），
写出来的格式与在插件里手动新建完全一致，不需要读插件源码，也不需要自己拼 Markdown。

## 前置

```bash
dada --help                 # 命令不存在？见「未安装时」
```

- **未安装时**：在插件仓库目录下执行一次 `node tools/dada.mjs install`（会装好 `dada` 命令和本 skill），
  重开 shell 后可用。安装前也可以直接在插件仓库里用 `node tools/dada.mjs <子命令>`。
- **库的定位**：自动用 Obsidian 当前打开的库；同时开着多个库时加 `--vault <库根路径>`
  （或环境变量 `DADA_VAULT`）。

## 命令

```bash
# 收件箱（无日期、未分组）—— 拿不准时的默认动作
dada add "整理 Q4 预算表" --json

# 截止日期（行内 📅，不会新建日记文件）
dada add "交周报" --due tomorrow --json
dada add "交周报" --due 2026-11-03 --json
dada add "评审会" --due 2026-11-03 --time 14:30 --json

# 放进清单的某个分组（先查名字）
dada lists --json                       # 清单名 / key / 未完成数
dada groups --list "产品改进"            # 该清单的 ### 分组
dada add "补英文 README" --list "产品改进" --group "P0" --priority high --json

# 只演示，不落盘
dada add "演示" --dry-run
```

选项：`--due <YYYY-MM-DD|today|tomorrow|+Nd>`、`--time HH:MM`、`--list <清单名>`、
`--group <分组标题>`、`--priority <high|medium|low>`、`--desc <说明>`、
`--vault <路径>`、`--dry-run`、`--json`。

## 语义

- **缺省落收件箱、未分组**（第一个 `###` 之前）。用户没指定清单就不自己挑。
- **清单 / 分组先查再写**：`lists` 拿真名，`groups` 拿分组标题；写错会直接报错并回传候选。
- **日期是行内标记** `📅 YYYY-MM-DD`；只给日期时不要加 `--time`，加了才会出现时间前缀。
- **描述**用 `--desc`，落成任务下方的缩进行；一两句即可。
- 任务的「归属」= 文件角色（收件箱 / 清单）+ `###` 分组，没有独立字段。
- Obsidian 开着时约 500ms 自动刷新；关着也会写进 Markdown，下次打开可见。

## 输出契约

加 `--json` 时 stdout 恒为 JSON，退出码 0 / 1：

```json
{"ok":true,"cmd":"add","path":"InBox.md","list":"收件箱","group":"（未分组）",
 "guid":"inbox#5","line":"- [ ] 整理 Q4 预算表 📅 2026-11-03","summary":"整理 Q4 预算表","dryRun":false}
```

失败时 `{"ok":false,"reason":"...","message":"..."}`，按 reason 自愈：

| reason | 怎么办 |
|---|---|
| `list_not_found` | 用返回的 `lists` 挑一个；或省略 `--list` 落收件箱 |
| `group_not_found` | 用返回的 `groups` 挑一个；或省略 `--group` 落未分组 |
| `ambiguous_vault` / `no_vault` | 用返回的 `vaults` 或用户给的库根加 `--vault` |
| `no_settings` | 该库没装/没启用插件，或 `--vault` 指错了库 |
| `bad_date` / `bad_time` / `bad_priority` / `missing_summary` | 按提示改参数 |

## 纪律

1. **先查后写**：涉及清单 / 分组时先 `lists` / `groups`，别猜名字。
2. **防重复**：重试前确认上次是否已写入（看 JSON 的 `guid`，或 `grep` 目标文件）；同一件事不连发两次 `add`。
3. **一次一件事**：用户没要求时不要把整段纪要拆成一堆待办，先问一句。
4. **只做创建**：搬移、勾选、删除、改期不在本命令能力内，需要时告知用户，不去改文件。
5. **不改插件设置**：不要动 `<库>/.obsidian/plugins/dada-todo-list/data.json`。
