'use strict';

/**
 * 通用工具:输入净化、深拷贝、深冻结、稳定排序比较。
 */

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 把(可能来自 JSON.parse 之外的)输入净化成 JSON 安全的数据。
 * - 对象键排序不在这里处理(见 canonical);
 * - bigint 仅在作为安全整数时接受,转成 number;
 * - 遇到 NaN/Infinity、symbol、function 等抛错,由调用方记为无效条目。
 */
function sanitize(value, label = '值') {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') {
    if (!Number.isSafeInteger(Number(value))) {
      throw new RangeError(`${label} 超出安全整数范围`);
    }
    return Number(value);
  }
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${label} 不是有限数`);
    return value;
  }
  if (t === 'undefined') return undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const item = sanitize(value[i], `${label}[${i}]`);
      if (item === undefined) throw new TypeError(`${label}[${i}] 不能是 undefined`);
      out.push(item);
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = sanitize(value[key], `${label}.${key}`);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  throw new TypeError(`${label} 含有不受支持的类型`);
}

function deepClone(value) {
  return value === undefined ? value : globalThis.structuredClone(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

/** 可用于任意(已净化)标量/数组的稳定比较:number < string,其余按字符串。 */
function compareValue(a, b) {
  const ta = typeof a;
  const tb = typeof b;
  if (ta === 'number' && tb === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'number' && tb === 'string') return -1;
  if (ta === 'string' && tb === 'number') return 1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 稳定的多键比较;每个 key 为 [取值函数, 方向('asc'|'desc')]。 */
function compareBy(keys) {
  return (a, b) => {
    for (const [getter, dir = 'asc'] of keys) {
      const r = compareValue(getter(a), getter(b));
      if (r !== 0) return dir === 'asc' ? r : -r;
    }
    return 0;
  };
}

/**
 * 稳定的内容标签:不引用数组下标,因此打乱数组顺序不会改变标签。
 * 键名排序;NaN/Infinity/bigint/undefined 等做确定性替换,仅用于错误信息。
 */
function stableLabel(value) {
  const convert = (v) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : null;
    if (t === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    if (t === 'undefined') return null;
    if (Array.isArray(v)) return v.map(convert);
    if (t === 'object') {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = convert(v[key]);
      return out;
    }
    return `[${t}]`;
  };
  let json;
  try {
    json = JSON.stringify(convert(value));
  } catch {
    return '<unrepresentable>';
  }
  return json.length > 80 ? json.slice(0, 77) + '...' : json;
}

module.exports = { isPlainObject, sanitize, deepClone, deepFreeze, compareValue, compareBy, stableLabel };
