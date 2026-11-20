# Dada 任务中心 (Dada Todo Agent)

> A task hub for Obsidian built on plain Markdown checkboxes — manage your own tasks, **delegate work to [T3 Code](https://github.com/t3code-ai/t3-code) agents, and let session progress sync back into your notes**. No account, no cloud, no lock-in.

[简体中文](./README_zh.md) · English

---

**Dada Todo Agent** started as a fork of [Dada Todo List](https://github.com/wengyingjian/dada-todo-agent) and has grown into a full task center: everything from the original task manager (seven views, inline syntax, drag-to-reschedule …) plus a deep integration with **T3 Code** — delegate any checklist item to an AI agent, watch its session state sync back onto the task line, chat with running sessions from a sidebar, and import historical sessions into your notes.

### Who is it for?

- **You use Obsidian for tasks and T3 Code for agent work** — this plugin is the bridge: your checklist is the control room, agent sessions become checkable task lines with live status, and everything stays plain Markdown.
- **You just want a great task manager** — the T3 integration is entirely optional. Without it configured, this is a polished, self-contained task & checklist manager powered by plain Markdown checkboxes.

### Quick start

1. Enable the core **Daily notes** plugin (Settings → Core plugins) so dated tasks land in your daily notes;
2. Click the ✅ icon in the left ribbon (or run the command "Open Dada Todo List") to open the panel;
3. Write a line `- [ ] Buy milk #life` in any daily note — it shows up in the panel instantly.

### Highlights — task manager

- **Seven views** — day timeline, seven-day week timeline with lane layout, month calendar (with Chinese lunar dates, solar terms, festivals and statutory holidays), rolling agenda, a 2×2 priority quadrants matrix, grouped checklists, and a filterable list of everything
- **Inline syntax** — write `#tags` and `[links](url)` right in the task title; they render as clickable pills and hyperlinks
- **Flexible time** — single time, time ranges (start – end), all-day, or **cross-date** (start date – end date, shown across multiple days), switchable per task
- **Subtasks** — indented lines become nested subtasks of any depth
- **Task priority** — high / medium / low (🔺 / 🔼 / 🔽), read & write compatible with the obsidian-tasks plugin
- **Tag colors** — assign a color to any tag in settings: task blocks, agenda cards and tag pills all pick it up
- **Drag to reschedule** — drag tasks between days, or drag timeline handles to fine-tune start / end times
- **Option/Alt + drag to copy** — hold Option (Mac) / Alt or Ctrl (Windows·Linux) while dragging to drop a copy at the target
- **Due-time reminders** — system notification or in-app notice with a short chime; ⚠️ Desktop only
- **Auto archive** — completed blocks can be auto-moved to an archive checklist after a configurable idle period, with 24h protection for fresh tasks

### 🤖 Highlights — T3 Code agent hub

All of the below is optional; it activates when a T3 Code installation is available.

- **One-click delegation** — press the ✈ button on any task (editor, checklist view, or the task modal) to delegate it to a T3 Code agent. A sub-line appears under the task showing what was delegated, then live state: running → awaiting → completed / failed
- **Projects = checklist files** — a project is a checklist file with a `cwd` in its frontmatter. T3 sessions started in that directory sync into the project's checklist automatically, grouped by state (### In progress / ### Pending / ### Completed)
- **Reverse sync** — the plugin watches T3 Code's SQLite database and syncs session state back onto task lines: status checkboxes update in place, finished sessions get a one-line summary, and new (unbound) sessions are written into the owning project's file or your daily note. Silent-period + prompt-count thresholds keep re-summarization cheap
- **LLM session summaries** — configure an OpenAI-compatible endpoint and completed delegations are rewritten as a short title + numbered takeaway points; without it, a truncated transcript excerpt is used
- **Sessions sidebar** — a dedicated right sidebar (search, today's collaboration stats, per-project activity timeline) listing every T3 session: pending / running / completed, click to filter. Refreshes near-instantly via SQLite WAL watching
- **Conversation modal** — open any session from the sidebar or a task line: read messages, send replies (⏎ to send), and answer agent questions (option picker + custom input) right from Obsidian. Full-access sessions are supported via the built-in OAuth flow
- **Checklist management extras** — create checklists from the UI (name + optional cwd, with a system folder picker), archive a checklist via right-click, and move tasks between checklists while keeping their dates

### Installation

**Manual**: download `main.js`, `styles.css` and `manifest.json` into
`your-vault/.obsidian/plugins/dada-todo-agent/`, then enable the plugin in Settings → Community plugins.

**BRAT**: install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add this repository.

### Where your data lives

| Data | Location |
|---|---|
| Dated tasks | Your **core Daily notes** folder — tasks are checkboxes inside each daily note |
| Dateless tasks (inbox) | `DadaTodoList.md` in the vault root by default; configurable, created automatically |
| Checklists & projects | Any note whose frontmatter `tags` include `todoList` (configurable); projects additionally carry a `cwd` field |
| Plugin settings | `data.json` in the plugin folder (including the optional T3 OAuth token) |

Everything is plain Markdown. Uninstalling the plugin changes nothing — your notes stay as they are. T3 Code's own data (sessions, threads) lives in T3 Code's storage; the plugin only ever **reads** that database and writes into your notes.

### Writing checklists

Any note whose frontmatter `tags` include the checklist tag (default `todoList`) becomes a checklist. Use **`###` third-level headings as group separators**:

```markdown
---
tags:
  - todoList
---

### Work
- [ ] Finish the quarterly report #work
    - [ ] Collect data
- [x] Reply to client emails  ⚡ t3:abc123#2

### Life
- [ ] Book a dentist appointment
```

- **`###` heading = group name**, freely added/renamed/removed; tasks before any heading fall into "Ungrouped"
- **Indented checkboxes are subtasks**, nesting to any depth
- **The `⚡ t3:<id>` mark at line end** binds that line to a T3 Code session — the plugin maintains it automatically when delegating or reverse-syncing; don't edit it by hand
- Drag tasks between groups, add per-group with the + button, archive a checklist via right-click (adds the `archived` tag)

### Settings

| Option | Description |
|---|---|
| Open location | Left sidebar / main workspace tab / right sidebar |
| Theme color scheme | 7 schemes for task blocks; color derived from the task title |
| Show lunar calendar & holidays | Lunar dates, solar terms and holiday badges; turn off for Gregorian only |
| Journal folder / load window | Where dated tasks live; limit how many days are loaded for large vaults |
| Inbox file | Where dateless tasks are stored |
| Checklist folder / checklist tag(s) | Where new checklists are created; which notes count as checklists |
| Week starts on / Timeline range / View menu | Display preferences for views |
| Completion date marker | Append ✅ date when checking off |
| Due-time reminders | Notification channel, all-day reminder time |
| **T3 binary path** | Where the `t3` CLI lives (auto-detected if empty) |
| **T3 provider / model** | Model override for delegated sessions |
| **Project default cwd** | Prefill for the delegation dialog |
| **Reverse sync** | Sync T3 session state back into your notes (on by default) |
| **Reverse sync min minutes** | A session must be at least this old before it's written into a file (default 3) |
| **Summary LLM** | OpenAI-compatible base URL / model / API key for session summaries; empty = truncated excerpt |
| **Summary prompt template** | Custom system prompt for the summarizer (`{{delegation}}` / `{{transcript}}` placeholders) |
| **Summary silent minutes** | A finished session must be silent this long before re-summarizing (default 30) |

### Interface

- **Trilingual** — follows Obsidian's interface language (English / 简体中文 / 繁體中文)
- **Theme aware** — all colors use Obsidian's native variables, adapting to light / dark and custom accents

### Language

The interface follows Obsidian's language setting (English / 简体中文 / 繁體中文). Restart Obsidian after switching.

---

## 🛠 Development

```bash
npm install
npm run build     # production build (outputs: dada-todo-agent/main.js, styles.css, manifest.json)
npm run dev       # dev mode: rebuild automatically on src/ changes
node --test src/project/reverse-sync.test.mjs   # run a unit test file (node:test)
node scripts/install.mjs                        # build + copy into your dev vault's plugin folder
```

Local debugging: symlink your test vault's plugin folder to the build output (folder name must match the plugin id `dada-todo-agent`):

```bash
ln -s "$(pwd)/dada-todo-agent" "your-vault/.obsidian/plugins/dada-todo-agent"
```

> After any code change, run `node scripts/install.mjs` (a plain `npm run build` does not update the copy in your vault), then reload the plugin in Obsidian.

## 📄 License

MIT
