// 自动归档目标路径的纯计算（Node 可单测）。
// 规格：<清单文件夹>/归档/<清单名>/归档-<清单名>-<日期>.md，日期取本批最早。
// 清单在库根时归档文件夹为「归档」（与 core/api/tasks.js 的 archiveFolder 同约定）。

import { archiveNameRegex } from './archive.js';

// 清单文件路径 + 本批日期 → { dir, prefix, path, nameRegex }
export function computeAutoArchiveTarget(listPath, dates) {
  const p = String(listPath || '');
  const dirPart = p.split('/').slice(0, -1).join('/');
  const listName = p.split('/').pop().replace(/\.md$/i, '');
  const aFolder = dirPart ? `${dirPart}/归档` : '归档';
  const prefix = `归档-${listName}-`;
  const ds = (dates || []).slice().sort();
  const date = ds[0] || '1970-01-01';
  return {
    dir: `${aFolder}/${listName}`,
    prefix,
    path: `${aFolder}/${listName}/${prefix}${date}.md`,
    nameRegex: archiveNameRegex(prefix)
  };
}
