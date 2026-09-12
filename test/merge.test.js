'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeRevisions } = require('../src/index');

const baseDoc = (overrides = {}) => ({
  frameRate: 25,
  subtitles: [
    { id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: '原始一', speaker: 'A' },
    { id: 2, language: 'zh', startFrame: 100, endFrame: 200, text: '原始二', speaker: 'B' },
    { id: 3, language: 'en', startFrame: 0, endFrame: 100, text: 'one', speaker: 'C' },
  ],
  revisions: [],
  ...overrides,
});

const codes = (result) => result.issues.map((i) => i.code);

test('无修订:原始字幕原样生效,无问题', () => {
  const r = mergeRevisions(baseDoc());
  assert.deepEqual(codes(r), []);
  assert.equal(r.subtitles.get('1').text, '原始一');
  assert.equal(r.subtitles.get('1').status, 'active');
});

test('乱序到达:按版本号升序应用,与输入顺序无关', () => {
  const revisions = [
    { revisionId: 'a2', targetId: 1, version: 2, action: 'update', payload: { text: '第二次' } },
    { revisionId: 'a3', targetId: 1, version: 3, action: 'update', payload: { endFrame: 120 } },
    { revisionId: 'a1', targetId: 1, version: 1, action: 'update', payload: { text: '第一次' } },
  ];
  const r = mergeRevisions(baseDoc({ revisions }));
  assert.deepEqual(codes(r), []);
  const s = r.subtitles.get('1');
  assert.equal(s.text, '第二次');
  assert.equal(s.endFrame, 120);
  assert.deepEqual(s.history.filter((h) => h.status === 'applied').map((h) => h.version), [1, 2, 3]);
});

test('完全相同的重复修订只生效一次,给 DUPLICATE_REVISION 警告', () => {
  const rev = { revisionId: 'd1', targetId: 1, version: 1, action: 'update', payload: { text: 'X' } };
  const r = mergeRevisions(baseDoc({ revisions: [rev, rev, { ...rev }] }));
  const issues = r.issues.filter((i) => i.code === 'DUPLICATE_REVISION');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warning');
  assert.match(issues[0].message, /重复出现 3 次/);
  assert.equal(r.subtitles.get('1').text, 'X');
  // 历史中只应用一次
  assert.equal(r.subtitles.get('1').history.filter((h) => h.status === 'applied').length, 1);
});

test('对象键顺序不同但内容相同 = 同一修订(规范签名)', () => {
  const rev1 = { revisionId: 'k1', targetId: 1, version: 1, action: 'update', payload: { text: 'X', speaker: 'A' } };
  const rev2 = { payload: { speaker: 'A', text: 'X' }, action: 'update', version: 1, targetId: 1, revisionId: 'k1' };
  const r = mergeRevisions(baseDoc({ revisions: [rev1, rev2] }));
  assert.ok(r.issues.some((i) => i.code === 'DUPLICATE_REVISION'));
  assert.equal(r.subtitles.get('1').text, 'X');
});

test('同一修订编号对应不同内容:REVISION_CONFLICT 且全部不生效', () => {
  const revisions = [
    { revisionId: 'c1', targetId: 1, version: 1, action: 'update', payload: { text: '版本A' } },
    { revisionId: 'c1', targetId: 1, version: 1, action: 'update', payload: { text: '版本B' } },
  ];
  const r = mergeRevisions(baseDoc({ revisions }));
  assert.ok(r.issues.some((i) => i.code === 'REVISION_CONFLICT' && i.severity === 'error'));
  assert.equal(r.subtitles.get('1').text, '原始一');
  assert.ok(r.subtitles.get('1').history.every((h) => h.status !== 'applied' || h.kind === 'origin'));
});

test('同一修订编号改动作也算冲突', () => {
  const revisions = [
    { revisionId: 'c2', targetId: 2, version: 1, action: 'update', payload: { text: 'x' } },
    { revisionId: 'c2', targetId: 2, version: 1, action: 'withdraw' },
  ];
  const r = mergeRevisions(baseDoc({ revisions }));
  assert.ok(r.issues.some((i) => i.code === 'REVISION_CONFLICT'));
  assert.equal(r.subtitles.get('2').status, 'active');
});

test('版本缺口:中间缺版本要报 VERSION_GAP,但已有版本仍顺序应用', () => {
  const revisions = [
    { revisionId: 'g1', targetId: 1, version: 1, action: 'update', payload: { text: '一' } },
    { revisionId: 'g3', targetId: 1, version: 3, action: 'update', payload: { text: '三' } },
  ];
  const r = mergeRevisions(baseDoc({ revisions }));
  const gaps = r.issues.filter((i) => i.code === 'VERSION_GAP');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].version, 2);
  assert.equal(r.subtitles.get('1').text, '三'); // v1、v3 仍生效
});

