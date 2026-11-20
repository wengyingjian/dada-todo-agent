// thread-hub 中央会话源单测：一处查询（WAL 监听 + 兜底轮询），多方订阅。
// fs.watch / setInterval 依赖真实文件系统与定时器，全部用注入件替换；
// 这里验证的是订阅语义、防抖合并、失败缓存三块纯逻辑。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadHub } from './thread-hub.js';

function makeDeps(overrides = {}) {
  const timers = [];
  const deps = {
    // 可控时钟：手动推进
    now: () => deps._t,
    _t: 0,
    setInterval(fn, ms) { timers.push({ fn, ms, fired: 0 }); return timers.length; },
    clearInterval() {},
    watchDir(_dir, onEvent) { deps._onEvent = onEvent; return { close() {} }; },
    query: overrides.query || (async () => [{ threadId: 't1' }]),
    debounceMs: 10,
    fallbackMs: 1000
  };
  Object.assign(deps, overrides.watchDir ? { watchDir: overrides.watchDir } : {});
  return { deps, timers };
}

test('订阅即拿到当前快照：首订阅触发首轮查询，后续订阅者立刻拿到当前快照', async () => {
  const { deps } = makeDeps();
  const hub = createThreadHub(deps);
  const hits = [];
  const unsub1 = hub.subscribe((t) => hits.push(['s1', t.length]));
  await hub.ready();           // 首轮查询完成并广播
  assert.equal(hub.snapshot().length, 1);
  const unsub2 = hub.subscribe((t) => hits.push(['s2', t.length])); // 立即拿到当前快照
  assert.deepEqual(hits, [['s1', 1], ['s2', 1]]);
  unsub1(); unsub2();
});

test('WAL 事件防抖后刷新：抖动多次只查一次库，快照推给订阅者', async () => {
  const { deps } = makeDeps();
  let queries = 0;
  deps.query = async () => { queries += 1; return [{ threadId: `t${queries}` }]; };
  const hub = createThreadHub(deps);
  const snaps = [];
  const unsub = hub.subscribe((threads) => snaps.push(threads.map((t) => t.threadId)));
  await hub.ready();
  assert.equal(queries, 1);

  // 模拟 WAL 连续抖动 5 次
  for (let i = 0; i < 5; i++) deps._onEvent('statev2.sqlite-wal');
  assert.equal(queries, 1); // 防抖窗口内还没查
  deps._t = 50;             // 推进时钟过防抖窗口（10ms）
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(queries, 2); // 只合并成一次查询
  assert.deepEqual(snaps.at(-1), ['t2']);
  unsub();
});

test('兜底轮询独立于 WAL 事件，按 fallbackMs 周期触发', async () => {
  const { deps, timers } = makeDeps();
  let queries = 0;
  deps.query = async () => { queries += 1; return []; };
  const hub = createThreadHub(deps);
  const unsub = hub.subscribe(() => {});
  await hub.ready();
  assert.equal(queries, 1);
  const fb = timers.find((x) => x.ms === 1000);
  assert.ok(fb, '应注册兜底轮询定时器');
  await fb.fn();
  assert.equal(queries, 2);
  unsub();
});

test('查询失败保留旧快照并继续轮询，不把空数组推给订阅者', async () => {
  const { deps } = makeDeps();
  let fail = false;
  deps.query = async () => { if (fail) throw new Error('db busy'); return [{ threadId: 't1' }]; };
  const hub = createThreadHub(deps);
  const snaps = [];
  const unsub = hub.subscribe((threads) => snaps.push(threads));
  await hub.ready();
  assert.equal(snaps.length, 1);

  fail = true;
  deps._onEvent('statev2.sqlite-wal');
  deps._t = 50;
  await new Promise((r) => setTimeout(r, 15));
  // 查询失败：快照仍是旧的 t1，订阅者没有被推空数组
  assert.equal(hub.snapshot().length, 1);
  assert.equal(hub.snapshot()[0].threadId, 't1');
  unsub();
});

test('并发去重：上次查询未结束时新触发不叠加，结束后一次性补查', async () => {
  const { deps } = makeDeps();
  let release;
  const gate = new Promise((r) => { release = r; });
  let queries = 0;
  deps.query = async () => { queries += 1; await gate; return [{ threadId: 't1' }]; };
  const hub = createThreadHub(deps);
  const unsub = hub.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 5)); // 等首轮查询启动（被 gate 挂起）
  assert.equal(queries, 1);

  deps._onEvent('statev2.sqlite-wal');
  deps._onEvent('statev2.sqlite-wal');
  deps._t = 50;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(queries, 1, '首轮查询挂着时，防抖到期也不并发叠加');
  release();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(queries, 2, '首轮结束后补查一次');
  unsub();
});

test('stop：停掉监听与轮询，之后的 WAL 事件不再触发查询', async () => {
  const { deps } = makeDeps();
  let queries = 0;
  deps.query = async () => { queries += 1; return []; };
  const hub = createThreadHub(deps);
  const unsub = hub.subscribe(() => {});
  await hub.ready();
  hub.stop();
  deps._onEvent('statev2.sqlite-wal');
  deps._t = 50;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(queries, 1);
  unsub();
});
