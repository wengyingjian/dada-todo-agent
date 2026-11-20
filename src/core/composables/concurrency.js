// 并发防护（纯逻辑，无 I/O，可单测）：
//   1. keyedMutex —— 按 key 串行化异步任务。同一 key 的任务排队执行（FIFO），
//      不同 key 互不阻塞。用于清单文件的读-改-写收口：同一文件的操作必须串行，
//      否则交错 RMW 会丢写/重复插（清单重复任务的根因之一）。
//   2. singleFlight —— 同名异步任务进行中时直接复用进行中的那次调用，
//      不再起新的。用于反向同步轮次：一轮 sync 含逐会话 LLM 总结可能超过轮询
//      间隔，若无防护下一 tick 会再起一轮，两轮共享过期快照各自写文件。
//   3. busyFlag —— 一次性长操作（历史导入）与周期任务（sync）互斥：
//      busy 期间周期任务直接跳过，导入结束自动放行。与 singleFlight 的区别是
//      不复用调用，只拒绝并发。

// 按键串行队列。run() 返回队尾任务的 Promise；任务抛错时后续任务不受影响。
export function createKeyedMutex() {
  const tails = new Map();
  return {
    run(key, fn) {
      const k = String(key);
      const prev = tails.get(k) || Promise.resolve();
      // prev 失败不阻断后续任务：fn 无论 prev 成败都执行
      const cur = prev.then(fn, fn);
      const wrapped = cur.finally(() => { if (tails.get(k) === wrapped) tails.delete(k); });
      tails.set(k, wrapped);
      return wrapped;
    }
  };
}

// single-flight：已有同 key 调用在跑时，返回该次调用的 Promise 而不是再起一次。
// fn 不带参数——调用方自行闭包上下文。
export function createSingleFlight() {
  const inflight = new Map();
  return {
    run(key, fn) {
      const k = String(key);
      if (inflight.has(k)) return inflight.get(k);
      const p = Promise.resolve().then(fn).finally(() => inflight.delete(k));
      inflight.set(k, p);
      return p;
    }
  };
}

// 忙标志：begin() 拿到占用权返回 true（重复 begin 返回 false），end() 释放。
// withBusy(fn) 是组合糖：拿到占用权才执行 fn，否则直接返回 busy 语义。
export function createBusyFlag() {
  let busy = false;
  return {
    begin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
    async withBusy(fn, { onBusy } = {}) {
      if (!this.begin()) {
        return onBusy ? onBusy() : null;
      }
      try {
        return await fn();
      } finally {
        this.end();
      }
    }
  };
}