test('版本从 2 开始:报 v1 缺口', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [{ revisionId: 'g2', targetId: 1, version: 2, action: 'update', payload: { text: 'x' } }],
  }));
  assert.equal(r.issues.filter((i) => i.code === 'VERSION_GAP')[0].version, 1);
});

test('引用不存在的字幕:DANGLING_REVISION', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [{ revisionId: 'x1', targetId: 999, version: 1, action: 'withdraw' }],
  }));
  const d = r.issues.filter((i) => i.code === 'DANGLING_REVISION');
  assert.equal(d.length, 1);
  assert.equal(d[0].targetId, '999');
  assert.match(d[0].message, /x1/);
});

test('撤回生效后继续修改:REVISION_AFTER_WITHDRAW 且修改被忽略', () => {
  const revisions = [
    { revisionId: 'w1', targetId: 1, version: 1, action: 'withdraw' },
    { revisionId: 'w2', targetId: 1, version: 2, action: 'update', payload: { text: '不应生效' } },
  ];
  const r = mergeRevisions(baseDoc({ revisions }));
  const after = r.issues.filter((i) => i.code === 'REVISION_AFTER_WITHDRAW');
  assert.equal(after.length, 1);
  assert.equal(after[0].revisionId, 'w2');
  assert.equal(r.subtitles.get('1').status, 'withdrawn');
  assert.notEqual(r.subtitles.get('1').text, '不应生效');
});

test('撤回之后又撤回:同样算撤回后修改', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [
      { revisionId: 'w1', targetId: 2, version: 1, action: 'withdraw' },
      { revisionId: 'w2', targetId: 2, version: 2, action: 'withdraw' },
    ],
  }));
  assert.equal(r.issues.filter((i) => i.code === 'REVISION_AFTER_WITHDRAW').length, 1);
});

test('撤回修订携带负载:INVALID_REVISION_PAYLOAD 且不撤回', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [{ revisionId: 'wp', targetId: 1, version: 1, action: 'withdraw', payload: { text: 'x' } }],
  }));
  assert.ok(r.issues.some((i) => i.code === 'INVALID_REVISION_PAYLOAD'));
  assert.equal(r.subtitles.get('1').status, 'active');
});

test('同版本多条不同修订:DUPLICATE_VERSION,该版本全部不应用', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [
      { revisionId: 'p1', targetId: 1, version: 1, action: 'update', payload: { text: 'A' } },
      { revisionId: 'p2', targetId: 1, version: 1, action: 'update', payload: { text: 'B' } },
      { revisionId: 'p3', targetId: 1, version: 2, action: 'update', payload: { text: 'C' } },
    ],
  }));
  assert.ok(r.issues.some((i) => i.code === 'DUPLICATE_VERSION'));
  assert.equal(r.subtitles.get('1').text, 'C'); // v1 跳过,v2 正常
});

test('更新非法字段(编号/语言轨):INVALID_REVISION_PAYLOAD', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [{ revisionId: 'b1', targetId: 1, version: 1, action: 'update', payload: { id: 9, language: 'en' } }],
  }));
  assert.ok(r.issues.some((i) => i.code === 'INVALID_REVISION_PAYLOAD'));
  assert.equal(r.subtitles.get('1').id, '1');
  assert.equal(r.subtitles.get('1').language, 'zh');
});

test('更新负载类型错误:不应用并报错', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [{ revisionId: 'b2', targetId: 1, version: 1, action: 'update', payload: { startFrame: 'oops' } }],
  }));
  assert.ok(r.issues.some((i) => i.code === 'INVALID_REVISION_PAYLOAD'));
  assert.equal(r.subtitles.get('1').startFrame, 0);
});

test('修订结构问题:缺字段、坏动作、坏版本号 都要收集,不静默丢弃', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [
      { revisionId: 'm1', targetId: 1, version: 1 }, // 缺 action
      { revisionId: 'm2', targetId: 1, version: 1, action: 'delete' }, // 坏动作
      { revisionId: 'm3', targetId: 1, version: 0, action: 'update', payload: { text: 'x' } }, // 坏版本
      { targetId: 1, version: 1, action: 'withdraw' }, // 缺 revisionId
      null, // 根本不是对象
    ],
  }));
  const invalid = r.issues.filter((i) => i.code === 'INVALID_REVISION');
  assert.equal(invalid.length, 5);
});

