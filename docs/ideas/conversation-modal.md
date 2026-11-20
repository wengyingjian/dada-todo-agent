# 会话对话弹窗（T3 Conversation Modal）

## Problem Statement
如何在不离开 Obsidian 的前提下，把 T3 会话的「看消息、回消息、答提问」搬进现有侧边栏卡片，并且打开就停在最新一条？

## 已确认的决策
- 弹窗外壳 1:1 照 AgentDeck 的 `ConversationModal`，只把只读正文换成可写会话。
- 卡片入口同 AgentDeck：整卡点击和右侧 `arrow-up-right` **仍然跳 T3 Code**；新增一个 `messages-square`（对话）按钮打开弹窗，卡片加 `.has-conversation` 变成四列网格。
- 提问回答**完整照抄 T3 交互**：选项按钮（带 description）、`multiSelect`；每个问题都带自定义输入框（实测 T3 不下发 `allowCustomAnswer`，桌面端的「Other」是隐式的）；未声明 `required` 时按必答处理。
- 发送只做「发消息」：忙碌时由 T3 自动排队，不打断、不做队列管理。
- 键盘：`↵` 直接发送，`⌘/Ctrl↵` 换行；输入法组字时的 `↵` 留给输入法。
- 打开即最新：`t3_thread_read` 必须显式传 `beforePosition: 999999999` 才返回最后一页（不传会从最早一条开始）；取最近 50 条，页内按 `position` 升序，天然就是「拉到底」。
- 不做工具时间线、附件、归档到笔记、审批（permission）应答。

## Recommended Direction
读和提问走 T3 的本机 MCP（`http://127.0.0.1:3773/mcp`），**发送走 CLI**。

为什么读/提问用 MCP：
- `t3_thread_read` + `beforePosition` 取最后一页，`earlierPosition` 翻旧页，天然满足「默认拉到底」。
- 单条内容默认只返回 500 字，必须显式传 `maxCharsPerItem: 20000`；仍超长的按返回的 `itemId` + `nextTextOffset` 续读拼接，保证 AI 回复完整。
- `t3_pending_request` 是唯一能 `list / read / respond` 用户提问的通道，CLI 没有对应命令。

为什么发送改用 CLI：MCP 客户端能拿到的权限上限是 `approval-required`（token 里的 `rtc` claim），而本机会话默认是 `full-access`；往全权限会话里 `t3_thread_send` / `respond` 会被 T3 拒绝（`runtime_mode_escalation_denied`）。
`t3 thread send <id> - --json` 自己在内部签发一个 full-access MCP 会话，能写全权限会话，消息从 stdin 传入（实测 0.28s），忙碌时同样自动排队。

全权限会话里的「代答」需要额外授权：MCP 会话的权限上限由 token 里的 `rtc` claim 决定，CLI 签的 token 最高只到 `approval-required`。插件走 T3 自己的 OAuth（授权码 + PKCE），在 T3 授权页选 **Full access** 后换一个 30 天的 `full-access` token；没有授权时，提问卡里给「授权后直接回答」与「在 T3 Code 打开」两个出口。

授权实现（`src/project/t3-auth.js` + `auth-modal.js`）：
1. 本地起 `127.0.0.1:随机端口/callback` 回环服务（`node:http`）。
2. `POST {origin}/oauth/mcp/register` 动态注册客户端，回调地址就是回环地址。
3. 用系统浏览器打开 `{origin}/oauth/mcp/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&resource={origin}/mcp&state=…`。
4. 浏览器里选 Full access 并确认；浏览器没有 T3 登录态时，页面要求粘贴「配对码」——插件用 `t3 auth pairing create --ttl 10m` 生成并显示，用完即撤销。
5. 回跳拿到 `code`，`POST /oauth/mcp/token`（form-urlencoded，带 `code_verifier`）换 token；token 载荷里 `rtc: "full-access"`，有效期 30 天（实测 `expires_in: 2592000`）。
6. token 存 `settings.t3Auth`，`getT3Client` 优先用它；被 401 拒绝时自动清掉并退回 CLI 临时 token。

实测：完整流程（注册 → 配对码 → decision → 回环回调 → 换 token → MCP 调用 → 撤销会话）已在真实 T3 上跑通；换到的 token 成功代答了全权限会话的提问。

