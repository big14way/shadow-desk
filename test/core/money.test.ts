import { describe, expect, it } from 'vitest';
import { fiatMinorFor, formatMinor, parseMinor, zatToZec, zecToZat } from '../../src/core/money';

describe('fiatMinorFor', () => {
  it('computes exact amounts', () => {
    // 0.01 ZEC at 50,000.00 NGN/ZEC = 500.00 NGN
    expect(fiatMinorFor(1_000_000n, 5_000_000n)).toBe(50_000n);
  });
  it('rounds half up', () => {
    // 1 zat at 50 minor/ZEC = 0.0000005 minor -> 0
    expect(fiatMinorFor(1n, 50n)).toBe(0n);
    // 0.5 minor rounds up to 1
    expect(fiatMinorFor(50_000_000n, 1n)).toBe(1n);
    // 0.49999999 minor rounds down
    expect(fiatMinorFor(49_999_999n, 1n)).toBe(0n);
    // 1.5 -> 2, 2.5 -> 3 (half up, not half even)
    expect(fiatMinorFor(150_000_000n, 1n)).toBe(2n);
    expect(fiatMinorFor(250_000_000n, 1n)).toBe(3n);
  });
  it('stays exact for large values', () => {
    expect(fiatMinorFor(2_100_000_000_000_000n, 9_999_999_999n)).toBe(209_999_999_979_000_000n);
  });
});

describe('zatToZec / zecToZat', () => {
  it('formats without trailing zeros', () => {
    expect(zatToZec(110_000n)).toBe('0.0011');
    expect(zatToZec(100_000_000n)).toBe('1');
    expect(zatToZec(1n)).toBe('0.00000001');
    expect(zatToZec(0n)).toBe('0');
    expect(zatToZec(123_456_789_012n)).toBe('1234.56789012');
  });
  it('round-trips', () => {
    for (const z of [0n, 1n, 10_000n, 110_000n, 1_000_000n, 100_000_000n, 2_100_000_000_000_000n]) {
      expect(zecToZat(zatToZec(z))).toBe(z);
    }
  });
  it('rejects bad input', () => {
    for (const s of ['', '-1', '1e-3', '0.000000001', 'abc', '1.2.3', ' . ']) expect(() => zecToZat(s)).toThrow();
  });
  it('accepts a trailing dot', () => {
    expect(zecToZat('1.')).toBe(100_000_000n);
  });
});

describe('formatMinor / parseMinor', () => {
  it('formats with the exponent', () => {
    expect(formatMinor(5_000_000n, 2)).toBe('50,000.00');
    expect(formatMinor(5n, 2)).toBe('0.05');
    expect(formatMinor(1234n, 0)).toBe('1,234');
  });
  it('parses', () => {
    expect(parseMinor('50,000.5', 2)).toBe(5_000_050n);
    expect(parseMinor('12', 2)).toBe(1200n);
    expect(() => parseMinor('1.234', 2)).toThrow();
    expect(() => parseMinor('-1', 2)).toThrow();
  });
});
