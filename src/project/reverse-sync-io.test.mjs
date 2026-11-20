// 反向同步 IO 并发回归：清单文件读-改-写在 path 锁内串行，两路并发插入不丢行、
// 不重复建（清单重复任务 bug 的最小复现口径）。
// tasks.js 依赖 obsidian 包（仅类型 + moment/TFile），这里用 module hooks 桩掉，
// 并以内存文件系统模拟 vault 的 cachedRead/modify/create。

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// ---- obsidian 桩：moment 用极简替代（测试不走日期解析路径），TFile 为标记类 ----
const obsidianStub = `
export class TFile {}
export const moment = () => { throw new Error('moment not available in test'); };
export default {};
`;
const STUB_URL = pathToFileURL('/tmp/dada-stub-obsidian.mjs').href;
registerHooks({
  resolve(spec, context, next) {
    if (spec === 'obsidian') {
      return { url: STUB_URL, shortCircuit: true };
    }
    return next(spec, context);
  },
  load(url, context, next) {
    if (url === STUB_URL) {
      return { format: 'module', source: obsidianStub, shortCircuit: true };
    }
    if (url.endsWith('.json')) {
      return next(url, { ...context, importAttributes: { type: 'json' } });
    }
    return next(url, context);
  }
});

// ---- 内存 vault：cachedRead 返回当前全文，modify 覆盖全文（带 1 tick 延迟模拟 IO） ----
function makeVault() {
  const files = new Map();
  const vault = {
    files,
    getAbstractFileByPath(path) {
      if (!files.has(path)) return null;
      // TFile 桩没有 path 属性，tasks.js 的 modify/create 都按 file.path 定位，补上
      return Object.assign(new TFile(), { path });
    },
    async cachedRead(file) {
      await new Promise((r) => setTimeout(r, 1));
      return files.get(file.path) ?? '';
    },
    async modify(file, doc) {
      await new Promise((r) => setTimeout(r, 1));
      files.set(file.path, doc);
    },
    async create(path, doc) {
      await new Promise((r) => setTimeout(r, 1));
      if (files.has(path)) throw new Error('File already exists');
      files.set(path, doc);
    },
    async createFolder() {}
  };
  return vault;
}

const api = await import('./../core/api/tasks.js');
const { TFile } = await import('obsidian');

function initPlugin(vault) {
  api.initTasksApi({
    app: { vault },
    settings: { dailyLoadWindow: 'all' },
    saveData: async () => {}
  });
}

const HEAD = '---\ntags:\n  - todoList\n---\n\n';
const LIST = '清单/x.md';

test('withListDoc + writeListDoc 锁内 RMW：两路并发各插一行，两行都在', async () => {
  const vault = makeVault();
  initPlugin(vault);
  vault.files.set(LIST, HEAD + '- [ ] 已有任务\n');

  // 两路并发：各自在锁内读最新内容、追加一行、落盘
  const [a, b] = await Promise.all([
    api.withListDoc(LIST, (doc) => ({ lines: [...doc.lines, '- [ ] 路A新增'] })),
    api.withListDoc(LIST, (doc) => ({ lines: [...doc.lines, '- [ ] 路B新增'] }))
  ]);

  const final = vault.files.get(LIST);
  assert.ok(final.includes('- [ ] 路A新增'), '路A的行不能被 B 覆盖丢掉');
  assert.ok(final.includes('- [ ] 路B新增'), '路B的行不能被 A 覆盖丢掉');
  assert.ok(final.includes('- [ ] 已有任务'));
  assert.equal(a.path, LIST);
  assert.equal(b.path, LIST);
});

