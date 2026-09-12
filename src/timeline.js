'use strict';

/**
 * 最终时轴检查:
 * - NEGATIVE_FRAME:任一帧号为负
 * - INVALID_INTERVAL:endFrame <= startFrame(反转或零时长)
 * - OVERLAPPING_SUBTITLES:同一语言轨内时间区间相交
 *
 * 区间按半开 [startFrame, endFrame) 处理:
 * 上一条的 endFrame 等于下一条的 startFrame(首尾相接)不算重叠。
 * 帧与帧率全部为整数/有理数比较,判定不含任何浮点运算。
 *
 * 已撤回(withdrawn)的字幕不参与最终时轴;
 * 区间本身无效的条目只报自身问题,不参与两两重叠判定,避免噪声。
 */

const { ProblemCollector } = require('./problems');

function checkTimeline(subtitles, frameRate) {
  const problems = new ProblemCollector();

  // 语言轨 -> 有效条目
  const tracks = new Map();

  for (const target of subtitles.values()) {
    const { id, language } = target;

    // 负帧:start/end 分别检查,一次报全
    if (target.startFrame < 0 || target.endFrame < 0) {
      problems.add(
        'NEGATIVE_FRAME',
        `字幕 ${id}(${language})存在负帧:startFrame=${target.startFrame}, endFrame=${target.endFrame}`,
        { language, targetId: id, sortKey: `${id}:negative` },
      );
    }

    // 无效区间
    if (target.endFrame <= target.startFrame) {
      problems.add(
        'INVALID_INTERVAL',
        `字幕 ${id}(${language})的区间无效:startFrame=${target.startFrame} >= endFrame=${target.endFrame}`,
        { language, targetId: id, startFrame: target.startFrame, endFrame: target.endFrame, sortKey: `${id}:interval` },
      );
    }

    if (target.status === 'withdrawn') continue;
    if (target.startFrame < 0 || target.endFrame < 0 || target.endFrame <= target.startFrame) continue;

    if (!tracks.has(language)) tracks.set(language, []);
    tracks.get(language).push({
      id,
      startFrame: target.startFrame,
      endFrame: target.endFrame,
    });
  }

  // 同轨重叠:稳定顺序(起始帧、结束帧、编号),逐对检查
  for (const [language, entries] of tracks.entries()) {
    entries.sort((a, b) =>
      a.startFrame - b.startFrame ||
      a.endFrame - b.endFrame ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        // 已按 start 排序,b.start >= a.start;b.start >= a.end 之后不可能再相交
        if (b.startFrame >= a.endFrame) break;
        if (a.startFrame < b.endFrame && b.startFrame < a.endFrame) {
          const overlapStart = Math.max(a.startFrame, b.startFrame);
          const overlapEnd = Math.min(a.endFrame, b.endFrame);
          // 稳定锚定:编号排序后较小者为 targetId,与数组排列无关
          const [first, second] = [a.id, b.id].sort();
          problems.add(
            'OVERLAPPING_SUBTITLES',
            `语言轨 ${language} 中字幕 ${first} 与 ${second} 时轴重叠` +
              `(区间 [${a.startFrame},${a.endFrame}) 与 [${b.startFrame},${b.endFrame}),重叠区间 [${overlapStart},${overlapEnd}))`,
            {
              language,
              targetId: first,
              otherTargetId: second,
              startFrame: overlapStart,
              endFrame: overlapEnd,
              sortKey: `${first}|${second}`,
            },
          );
        }
      }
    }
  }

  return { issues: problems.items, tracks };
}

module.exports = { checkTimeline };
