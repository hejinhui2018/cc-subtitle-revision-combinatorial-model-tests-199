'use strict';

/**
 * 对外 API:
 * - analyzeDocument(document): 合并修订 + 时轴检查,返回完整交付报告
 * - loadSubtitles(document) / new SubtitleStore():按编号查原始内容与修订历史、按帧查当前字幕
 *
 * 所有对外返回的数据都经过深冻结与拷贝,不暴露内部可变状态。
 */

const { Fraction } = require('./fraction');
const { merge, normalizeId } = require('./merge');
const { checkTimeline } = require('./timeline');
const { sortProblems, ERROR, WARNING } = require('./problems');
const { deepClone, deepFreeze } = require('./util');
const { exportTrack } = require('./export');

function parseInput(input) {
  if (typeof input === 'string') {
    return JSON.parse(input);
  }
  return input;
}

function frameRateDescriptor(frameRate) {
  if (!frameRate) return null;
  return {
    numerator: Number(frameRate.num),
    denominator: Number(frameRate.den),
    label: frameRate.toString(),
    isIntegerRate: frameRate.den === 1n,
  };
}

/** 去掉内部排序辅助字段后再对外暴露问题。 */
function publicProblem(p) {
  const { sortKey, ...rest } = p;
  return { ...rest };
}

/** 一帧起点对应的秒数(精确 Fraction):frame / frameRate。 */
function frameToSecondsFraction(frame, frameRate) {
  return Fraction.of(frame).div(frameRate);
}

class SubtitleStore {
  /** 直接构造请用 loadSubtitles();这里接收 merge 的内部结果。 */
  constructor(mergeResult, timelineResult) {
    this._frameRate = mergeResult.frameRate;
    this._subtitles = mergeResult.subtitles;
    this._issues = mergeResult.issues.concat(timelineResult.issues);
    this._timelineTracks = timelineResult.tracks;
  }

  get frameRate() {
    return this._frameRate ? deepFreeze(frameRateDescriptor(this._frameRate)) : null;
  }

  /** 全部问题(稳定排序、冻结)。 */
  get issues() {
    return deepFreeze(sortProblems(this._issues).map(publicProblem));
  }

  /**
   * 按字幕编号查看原始内容与完整修订历史。
   * 编号可以是数字或字符串;不存在时返回 null。
   */
  getSubtitle(id) {
    const target = this._subtitles.get(normalizeId(id));
    if (!target) return null;

    const origin = target.history.find((h) => h.kind === 'origin');
    const history = target.history
      .filter((h) => h.kind === 'revision')
      .map((h) => {
        const rec = {
          revisionId: h.revisionId,
          version: h.version,
          action: h.action,
          status: h.status, // applied | conflicted | skipped_duplicate_version | after_withdraw | invalid_payload
          payload: deepClone(h.payload),
        };
        if (h.snapshot) rec.resultingState = deepClone(h.snapshot);
        return rec;
      });

    const current = target.status === 'withdrawn'
      ? null
      : {
          id: target.id,
          language: target.language,
          startFrame: target.startFrame,
          endFrame: target.endFrame,
          text: target.text,
          speaker: target.speaker,
        };

    return deepFreeze({
      id: target.id,
      language: target.language,
      status: target.status, // active | withdrawn
      original: deepClone(origin.snapshot),
      current,
      history,
    });
  }

