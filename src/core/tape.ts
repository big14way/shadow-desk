// The public price tape: price, a size range and an hour. Nothing else (build guide §11.10).

export type SizeBucket = '<0.1' | '0.1-1' | '>1';

export const sizeBucket = (zat: bigint): SizeBucket =>
  zat < 10_000_000n ? '<0.1' : zat < 100_000_000n ? '0.1-1' : '>1';

/** Unix seconds, floored to the hour. */
export const hourBucket = (ms: number) => Math.floor(ms / 3_600_000) * 3600;

/** A random publication delay in [0, maxDelayMs), so a tape row can't be matched to a trade's end time. */
export const tapeDelay = (maxDelayMs: number, random: () => number = Math.random) =>
  Math.floor(random() * maxDelayMs);
