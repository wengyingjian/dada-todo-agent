// Obsidian 侧的 T3 连接：用 requestUrl 绕开渲染进程的 CORS 限制。
// 单独成文件，保证 t3-client.js 保持纯 node，可直接被 node --test 引入。
import { requestUrl } from 'obsidian';
import { T3Client } from './t3-client.js';

export async function obsidianRequest({ url, method, headers, body }) {
  const res = await requestUrl({ url, method, headers, body, throw: false });
  return { status: res.status, headers: res.headers, text: res.text };
}

export function getT3Client(plugin) {
  if (!plugin._t3Client) {
    plugin._t3Client = new T3Client({
      request: obsidianRequest,
      binary: plugin.settings?.t3Binary || null
    });
  }
  return plugin._t3Client;
}
