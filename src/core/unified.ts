// Unified Address / Unified Full Viewing Key decoding (ZIP 316), in plain TypeScript so the
// desk can check addresses without shelling out. Runs in the browser and on the server.
//
// Encoding: bech32m(HRP, F4Jumble(items || pad(HRP, 16))), where each item is
// compactSize(typecode) || compactSize(length) || bytes.

import { bech32m } from '@scure/base';
import { blake2b } from '@noble/hashes/blake2.js';

export const TYPECODE = { P2PKH: 0x00, P2SH: 0x01, SAPLING: 0x02, ORCHARD: 0x03 } as const;

const enc = new TextEncoder();

function personal(tag: 'UA_F4Jumble_H' | 'UA_F4Jumble_G', i: number, j = 0): Uint8Array {
  const p = new Uint8Array(16);
  p.set(enc.encode(tag));
  p[13] = i;
  p[14] = j & 0xff;
  p[15] = (j >> 8) & 0xff;
  return p;
}

const H = (i: number, u: Uint8Array, len: number) => blake2b(u, { dkLen: len, personalization: personal('UA_F4Jumble_H', i) });

function G(i: number, u: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(len / 64) * 64);
  for (let j = 0; j * 64 < len; j++) out.set(blake2b(u, { dkLen: 64, personalization: personal('UA_F4Jumble_G', i, j) }), j * 64);
  return out.subarray(0, len);
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k++) r[k] = a[k] ^ b[k];
  return r;
}

function split(m: Uint8Array) {
  if (m.length < 48 || m.length > 4_194_368) throw new Error('F4Jumble: bad message length');
  const lL = Math.min(64, Math.floor(m.length / 2));
  return { left: m.subarray(0, lL), right: m.subarray(lL), lL, lR: m.length - lL };
}

function concat(a: Uint8Array, b: Uint8Array) {
  const r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}

export function f4jumble(m: Uint8Array): Uint8Array {
  const { left: a, right: b, lL, lR } = split(m);
  const x = xor(b, G(0, a, lR));
  const y = xor(a, H(0, x, lL));
  const d = xor(x, G(1, y, lR));
  const c = xor(y, H(1, d, lL));
  return concat(c, d);
}

export function f4jumbleInv(m: Uint8Array): Uint8Array {
  const { left: c, right: d, lL, lR } = split(m);
  const y = xor(c, H(1, d, lL));
  const x = xor(d, G(1, y, lR));
  const a = xor(y, H(0, x, lL));
  const b = xor(x, G(0, a, lR));
  return concat(a, b);
}

export type UnifiedItem = { typecode: number; data: Uint8Array };

function readCompactSize(buf: Uint8Array, pos: number): [number, number] {
  const first = buf[pos];
  if (first === undefined) throw new Error('truncated');
  if (first < 0xfd) return [first, pos + 1];
  if (first === 0xfd) return [buf[pos + 1] | (buf[pos + 2] << 8), pos + 3];
  if (first === 0xfe) return [(buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16) | (buf[pos + 4] << 24)) >>> 0, pos + 5];
  throw new Error('compactSize too large');
}

function writeCompactSize(n: number): number[] {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, n >> 8];
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Decodes any ZIP 316 unified encoding (address, FVK, IVK). Throws on a malformed string. */
export function decodeUnified(s: string): { hrp: string; items: UnifiedItem[] } {
  const str = s.trim();
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('mixed case');
  const { prefix, words } = bech32m.decode(str.toLowerCase(), false);
  const raw = f4jumbleInv(bech32m.fromWords(words));
  const pad = raw.subarray(raw.length - 16);
  const hrpBytes = enc.encode(prefix);
  if (hrpBytes.length > 16) throw new Error('HRP too long');
  for (let k = 0; k < 16; k++) if (pad[k] !== (hrpBytes[k] ?? 0)) throw new Error('bad padding');

  const body = raw.subarray(0, raw.length - 16);
  const items: UnifiedItem[] = [];
  let pos = 0;
  while (pos < body.length) {
    const [typecode, p1] = readCompactSize(body, pos);
    const [len, p2] = readCompactSize(body, p1);
    if (p2 + len > body.length) throw new Error('truncated item');
    items.push({ typecode, data: body.slice(p2, p2 + len) });
    pos = p2 + len;
  }
  if (!items.length) throw new Error('no items');
  for (let k = 1; k < items.length; k++) if (items[k].typecode <= items[k - 1].typecode) throw new Error('items out of order');
  return { hrp: prefix, items };
}

