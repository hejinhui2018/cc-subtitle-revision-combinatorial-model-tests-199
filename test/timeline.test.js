'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, loadSubtitles } = require('../src/index');

const doc = (subtitles, revisions = [], frameRate = 25) => ({ frameRate, subtitles, revisions });
const sub = (id, language, startFrame, endFrame, extra = {}) => ({
  id, language, startFrame, endFrame, text: `t${id}`, speaker: null, ...extra,
});
const codesOf = (report) => report.problems.map((p) => p.code);

test('正常时轴:无问题,可交付', () => {
  const report = analyzeDocument(doc([
    sub(1, 'zh', 0, 100),
    sub(2, 'zh', 100, 200), // 首尾相接
    sub(3, 'en', 50, 150),  // 跨语言,与 zh 重叠不算
  ]));
  assert.deepEqual(codesOf(report), []);
  assert.equal(report.overall.deliverable, true);
  assert.deepEqual(report.tracks.map((t) => [t.language, t.deliverable]), [['en', true], ['zh', true]]);
});

test('首尾相接不算重叠', () => {
  const report = analyzeDocument(doc([sub(1, 'zh', 0, 100), sub(2, 'zh', 100, 200)]));
  assert.equal(report.problems.some((p) => p.code === 'OVERLAPPING_SUBTITLES'), false);
});

test('单帧重叠也要报', () => {
  const report = analyzeDocument(doc([sub(1, 'zh', 0, 101), sub(2, 'zh', 100, 200)]));
  const overlaps = report.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES');
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].startFrame, 100);
  assert.equal(overlaps[0].endFrame, 101);
});

test('完全包含的区间报重叠', () => {
  const report = analyzeDocument(doc([sub(1, 'zh', 0, 200), sub(2, 'zh', 50, 60)]));
  assert.equal(report.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES').length, 1);
});

test('多重重叠成对报全(3 条两两重叠 = 3 个问题)', () => {
  const report = analyzeDocument(doc([sub(1, 'zh', 0, 100), sub(2, 'zh', 50, 150), sub(3, 'zh', 120, 200)]));
  assert.equal(report.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES').length, 2); // 1-2, 2-3;1 与 3 不相交
  const all = analyzeDocument(doc([sub(1, 'zh', 0, 100), sub(2, 'zh', 10, 110), sub(3, 'zh', 20, 120)]));
  assert.equal(all.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES').length, 3);
});

test('重叠只在同一语言轨内判定', () => {
  const report = analyzeDocument(doc([
    sub(1, 'zh', 0, 100), sub(2, 'zh', 50, 150),
    sub(3, 'en', 0, 100), sub(4, 'en', 50, 150),
  ]));
  const overlaps = report.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES');
  assert.equal(overlaps.length, 2);
  assert.deepEqual(overlaps.map((o) => o.language).sort(), ['en', 'zh']);
});

test('负帧检查:start 或 end 为负都报', () => {
  const report = analyzeDocument(doc([
    sub(1, 'zh', -5, 100),
    sub(2, 'zh', -50, -10),
  ]));
  const negs = report.problems.filter((p) => p.code === 'NEGATIVE_FRAME');
  assert.equal(negs.length, 2);
});

test('无效区间:end <= start(反转与零时长)', () => {
  const report = analyzeDocument(doc([
    sub(1, 'zh', 100, 100), // 零时长
    sub(2, 'zh', 200, 100), // 反转
  ]));
  assert.equal(report.problems.filter((p) => p.code === 'INVALID_INTERVAL').length, 2);
});

test('无效区间的条目不参与重叠判定,避免连带噪声', () => {
  const report = analyzeDocument(doc([sub(1, 'zh', 100, 50), sub(2, 'zh', 60, 80)]));
  assert.equal(report.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES').length, 0);
  assert.equal(report.problems.filter((p) => p.code === 'INVALID_INTERVAL').length, 1);
});

test('撤回的字幕不参与最终时轴', () => {
  const report = analyzeDocument(doc(
    [sub(1, 'zh', 0, 100), sub(2, 'zh', 50, 150)],
    [{ revisionId: 'w', targetId: 2, version: 1, action: 'withdraw' }],
  ));
  assert.equal(report.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES').length, 0);
  assert.equal(report.tracks[0].withdrawnSubtitles, 1);
});

test('修订造成的重叠在最终时轴上被发现', () => {
  const report = analyzeDocument(doc(
    [sub(1, 'zh', 0, 100), sub(2, 'zh', 200, 300)],
    [{ revisionId: 'm', targetId: 2, version: 1, action: 'update', payload: { startFrame: 50 } }],
  ));
  assert.equal(report.problems.filter((p) => p.code === 'OVERLAPPING_SUBTITLES').length, 1);
  assert.equal(report.overall.deliverable, false);
});

test('交付结论:一轨有错只判该轨不可交付,整体仍为 false;重复警告不阻止交付', () => {
  const report = analyzeDocument(doc(
    [
      sub(1, 'zh', 0, 100), sub(2, 'zh', 50, 150), // zh 重叠
      sub(3, 'en', 0, 100),
    ],
    [{ revisionId: 'dup', targetId: 3, version: 1, action: 'update', payload: { text: 'x' } },
     { revisionId: 'dup', targetId: 3, version: 1, action: 'update', payload: { text: 'x' } }],
  ));
  const zh = report.tracks.find((t) => t.language === 'zh');
  const en = report.tracks.find((t) => t.language === 'en');
  assert.equal(zh.deliverable, false);
  assert.equal(en.deliverable, true); // 只有重复警告
  assert.equal(en.warningCount, 1);
  assert.equal(report.overall.deliverable, false);
});

test('帧率无效:整体不可交付,帧级检查仍执行', () => {
  const report = analyzeDocument(doc([sub(1, 'zh', 0, 100)], [], 0));
  assert.equal(report.frameRate, null);
  assert.equal(report.overall.frameRateValid, false);
  assert.equal(report.overall.deliverable, false);
});
