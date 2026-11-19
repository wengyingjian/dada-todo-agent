// 委派总结 I/O：调用 OpenAI 兼容 chat/completions 生成总结。
// 未配置 / 网络失败 / 超时一律返回 null，调用方回退到现有截断行为。
// 返回值直接是 parseSummaryReply 的结果 { title, points }。
//
// 网络通路：Obsidian 渲染进程的全局 fetch 走 Chromium 网络栈，对某些站点（系统代理、
// 自签/内网证书）会直接 Failed to fetch；Electron 主进程 net.fetch 使用系统网络栈，
// 这类站点反而能通。所以默认 fetch 失败后依次尝试 fallbackFetchers（runtime 注入
// 主进程 net.fetch 包装）。

import { parseSummaryReply } from './summarize-llm.js';

export function chatCompletionsUrl(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
}

// 依次用 fetchers 里的通路调用；任何一个成功即返回，全部失败返回 null
async function requestOnce(url, init, fetchers, timeoutMs) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), Math.max(1000, Number(timeoutMs) || 30000)));
  const attempt = async () => {
    for (const run of fetchers) {
      if (!run) continue;
      try {
        const resp = await run(url, init);
        if (!resp || !resp.ok) continue;
        const data = await resp.json();
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content) continue;
        return String(content);
      } catch { /* 换下一通路 */ }
    }
    return null;
  };
  return Promise.race([attempt(), timeout]);
}

export async function callSummaryLlm({
  baseUrl, model, apiKey, system, user,
  timeoutMs = 30000, maxPoints = 5,
  fetchImpl,           // 测试注入；也作为首选通路
  globalFetch,         // 测试注入默认通路（缺省用全局 fetch）
  fallbackFetchers = [] // 备用通路（运行时注入 Electron 主进程 net.fetch 包装）
} = {}) {
  if (!String(baseUrl || '').trim() || !String(apiKey || '').trim() || !String(model || '').trim()) return null;
  const url = chatCompletionsUrl(baseUrl);
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.2
    })
  };
  const fetchers = [fetchImpl, globalFetch || fetch, ...fallbackFetchers];
  const content = await requestOnce(url, init, fetchers, timeoutMs);
  if (!content) return null;
  return parseSummaryReply(content, { maxPoints });
}
