// 等待 Obsidian metadataCache 解析出新文件的 frontmatter。
// 新建清单文件后立刻重扫项目索引会因缓存未就绪而扫不到（误报 no_node），
// 调用方须先等缓存就绪再 nodeOf。纯轮询、可注入，Node 下可单测。

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 轮询 getCache(filePath) 直到返回带 frontmatter 的缓存（或超时）。
 * @param {(path: string) => any} getCache 取缓存回调（生产传 metadataCache.getFileCache）
 * @param {string} filePath 目标文件路径
 * @param {{intervalMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>} true=缓存已就绪（frontmatter 字段存在，可为空对象）
 */
export async function waitForFrontmatter(getCache, filePath, opts = {}) {
  const interval = Math.max(1, Number(opts.intervalMs) || 50);
  const timeout = Math.max(0, Number(opts.timeoutMs) || 3000);
  const deadline = Date.now() + timeout;
  for (;;) {
    let cache = null;
    try { cache = getCache(filePath); } catch { cache = null; }
    if (cache && typeof cache === 'object' && 'frontmatter' in cache) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}
