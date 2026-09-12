'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeDocument, loadSubtitles } = require('../src/index');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'sample-input.json'), 'utf8'));

test('综合示例:乱序修订 + 编号冲突 + 时轴重叠同时出现,结论与问题齐全', () => {
  const report = analyzeDocument(sample);

  const codes = report.problems.map((p) => p.code);
  for (const c of [
    'REVISION_CONFLICT',
    'DUPLICATE_REVISION',
    'VERSION_GAP',
    'DANGLING_REVISION',
    'REVISION_AFTER_WITHDRAW',
    'OVERLAPPING_SUBTITLES',
  ]) {
    assert.ok(codes.includes(c), `应报告 ${c}`);
  }

  // 警告不阻止交付,错误阻止:en 轨干净,zh 轨不可交付,整体不可交付
  const en = report.tracks.find((t) => t.language === 'en');
  const zh = report.tracks.find((t) => t.language === 'zh');
  assert.equal(en.deliverable, true);
  assert.equal(zh.deliverable, false);
  assert.equal(report.overall.deliverable, false);
  assert.equal(report.overall.errorCount, 5);
  assert.equal(report.overall.warningCount, 1);

  // 乱序修订仍按版本应用:S1 收到 v1(改说话人)、v2、v3,最终文本是 v3
  const store = loadSubtitles(sample);
  const s1 = store.getSubtitle('S1');
  assert.equal(s1.current.speaker, '主播');
  assert.equal(s1.current.text, '大家好,欢迎收看本期节目!');
  assert.deepEqual(s1.history.map((h) => h.version), [1, 2, 3]);

  // 冲突修订 r200 两条都不生效:S2 保持原始文本
  assert.equal(store.getSubtitle('S2').current.text, '欢迎收看本期节目。');

  // S4 被撤回,r401 的修改被忽略
  assert.equal(store.getSubtitle('S4').status, 'withdrawn');
  assert.equal(store.getSubtitle('S4').current, null);

  // 重叠信息带具体区间
  const overlap = report.problems.find((p) => p.code === 'OVERLAPPING_SUBTITLES');
  assert.equal(overlap.language, 'zh');
  assert.equal(overlap.startFrame, 200);
  assert.equal(overlap.endFrame, 300);
});

test('综合示例:打乱全部数组顺序后报告完全一致', () => {
  const permute = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = (i * 11 + 5) % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const shuffled = {
    frameRate: sample.frameRate,
    subtitles: permute(sample.subtitles),
    revisions: permute(sample.revisions),
  };
  const a = analyzeDocument(sample);
  const b = analyzeDocument(shuffled);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
});

test('修订可以引入负帧与无效区间,最终时轴照样报出', () => {
  const report = analyzeDocument({
    frameRate: 25,
    subtitles: [{ id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: 'a', speaker: null }],
    revisions: [
      { revisionId: 'r1', targetId: 1, version: 1, action: 'update', payload: { startFrame: -10 } },
    ],
  });
  assert.ok(report.problems.some((p) => p.code === 'NEGATIVE_FRAME'));
  assert.equal(report.overall.deliverable, false);
});

test('处理过程不修改输入对象', () => {
  const input = {
    frameRate: 25,
    subtitles: [{ id: 1, language: 'zh', startFrame: 0, endFrame: 10, text: 'a', speaker: null }],
    revisions: [
      { revisionId: 'r', targetId: 1, version: 1, action: 'update', payload: { text: 'b' } },
      { revisionId: 'r', targetId: 1, version: 1, action: 'update', payload: { text: 'b' } },
    ],
  };
  const snapshot = JSON.stringify(input);
  analyzeDocument(input);
  loadSubtitles(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('查询结果嵌套结构也被冻结(历史负载、问题附加字段)', () => {
  const store = loadSubtitles(sample);
  const s1 = store.getSubtitle('S1');
  assert.throws(() => { s1.history[0].payload.text = 'x'; }, TypeError);
  assert.throws(() => { s1.history[0].resultingState.text = 'x'; }, TypeError);
  assert.throws(() => { store.issues[0].otherTargetIds?.push('X'); }, TypeError);
});

test('非法输入文档不崩溃,而是返回 INVALID_DOCUMENT 且结论不可交付', () => {
  assert.equal(analyzeDocument(null).overall.deliverable, false);
  assert.ok(analyzeDocument(null).problems.some((p) => p.code === 'INVALID_DOCUMENT'));
  assert.throws(() => analyzeDocument('{bad json'), SyntaxError); // JSON 字符串解析错误抛给调用方
  const report = analyzeDocument({ subtitles: [], revisions: [] });
  assert.ok(report.problems.some((p) => p.code === 'INVALID_FRAME_RATE'));
});
