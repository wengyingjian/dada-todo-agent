// 委派总结 I/O：调用 OpenAI 兼容 chat/completions 生成总结。
// 未配置 / 网络失败 / 超时一律返回 null，调用方回退到现有截断行为。
// 返回值直接是 parseSummaryReply 的结果 { title, points }。

import { parseSummaryReply } from './summarize-llm.js';

export function chatCompletionsUrl(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
}

export async function callSummaryLlm({ baseUrl, model, apiKey, system, user, timeoutMs = 30000, maxPoints = 5, fetchImpl } = {}) {
  if (!String(baseUrl || '').trim() || !String(apiKey || '').trim() || !String(model || '').trim()) return null;
  const run = fetchImpl || fetch;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), Math.max(1000, Number(timeoutMs) || 30000)));
  let parsed = null;
  try {
    const work = (async () => {
      const resp = await run(chatCompletionsUrl(baseUrl), {
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
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) return null;
      return parseSummaryReply(String(content), { maxPoints });
    })();
    parsed = await Promise.race([work, timeout]);
  } catch {
    return null;
  }
  return parsed;
}
