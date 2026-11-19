// 极简 CDP 驱动：连到正在运行、带 --remote-debugging-port 的 Obsidian 渲染进程。
// 不依赖 puppeteer：Node 22+ 自带全局 WebSocket。

export async function connect({ port = process.env.E2E_PORT || 9333, target = process.env.E2E_TARGET || 'ObsidianVault' } = {}) {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch (e) {
    throw new Error(`连不上调试端口 ${port}：请先退出 Obsidian，再用 --remote-debugging-port=${port} 重启（见 scripts/e2e/README.md）`);
  }
  // 可能有多个窗口（例如单独弹出的「设置」），只认主窗口（加载了 app:// 的那一个）
  const pages = targets.filter((t) => t.type === 'page' && (t.title || '').includes(target));
  const page = pages.find((t) => String(t.url || '').startsWith('app://')) || pages[0];
  if (!page) throw new Error(`没有找到标题含「${target}」的 Obsidian 窗口；当前：${targets.map((t) => t.title).join(' | ')}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  async function ev(expression, { timeout = 240000 } = {}) {
    const m = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout
    });
    const d = m.result && m.result.exceptionDetails;
    if (d) throw new Error('页面异常：' + (d.exception && d.exception.description || d.text));
    return m.result && m.result.result && m.result.result.value;
  }

  // 真实鼠标事件（走 Chromium Input 域）：右键菜单、拖拽等必须用这种方式
  async function mouse(type, x, y, button = 'left', clickCount = 1) {
    await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0 });
  }
  async function rightClickAt(x, y) {
    await mouse('mouseMoved', x, y, 'none', 0);
    await mouse('mousePressed', x, y, 'right');
    await mouse('mouseReleased', x, y, 'right');
  }
  async function clickAt(x, y) {
    await mouse('mouseMoved', x, y, 'none', 0);
    await mouse('mousePressed', x, y, 'left');
    await mouse('mouseReleased', x, y, 'left');
  }

  return { ev, send, mouse, rightClickAt, clickAt, close: () => ws.close(), page };
}

export function poll(fn, { timeout = 15000, interval = 250, label = '' } = {}) {
  const t0 = Date.now();
  return (async () => {
    let last;
    while (Date.now() - t0 < timeout) {
      try { last = await fn(); if (last) return last; } catch (e) { last = e; }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`超时（${timeout}ms）${label ? '：' + label : ''}${last instanceof Error ? '；最后一次错误：' + last.message : ''}`);
  })();
}
