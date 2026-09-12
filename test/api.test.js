'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, loadSubtitles } = require('../src/index');

const document = {
  frameRate: { numerator: 30000, denominator: 1001 },
  subtitles: [
    { id: 1, language: 'zh', startFrame: 0, endFrame: 300, text: '第一句', speaker: '甲' },
    { id: 2, language: 'zh', startFrame: 300, endFrame: 600, text: '第二句', speaker: '乙' },
    { id: 3, language: 'en', startFrame: 150, endFrame: 450, text: 'hello', speaker: 'Ann' },
  ],
  revisions: [
    { revisionId: 'r2', targetId: 1, version: 2, action: 'update', payload: { text: '第一句(改)' } },
    { revisionId: 'r1', targetId: 1, version: 1, action: 'update', payload: { speaker: '主持人' } },
  ],
};

test('getSubtitle:原始内容 + 修订历史 + 当前生效内容', () => {
  const store = loadSubtitles(document);
  const s = store.getSubtitle(1);
  assert.equal(s.original.text, '第一句');
  assert.equal(s.original.speaker, '甲');
  assert.equal(s.current.text, '第一句(改)');
  assert.equal(s.current.speaker, '主持人');
  assert.equal(s.status, 'active');
  assert.deepEqual(s.history.map((h) => h.version), [1, 2]); // 乱序到达但历史按版本
  assert.deepEqual(s.history.map((h) => h.status), ['applied', 'applied']);
  assert.equal(s.history[0].resultingState.speaker, '主持人');
  assert.equal(s.history[1].resultingState.text, '第一句(改)');
});

test('getSubtitle:数字编号与字符串编号等价;不存在返回 null', () => {
  const store = loadSubtitles(document);
  assert.equal(store.getSubtitle(1).id, '1');
  assert.equal(store.getSubtitle('1').current.text, '第一句(改)');
  assert.equal(store.getSubtitle(999), null);
});

test('getSubtitle:撤回字幕 current 为 null 但历史完整', () => {
  const store = loadSubtitles({
    frameRate: 25,
    subtitles: [{ id: 7, language: 'zh', startFrame: 0, endFrame: 10, text: '再见', speaker: null }],
    revisions: [
      { revisionId: 'w', targetId: 7, version: 1, action: 'update', payload: { text: '再见!' } },
      { revisionId: 'w2', targetId: 7, version: 2, action: 'withdraw' },
    ],
  });
  const s = store.getSubtitle(7);
  assert.equal(s.status, 'withdrawn');
  assert.equal(s.current, null);
  assert.equal(s.original.text, '再见');
  assert.equal(s.history.length, 2);
  assert.equal(store.currentSubtitles().length, 0);
});

test('subtitlesAtFrame:半开区间边界 — 结束帧不命中,首尾相接只命中后一条', () => {
  const store = loadSubtitles(document);
  assert.deepEqual(store.subtitlesAtFrame(0, 'zh').map((s) => s.id), ['1']);
  assert.deepEqual(store.subtitlesAtFrame(299, 'zh').map((s) => s.id), ['1']);
  // frame 300:字幕 1 已结束,字幕 2 刚开始(首尾相接)
  assert.deepEqual(store.subtitlesAtFrame(300, 'zh').map((s) => s.id), ['2']);
  assert.deepEqual(store.subtitlesAtFrame(600, 'zh').map((s) => s.id), []);
});

test('subtitlesAtFrame:跨语言同帧可命中多条,可按语言过滤', () => {
  const store = loadSubtitles(document);
  const hits = store.subtitlesAtFrame(200);
  assert.deepEqual(hits.map((s) => [s.language, s.id]).sort(), [['en', '3'], ['zh', '1']]);
  assert.deepEqual(store.subtitlesAtFrame(200, 'en').map((s) => s.id), ['3']);
  assert.deepEqual(store.subtitlesAtFrame(200, ['zh']).map((s) => s.id), ['1']);
});

test('subtitlesAtFrame:坏帧号抛错', () => {
  const store = loadSubtitles(document);
  assert.throws(() => store.subtitlesAtFrame(1.5), /安全整数/);
  assert.throws(() => store.subtitlesAtFrame('x'), /安全整数/);
});

test('帧→时间换算精确(29.97fps),仅展示用途', () => {
  const store = loadSubtitles(document);
  assert.equal(store.frameToSeconds(30000), '1001.000');
  assert.equal(store.frameToTimecode(30000), '00:16:41.000');
  assert.equal(store.frameToTimecode(1), '00:00:00.033');
});

test('返回结果深度冻结:无法从外部篡改内部状态', () => {
  const store = loadSubtitles(document);
  const s = store.getSubtitle(1);
  assert.throws(() => { s.current.text = '黑入'; }, TypeError);
  assert.throws(() => { s.history.push({}); }, TypeError);
  const hits = store.subtitlesAtFrame(0);
  assert.throws(() => { hits[0].text = 'x'; }, TypeError);
  assert.throws(() => { hits.push({}); }, TypeError);
  const report = analyzeDocument(document);
  assert.throws(() => { report.problems.push({}); }, TypeError);
  // 再次查询仍是原值
  assert.equal(store.getSubtitle(1).current.text, '第一句(改)');
});