鉴权：首次打开弹窗时执行
`t3 auth session issue --subject mcp-client --scope orchestration:read --scope orchestration:operate --ttl 12h --token-only --label obsidian-dada-todo-agent`，
token 与 `mcp-session-id` 只放内存，不落盘、不进设置。遇到 401 就静默重签一次再重试。`t3` 可执行文件按「设置项 → `~/.local/bin/t3` → `~/.t3/bin/t3` → `/opt/homebrew/bin/t3` → `/usr/local/bin/t3`」顺序探测。

分层：
- `t3-client.js`：MCP 传输（initialize / tools.call / 401 重签 / 错误归一化）。
- `conversation.js`：纯函数（消息反转与裁剪、`buildAnswers`、`shouldStickToBottom`、状态文案），全部可单测。
- `conversation-modal.js`：Obsidian `Modal`，只负责 DOM 与事件。

弹窗结构（照 AgentDeck，新增 composer 与提问卡片）：
- 头部：T3 图标 + 标题 + 工作区/短 id +「在 T3 Code 打开」「刷新」。
- 正文：`ad-conversation__messages`，用户消息与助手消息两种卡片，Markdown 用 `MarkdownRenderer.render`。
- 提问区：放在正文末尾、输入框上方；一个待答请求一张卡，卡片里按问题逐个排（选项按钮可选中、多选可多亮、每题都有自定义输入框），必答未答时提交按钮禁用。
- 输入框：多行 textarea，`↵` 发送、`⌘↵` 换行；发送后立刻乐观插入一条用户消息并滚到底。
- 轮询：弹窗打开且可见时每 1.5s 读一次最新一页；位置没变就不重绘；用户上翻后不强制跟随。

## Key Assumptions to Validate
- [x] Obsidian 的 `requestUrl` 能直连 `127.0.0.1:3773/mcp`（无 CORS / 代理干扰）—— 2026-11-20 的 UI E2E 已跑通。
- [x] 插件子进程能执行 `t3 auth session issue`（Electron 的 PATH 常缺 `~/.local/bin`）—— `~/.local/bin/t3` 探测命中。
- [x] `answers` 以 **question id** 为键，自由输入传字符串 —— 协议层 E2E 实测落库与提交值一致；多选按数组提交（单测覆盖，真实场景以 T3 的 `multiSelect` 为准）。
- [ ] 12h token 过期后静默重签无感；T3 重启导致 session 失效时能自愈 —— 已实现 401 重签 + 网络失败重试，长跑观察。
- [x] 680px 宽度下提问卡片与输入框不拥挤 —— UI E2E 渲染 2 个问题、5 个选项、2 个自定义输入框无溢出。
- [x] 全权限会话的写入边界 —— MCP 发送/应答报 `runtime_mode_escalation_denied`；`t3 thread send` 可写（实测），MCP `respond` 不可答，需回 T3 桌面端。

## MVP Scope
1. `t3-client.js`：从 `server-runtime.json` 取 origin，签 token，`initialize` 拿 `mcp-session-id`，`tools/call` 封装，401 重签一次。
2. `conversation.js` + 测试：`normalizeMessages`（按 position 归一到时间正序、去重、过滤空文本、合并翻页结果）、`buildAnswers`（单选/多选/自定义/required）、`shouldStickToBottom`（距底 80px 内）、`isActiveStatus`（是否显示「正在回复…」）。
3. `conversation-modal.js`：AgentDeck 弹窗样式 + composer + 提问卡片。
4. 卡片新增 `messages-square` 按钮与 `.has-conversation` 四列网格；整卡/箭头行为不变。
5. `conversation.css`：从 AgentDeck `styles.css` 复制 `.ad-modal` / `.ad-modalhead` / `.ad-btn` / `.ad-conversation` 及 tool 之外的段落，根选择器改为 `.dada-conversation`；新增 composer / 提问卡片样式沿用同一套 token。
6. i18n：三份 locale 增加 `conversation.*`（发送、发送中、你、助手、等待回答、必填、自定义回答、读取失败、T3 未运行等）。
7. 测试钩子：卡片加 `data-thread-id`，对话按钮加 `data-action="conversation"`，弹窗根节点 `.dada-conversation`，提问卡片 `.dada-question`（供 E2E 定位，与 AgentDeck 的 `data-sid` 同思路）。
8. E2E：`scripts/e2e-conversation.mjs`（协议层，`--live` 手动跑）+ `scripts/e2e-modal-cdp.mjs`（UI 层，需 Obsidian 以 9223 端口启动）。
9. `node scripts/install.mjs` 部署，提醒在 Obsidian `Cmd+R` 重载。