/** Encodes items as a unified string. Used by tests and by the dry-run demo. */
export function encodeUnified(hrp: string, items: UnifiedItem[]): string {
  const bytes: number[] = [];
  for (const it of [...items].sort((a, b) => a.typecode - b.typecode)) {
    bytes.push(...writeCompactSize(it.typecode), ...writeCompactSize(it.data.length), ...it.data);
  }
  const pad = new Uint8Array(16);
  pad.set(enc.encode(hrp));
  const jumbled = f4jumble(concat(Uint8Array.from(bytes), pad));
  return bech32m.encode(hrp, bech32m.toWords(jumbled), false);
}

export type Network = 'main' | 'test';
const HRP = {
  main: { address: 'u', fvk: 'uview' },
  test: { address: 'utest', fvk: 'uviewtest' },
} as const;

const RECEIVER_NAMES: Record<number, string> = { 0: 'p2pkh', 1: 'p2sh', 2: 'sapling', 3: 'orchard' };

export type Check = { ok: true; receivers: string[] } | { ok: false; reason: string };

function receiversOf(s: string, network: Network): Check & { items?: UnifiedItem[] } {
  if (!s.trim().toLowerCase().startsWith(`${HRP[network].address}1`)) {
    return { ok: false, reason: `not a ${network === 'main' ? 'Mainnet u1…' : 'Testnet utest1…'} Unified Address` };
  }
  try {
    const { hrp, items } = decodeUnified(s);
    if (hrp !== HRP[network].address) return { ok: false, reason: 'wrong network' };
    return { ok: true, receivers: items.map((i) => RECEIVER_NAMES[i.typecode] ?? `unknown(${i.typecode})`), items };
  } catch (e) {
    return { ok: false, reason: `invalid Unified Address (${(e as Error).message})` };
  }
}

/** A buyer receive address or seller refund address: shielded receivers only (build guide §11.3). */
export function checkShieldedAddress(s: string, network: Network = 'main'): Check {
  const r = receiversOf(s, network);
  if (!r.ok) return r;
  if (r.receivers.some((x) => x === 'p2pkh' || x === 'p2sh')) return { ok: false, reason: 'contains a transparent receiver' };
  if (!r.receivers.some((x) => x === 'sapling' || x === 'orchard')) return { ok: false, reason: 'no shielded receiver' };
  return { ok: true, receivers: r.receivers };
}

/**
 * The escrow address must carry an Orchard-protocol receiver and nothing else. FROST controls only
 * the Orchard spend key: funds sent to a Sapling receiver of a FROST account are unspendable (§3).
 */
export function checkEscrowAddress(s: string, network: Network = 'main'): Check {
  const r = receiversOf(s, network);
  if (!r.ok) return r;
  if (r.receivers.length !== 1 || r.receivers[0] !== 'orchard') {
    return { ok: false, reason: `escrow address must be Orchard-only, found: ${r.receivers.join(', ')}` };
  }
  return { ok: true, receivers: r.receivers };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * The Orchard spend validating key `ak` inside a UFVK, as hex. For a FROST escrow this is the group
 * public key that `zcash-sign generate --ak` was given, so the desk can check that the viewing key it
 * watches belongs to the trade's FROST group.
 */
export function ufvkOrchardAk(ufvk: string, network: Network = 'main'): string {
  const { hrp, items } = decodeUnified(ufvk);
  if (hrp !== HRP[network].fvk) throw new Error(`not a ${HRP[network].fvk}1… viewing key`);
  const orchard = items.find((i) => i.typecode === TYPECODE.ORCHARD);
  if (!orchard || orchard.data.length !== 96) throw new Error('viewing key has no Orchard component');
  return hex(orchard.data.subarray(0, 32));
}
