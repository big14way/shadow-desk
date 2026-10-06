// frost-client contact strings: bech32m("zffrost", postcard(Contact { version: Some(0), name, pubkey })).
// Format taken from frost-tools frost-client/src/cli/contact.rs (Contact::as_text / from_text).

import { bech32m } from '@scure/base';

export type FrostContact = { name: string; pubkey: string };

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = b[pos++];
    if (byte === undefined) throw new Error('truncated');
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, pos];
  }
  throw new Error('varint too long');
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function parseContact(text: string): FrostContact {
  const s = text.trim();
  if (!s.startsWith('zffrost1')) throw new Error('not a zffrost1… contact string');
  const { prefix, words } = bech32m.decode(s as `${string}1${string}`, false);
  if (prefix !== 'zffrost') throw new Error('wrong prefix');
  const b = bech32m.fromWords(words);

  let pos = 0;
  if (b[pos++] !== 1 || b[pos++] !== 0) throw new Error('unsupported contact version');
  const [nameLen, p1] = readVarint(b, pos);
  const name = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(p1, p1 + nameLen));
  pos = p1 + nameLen;
  const [keyLen, p2] = readVarint(b, pos);
  if (keyLen !== 32 || p2 + keyLen !== b.length) throw new Error('bad public key');
  return { name, pubkey: hex(b.subarray(p2, p2 + keyLen)) };
}

/** Inverse of parseContact; used by tests and the dry-run demo. */
export function encodeContact(c: FrostContact): string {
  const name = new TextEncoder().encode(c.name);
  if (name.length > 127) throw new Error('name too long');
  const key = Uint8Array.from(c.pubkey.match(/../g)!.map((h) => parseInt(h, 16)));
  const bytes = Uint8Array.from([1, 0, name.length, ...name, key.length, ...key]);
  return bech32m.encode('zffrost', bech32m.toWords(bytes), false);
}

export const isHex32 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