  /** 所有编号(按语言轨、起始帧、编号稳定排序)。 */
  listIds() {
    return [...this._subtitles.values()]
      .sort((a, b) =>
        a.language < b.language ? -1 : a.language > b.language ? 1 :
        a.startFrame - b.startFrame ||
        a.endFrame - b.endFrame ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((s) => s.id);
  }

  /**
   * 当前生效字幕列表。默认所有语言轨;可传语言或语言数组。
   * 已撤回的不返回。
   */
  currentSubtitles(language) {
    const wanted = language === undefined
      ? null
      : new Set(Array.isArray(language) ? language : [language]);
    const list = [...this._subtitles.values()]
      .filter((s) => s.status !== 'withdrawn')
      .filter((s) => wanted === null || wanted.has(s.language))
      .map((s) => ({
        id: s.id,
        language: s.language,
        startFrame: s.startFrame,
        endFrame: s.endFrame,
        text: s.text,
        speaker: s.speaker,
      }))
      .sort((a, b) =>
        a.language < b.language ? -1 : a.language > b.language ? 1 :
        a.startFrame - b.startFrame ||
        a.endFrame - b.endFrame ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    return deepFreeze(list);
  }

  /**
   * 按帧位置查询当前生效的字幕(半开区间 [startFrame, endFrame))。
   * 恰好在上一条结束帧(=下一条开始帧,首尾相接)时只命中下一条。
   * 返回冻结数组;有重叠时可能命中多条。
   */
  subtitlesAtFrame(frame, language) {
    if (typeof frame !== 'number' || !Number.isSafeInteger(frame)) {
      throw new TypeError('frame 必须是安全整数');
    }
    const wanted = language === undefined
      ? null
      : new Set(Array.isArray(language) ? language : [language]);
    const list = [...this._subtitles.values()]
      .filter((s) => s.status !== 'withdrawn')
      .filter((s) => wanted === null || wanted.has(s.language))
      .filter((s) => s.startFrame <= frame && frame < s.endFrame)
      .map((s) => ({
        id: s.id,
        language: s.language,
        startFrame: s.startFrame,
        endFrame: s.endFrame,
        text: s.text,
        speaker: s.speaker,
      }))
      .sort((a, b) =>
        a.language < b.language ? -1 : a.language > b.language ? 1 :
        a.startFrame - b.startFrame ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    return deepFreeze(list);
  }

  /** 帧号 → 秒数文本(精确,仅用于展示)。帧率无效时返回 null。 */
  frameToSeconds(frame, decimals = 3) {
    if (!this._frameRate) return null;
    return frameToSecondsFraction(frame, this._frameRate).toSeconds(decimals);
  }

  /** 帧号 → HH:MM:SS.mmm 时间码(精确,仅用于展示)。帧率无效时返回 null。 */
  frameToTimecode(frame, decimals = 3) {
    if (!this._frameRate) return null;
    return frameToSecondsFraction(frame, this._frameRate).toTimecode(decimals);
  }
}

function loadSubtitles(input) {
  const document = parseInput(input);
  const merged = merge(document);
  const timeline = checkTimeline(merged.subtitles, merged.frameRate);
  return new SubtitleStore(merged, timeline);
}

/**
 * 完整交付分析:合并 + 时轴检查 + 每条语言轨与整体结论。
 */
function analyzeDocument(input) {
  const document = parseInput(input);
  const merged = merge(document);
  const timeline = checkTimeline(merged.subtitles, merged.frameRate);
  const allProblems = sortProblems(merged.issues.concat(timeline.issues));

  // 按语言轨汇总
  const trackInfo = new Map();
  const ensureTrack = (language) => {
    if (!trackInfo.has(language)) {
      trackInfo.set(language, { language, errors: 0, warnings: 0, totalSubtitles: 0, activeSubtitles: 0, withdrawnSubtitles: 0 });
    }
    return trackInfo.get(language);
  };
  for (const target of merged.subtitles.values()) {
    const t = ensureTrack(target.language);
    t.totalSubtitles += 1;
    if (target.status === 'withdrawn') t.withdrawnSubtitles += 1;
    else t.activeSubtitles += 1;
  }
  for (const p of allProblems) {
    if (!p.language) continue;
    const t = ensureTrack(p.language);
    if (p.severity === ERROR) t.errors += 1;
    else t.warnings += 1;
  }

  const tracks = [...trackInfo.values()]
    .sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0))
    .map((t) => ({
      language: t.language,
      deliverable: t.errors === 0,
      errorCount: t.errors,
      warningCount: t.warnings,
      totalSubtitles: t.totalSubtitles,
      activeSubtitles: t.activeSubtitles,
      withdrawnSubtitles: t.withdrawnSubtitles,
    }));

  const globalErrors = allProblems.filter((p) => p.severity === ERROR && !p.language).length;
  const totalErrors = allProblems.filter((p) => p.severity === ERROR).length;
  const totalWarnings = allProblems.filter((p) => p.severity === WARNING).length;

  const overall = {
    deliverable: merged.frameRate !== null && totalErrors === 0,
    frameRateValid: merged.frameRate !== null,
    errorCount: totalErrors,
    warningCount: totalWarnings,
    unattributedErrorCount: globalErrors,
    trackCount: tracks.length,
  };

  const currentSubtitles = new SubtitleStore(merged, timeline).currentSubtitles();

  return deepFreeze({
    frameRate: frameRateDescriptor(merged.frameRate),
    overall,
    tracks,
    problems: allProblems.map(publicProblem),
    currentSubtitles,
  });
}

module.exports = {
  analyzeDocument,
  loadSubtitles,
  exportTrack,
  SubtitleStore,
  frameToSecondsFraction,
  Fraction,
  // 便于高级用法与测试
  mergeRevisions: merge,
  checkTimeline,
};
