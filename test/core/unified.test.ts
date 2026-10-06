import { describe, expect, it } from 'vitest';
import f4vectors from '../vectors/f4jumble.json';
import uaVectors from '../vectors/unified_address.json';
import ufvkVectors from '../vectors/unified_full_viewing_keys.json';
import {
  checkEscrowAddress,
  checkShieldedAddress,
  decodeUnified,
  encodeUnified,
  f4jumble,
  f4jumbleInv,
  TYPECODE,
  ufvkOrchardAk,
} from '../../src/core/unified';

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

type UaRow = [string | null, string | null, string | null, string | null, number | null, string | null, string, string, number, number];
const uaRows = (uaVectors as unknown[]).slice(2) as UaRow[];
type FvkRow = [string | null, string | null, string | null, number | null, string | null, string, string, number];
const fvkRows = (ufvkVectors as unknown[]).slice(2) as FvkRow[];

describe('F4Jumble (ZIP 316 test vectors)', () => {
  for (const [normal, jumbled] of (f4vectors as string[][]).slice(2)) {
    it(`jumbles and unjumbles ${normal.length / 2} bytes`, () => {
      expect(toHex(f4jumble(fromHex(normal)))).toBe(jumbled);
      expect(toHex(f4jumbleInv(fromHex(jumbled)))).toBe(normal);
    });
  }
});

describe('decodeUnified (ZIP 316 address vectors)', () => {
  it('recovers every receiver from every vector', () => {
    expect(uaRows.length).toBeGreaterThan(10);
    for (const [p2pkh, p2sh, sapling, orchard, unknownCode, unknownBytes, ua] of uaRows) {
      const { hrp, items } = decodeUnified(ua);
      expect(hrp).toBe('u');
      const get = (tc: number) => items.find((i) => i.typecode === tc);
      expect(get(TYPECODE.P2PKH) && toHex(get(TYPECODE.P2PKH)!.data)).toBe(p2pkh ?? undefined);
      expect(get(TYPECODE.P2SH) && toHex(get(TYPECODE.P2SH)!.data)).toBe(p2sh ?? undefined);
      expect(get(TYPECODE.SAPLING) && toHex(get(TYPECODE.SAPLING)!.data)).toBe(sapling ?? undefined);
      expect(get(TYPECODE.ORCHARD) && toHex(get(TYPECODE.ORCHARD)!.data)).toBe(orchard ?? undefined);
      if (unknownCode !== null) expect(toHex(get(unknownCode)!.data)).toBe(unknownBytes);
    }
  });

  it('re-encodes to the same string', () => {
    for (const row of uaRows.slice(0, 10)) {
      const { hrp, items } = decodeUnified(row[6]);
      expect(encodeUnified(hrp, items)).toBe(row[6]);
    }
  });

  it('rejects a corrupted checksum', () => {
    const ua = uaRows[0][6];
    const bad = ua.slice(0, -1) + (ua.endsWith('q') ? 'p' : 'q');
    expect(() => decodeUnified(bad)).toThrow();
  });
});

describe('address checks', () => {
  const withTransparent = uaRows.find((r) => r[0] || r[1])![6];
  const orchardOnly = encodeUnified('u', [{ typecode: TYPECODE.ORCHARD, data: fromHex(uaRows.find((r) => r[3])![3]!) }]);
  const saplingAndOrchard = uaRows.find((r) => r[2] && r[3] && !r[0] && !r[1] && r[4] === null);

  it('rejects transparent receivers for buyer and refund addresses', () => {
    const r = checkShieldedAddress(withTransparent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/transparent/);
  });
  it('accepts a shielded-only Unified Address', () => {
    expect(checkShieldedAddress(orchardOnly)).toEqual({ ok: true, receivers: ['orchard'] });
    if (saplingAndOrchard) expect(checkShieldedAddress(saplingAndOrchard[6]).ok).toBe(true);
  });
  it('rejects non-UA strings and the wrong network', () => {
    expect(checkShieldedAddress('zs1abcdef').ok).toBe(false);
    expect(checkShieldedAddress('t1abcdef').ok).toBe(false);
    const testnet = encodeUnified('utest', [{ typecode: TYPECODE.ORCHARD, data: new Uint8Array(43).fill(7) }]);
    expect(checkShieldedAddress(testnet).ok).toBe(false);
    expect(checkShieldedAddress(testnet, 'test').ok).toBe(true);
  });
  it('requires the escrow address to be Orchard-only', () => {
    expect(checkEscrowAddress(orchardOnly).ok).toBe(true);
    if (saplingAndOrchard) {
      const r = checkEscrowAddress(saplingAndOrchard[6]);
      expect(r.ok).toBe(false);
    }
    expect(checkEscrowAddress(withTransparent).ok).toBe(false);
  });
});

describe('ufvkOrchardAk (ZIP 316 UFVK vectors)', () => {
  it('extracts ak from the Orchard FVK', () => {
    const rows = fvkRows.filter((r) => r[2]);
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(ufvkOrchardAk(row[5])).toBe(row[2]!.slice(0, 64));
  });
  it('fails when there is no Orchard component', () => {
    const row = fvkRows.find((r) => !r[2]);
    if (row) expect(() => ufvkOrchardAk(row[5])).toThrow(/Orchard/);
  });
  it('rejects an address passed as a viewing key', () => {
    expect(() => ufvkOrchardAk(uaRows[0][6])).toThrow(/uview/);
  });
});