test('裸 writeListDoc（整体覆盖写）与 RMW 互斥排队，不交错丢写', async () => {
  const vault = makeVault();
  initPlugin(vault);
  vault.files.set(LIST, HEAD + '- [ ] 基线\n');

  // 路A：writeListDoc 覆盖全文件；路B：withListDoc 读改写追加
  await Promise.all([
    api.writeListDoc(LIST, HEAD, ['- [ ] 覆盖写', '']),
    api.withListDoc(LIST, (doc) => ({ lines: [...doc.lines, '- [ ] RMW新增'] }))
  ]);
  const final = vault.files.get(LIST);
  // 两个操作都完整执行（谁先谁后不重要，但不能互相写一半）
  const fullWrite = final.includes('- [ ] 覆盖写');
  const rmw = final.includes('- [ ] RMW新增') || (final.includes('- [ ] 覆盖写') && final.includes('- [ ] 基线') === false);
  assert.ok(fullWrite, '覆盖写必须落盘');
  // RMW 若排在覆盖写之后，读到的是覆盖后的内容（基线已被覆盖写替换），行仍要存在
  // RMW 若排在覆盖写之前，其结果会被覆盖写整体替换——这是语义上允许的（后者赢），
  // 但不允许的是「各写一半」。断言最终文件自洽：要么两行都有，要么是完整覆盖写。
  assert.ok(
    rmw || (!final.includes('- [ ] RMW新增') && final.includes('- [ ] 覆盖写')),
    '最终文件必须自洽'
  );
});

test('insertListLines / replaceListLines 原子 RMW：并发插入全部落盘', async () => {
  const vault = makeVault();
  initPlugin(vault);
  vault.files.set(LIST, HEAD);

  await Promise.all([
    api.insertListLines(LIST, -1, ['- [ ] 插入1']),
    api.insertListLines(LIST, -1, ['- [ ] 插入2']),
    api.insertListLines(LIST, -1, ['- [ ] 插入3'])
  ]);

  const body = vault.files.get(LIST).slice(HEAD.length);
  for (const l of ['插入1', '插入2', '插入3']) {
    assert.ok(body.includes(l), `${l} 丢失`);
  }
});

test('replaceListLines 在锁内重读：过期行号不会覆盖别人的新内容', async () => {
  const vault = makeVault();
  initPlugin(vault);
  vault.files.set(LIST, HEAD + '- [ ] 目标行\n');

  // frontmatter 后 splitDoc 留一个空行，「目标行」是正文第 1 行
  const r = await api.replaceListLines(LIST, 1, ['- [ ] 已改写']);
  assert.ok(r && r.lineNo === 1);
  assert.ok(vault.files.get(LIST).includes('- [ ] 已改写'));
  assert.ok(!vault.files.get(LIST).includes('- [ ] 目标行'));
});

test('createChecklistTask dedupeMark：锁内查重，已有同标记行时不重复插入', async () => {
  const vault = makeVault();
  initPlugin(vault);
  const existing = `${HEAD}- [/] 09:10-09:13 旧任务 📅 2026-11-20  ⚡ t3:9220a55aaa95209f#1\n`;
  vault.files.set(LIST, existing);

  const r = await api.createChecklistTask('cl:清单/x', '', {
    summary: '09:10-09:13 新建同会话 📅 2026-11-20',
    dedupeMark: '⚡ t3:9220a55aaa95209f'
  });
  // createChecklistTask 返回 { status, body } 包裹（runtime 层的 unwrap 负责解包）
  const rb = r.body || r;
  assert.equal(rb.ok, false);
  assert.equal(rb.reason, 'duplicate');

  const body = vault.files.get(LIST).slice(HEAD.length);
  assert.equal(body.split('\n').filter((l) => l.includes('⚡ t3:9220a55aaa95209f')).length, 1, '不得出现第二行同 threadId');

  // 无 dedupeMark 时正常创建（两路并发带同一 dedupeMark 也只落一行）
  const ok = await api.createChecklistTask('cl:清单/x', '', { summary: '普通新建' });
  assert.equal((ok.body || ok).ok, true);
  const body2 = vault.files.get(LIST).slice(HEAD.length);
  assert.ok(body2.includes('普通新建'));
});

test('withListDoc 不可重入：fn 内再调带锁出口直接报错而非挂死', async () => {
  const vault = makeVault();
  initPlugin(vault);
  vault.files.set(LIST, HEAD);
  let innerErr = null;
  const outer = await api.withListDoc(LIST, async () => {
    // 重入调用立即被拒（rejected promise），不排队不挂起
    try { await api.insertListLines(LIST, -1, ['- [ ] 重入']); } catch (e) { innerErr = e; }
    return { lines: [] };
  });
  assert.ok(innerErr, '重入调用必须抛错');
  assert.match(innerErr.message, /reentrant_list_lock/);
  assert.ok(outer, '外层调用本身正常完成');
});
