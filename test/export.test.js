'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exportTrack, Fraction } = require('../src/index');

/** 构造一份干净的双轨文档(默认 29.97fps),可按需覆写。 */
function makeDoc(overrides = {}) {
  return {
    frameRate: { numerator: 30000, denominator: 1001 },
    subtitles: [
      { id: 'S2', language: 'zh', startFrame: 150, endFrame: 300, text: '第二句', speaker: '乙' },
      { id: 'S1', language: 'zh', startFrame: 0, endFrame: 150, text: '第一句', speaker: '甲' },
      { id: 'E1', language: 'en', startFrame: 0, endFrame: 150, text: 'First line.\nSecond line.', speaker: 'Ann' },
    ],
    revisions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- 成功路径

test('整数帧率:SRT 时间戳 HH:MM:SS,mmm,序号从 1 连续,按帧排序', () => {
  const doc = makeDoc({ frameRate: 25, subtitles: [
    { id: 'b', language: 'zh', startFrame: 25, endFrame: 50, text: 'B', speaker: null },
    { id: 'a', language: 'zh', startFrame: 0, endFrame: 25, text: 'A', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'srt');
  assert.equal(r.language, 'zh');
  assert.equal(r.subtitleCount, 2);
  assert.equal(
    r.text,
    '1\n' +
      '00:00:00,000 --> 00:00:01,000\n' +
      'A\n\n' +
      '2\n' +
      '00:00:01,000 --> 00:00:02,000\n' +
      'B\n',
  );
});

test('30000/1001:精确有理数换算,第 150 帧恰为 5005ms', () => {
  const r = exportTrack(makeDoc(), { language: 'zh', format: 'srt' });
  assert.equal(r.ok, true);
  // 一帧 ≈ 33.3667ms;150 帧 = 5005ms 整,300 帧 = 10010ms 整
  assert.match(r.text, /1\n00:00:00,000 --> 00:00:05,005\n/);
  assert.match(r.text, /2\n00:00:05,005 --> 00:00:10,010\n/);
});

test('四舍五入:第 1 帧 33ms、第 2 帧 67ms;恰好半毫秒向上', () => {
  // 30000/1001 下第 15 帧 = 500.5ms → 必须向上取 501
  const doc = makeDoc({ subtitles: [
    { id: 'x', language: 'zh', startFrame: 1, endFrame: 2, text: 'a', speaker: null },
    { id: 'y', language: 'zh', startFrame: 2, endFrame: 15, text: 'b', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(r.ok, true);
  assert.match(r.text, /00:00:00,033 --> 00:00:00,067/);
  assert.match(r.text, /00:00:00,067 --> 00:00:00,501/);

  // 底层 Fraction 直接核对若干取整边界
  const fr = new Fraction(30000, 1001);
  const ms = (f) => Fraction.of(f).div(fr).toMillisecondsRounded();
  assert.equal(ms(0), 0n);
  assert.equal(ms(1), 33n);   // 33.366
  assert.equal(ms(2), 67n);   // 66.733
  assert.equal(ms(15), 501n); // 500.5 恰好半毫秒,向上
  assert.equal(ms(150), 5005n);
});

test('共享帧边界:上一条结束与下一条开始时间戳完全一致', () => {
  const r = exportTrack(makeDoc(), { language: 'zh', format: 'srt' });
  const shared = r.text.match(/--> (00:00:05,005)[\s\S]*?\n2\n(00:00:05,005) -->/);
  assert.ok(shared);
  assert.equal(shared[1], shared[2]);
});

test('WebVTT:WEBVTT 文件头、字幕编号、点号时间戳', () => {
  const r = exportTrack(makeDoc(), { language: 'en', format: 'vtt' });
  assert.equal(r.ok, true);
  assert.equal(
    r.text,
    'WEBVTT\n\n' +
      'E1\n' +
      '00:00:00.000 --> 00:00:05.005\n' +
      'First line.\nSecond line.\n',
  );
});

test('多行文本原有换行完整保留(SRT 与 VTT)', () => {
  for (const format of ['srt', 'vtt']) {
    const r = exportTrack(makeDoc(), { language: 'en', format });
    assert.ok(r.text.includes('First line.\nSecond line.'), format);
  }
});

test('说话人默认不加入正文', () => {
  const r = exportTrack(makeDoc(), { language: 'zh', format: 'srt' });
  assert.ok(!r.text.includes('甲'));
  assert.ok(r.text.includes('第一句'));
});

test('includeSpeaker:true 时在正文前加「说话人: 」;无说话人时不加', () => {
  const doc = makeDoc({ subtitles: [
    { id: 's1', language: 'zh', startFrame: 0, endFrame: 150, text: '你好\n再见', speaker: '主持人' },
    { id: 's2', language: 'zh', startFrame: 150, endFrame: 300, text: '无主', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'vtt', includeSpeaker: true });
  assert.match(r.text, /s1\n[\d:. -->]+\n主持人: 你好\n再见/);
  assert.match(r.text, /s2\n[\d:. -->]+\n无主/);
  assert.ok(!/null: /.test(r.text));
});

test('撤回的字幕不导出(修订合并后仍生效的才导出)', () => {
  const doc = makeDoc({ revisions: [
    { revisionId: 'w1', targetId: 'S1', version: 1, action: 'withdraw' },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(r.ok, true);
  assert.equal(r.subtitleCount, 1);
  assert.ok(!r.text.includes('第一句'));
  assert.ok(r.text.includes('第二句'));
  // 撤回后剩下的一条重新从 1 编号
  assert.match(r.text, /^1\n/);
});

test('整条语言轨全部撤回:空轨导出成功,数量 0,SRT 空串 / VTT 仅文件头', () => {
  const doc = {
    frameRate: 25,
    subtitles: [
      { id: 1, language: 'ja', startFrame: 0, endFrame: 10, text: 'あ', speaker: null },
      { id: 2, language: 'ja', startFrame: 10, endFrame: 20, text: 'い', speaker: null },
    ],
    revisions: [
      { revisionId: 'w1', targetId: 1, version: 1, action: 'withdraw' },
      { revisionId: 'w2', targetId: 2, version: 1, action: 'withdraw' },
    ],
  };
  const srt = exportTrack(doc, { language: 'ja', format: 'srt' });
  assert.equal(srt.ok, true);
  assert.equal(srt.subtitleCount, 0);
  assert.equal(srt.text, '');
  const vtt = exportTrack(doc, { language: 'ja', format: 'vtt' });
  assert.equal(vtt.ok, true);
  assert.equal(vtt.text, 'WEBVTT\n');
});

test('接受 JSON 字符串输入,结果深冻结', () => {
  const r = exportTrack(JSON.stringify(makeDoc()), { language: 'zh', format: 'srt' });
  assert.equal(r.ok, true);
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.warnings));
  assert.throws(() => r.warnings.push({}), TypeError);
});

// ---------------------------------------------------------------- 隔离与阻断

test('多语言隔离:其他语言轨的错误不阻止干净轨导出', () => {
  const doc = makeDoc({ subtitles: [
    { id: 'S1', language: 'zh', startFrame: 0, endFrame: 150, text: '中文', speaker: null },
    // en 轨两条重叠
    { id: 'E1', language: 'en', startFrame: 0, endFrame: 200, text: 'a', speaker: null },
    { id: 'E2', language: 'en', startFrame: 100, endFrame: 300, text: 'b', speaker: null },
  ] });
  const zh = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(zh.ok, true);
  assert.ok(zh.text.includes('中文'));
  const en = exportTrack(doc, { language: 'en', format: 'srt' });
  assert.equal(en.ok, false);
  assert.equal(en.reasonCode, 'TRACK_HAS_ERRORS');
  assert.ok(en.problems.some((p) => p.code === 'OVERLAPPING_SUBTITLES'));
  assert.equal(en.text, '');
});

test('warning 不阻止导出,并在 warnings 中回传(重复修订只生效一次)', () => {
  const dup = { revisionId: 'r1', targetId: 'S1', version: 1, action: 'update', payload: { text: '第一句(改)' } };
  const doc = makeDoc({ revisions: [dup, { ...dup }] });
  const r = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(r.ok, true);
  assert.equal(r.subtitleCount, 2);
  assert.ok(r.text.includes('第一句(改)'));
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'DUPLICATE_REVISION');
});

test('所选语言轨自身有 error 时阻断,不生成半成品', () => {
  const doc = makeDoc({ subtitles: [
    { id: 'S1', language: 'zh', startFrame: 0, endFrame: 200, text: 'a', speaker: null },
    { id: 'S2', language: 'zh', startFrame: 100, endFrame: 300, text: 'b', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'TRACK_HAS_ERRORS');
  assert.equal(r.format, 'srt');
  assert.equal(r.language, 'zh');
  assert.equal(r.subtitleCount, 0);
  assert.equal(r.text, '');
  assert.ok(r.problems.some((p) => p.code === 'OVERLAPPING_SUBTITLES'));
});

test('无法归属语言轨的 error(孤立修订)全局阻断,干净轨也不能导出', () => {
  const doc = makeDoc({ revisions: [
    { revisionId: 'x', targetId: 'NOPE', version: 1, action: 'withdraw' },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'UNATTRIBUTED_ERRORS');
  assert.ok(r.problems.some((p) => p.code === 'DANGLING_REVISION'));
  assert.equal(r.text, '');
});

test('帧率无效:全局阻断,原因 INVALID_FRAME_RATE', () => {
  const doc = makeDoc({ frameRate: 0 });
  const r = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'INVALID_FRAME_RATE');
  assert.ok(r.problems.some((p) => p.code === 'INVALID_FRAME_RATE'));
  assert.equal(r.text, '');
});

test('不存在的语言轨:可识别的失败原因 UNKNOWN_LANGUAGE', () => {
  const r = exportTrack(makeDoc(), { language: 'fr', format: 'srt' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'UNKNOWN_LANGUAGE');
  assert.equal(r.language, 'fr');
  assert.equal(r.text, '');
  assert.equal(r.problems.length, 0);
});

test('正帧区间换算取整后压缩成零毫秒:明确失败,不生成无效 cue', () => {
  // 3000fps:一帧 = 1/3 ms,四舍五入为 0ms
  const doc = {
    frameRate: 3000,
    subtitles: [
      { id: 'a', language: 'zh', startFrame: 0, endFrame: 1, text: '零毫秒', speaker: null },
      { id: 'b', language: 'zh', startFrame: 2, endFrame: 5, text: '正常', speaker: null },
    ],
    revisions: [],
  };
  const r = exportTrack(doc, { language: 'zh', format: 'vtt' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'ZERO_DURATION_CUE');
  assert.equal(r.subtitleCount, 0);
  assert.equal(r.text, '');
  assert.ok(!r.text.includes('正常')); // 不产出任何半成品 cue
});

test('非法选项:缺 language、format 非法、includeSpeaker 非布尔', () => {
  const doc = makeDoc();
  assert.equal(exportTrack(doc, { format: 'srt' }).reasonCode, 'INVALID_OPTIONS');
  assert.equal(exportTrack(doc, { language: 'zh' }).reasonCode, 'INVALID_OPTIONS');
  assert.equal(exportTrack(doc, { language: 'zh', format: 'txt' }).reasonCode, 'INVALID_OPTIONS');
  const bad = exportTrack(doc, { language: 'zh', format: 'srt', includeSpeaker: 'yes' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonCode, 'INVALID_OPTIONS');
  assert.equal(exportTrack(doc, null).reasonCode, 'INVALID_OPTIONS');
});

test('无法解析的 JSON 字符串:返回 INVALID_DOCUMENT 失败而非抛错', () => {
  const r = exportTrack('{not json', { language: 'zh', format: 'srt' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'INVALID_DOCUMENT');
  assert.equal(r.text, '');
});

// ------------------------------------------------ WebVTT cue identifier 转义

/** 取某条 cue 的 identifier(VTT 中时间戳上一行)。 */
function vttIdentifiers(text) {
  return text
    .split('\n\n')
    .slice(1) // 去掉 "WEBVTT" 文件头块
    .map((block) => block.split('\n')[0]);
}

test('VTT 编号:普通安全编号(含 Unicode、空格、短横线)原样保留', () => {
  const doc = makeDoc({ subtitles: [
    { id: '中文字幕-A 1', language: 'zh', startFrame: 0, endFrame: 150, text: 'a', speaker: null },
    { id: 'café_☕', language: 'zh', startFrame: 150, endFrame: 300, text: 'b', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'vtt' });
  assert.equal(r.ok, true);
  assert.deepEqual(vttIdentifiers(r.text), ['中文字幕-A 1', 'café_☕']);
  // 每个 identifier 后紧跟时间戳行,解析结构不被破坏
  assert.match(r.text, /中文字幕-A 1\n\d\d:\d\d:\d\d\.\d\d\d --> /);
});

test('VTT 编号:含换行/回车的编号转成单行(esc: 前缀 + %0A/%0D),不再拆行', () => {
  const doc = makeDoc({ subtitles: [
    { id: 'bad\nid', language: 'zh', startFrame: 0, endFrame: 150, text: 'a', speaker: null },
    { id: 'cr\rid', language: 'zh', startFrame: 150, endFrame: 300, text: 'b', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'vtt' });
  assert.equal(r.ok, true);
  assert.deepEqual(vttIdentifiers(r.text), ['esc:bad%0Aid', 'esc:cr%0Did']);
  // 结构完整:恰好两个 cue,每个块第一行是标识符、第二行是时间戳
  const blocks = r.text.trimEnd().split('\n\n');
  assert.equal(blocks.length, 3); // WEBVTT + 2 cue
  for (const block of blocks.slice(1)) {
    const lines = block.split('\n');
    assert.match(lines[1], / --> /);
  }
});

test('VTT 编号:含 --> 箭头的编号转义为 %2D%2D%3E,identifier 内不再出现箭头', () => {
  const doc = makeDoc({ subtitles: [
    { id: 'bad --> id', language: 'zh', startFrame: 0, endFrame: 150, text: 'a', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'vtt' });
  assert.equal(r.ok, true);
  const identifier = vttIdentifiers(r.text)[0];
  assert.equal(identifier, 'esc:bad %2D%2D%3E id');
  assert.ok(!identifier.includes('-->'));
  // 箭头只出现在真正的时间戳行
  assert.equal((r.text.match(/-->/g) || []).length, 1);
});

test('VTT 编号转义无碰撞:转义符 %、换行、箭头、前缀本身各自唯一', () => {
  // 这些原始编号若用朴素替换会互相碰撞;转义后必须两两不同
  const ids = [
    'bad\nid',      // 朴素替换可能与下者混淆
    'bad%0Aid',     // 字面的百分号转义序列
    'bad --> id',
    'bad %2D%2D%3E id',
    'esc:bad%0Aid', // 长得像转义产物的原始编号
    '%',
    '-->',
    'a\r\nb',
    'a%0D%0Ab',
  ];
  const doc = makeDoc({
    subtitles: ids.map((id, i) => ({
      id,
      language: 'zh',
      startFrame: i * 100,
      endFrame: i * 100 + 50,
      text: `t${i}`,
      speaker: null,
    })),
  });
  const r = exportTrack(doc, { language: 'zh', format: 'vtt' });
  assert.equal(r.ok, true);
  const identifiers = vttIdentifiers(r.text);
  assert.equal(new Set(identifiers).size, identifiers.length); // 两两不碰撞
  assert.deepEqual(identifiers, [
    'esc:bad%0Aid',
    'esc:bad%250Aid',
    'esc:bad %2D%2D%3E id',
    'esc:bad %252D%252D%253E id',
    'esc:esc:bad%250Aid',
    'esc:%25',
    'esc:%2D%2D%3E',
    'esc:a%0D%0Ab',
    'esc:a%250D%250Ab',
  ]);
});

test('VTT 转义不影响 SRT:SRT 始终用连续序号,不写原始编号', () => {
  const doc = makeDoc({ subtitles: [
    { id: 'bad\nid', language: 'zh', startFrame: 0, endFrame: 150, text: 'a', speaker: null },
    { id: 'x --> y', language: 'zh', startFrame: 150, endFrame: 300, text: 'b', speaker: null },
  ] });
  const srt = exportTrack(doc, { language: 'zh', format: 'srt' });
  assert.equal(srt.ok, true);
  assert.match(srt.text, /^1\n/);
  assert.match(srt.text, /\n\n2\n/);
  assert.ok(!srt.text.includes('bad'));
  assert.ok(!srt.text.includes('--> id')); // 仅时间戳行含 -->
});

test('VTT 转义不改变正文文本', () => {
  const doc = makeDoc({ subtitles: [
    { id: 'bad\nid', language: 'zh', startFrame: 0, endFrame: 150,
      text: '正文\n第二行 -> 保留 --> 原样', speaker: null },
  ] });
  const r = exportTrack(doc, { language: 'zh', format: 'vtt' });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('正文\n第二行 -> 保留 --> 原样'));
});

