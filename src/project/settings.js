// 项目视图设置默认值（独立文件，避免 main.js 与 runtime.js 之间的依赖环）
export const DEFAULT_SETTINGS = {
  projectsRoot: '任务',
  t3Binary: '',
  // 委派时指定模型（留空用 T3 项目的默认模型）；新建的 T3 项目没有默认模型时必须填
  t3Provider: '',
  t3Model: '',
  projectDefaultCwd: '',
  reverseSync: true,
  reverseSyncSeconds: 60,
  reverseSyncMinMinutes: 3,
  summaryMaxChars: 200,
  // 委派总结 LLM（OpenAI 兼容 /v1/chat/completions；三项任一为空则不总结，回退截断行为）
  summaryLlmBaseUrl: '',
  summaryLlmModel: '',
  summaryLlmApiKey: '',
  // 总结 system prompt 模板（留空用内置默认；支持 {{delegation}} / {{transcript}} 占位符，
  // 含 {{transcript}} 时整段模板接管 user 消息）
  summaryPromptTemplate: '',
  summaryTimeoutSeconds: 30,
  // 会话静默多少分钟后才允许「再总结」（与 #count 计数变化双门槛）
  summarySilentMinutes: 30,
  // 首次启用时刻（-30 分钟）：只回传此后新建的会话，避免把历史会话一次性灌进日记
  syncSince: 0
};

export function mergeProjectSettings(raw) {
  return { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
}
