// ZIP 321 payment URIs. Runs in the browser: the seller's bank details are encoded here
// and never sent to the desk server (build guide §11.6).

import { zatToZec } from './money';

export const MAX_MEMO_BYTES = 512; // ZIP 302

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const memoBytes = (memoText: string) => new TextEncoder().encode(memoText).length;

export function buildZip321(address: string, zat: bigint, memoText?: string, message?: string): string {
  if (zat <= 0n) throw new Error('amount must be positive');
  const params = [`amount=${zatToZec(zat)}`];
  if (memoText !== undefined) {
    if (address.startsWith('t')) throw new Error('memo not allowed for a transparent address');
    const memo = new TextEncoder().encode(memoText);
    if (memo.length > MAX_MEMO_BYTES) throw new Error(`memo exceeds ${MAX_MEMO_BYTES} bytes`);
    params.push(`memo=${b64url(memo)}`);
  }
  if (message) params.push(`message=${encodeURIComponent(message)}`);
  return `zcash:${address}?${params.join('&')}`;
}

/** The payment-details memo the seller sends to the buyer's fresh address. */
export function paymentDetailsMemo(tradeId: string, d: { bank: string; accountNo: string; accountName: string; reference: string }) {
  return `SHADOWDESK ${tradeId}\nPay: ${d.bank} ${d.accountNo} ${d.accountName}\nRef: ${d.reference}`;
}

/** 0.00001 ZEC: the details memo needs a shielded output, so it carries a token amount. */
export const DETAILS_MEMO_ZAT = 1_000n;
