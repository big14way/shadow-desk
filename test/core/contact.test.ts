import { describe, expect, it } from 'vitest';
import { encodeContact, parseContact } from '../../src/core/contact';

describe('frost-client contact strings', () => {
  const pub = 'ab'.repeat(32);
  it('round-trips', () => {
    const text = encodeContact({ name: 'buyer-T1', pubkey: pub });
    expect(text.startsWith('zffrost1')).toBe(true);
    expect(parseContact(text)).toEqual({ name: 'buyer-T1', pubkey: pub });
  });
  it('rejects other strings', () => {
    expect(() => parseContact('u1abc')).toThrow();
    expect(() => parseContact('zffrost1qqqqqq')).toThrow();
  });
});
