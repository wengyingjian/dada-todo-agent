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
  // 首次启用时刻（-30 分钟）：只回传此后新建的会话，避免把历史会话一次性灌进日记
  syncSince: 0
};

export function mergeProjectSettings(raw) {
  return { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
}
