// 清单文件的纯逻辑：名称校验、frontmatter 标签归一化、归档标记。
// 无 Obsidian / i18n 依赖，Node 下可直接单测。

// 归档标记：清单文件 frontmatter tags 含该标签即视为已归档，清单 / 列表视图不再展示。
// 与项目视图的「归档任务」（archive.js，把任务搬到归档文件）无关，这里只归档整份清单。
export const ARCHIVED_TAG = 'archived';

// 新建清单的名称校验（弹窗与数据层共用同一份规则，避免两处正则漂移）。
// 合法返回 ''，否则返回原因码：'missing_name'（空）| 'bad_name'（文件名不可用）。
// 规则：非空、不含路径分隔符与 Windows 非法字符 / 控制字符、非 Windows 保留名、不以点开头或结尾、长度上限。
export function checklistNameError(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return 'missing_name';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n)) return 'bad_name';
  if (n.startsWith('.') || n.endsWith('.')) return 'bad_name';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) return 'bad_name';
  if (n.length > 120) return 'bad_name';
  return '';
}

// frontmatter tags 归一化为字符串数组：
//  - 数组：过滤 null / undefined（YAML 空值会产生 null 项）
//  - 字符串：兼容逗号分隔写法（tags: todoList, archived）
//  - 其余（缺失 / 数字等）：空数组
export function frontmatterTags(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((x) => x != null).map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// tags 中是否含指定标签（精确匹配；清单识别另支持 `todoList/xxx` 前缀语义）
export function hasFrontmatterTag(raw, tag) {
  return frontmatterTags(raw).includes(tag);
}

// 是否已归档：frontmatter tags 含 archived
export function isArchivedTags(raw) {
  return hasFrontmatterTag(raw, ARCHIVED_TAG);
}

// 写 frontmatter 用的 YAML 标量：
// 安全字符（路径 / 标签常用字符）原样输出；含空格、引号、#、中文等时用 JSON 双引号转义，
// 避免被 YAML 解析成注释 / 其他类型。JSON 字符串本身即合法的 YAML 双引号标量。
export function yamlScalar(value) {
  const s = String(value == null ? '' : value);
  return /^[A-Za-z0-9_\-./~]+$/.test(s) ? s : JSON.stringify(s);
}
