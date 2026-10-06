import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Capability token: 256 bits, handed out once inside a URL fragment (#k=…). */
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 128-bit random id, lowercase base32 without padding (26 characters). */
export function newId(): string {
  const bytes = randomBytes(16);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-z2-7]{26}$/.test(s);
