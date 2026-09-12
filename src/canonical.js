'use strict';

/**
 * 规范化签名(canonical JSON):
 * 递归排序对象键,使 {a:1,b:2} 与 {b:2,a:1} 视为同一份内容。
 * 数组顺序保持语义顺序。
 *
 * 用于"完全相同的重复修订只生效一次 / 同号异内容即冲突"的判定,
 * 判定基于内容而非数组中的位置。
 */

function build(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(build).join(',') + ']';
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    parts.push(JSON.stringify(key) + ':' + build(value[key]));
  }
  return '{' + parts.join(',') + '}';
}

/** 返回稳定签名字符串。传入对象应为已净化的 JSON 安全数据。 */
function signature(value) {
  return build(value);
}

module.exports = { signature };