## Not Doing（及原因）
- **工具时间线 / 附件 / 归档到笔记 / side chat** —— 与「发消息 + 答提问」无关，先不加。
- **打断（interrupt）与队列管理（queue edit/cancel）** —— 用户明确只要「只发消息，忙碌自动排队」。
- **permission 审批弹窗** —— MCP 明确说 `t3_pending_request` 不能批准权限请求；这类请求继续去 T3 处理。
- **新建会话** —— 侧边栏定位是「看已有会话」，新建仍在 T3。
- **自动拉起 T3 服务** —— 越权且容易起多份实例；未运行时弹窗内提示并给「打开 T3 Code」。
- **SSE / WebSocket 流式** —— 1.5s 轮询已够「近实时」，实现面小得多。

## E2E 测试

分两层：协议层在终端可重复跑；UI 层需要 Obsidian 以远程调试端口启动。

### 夹具
- 测试会话建在本仓库项目下：协议层复用 `[E2E] 对话弹窗`，UI 层每次新建 `[E2E] 弹窗 UI <epoch>`（保证侧边栏里有独立卡片）。
- 每条断言都以 nonce `e2e-<epoch>-<rand>` 为锚点，避免历史消息造成假阳性。
- 跑完 `t3_thread_organize archive` 归档；若仍在跑或仍在等回答则跳过（归档会掐断 provider 流）。

### E2E-1 点击打开弹窗（UI）
前置：Obsidian 以 `--remote-debugging-port=9223` 启动，插件已加载，会话侧栏已打开。
步骤：CDP `Runtime.evaluate` →
1. `document.querySelector('[data-thread-id="<id>"] [data-action="conversation"]').click()`
2. 轮询等待 `.modal-container .dada-conversation`（≤2s）
断言：弹窗存在；标题等于会话标题；输入框可用（T3 运行中）。
自动化：`scripts/e2e-modal-cdp.mjs`。

### E2E-2 打开即最新 + 自动滚到底（UI + MCP）
步骤：
1. 先通过 MCP 向测试会话发一条带 nonce 的消息，并等到一条 assistant 回复（确保有新的末条）。
2. 点开弹窗（同 E2E-1）。
3. 取 DOM 最后一条 `.ad-conversation__message.is-assistant` 的文本，与 MCP `t3_thread_read` 的最新 assistant 文本比对。
断言：
- 末条文本互相包含；
- `scrollHeight - scrollTop - clientHeight < 8`；
- 反向回归：若实现退化成「从最早一条开始」，`scrollTop === 0` 且 `scrollHeight > 2 × clientHeight`，该用例必须失败。

### E2E-3 发消息 → T3 收到并响应（UI → MCP）
步骤：在弹窗输入 `e2e-send-<nonce>`，按 `↵` 发送；另断言 `⌘↵` 不被拦截（留给换行）。
断言：
- 2s 内 DOM 出现乐观用户气泡，文本含 nonce；
- 30s 内 MCP `t3_thread_read` 出现 `type: user_message` 且 text 含 nonce；
- 90s 内出现 nonce 之后的 assistant 消息，且弹窗在 1.5s 轮询内自动更新到该条。
失败态：T3 未运行时输入框禁用并显示「T3 未运行」，不产生误发。

### 造数：让 T3 主动提问
向测试会话发固定 prompt（只做这一件事）：

> 只做一件事：调用 AskUserQuestion 提出两个问题。第一题 header「E2E 选择」、question「选一个颜色」、options 红/蓝/绿，单选；第二题 header「E2E 自定义」、question「用一句话描述这个测试」。然后停下等待回答。

（T3 的 AskUserQuestion 不暴露 `allowCustomAnswer` / `required`，桌面端「Other」和必答都是隐式行为，所以造数 prompt 里不再要求这两个字段。）

随后轮询 MCP `t3_pending_request list`，直到非空（≤60s）。