test('原始字幕缺字段/坏帧号:INVALID_SUBTITLE', () => {
  const r = mergeRevisions({
    frameRate: 25,
    subtitles: [
      { id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: '好' },
      { id: 2, language: 'zh', startFrame: 'x', endFrame: 100, text: '坏帧' },
      { id: 3, language: '', startFrame: 0, endFrame: 100, text: '坏语言' },
      { language: 'zh', startFrame: 0, endFrame: 100, text: '无编号' },
    ],
    revisions: [],
  });
  const bad = r.issues.filter((i) => i.code === 'INVALID_SUBTITLE');
  assert.equal(bad.length, 3);
  assert.ok(r.subtitles.has('1'));
});

test('原始字幕编号重复:DUPLICATE_SUBTITLE_ID,均不纳入', () => {
  const r = mergeRevisions({
    frameRate: 25,
    subtitles: [
      { id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: 'A' },
      { id: 1, language: 'zh', startFrame: 0, endFrame: 100, text: 'B' },
    ],
    revisions: [],
  });
  assert.ok(r.issues.some((i) => i.code === 'DUPLICATE_SUBTITLE_ID'));
  assert.equal(r.subtitles.has('1'), false);
});

test('帧率:整数、分子分母、字符串分数均可;坏帧率/缺帧率报错', () => {
  assert.equal(mergeRevisions(baseDoc({ frameRate: 25 })).frameRate.toString(), '25');
  assert.equal(mergeRevisions(baseDoc({ frameRate: { numerator: 30000, denominator: 1001 } })).frameRate.toString(), '30000/1001');
  assert.equal(mergeRevisions(baseDoc({ frameRate: '24000/1001' })).frameRate.toString(), '24000/1001');
  const bad = mergeRevisions(baseDoc({ frameRate: 0 }));
  assert.ok(bad.issues.some((i) => i.code === 'INVALID_FRAME_RATE'));
  assert.equal(bad.frameRate, null);
  const doc = baseDoc();
  delete doc.frameRate;
  const missing = mergeRevisions(doc);
  assert.ok(missing.issues.some((i) => i.code === 'INVALID_FRAME_RATE'));
  assert.equal(missing.frameRate, null);
});

test('历史记录包含原始快照与每条修订的状态', () => {
  const r = mergeRevisions(baseDoc({
    revisions: [
      { revisionId: 'h1', targetId: 1, version: 1, action: 'update', payload: { text: '一' } },
      { revisionId: 'h2', targetId: 1, version: 2, action: 'withdraw' },
    ],
  }));
  const h = r.subtitles.get('1').history;
  assert.equal(h[0].kind, 'origin');
  assert.equal(h[0].snapshot.text, '原始一');
  assert.deepEqual(h.slice(1).map((x) => [x.revisionId, x.status]), [['h1', 'applied'], ['h2', 'applied']]);
  assert.equal(h[1].snapshot.text, '一');
  assert.equal(h[2].snapshot.text, '一'); // 撤回时快照仍为当前文本
});

test('一次输入中的多个问题全部返回', () => {
  const r = mergeRevisions(baseDoc({
    frameRate: -1,
    revisions: [
      { revisionId: 'c1', targetId: 1, version: 1, action: 'update', payload: { text: 'A' } },
      { revisionId: 'c1', targetId: 1, version: 1, action: 'update', payload: { text: 'B' } },
      { revisionId: 'x', targetId: 404, version: 1, action: 'withdraw' },
      { revisionId: 'g', targetId: 2, version: 5, action: 'withdraw' },
    ],
  }));
  const codeSet = new Set(codes(r));
  for (const c of ['INVALID_FRAME_RATE', 'REVISION_CONFLICT', 'DANGLING_REVISION', 'VERSION_GAP']) {
    assert.ok(codeSet.has(c), `应包含 ${c}`);
  }
});

test('speaker 缺省为 null,更新可改可清空', () => {
  const r = mergeRevisions({
    frameRate: 25,
    subtitles: [{ id: 1, language: 'zh', startFrame: 0, endFrame: 10, text: 'x' }],
    revisions: [
      { revisionId: 's1', targetId: 1, version: 1, action: 'update', payload: { speaker: '嘉宾' } },
      { revisionId: 's2', targetId: 1, version: 2, action: 'update', payload: { speaker: null } },
    ],
  });
  assert.equal(r.subtitles.get('1').speaker, null);
  assert.deepEqual(
    r.subtitles.get('1').history.filter((h) => h.status === 'applied').map((h) => h.payload.speaker),
    ['嘉宾', null],
  );
});
