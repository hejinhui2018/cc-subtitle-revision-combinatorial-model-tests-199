'use strict';

/**
 * SRT / WebVTT 交付文本导出。
 *
 * 导出必须复用现有的修订合并(merge)与时轴检查(checkTimeline)结果,不做二次判定:
 * - 帧率无效 → 全局阻断;
 * - 存在无法归属到任何语言轨的 error → 全局阻断;
 * - 所选语言轨自身有 error(或在合并阶段根本不存在)→ 该轨阻断;
 * - 其他语言轨的 error 不影响本轨;warning 永远不阻断。
 *
 * 帧 → 毫秒全程基于精确有理数(Fraction),不使用浮点;
 * 四舍五入到最近毫秒,恰好半毫秒向上(朝 +∞)。
 * 同一帧换算结果与相邻条目共享,因此首尾相接处两条 cue 的时间戳完全一致。
 * 正帧区间取整后若压缩成零毫秒,判定为 ZERO_DURATION_CUE,明确失败,不产出无效 cue。
 */

const { Fraction } = require('./fraction');
const { merge } = require('./merge');
const { checkTimeline } = require('./timeline');
const { sortProblems, ERROR, WARNING } = require('./problems');
const { deepFreeze } = require('./util');

const FORMATS = new Set(['srt', 'vtt']);

/** 毫秒数 → HH:MM:SS 与 mmm。 */
function hmsAndMillis(totalMs) {
  const hours = totalMs / 3600000n;
  const minutes = (totalMs % 3600000n) / 60000n;
  const seconds = (totalMs % 60000n) / 1000n;
  const millis = totalMs % 1000n;
  const pad2 = (x) => x.toString().padStart(2, '0');
  return {
    hms: `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`,
    millis: millis.toString().padStart(3, '0'),
  };
}

/** 毫秒 → SRT 时间戳 HH:MM:SS,mmm。 */
function srtTimestamp(totalMs) {
  const { hms, millis } = hmsAndMillis(totalMs);
  return `${hms},${millis}`;
}

/** 毫秒 → WebVTT 时间戳 HH:MM:SS.mmm。 */
function vttTimestamp(totalMs) {
  const { hms, millis } = hmsAndMillis(totalMs);
  return `${hms}.${millis}`;
}

/**
 * 失败结果构造。reasonCode 为机器可识别的失败原因,problems 为相关问题(冻结副本)。
 */
function failure(reasonCode, message, problems = [], extra = {}) {
  return deepFreeze({
    ok: false,
    reasonCode,
    message,
    problems: problems.map(stripSortKey),
    format: null,
    language: null,
    subtitleCount: 0,
    text: '',
    ...extra,
  });
}

function stripSortKey(p) {
  const { sortKey, ...rest } = p;
  return { ...rest };
}

/**
 * 导出一条语言轨的交付文本。
 *
 * @param {object|string} input 与 analyzeDocument 相同的文档(对象或 JSON 字符串)
 * @param {object} options
 * @param {string} options.language 必填,要导出的语言轨标识
 * @param {'srt'|'vtt'} options.format 必填,交付格式
 * @param {boolean} [options.includeSpeaker=false]
 *        有说话人时是否在正文前加说话人;默认 false(不加入)。
 *        开启后以 `说话人: 正文` 作为第一行(多行文本的其余换行原样保留)。
 * @returns {object} 成功 { ok:true, format, language, subtitleCount, text } ;
 *                   失败 { ok:false, reasonCode, message, problems, ... , text:'' }
 */
