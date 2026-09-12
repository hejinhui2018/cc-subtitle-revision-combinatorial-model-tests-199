'use strict';

/**
 * 问题登记与稳定排序。
 * 一次输入中的所有问题必须一次性返回,且顺序稳定、与数组成员的排列无关。
 */

const ERROR = 'error';
const WARNING = 'warning';

// 固定的问题类别顺序(同类内部再按 语言/目标/修订/版本 排序)
const CODE_ORDER = [
  'INVALID_FRAME_RATE',
  'INVALID_DOCUMENT',
  'INVALID_SUBTITLE',
  'DUPLICATE_SUBTITLE_ID',
  'INVALID_REVISION',
  'REVISION_CONFLICT',
  'DUPLICATE_REVISION',
  'DUPLICATE_VERSION',
  'VERSION_GAP',
  'DANGLING_REVISION',
  'INVALID_REVISION_PAYLOAD',
  'REVISION_AFTER_WITHDRAW',
  'NEGATIVE_FRAME',
  'INVALID_INTERVAL',
  'OVERLAPPING_SUBTITLES',
];

const CODE_INDEX = new Map(CODE_ORDER.map((code, i) => [code, i]));

const SEVERITY_BY_CODE = {
  INVALID_FRAME_RATE: ERROR,
  INVALID_DOCUMENT: ERROR,
  INVALID_SUBTITLE: ERROR,
  DUPLICATE_SUBTITLE_ID: ERROR,
  INVALID_REVISION: ERROR,
  REVISION_CONFLICT: ERROR,
  DUPLICATE_REVISION: WARNING, // 内容完全一致,只生效一次,不影响交付结论
  DUPLICATE_VERSION: ERROR,
  VERSION_GAP: ERROR,
  DANGLING_REVISION: ERROR,
  INVALID_REVISION_PAYLOAD: ERROR,
  REVISION_AFTER_WITHDRAW: ERROR,
  NEGATIVE_FRAME: ERROR,
  INVALID_INTERVAL: ERROR,
  OVERLAPPING_SUBTITLES: ERROR,
};

class ProblemCollector {
  constructor() {
    this.items = [];
  }

  add(code, message, extra = {}) {
    this.items.push({
      code,
      severity: SEVERITY_BY_CODE[code] ?? ERROR,
      message,
      ...extra,
    });
  }
}

function sortKey(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 全局稳定排序:类别 → 语言轨 → 字幕编号 → 修订编号 → 版本 → 附加键。
 * 不使用数组下标,因此打乱输入数组不会改变输出顺序。
 */
function compareProblems(a, b) {
  const ia = CODE_INDEX.get(a.code);
  const ib = CODE_INDEX.get(b.code);
  if (ia !== ib) return (ia ?? CODE_ORDER.length) - (ib ?? CODE_ORDER.length);
  const keys = [
    sortKey(a.language),
    sortKey(b.language),
    sortKey(a.targetId),
    sortKey(b.targetId),
    sortKey(a.revisionId),
    sortKey(b.revisionId),
    (a.version ?? 1e15),
    (b.version ?? 1e15),
    sortKey(a.sortKey),
    sortKey(b.sortKey),
  ];
  for (let i = 0; i < keys.length; i += 2) {
    if (keys[i] < keys[i + 1]) return -1;
    if (keys[i] > keys[i + 1]) return 1;
  }
  return 0;
}

function sortProblems(problems) {
  return problems.slice().sort(compareProblems);
}

module.exports = {
  ERROR,
  WARNING,
  CODE_ORDER,
  ProblemCollector,
  compareProblems,
  sortProblems,
};
