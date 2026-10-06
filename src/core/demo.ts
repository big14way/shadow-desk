// Structurally valid stand-ins for real keys and addresses, for dry-run mode and tests. They go through the same
// validation as real ones. Dry-run uses Testnet encodings (utest1…, uviewtest1…), which Mainnet wallets refuse, so a
// demo escrow address can never receive real ZEC by accident.

import { contactName } from './commands';
import { encodeContact } from './contact';
import { encodeUnified, TYPECODE, type Network } from './unified';
import type { Role } from './api';

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const hrp = (network: Network, kind: 'address' | 'fvk') =>
  kind === 'address' ? (network === 'main' ? 'u' : 'utest') : network === 'main' ? 'uview' : 'uviewtest';

export const demoPubkey = () => hex(rand(32));

export const demoContact = (role: Role | 'arbiter', tradeId: string, pubkey = demoPubkey()) =>
  encodeContact({ name: role === 'arbiter' ? `arbiter-${tradeId}` : contactName(role, tradeId), pubkey });

/** An Orchard-only Unified Address with random bytes. */
export const demoAddress = (network: Network) => encodeUnified(hrp(network, 'address'), [{ typecode: TYPECODE.ORCHARD, data: rand(43) }]);

/** What `zcash-sign generate --ak <groupKey>` returns: a UFVK whose Orchard ak is the group key, and an address. */
export function demoEscrow(groupPubkey: string, network: Network) {
  const fvk = new Uint8Array(96);
  fvk.set(fromHex(groupPubkey), 0);
  fvk.set(rand(64), 32);
  return {
    ufvk: encodeUnified(hrp(network, 'fvk'), [{ typecode: TYPECODE.ORCHARD, data: fvk }]),
    address: demoAddress(network),
  };
}

export const demoTxid = () => `dryrun-${hex(rand(29))}`;