### E2E-4 提问展示 / 选择 / 自定义 / 提交（MCP 造数 + UI）
步骤：
1. `list` 拿到 requestId，`read` 断言 `questions.length === 2`、每题都有 `options`、第一题 `options.length >= 3`。
2. UI 断言：`.dada-question__text` 数量为 2（一个请求一张卡，卡片里按问题逐个排）；第一题渲染 ≥3 个选项按钮；每题都有 `.dada-question__custom`；未答时提交按钮 disabled。
3. 点第一题「红」；第二题输入 `e2e-custom-<nonce>`；提交按钮变为可用。
4. 点提交。
断言：
- 20s 内 `t3_pending_request list` 变空；
- 90s 内会话继续产出 assistant 消息；
- 数据库 `orchestration_v2_projection_runtime_requests.payload_json.answers` 落了两条答案（键为 question id，值为选项 label / 自由文本）——用真实值把 `buildAnswers` 的格式钉进单测。

### 运行方式
- 协议层：`node scripts/e2e-conversation.mjs --live`。会消耗模型额度，1–3 分钟，发版前手动跑。
- UI 层：先退出 Obsidian，再 `open -a Obsidian --args --remote-debugging-port=9223`，然后 `node scripts/e2e-modal-cdp.mjs --live`（加 `--keep` 保留弹窗）。脚本只读 DOM + 模拟点击，不改 vault 内容。
- 当前 9222 端口属于 WorkBuddy，不要复用；Obsidian 固定用 9223。

## 实测记录（2026-11-20）
- 协议层 `e2e-conversation.mjs --live`：通过。最后一页读取、发送被 T3 接收并回复、提问 read/respond、答案落库（`{"选一个颜色":"红","用一句话描述这个测试":"e2e-custom-…"}`）全部验证。
- UI 层 `e2e-modal-cdp.mjs --live`：通过。点击对话按钮开弹窗、末条与 T3 最新回复一致且 `gap <= 4px`、UI 发送被 T3 收到并回显新回复、2 个问题 + 5 个选项 + 2 个自定义输入框渲染正常、选择 + 自定义提交后卡片消失。
- 修掉的两个真实问题：T3 不下发 `allowCustomAnswer` / `required`（改为每题都给自定义输入、默认必答）；发送偶发网络失败（加 `clientRequestId` 幂等重试与串行 initialize）。
- 真实全权限会话上报 `runtime_mode_escalation_denied`：确认 MCP 权限上限只能到 approval-required（`t3 auth session issue` 没有 access 参数，只有 CLI 内部的 `withThreadTools` 能签发 full-access 会话）。发送改走 `t3 thread send`（stdin，实测 0.28s，全权限会话可写）；应答仍无法代答，改为卡片内提示 + 打开 T3。
- 键盘改为 `↵` 发送 / `⌘↵` 换行（输入法组字不触发发送）；底部说明压成一行，去掉排队文案。
- 发现 `t3_thread_read` 默认把每条消息截到 500 字（实测 1694 字的长回复只剩前 500 字）。现改为请求 `maxCharsPerItem: 20000`，并实现 `itemId` + `textOffset` 续读拼接；同一会话实测最长回复完整取到 1694 字。

## Open Questions
无。`answers` 的格式已由实测确认：键是 question id（T3 里通常等于问题文本），值是选项 label / 自由文本，多选为数组。

## 实现落点
- `src/project/t3-client.js`（新增）：MCP 客户端与 token 生命周期。
- `src/project/conversation.js`（新增）：消息归一化、回答载荷、滚动判定（纯函数）。
- `src/project/conversation.test.mjs`（新增）：上述纯函数单测。
- `src/project/conversation-modal.js`（新增）：Obsidian `Modal`。
- `src/project/t3-auth.js` + `t3-auth.test.mjs`（新增）：MCP OAuth（PKCE、回环回调、注册/换 token、撤销）。
- `src/project/auth-modal.js`（新增）：授权弹窗（显示配对码、打开授权页、状态与撤销）。
- `src/project/conversation.css`（新增）：AgentDeck 弹窗样式搬运 + composer/提问卡片。
- `src/project/sessions-view.js`（修改）：卡片加对话按钮，打开弹窗。
- `src/core/i18n/locales/{zh-cn,zh-tw,en}.json`（修改）：`conversation.*`。
- `scripts/e2e-conversation.mjs`（新增）：协议层 E2E（读最新 / 发送并等回复 / 提问造数与应答）。
- `scripts/e2e-modal-cdp.mjs`（新增）：UI 层 E2E（点开弹窗 / 末条与滚动 / 发送 / 选项与自定义回答提交）。
