// 给 CLI 用的「Obsidian 最小运行时」：把 app.vault / metadataCache 落到真实文件系统上，
// 让插件自己的 api/tasks.js 能在 Node 里原样运行（语义不打折、格式不漂移）。
//
// 只实现 CLI 走到的部分：收件箱 / 清单的读写、frontmatter tags 扫描。
// 日记相关的插件内部配置（Daily Notes / Periodic Notes）一律返回空，由 API 自己兜底。
// --dry-run 时所有写操作进内存 overlay（后续读能看见），不碰磁盘。
import fs from 'node:fs';
import path from 'node:path';

let dryRun = false;
let ops = [];
let overlay = new Map(); // relPath -> content（dry-run 的"已写但未落盘"状态）

export function setDryRun(v) {
  dryRun = !!v;
  overlay = new Map();
  if (!dryRun) ops = [];
}

/** 取出本次运行产生的写操作（{ op: 'create'|'modify'|'createFolder', path, content? }），并清空记录 */
export function takeOps() { const out = ops; ops = []; return out; }

const ROOT = () => process.env.TASK_VAULT;
const abs = (p) => path.join(ROOT(), String(p || '').replace(/^\/+/, ''));
const readFile = (p) => (overlay.has(p) ? overlay.get(p) : fs.readFileSync(abs(p), 'utf8'));
const fileExists = (p) => overlay.has(p) || fs.existsSync(abs(p));
const dirExists = (p) => (!p ? true : fs.existsSync(abs(p)));

export class TAbstractFile {
  constructor(p) { this.path = p; this.name = path.basename(p); }
}

export class TFile extends TAbstractFile {
  constructor(p) {
    super(p);
    this.name = path.basename(p);
    this.extension = 'md';
    this.basename = this.name.replace(/\.md$/i, '');
  }
}

function walkMd(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.obsidian' || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(full, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      out.push(path.relative(ROOT(), full).split(path.sep).join('/'));
    }
  }
  return out;
}

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(raw || ''));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === '') {
      const arr = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) { arr.push(lines[j].replace(/^\s+-\s+/, '').trim()); j++; }
      if (arr.length) { fm[key] = arr; i = j - 1; }
    } else if (val.startsWith('[')) {
      fm[key] = val.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

export const app = {
  vault: {
    getAbstractFileByPath(p) {
      const s = String(p || '');
      if (s.toLowerCase().endsWith('.md')) return fileExists(s) ? new TFile(s) : null;
      return dirExists(s) ? new TAbstractFile(s) : null;
    },
    async cachedRead(f) { return readFile(f.path); },
    async read(f) { return readFile(f.path); },
    async modify(f, data) {
      ops.push({ op: 'modify', path: f.path, content: data });
      if (dryRun) overlay.set(f.path, data);
      else fs.writeFileSync(abs(f.path), data, 'utf8');
    },
    async create(p, data) {
      if (fileExists(p)) throw new Error('File already exists.');
      ops.push({ op: 'create', path: p, content: data });
      if (dryRun) overlay.set(p, data);
      else {
        fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
        fs.writeFileSync(abs(p), data, 'utf8');
      }
      return new TFile(p);
    },
    async createFolder(p) {
      ops.push({ op: 'createFolder', path: p });
      if (!dryRun) fs.mkdirSync(abs(p), { recursive: true });
    },
    getMarkdownFiles() {
      const disk = walkMd(ROOT(), []);
      for (const p of overlay.keys()) if (!disk.includes(p)) disk.push(p);
      return disk.map((p) => new TFile(p));
    },
    getConfig() { return 'zh-cn'; },
    adapter: { exists: async (p) => fileExists(p) || dirExists(p) },
  },
  metadataCache: {
    getFileCache(f) { return { frontmatter: parseFrontmatter(readFile(f.path)) }; },
    on() {},
  },
  internalPlugins: { getEnabledPluginById() { return null; }, getPluginById() { return null; } },
  plugins: { getPlugin() { return null; } },
};

// 仅日记路径解析会用到；CLI 的收件箱 / 清单路径不触发
export const moment = (input) => ({ format: () => String(input), locale() { return moment; } });
moment.locale = () => 'zh-cn';
export const normalizePath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
export const Platform = { isDesktopApp: true, isMobile: false };
export const requestUrl = async () => { throw new Error('requestUrl 在 CLI 中不可用'); };
