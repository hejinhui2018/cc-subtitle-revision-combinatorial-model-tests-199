'use strict';

/**
 * 精确有理数运算,用于帧率与时间换算。
 *
 * 时间换算全部走 BigInt 分子/分母,绝不使用浮点数,
 * 因此边界比较(如某帧是否等于某时间点)不会出现浮点误差。
 */

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** 归一化:约分并保证分母为正。num/den 接受 bigint 或安全整数。 */
function reduce(num, den) {
  if (den === 0n) throw new RangeError('有理数分母不能为 0');
  if (num === 0n) return { num: 0n, den: 1n };
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function toBigInt(value, label) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label} 必须是安全整数或 bigint,收到: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new TypeError(`${label} 必须是整数,收到: ${String(value)}`);
}

class Fraction {
  constructor(num, den = 1n) {
    const n = toBigInt(num, '分子');
    const d = toBigInt(den, '分母');
    const r = reduce(n, d);
    this.num = r.num;
    this.den = r.den;
    Object.freeze(this);
  }

  static of(num, den) {
    return new Fraction(num, den ?? 1n);
  }

  /** 解析帧率:25(整数)、"25"、{ numerator, denominator }、{ num, den }。 */
  static fromFrameRate(value) {
    if (value instanceof Fraction) return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
      if (typeof value === 'string' && /\//.test(value)) {
        const [a, b] = value.split('/');
        return new Fraction(a.trim(), b.trim());
      }
      return new Fraction(value, 1n);
    }
    if (value && typeof value === 'object') {
      const num = value.numerator ?? value.num;
      const den = value.denominator ?? value.den ?? 1;
      if (num === undefined || num === null) {
        throw new TypeError('帧率对象必须包含 numerator(或 num)字段');
      }
      return new Fraction(num, den);
    }
    throw new TypeError(`无法解析帧率: ${String(value)}`);
  }

  add(other) {
    other = other instanceof Fraction ? other : new Fraction(other, 1n);
    return new Fraction(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other) {
    other = other instanceof Fraction ? other : new Fraction(other, 1n);
    return new Fraction(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other) {
    other = other instanceof Fraction ? other : new Fraction(other, 1n);
    return new Fraction(this.num * other.num, this.den * other.den);
  }

  div(other) {
    other = other instanceof Fraction ? other : new Fraction(other, 1n);
    if (other.num === 0n) throw new RangeError('不能除以 0');
    return new Fraction(this.num * other.den, this.den * other.num);
  }

  negate() {
    return new Fraction(-this.num, this.den);
  }

  /** 整数取负判断由比较处理;cmp: -1/0/1 */
  cmp(other) {
    other = other instanceof Fraction ? other : Fraction.of(other);
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  get isNegative() {
    return this.num < 0n;
  }

  get isZero() {
    return this.num === 0n;
  }

  equals(other) {
    return this.cmp(other) === 0;
  }

  lessThan(other) {
    return this.cmp(other) < 0;
  }

  lessThanOrEqual(other) {
    return this.cmp(other) <= 0;
  }

  /** 精确转成以秒为单位的小数(仅用于展示,不参与判定)。 */
  toSeconds(decimals = 3) {
    const scale = 10n ** BigInt(decimals);
    const scaled = (this.num * scale) / this.den;
    const negative = scaled < 0n;
    const abs = negative ? -scaled : scaled;
    const whole = abs / scale;
    const prefix = `${negative ? '-' : ''}${whole}`;
    if (decimals === 0) return prefix;
    const frac = (abs % scale).toString().padStart(decimals, '0');
    return `${prefix}.${frac}`;
  }

  /**
   * 把本 Fraction(视为秒数)换算成毫秒,并按四舍五入取整:
   * 小数部分 > 0.5 进位、< 0.5 舍去、恰好 0.5 向上(朝 +∞)。
   * 全程 BigInt 整数运算,不使用浮点;返回 bigint 毫秒。
   *
   * 对非负值即 round(1000*num/den);通用 floor 除法实现保证负值也朝 +∞ 取整。
   */
  toMillisecondsRounded() {
    // round-half-up(恰好半毫秒朝 +∞): floor(1000*num/den + 1/2) = floor((2000*num + den)/(2*den))
    const n = this.num * 2000n + this.den;
    const d = this.den * 2n;
    let q = n / d; // BigInt 除法向零截断
    const rem = n % d;
    if (n < 0n && rem !== 0n) q -= 1n; // 截断修正为 floor
    return q;
  }

  /** HH:MM:SS.mmm 形式,仅用于展示。 */
  toTimecode(decimals = 3) {
    const negative = this.isNegative;
    const abs = negative ? this.negate() : this;
    const totalSeconds = abs.num / abs.den; // 秒的整数部分
    const hours = totalSeconds / 3600n;
    const minutes = (totalSeconds % 3600n) / 60n;
    const seconds = totalSeconds % 60n;
    const pad = (x) => x.toString().padStart(2, '0');
    const base = `${negative ? '-' : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    if (decimals === 0) return base;
    const rest = abs.sub(Fraction.of(totalSeconds)); // 不足一秒的零头
    const restScaled = (rest.num * 10n ** BigInt(decimals)) / rest.den;
    const frac = restScaled.toString().padStart(decimals, '0');
    return `${base}.${frac}`;
  }

  toString() {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

module.exports = { Fraction, gcd, reduce };
