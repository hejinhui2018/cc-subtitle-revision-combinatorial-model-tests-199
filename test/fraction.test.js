'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Fraction } = require('../src/fraction');

test('Fraction: 整数帧率归一化', () => {
  const f = Fraction.fromFrameRate(25);
  assert.equal(f.num, 25n);
  assert.equal(f.den, 1n);
  assert.equal(f.isIntegerRate ?? f.den, 1n);
});

test('Fraction: 分子/分母帧率并约分', () => {
  const f = Fraction.fromFrameRate({ numerator: 30000, denominator: 1001 });
  assert.equal(f.num, 30000n);
  assert.equal(f.den, 1001n);

  const g = new Fraction(60000n, 2002n);
  assert.equal(g.num, 30000n);
  assert.equal(g.den, 1001n);
});

test('Fraction: 接受字符串分数与字符串整数', () => {
  assert.ok(Fraction.fromFrameRate('24000/1001').equals(new Fraction(24000n, 1001n)));
  assert.ok(Fraction.fromFrameRate('24').equals(new Fraction(24n)));
});

test('Fraction: 非法帧率抛错', () => {
  assert.throws(() => Fraction.fromFrameRate({ denominator: 1001 }), /numerator/);
  assert.throws(() => Fraction.fromFrameRate('abc'), /整数/);
  assert.throws(() => new Fraction(1, 0), /分母不能为 0/);
});

test('Fraction: 帧到时间的精确换算 — 29.97fps 边界无浮点误差', () => {
  // 30000/1001 fps:第 30000 帧恰好等于 1001 秒
  const fps = new Fraction(30000n, 1001n);
  const t = Fraction.of(30000).div(fps);
  assert.equal(t.num, 1001n);
  assert.equal(t.den, 1n);
  assert.equal(t.cmp(1001), 0);

  // 半秒边界:第 15000 帧 = 1001/2 秒 = 500.5 秒,严格大于 500、严格小于 501
  const half = Fraction.of(15000).div(fps);
  assert.equal(half.cmp(new Fraction(1001n, 2n)), 0);
  assert.equal(half.lessThanOrEqual(500), false);
  assert.equal(half.lessThan(501), true);
});

test('Fraction: 首尾相接场景下相等判定不被浮点破坏', () => {
  // 模拟 "某区间终点(秒)" 与 "下一区间起点(秒)" 在分数意义下相等
  const fps = new Fraction(24000n, 1001n);
  const end = Fraction.of(48000).div(fps);
  const start = Fraction.of(48000).div(fps);
  assert.equal(end.cmp(start), 0);
  assert.equal(end.equals(start), true);
});

test('Fraction: 比较与四则运算', () => {
  const a = new Fraction(1n, 3n);
  const b = new Fraction(1n, 6n);
  assert.ok(a.add(b).equals(new Fraction(1n, 2n)));
  assert.ok(a.sub(b).equals(b));
  assert.ok(a.mul(b).equals(new Fraction(1n, 18n)));
  assert.ok(a.div(b).equals(2n));
  assert.equal(a.cmp(b), 1);
  assert.equal(b.cmp(a), -1);
  assert.throws(() => a.div(0), /除以 0/);
});

test('Fraction: 负帧率/零帧率由调用方识别,分数本身支持负数', () => {
  const f = new Fraction(-24n);
  assert.equal(f.isNegative, true);
  const fps = Fraction.fromFrameRate({ numerator: -25, denominator: 1 });
  assert.equal(fps.num < 0n, true);
});

test('Fraction: 展示用秒与时间码', () => {
  const fps = new Fraction(25n);
  assert.equal(Fraction.of(25).div(fps).toSeconds(3), '1.000');
  assert.equal(Fraction.of(1).div(fps).toSeconds(3), '0.040');
  // 3723/25 = 148.92 秒 = 2 分 28.92 秒
  assert.equal(Fraction.of(3723).div(fps).toTimecode(3), '00:02:28.920');
  assert.equal(new Fraction(-5n).toTimecode(0), '-00:00:05');
});

test('Fraction: 实例冻结', () => {
  const f = new Fraction(3n, 2n);
  assert.throws(() => { f.num = 9n; }, TypeError);
});
