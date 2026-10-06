// Integer-only money helpers. 1 ZEC = 100,000,000 zatoshis.

export const ZAT_PER_ZEC = 100_000_000n;

/** ZIP 317: 5,000 zatoshis per logical action, minimum 2 actions. */
export const FEE_ZAT = 10_000n;

/** Hackathon cap: no trade larger than 0.01 ZEC (build guide §3). */
export const MAX_TRADE_ZAT = 1_000_000n;

/** Fiat amount in minor units, rounded half up. */
export const fiatMinorFor = (amountZat: bigint, priceMinorPerZec: bigint) =>
  (amountZat * priceMinorPerZec + ZAT_PER_ZEC / 2n) / ZAT_PER_ZEC;

/** 110000n -> "0.0011". No trailing zeros, no exponent. */
export function zatToZec(zat: bigint): string {
  const neg = zat < 0n;
  const abs = neg ? -zat : zat;
  const whole = abs / ZAT_PER_ZEC;
  const frac = (abs % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${frac ? `${whole}.${frac}` : `${whole}`}`;
}

/** "0.0011" -> 110000n. Rejects more than 8 decimals, signs and exponents. */
export function zecToZat(zec: string): bigint {
  const s = zec.trim();
  const m = /^(\d+)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m) throw new Error(`not a ZEC amount: ${JSON.stringify(zec)}`);
  return BigInt(m[1]) * ZAT_PER_ZEC + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
}

/** Formats an integer amount of minor units with the currency's exponent. */
export function formatMinor(minor: bigint, exponent: number): string {
  if (exponent === 0) return minor.toLocaleString('en-US');
  const scale = 10n ** BigInt(exponent);
  const whole = minor / scale;
  const frac = (minor % scale).toString().padStart(exponent, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

/** "1234.5" with exponent 2 -> 123450n. */
export function parseMinor(input: string, exponent: number): bigint {
  const s = input.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`not an amount: ${JSON.stringify(input)}`);
  const frac = m[2] ?? '';
  if (frac.length > exponent) throw new Error(`at most ${exponent} decimal places`);
  return BigInt(m[1]) * 10n ** BigInt(exponent) + BigInt(frac.padEnd(exponent, '0') || '0');
}
