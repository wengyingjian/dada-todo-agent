// Electron 系统对话框：目录选择。项目页与编辑器委派弹窗共用。
// 返回所选目录路径；取消或环境不支持返回 null（调用方决定提示）。
export async function pickFolder() {
  const electron = require('electron');
  const dialog = (electron && electron.remote && electron.remote.dialog)
    || (electron && electron.dialog)
    || (() => { try { return require('@electron/remote').dialog; } catch { return null; } })();
  if (!dialog || !dialog.showOpenDialog) throw new Error('找不到系统对话框');
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return (!r.canceled && r.filePaths && r.filePaths[0]) ? r.filePaths[0] : null;
}
