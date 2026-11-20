// 中央会话源：一处查询（WAL 监听 + 兜底轮询），多方订阅（侧栏会话视图 / 反向同步）。
// 之前侧栏和反向同步各自 fork sqlite3 查会话，同一条 queryThreads 跑了两份；
// 收口到这里后 sqlite fork 减半，反向同步也搭上 WAL 事件的便车（不再干等 60s 轮询）。
// 写清单的节奏不受影响：反向同步的静默门槛在订阅方自己控制。

// fs.watch / setInterval 依赖真实文件系统与定时器，全部从 deps 注入，Node 下可单测。
export function createThreadHub(deps) {
  const {
    watchDir,            // (dir, onEvent) => { close() }，生产传 fs.watch 包装
    query,               // async () => threads[]，生产传 queryThreads 包装
    dbDir,               // 监听目录（生产传 t3 数据库目录）
    setInterval = globalThis.setInterval,
    clearInterval = globalThis.clearInterval,
    now = () => Date.now(),
    debounceMs = 400,    // WAL 防抖：与原 sessions-view 一致
    fallbackMs = 20000   // 兜底轮询：与原 sessions-view 一致
  } = deps;

  let threads = [];
  let watcher = null;
  let timer = null;
  let debounceTimer = null;
  let querying = false;
  let pendingAfterQuery = false; // 查询进行中新到的事件：结束后补查一次
  let stopped = false;
  const subs = new Set();

  async function runQuery() {
    if (querying) { pendingAfterQuery = true; return; }
    querying = true;
    try {
      const next = await query();
      // 失败保留旧快照：query 约定失败返回 []，空结果且旧快照非空时按失败处理不覆盖
      if (!(Array.isArray(next) && next.length === 0 && threads.length > 0)) {
        threads = Array.isArray(next) ? next : [];
        for (const fn of subs) { try { fn(threads); } catch { /* 订阅者异常不拖垮广播 */ } }
      }
    } catch {
      /* 查询异常：保留旧快照 */
    } finally {
      querying = false;
      if (pendingAfterQuery && !stopped) {
        pendingAfterQuery = false;
        scheduleDebounce();
      }
    }
  }

  function scheduleDebounce() {
    if (stopped || debounceTimer) return;
    const firedAt = now() + debounceMs;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runQuery();
    }, debounceMs);
    void firedAt;
  }

  function onFsEvent(_event, name) {
    if (stopped) return;
    if (deps.isDbFile && !deps.isDbFile(name)) return;
    scheduleDebounce();
  }

  function start() {
    if (watcher || timer) return;
    try { watcher = watchDir(dbDir, onFsEvent); } catch { watcher = null; }
    watcher?.on?.('error', () => {});
    timer = setInterval(() => { if (!stopped && !querying) runQuery(); }, fallbackMs);
  }

  function stop() {
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
    try { watcher?.close(); } catch { /* 已关闭 */ }
    watcher = null;
  }

  // subscribe(fn) → 注册并立即推当前快照；返回退订函数。
  // 首个订阅者触发 start（查询 + 监听 + 轮询），首轮查询完成时统一经 runQuery 广播。
  function subscribe(fn) {
    subs.add(fn);
    if (subs.size === 1 && !watcher && !timer) {
      start();
      runQuery(); // 首轮广播由 runQuery 完成，这里不重复推
    } else {
      try { fn(threads); } catch { /* ignore */ }
    }
    return () => subs.delete(fn);
  }

  // 等待进行中的查询结束（首轮订阅后调 ready 可等到首份快照就绪）
  async function ready() {
    while (querying) await new Promise((r) => setTimeout(r, 2));
  }

  // 手动刷新：走同一个防抖队列（连点合并为一次查询）
  function requestRefresh() {
    scheduleDebounce();
  }

  return { subscribe, snapshot: () => threads, stop, ready, requestRefresh };
}
