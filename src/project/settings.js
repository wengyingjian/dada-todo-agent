// 项目视图设置默认值（独立文件，避免 main.js 与 runtime.js 之间的依赖环）
export const DEFAULT_SETTINGS = {
  projectsRoot: '任务',
  t3Binary: '',
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
