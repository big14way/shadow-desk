import { describe, expect, it } from 'vitest';
import { hourBucket, sizeBucket, tapeDelay } from '../../src/core/tape';

describe('tape', () => {
  it('buckets sizes', () => {
    expect(sizeBucket(1_000_000n)).toBe('<0.1');
    expect(sizeBucket(9_999_999n)).toBe('<0.1');
    expect(sizeBucket(10_000_000n)).toBe('0.1-1');
    expect(sizeBucket(99_999_999n)).toBe('0.1-1');
    expect(sizeBucket(100_000_000n)).toBe('>1');
  });
  it('floors to the hour in unix seconds', () => {
    expect(hourBucket(Date.UTC(2026, 9, 6, 13, 59, 59, 999))).toBe(Date.UTC(2026, 9, 6, 13) / 1000);
    expect(hourBucket(Date.UTC(2026, 9, 6, 14))).toBe(Date.UTC(2026, 9, 6, 14) / 1000);
  });
  it('delays within [0, max)', () => {
    expect(tapeDelay(3_600_000, () => 0)).toBe(0);
    expect(tapeDelay(3_600_000, () => 0.999999)).toBeLessThan(3_600_000);
    for (let i = 0; i < 100; i++) {
      const d = tapeDelay(3_600_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(3_600_000);
    }
  });
});