test('查询方法返回的是副本,两次结果互不相干', () => {
  const store = loadSubtitles(document);
  const a = store.getSubtitle(1);
  const b = store.getSubtitle(1);
  assert.notEqual(a, b);
  assert.notEqual(a.current, b.current);
  assert.deepEqual(a, b);
});

test('输入接受 JSON 字符串', () => {
  const store = loadSubtitles(JSON.stringify(document));
  assert.equal(store.getSubtitle(2).current.text, '第二句');
  const report = analyzeDocument(JSON.stringify(document));
  assert.equal(report.overall.deliverable, true);
});

test('排列无关性:打乱字幕与修订数组,最终报告完全一致', () => {
  const shuffle = (arr) => {
    const a = arr.slice();
    // 固定的确定性置换(不依赖随机数)
    for (let i = a.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const shuffled = {
    ...document,
    subtitles: shuffle(document.subtitles),
    revisions: shuffle(document.revisions),
  };
  const r1 = analyzeDocument(document);
  const r2 = analyzeDocument(shuffled);
  assert.deepEqual(JSON.parse(JSON.stringify(r2)), JSON.parse(JSON.stringify(r1)));

  // 再换一种置换,问题顺序仍一致
  const shuffled2 = {
    ...document,
    subtitles: shuffle(shuffled.subtitles),
    revisions: shuffle(shuffled.revisions),
  };
  const r3 = analyzeDocument(shuffled2);
  assert.deepEqual(
    r3.problems.map((p) => [p.code, p.targetId, p.revisionId]),
    r1.problems.map((p) => [p.code, p.targetId, p.revisionId]),
  );
  assert.equal(r3.overall.deliverable, r1.overall.deliverable);
});

test('排列无关性:同一批问题的输出顺序在不同排列下稳定', () => {
  const entries = [
    { id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: 'a', speaker: null },
    { id: 2, language: 'zh', startFrame: 50, endFrame: 150, text: 'b', speaker: null },
    { id: 3, language: 'en', startFrame: 0, endFrame: 100, text: 'c', speaker: null },
  ];
  const revs = [
    { revisionId: 'x1', targetId: 901, version: 1, action: 'withdraw' },
    { revisionId: 'x2', targetId: 902, version: 1, action: 'withdraw' },
  ];
  const make = (subs, revisions) => ({ frameRate: 0, subtitles: subs, revisions });
  const a = analyzeDocument(make(entries, revs));
  const b = analyzeDocument(make([entries[2], entries[0], entries[1]], [revs[1], revs[0]]));
  assert.deepEqual(
    a.problems.map((p) => `${p.code}:${p.language ?? ''}:${p.targetId ?? ''}:${p.revisionId ?? ''}`),
    b.problems.map((p) => `${p.code}:${p.language ?? ''}:${p.targetId ?? ''}:${p.revisionId ?? ''}`),
  );
});

test('问题一次性全部返回且按稳定顺序排列(类别 → 语言 → 目标 → 修订)', () => {
  const report = analyzeDocument({
    frameRate: 25,
    subtitles: [
      { id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: 'a', speaker: null },
      { id: 2, language: 'zh', startFrame: 50, endFrame: 150, text: 'b', speaker: null }, // 与 1 重叠
      { id: 3, language: 'en', startFrame: 200, startFrame2: 0, endFrame: 100, text: 'c', speaker: null },
    ],
    revisions: [
      { revisionId: 'c', targetId: 1, version: 1, action: 'update', payload: { text: 'A' } },
      { revisionId: 'c', targetId: 1, version: 1, action: 'update', payload: { text: 'B' } }, // 冲突
      { revisionId: 'd', targetId: 404, version: 1, action: 'withdraw' }, // 孤立
    ],
  });
  const codes = report.problems.map((p) => p.code);
  // REVISION_CONFLICT 在 DANGLING 之前,DANGLING 在 OVERLAPPING 之前
  assert.ok(codes.indexOf('REVISION_CONFLICT') < codes.indexOf('DANGLING_REVISION'));
  assert.ok(codes.indexOf('DANGLING_REVISION') < codes.indexOf('OVERLAPPING_SUBTITLES'));
  assert.equal(report.overall.errorCount, codes.filter((c) => c).length);
});

test('listIds 与 currentSubtitles 稳定排序,撤回条目不出现', () => {
  const store = loadSubtitles({
    frameRate: 25,
    subtitles: [
      { id: 3, language: 'zh', startFrame: 200, endFrame: 300, text: 'c', speaker: null },
      { id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: 'a', speaker: null },
      { id: 2, language: 'en', startFrame: 0, endFrame: 100, text: 'b', speaker: null },
    ],
    revisions: [{ revisionId: 'w', targetId: 3, version: 1, action: 'withdraw' }],
  });
  assert.deepEqual(store.listIds(), ['2', '1', '3']); // en 先;zh 内按起始帧
  assert.deepEqual(store.currentSubtitles().map((s) => s.id), ['2', '1']);
  assert.deepEqual(store.currentSubtitles('zh').map((s) => s.id), ['1']);
});
