import { describe, expect, it } from 'vitest';
import { b64url, buildZip321, paymentDetailsMemo } from '../../src/core/zip321';

const UA = 'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';

describe('b64url', () => {
  it('has no padding and uses the URL-safe alphabet', () => {
    expect(b64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(b64url(new TextEncoder().encode('a'))).toBe('YQ');
    expect(b64url(new Uint8Array([]))).toBe('');
  });
});

describe('buildZip321', () => {
  it('builds a funding link without a memo', () => {
    expect(buildZip321(UA, 110_000n)).toBe(`zcash:${UA}?amount=0.0011`);
  });
  it('encodes the memo as base64url and the message as a URI component', () => {
    const uri = buildZip321(UA, 1000n, 'hi there', 'Shadow Desk payment details');
    expect(uri).toBe(`zcash:${UA}?amount=0.00001&memo=aGkgdGhlcmU&message=Shadow%20Desk%20payment%20details`);
    expect(uri).not.toMatch(/=(&|$)/);
  });
  it('accepts a memo of exactly 512 bytes and rejects 513', () => {
    expect(() => buildZip321(UA, 1000n, 'x'.repeat(512))).not.toThrow();
    expect(() => buildZip321(UA, 1000n, 'x'.repeat(513))).toThrow(/512/);
    // multi-byte characters count as bytes, not characters
    expect(() => buildZip321(UA, 1000n, '€'.repeat(171))).toThrow(/512/);
  });
  it('rejects a memo to a transparent address', () => {
    expect(() => buildZip321('t1abc', 1000n, 'memo')).toThrow(/transparent/);
  });
  it('rejects non-positive amounts', () => {
    expect(() => buildZip321(UA, 0n)).toThrow();
  });
  it('builds the details memo used by the trade room', () => {
    const memo = paymentDetailsMemo('T1', { bank: 'GTBank', accountNo: '0123456789', accountName: 'A. Seller', reference: 'SD-T1' });
    expect(memo).toBe('SHADOWDESK T1\nPay: GTBank 0123456789 A. Seller\nRef: SD-T1');
  });
});
