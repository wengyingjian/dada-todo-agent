# 文件读写收口：统一到 dadatodolist 数据层

## Problem Statement

如何把散落在 `src/project/`（主要是 runtime.js，52 处 vault 调用）里的文件读写收口到 `src/core/api/tasks.js` 这一个数据层，让「谁改了文件、怎么改的、格式对不对」只有一个答案？

背景：agentdeck 的项目/任务功能已融合进 dadatodolist 插件。任务 CRUD 已走核心清单接口（`createChecklistTask` / `moveChecklistTask` / `updateTask` / `deleteTask`），但委派子行写入、任务级归档、项目文件创建仍在 runtime.js 直接读写 vault，与核心层并存两套解析（`splitFile` vs `splitDoc`）、两套 frontmatter 模板（`PROJECT_HEAD` vs `createChecklist`）。

## 接口出身（git 已鉴定）

- **dadatodolist 原生**：任务 CRUD、清单任务增/移、`readTasks`/`writeTasks`/`splitDoc`/`noteSelfWrite`（私有原语）、`taskFilePath`、清单定位与分组。
- **融合期新造**（伪装成核心接口）：`createChecklist` 的 `cwd` 参数、`setChecklistArchived` + `ARCHIVED_TAG`（均来自 `a9806ab` 会话侧边栏）、整个 `src/project/` 的 IO 层（`1e387b2`）。

## Recommended Direction

**能力下沉到核心 API，runtime.js 退化为纯调用方。**

1. **核心 API 补齐清单级通用能力**（底层复用 `readTasks`/`writeTasks`，写路径统一过 `noteSelfWrite()`——自写标记内置，覆盖 project 写操作，修掉「project 写文件后任务视图误判外部变更」的潜在 bug）：
   - `appendListLine(listKey, afterGuid, line)` — 清单内任意行后插入格式化行
   - `updateListLine(listKey, lineNo, patch)` — 按 id/占位 id 改行
   - `createChecklist` 扩展 opts：自定义目录、额外 frontmatter 字段（type/status），消灭 `PROJECT_HEAD` 双模板
2. **委派行抽象为「agent 会话关联」**：核心 API 只认通用概念——`{ agent: 't3', sessionId, state, title, ... }` 的行级 patch 与定位（按 sessionId / pendingId）。⚡/📅/🛫 前缀等 T3 具体格式留在 project 层作为 t3 的 serializer 实现。未来接入其他 agent 时只需新增一个 serializer，核心接口不动。
3. **任务级自动归档做成清单能力，设置开关**：新设置项（如 `autoArchive`，含开关与目标配置），归档逻辑从 runtime.js `archiveTasks` 下沉为核心导出，project 与普通清单共用。
4. **触发时机：插件启动时（app load）异步执行**，不阻塞主进程——挂到 vault 就绪后的 idle/低优先级回调，避免大库扫描卡住启动。
5. **行为差异攒批确认**：重构中发现的两套实现不一致（如 `splitFile` 不处理 `\r\n` 而 `splitDoc` 处理），列出现象/差异/影响/建议，攒一批找用户定夺，不中断流程。

## Key Assumptions to Validate

- [ ] 委派行格式能以「通用 agent 会话行 patch」表达而不漏 T3 语义进核心 —— 验证：先写核心接口签名与 t3 serializer 的映射，跑通一个委派回填单测
- [ ] 启动时自动归档在大库（几百份清单/项目文件）下不拖慢启动 —— 验证：用现有日记窗口扫描逻辑的量级估算 + 手动测一次全库扫描耗时
- [ ] runtime.js 现有 26 个 Node 单测在收口后不回归 —— 验证：纯挪代码阶段跑全量 `*.test.mjs`

## MVP Scope

纯重构第一刀（行为不变）：
1. 核心层导出 `appendListLine` / `updateListLine` / 扩展版 `createChecklist`
2. runtime.js 的 `appendDelegation` / `updateDelegation` / `ensureProjectFile` / `createProject` 改调核心接口，删除 `splitFile`/`joinFile`/`PROJECT_HEAD` 的对外使用
3. 全部写路径经 `noteSelfWrite()`，单测全绿后 `node scripts/install.mjs` 部署

第二刀（新能力）：自动归档下沉 + 设置开关 + 启动异步触发。

## Not Doing (and Why)

- **不收只读调用** —— `cachedRead`/`getAbstractFileByPath` 不会破坏格式，settings/i18n/devReload 等基础设施的零散读不值得动
- **不做「一个数据模型管所有文件」** —— project 文件的 cwd/status 语义不塞进核心任务模型，走「清单 + 额外 frontmatter」的松耦合
- **不一次性接入其他 agent** —— 只留 serializer 扩展点，不预先设计多 agent 注册机制
- **不动未提交的 feat/session-sidebar 改动** —— 本次重构在其之上或另开分支，先与用户确认基线

## Open Questions

- 自动归档的规则细节：只归「已完成」还是含过期（📅 早于今天）未完成？归档目标文件沿用 `task-<起>~<止>.md` 命名吗？
- 普通清单（非 project）的自动归档目标：各自目录下的 `# 归档` 文件，还是统一归档文件夹？
