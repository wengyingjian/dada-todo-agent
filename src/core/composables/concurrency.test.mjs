// concurrency 单测：keyedMutex / singleFlight / busyFlag
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedMutex, createSingleFlight, createBusyFlag } from './concurrency.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

test('keyedMutex: 同一 key 严格串行（FIFO）', async () => {
  const m = createKeyedMutex();
  const order = [];
  const gates = [deferred(), deferred()];
  const p1 = m.run('a', async () => { order.push('1-start'); await gates[0].p; order.push('1-end'); });
  const p2 = m.run('a', async () => { order.push('2-start'); await gates[1].p; order.push('2-end'); });
  await tick();
  assert.deepEqual(order, ['1-start']);
  gates[0].resolve();
  await p1;
  await tick();
  assert.deepEqual(order, ['1-start', '1-end', '2-start']);
  gates[1].resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['1-start', '1-end', '2-start', '2-end']);
});

test('keyedMutex: 不同 key 并行不互阻塞', async () => {
  const m = createKeyedMutex();
  const gate = deferred();
  const p1 = m.run('a', async () => { await gate.p; return 'a'; });
  const p2 = m.run('b', async () => 'b');
  await tick();
  assert.equal(await p2, 'b');
  gate.resolve();
  assert.equal(await p1, 'a');
});

test('keyedMutex: 任务抛错不阻断后续任务', async () => {
  const m = createKeyedMutex();
  let ran = false;
  const p1 = m.run('a', async () => { throw new Error('boom'); });
  const p2 = m.run('a', async () => { ran = true; return 'ok'; });
  await assert.rejects(p1, /boom/);
  assert.equal(await p2, 'ok');
  assert.equal(ran, true);
});

test('keyedMutex: 前一任务失败后队列仍推进（不吞下一任务结果）', async () => {
  const m = createKeyedMutex();
  const results = [];
  const ps = [1, 2, 3].map((i) => m.run('a', async () => {
    if (i === 2) throw new Error('mid-fail');
    return i;
  }).then((v) => results.push(v)).catch(() => results.push('err')));
  await Promise.all(ps);
  assert.deepEqual(results, [1, 'err', 3]);
});

test('singleFlight: 进行中复用同一 Promise，结束后重新起', async () => {
  const sf = createSingleFlight();
  let n = 0;
  const gate = deferred();
  const fn = async () => { n += 1; await gate.p; return n; };
  const a = sf.run('sync', fn);
  const b = sf.run('sync', fn);
  assert.equal(a, b);
  gate.resolve();
  assert.equal(await a, 1);
  const c = sf.run('sync', fn);
  assert.notEqual(c, a);
  assert.equal(await c, 2);
});

test('singleFlight: 失败后释放占用，下次可重试', async () => {
  const sf = createSingleFlight();
  const a = sf.run('k', async () => { throw new Error('x'); });
  await assert.rejects(a, /x/);
  const b = sf.run('k', async () => 'ok');
  assert.equal(await b, 'ok');
});

test('busyFlag: begin/end 互斥，withBusy 拿不到占用时走 onBusy', async () => {
  const f = createBusyFlag();
  assert.equal(f.begin(), true);
  assert.equal(f.begin(), false);
  assert.equal(f.isBusy(), true);
  f.end();
  assert.equal(f.isBusy(), false);

  let ran = 0;
  const r1 = await f.withBusy(async () => { ran += 1; return 'first'; }, { onBusy: () => 'busy' });
  assert.equal(r1, 'first');
  const gate = deferred();
  const long = f.withBusy(async () => { await gate.p; return 'long'; }, { onBusy: () => 'busy' });
  const r2 = await f.withBusy(async () => { ran += 1; return 'second'; }, { onBusy: () => 'busy' });
  assert.equal(r2, 'busy');
  assert.equal(ran, 1);
  gate.resolve();
  assert.equal(await long, 'long');
  // fn 抛错也释放占用
  await assert.rejects(f.withBusy(async () => { throw new Error('e'); }), /e/);
  assert.equal(f.isBusy(), false);
  assert.equal(await f.withBusy(async () => 'after', { onBusy: () => 'busy' }), 'after');
});