function exportTrack(input, options) {
  // ---- 选项校验(不依赖合并结果)----
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return failure('INVALID_OPTIONS', 'options 必须是对象,且包含 language 与 format');
  }
  const { language, format, includeSpeaker = false } = options;
  if (typeof language !== 'string' || language.trim() === '') {
    return failure('INVALID_OPTIONS', 'options.language 必填且必须是非空字符串');
  }
  if (!FORMATS.has(format)) {
    return failure('INVALID_OPTIONS', "options.format 只接受 'srt' 或 'vtt'");
  }
  if (typeof includeSpeaker !== 'boolean') {
    return failure('INVALID_OPTIONS', 'options.includeSpeaker 必须是布尔值', [], {
      format,
      language,
    });
  }

  // ---- 复用现有合并与时轴校验结果 ----
  let merged;
  try {
    merged = merge(typeof input === 'string' ? JSON.parse(input) : input);
  } catch (err) {
    return failure('INVALID_DOCUMENT', `输入文档无法解析: ${err.message}`);
  }
  const timeline = checkTimeline(merged.subtitles, merged.frameRate);
  const allProblems = sortProblems(merged.issues.concat(timeline.issues));

  // 帧率无效:任何时间换算都没有意义,全局阻断
  if (merged.frameRate === null) {
    return failure(
      'INVALID_FRAME_RATE',
      '帧率无效或缺失,无法进行帧到毫秒的换算,已中止导出',
      allProblems.filter((p) => p.code === 'INVALID_FRAME_RATE'),
      { format, language },
    );
  }

  // 无法归属到具体语言轨的 error:整体不可信,全局阻断
  const unattributedErrors = allProblems.filter((p) => p.severity === ERROR && !p.language);
  if (unattributedErrors.length > 0) {
    return failure(
      'UNATTRIBUTED_ERRORS',
      `存在 ${unattributedErrors.length} 个无法归属语言轨的错误,已中止全部导出`,
      unattributedErrors,
      { format, language },
    );
  }

  // 所选语言轨是否存在(以合并结果中实际存在的字幕为准)
  const trackTargets = [...merged.subtitles.values()].filter((s) => s.language === language);
  if (trackTargets.length === 0) {
    return failure(
      'UNKNOWN_LANGUAGE',
      `语言轨 '${language}' 不存在,没有任何字幕归属该轨`,
      [],
      { format, language },
    );
  }

  // 所选语言轨自身的问题:error 阻断,warning 仅透传
  const trackProblems = allProblems.filter((p) => p.language === language);
  const trackErrors = trackProblems.filter((p) => p.severity === ERROR);
  if (trackErrors.length > 0) {
    return failure(
      'TRACK_HAS_ERRORS',
      `语言轨 '${language}' 存在 ${trackErrors.length} 个错误,未生成半成品`,
      trackErrors,
      {
        format,
        language,
        warnings: trackProblems.filter((p) => p.severity === WARNING).map(stripSortKey),
      },
    );
  }

  // ---- 当前生效字幕(撤回的不导出),稳定排序:起始帧、结束帧、编号 ----
  const active = trackTargets
    .filter((s) => s.status !== 'withdrawn')
    .sort((a, b) =>
      a.startFrame - b.startFrame ||
      a.endFrame - b.endFrame ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((s) => ({ ...s }));

  // ---- 帧 → 毫秒(精确有理数,半毫秒向上);同帧共享换算结果 ----
  const frameMsCache = new Map();
  const frameToMs = (frame) => {
    const key = frame;
    if (!frameMsCache.has(key)) {
      const sec = Fraction.of(frame).div(merged.frameRate);
      frameMsCache.set(key, sec.toMillisecondsRounded());
    }
    return frameMsCache.get(key);
  };

  const cues = [];
  for (const s of active) {
    const startMs = frameToMs(s.startFrame);
    const endMs = frameToMs(s.endFrame);
    // 正帧区间(timeline 已保证 start < end 且非负)取整后压缩成零毫秒 → 明确失败
    if (endMs - startMs <= 0n) {
      return failure(
        'ZERO_DURATION_CUE',
        `字幕 ${s.id} 的正帧区间 [${s.startFrame}, ${s.endFrame}) 换算取整后时长为 0 毫秒,` +
          `无法生成有效 cue(起始 ${startMs}ms,结束 ${endMs}ms)`,
        [],
        { format, language, subtitleCount: 0 },
      );
    }
    cues.push({ id: s.id, startMs, endMs, text: s.text, speaker: s.speaker });
  }

  const text =
    format === 'srt'
      ? renderSrt(cues, includeSpeaker)
      : renderVtt(cues, includeSpeaker);

  return deepFreeze({
    ok: true,
    format,
    language,
    subtitleCount: cues.length,
    text,
    warnings: trackProblems.filter((p) => p.severity === WARNING).map(stripSortKey),
  });
}

/** 正文:保留原有换行;需要说话人时在最前面加 `说话人: ` 一行。 */
function cueBody(cue, includeSpeaker) {
  const body = cue.text;
  if (includeSpeaker && cue.speaker) return `${cue.speaker}: ${body}`;
  return body;
}

/**
 * 把字幕编号序列化成合法的 WebVTT cue identifier。
 *
 * WebVTT 规定 cue identifier 必须是单行、且不得包含时间箭头 `-->`。
 * 普通安全编号(不含 CR、LF、`-->`、转义符 `%`)原样保留(允许任意 Unicode);
 * 含上述字符的编号按确定性的百分号编码转换,并加固定前缀:
 *   换行 LF → %0A,回车 CR → %0D,`-->` → %2D%2D%3E,转义符 `%` → %25
 * 编码结果必含 `%`,而安全编号不含 `%`,因此安全标识与转义标识、
 * 以及任意两个不同原始编号之间都不会碰撞(映射是单射)。
 */
const VTT_ESCAPED_PREFIX = 'esc:';

function vttIdentifier(id) {
  if (!/[\r\n%]|-->/.test(id)) return id; // 安全编号原样
  const encoded = id.replace(/%|\r|\n|-->/g, (ch) => {
    if (ch === '%') return '%25';
    if (ch === '\r') return '%0D';
    if (ch === '\n') return '%0A';
    return '%2D%2D%3E'; // -->
  });
  return `${VTT_ESCAPED_PREFIX}${encoded}`;
}

function renderSrt(cues, includeSpeaker) {
  if (cues.length === 0) return '';
  const blocks = cues.map((cue, i) => {
    const header = `${i + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}`;
    return `${header}\n${cueBody(cue, includeSpeaker)}`;
  });
  // SRT 文件以末尾换行收尾
  return `${blocks.join('\n\n')}\n`;
}

function renderVtt(cues, includeSpeaker) {
  if (cues.length === 0) return 'WEBVTT\n'; // 空轨:只有文件头
  const blocks = cues.map((cue) => {
    // 字幕编号:使用文档中稳定的字幕 id;含换行/箭头等非法字符时经 vttIdentifier 转义
    const header = `${vttIdentifier(cue.id)}\n${vttTimestamp(cue.startMs)} --> ${vttTimestamp(cue.endMs)}`;
    return `${header}\n${cueBody(cue, includeSpeaker)}`;
  });
  // WEBVTT 文件头 + 空行;文件以末尾换行收尾
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

module.exports = { exportTrack };
