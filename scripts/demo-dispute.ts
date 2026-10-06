// Drives one dry-run trade to a dispute with sealed evidence, through the public API only.
// Usage (with `pnpm demo` running): pnpm exec tsx scripts/demo-dispute.ts [http://127.0.0.1:8787]

import sodium from 'libsodium-wrappers';
import { demoAddress, demoContact, demoEscrow } from '../src/core/demo';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error}`);
  return json;
};
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out');
};

const cfg = await call('GET', '/config');
if (!cfg.dryRun) throw new Error('this script only runs against a dry-run desk');
const offer = await call('POST', '/offers', undefined, { minZat: '200000', maxZat: '500000', priceMinor: '450000', currency: 'USD', method: 'instant_payment' });
const take = await call('POST', `/offers/${offer.offerId}/take`, undefined, { amountZat: '250000' });
const claim = await call('POST', `/offers/${offer.offerId}/trades/${take.tradeId}/claim`, offer.makerToken);
const [id, buyer, seller] = [take.tradeId as string, take.buyerToken as string, claim.sellerToken as string];
const state = async (s: string) => (await call('GET', `/trades/${id}`, buyer)).state === s;

await until(async () => !!(await call('GET', `/trades/${id}`, buyer)).arbiter.contact);
await call('POST', `/trades/${id}/contact`, buyer, { contact: demoContact('buyer', id) });
await call('POST', `/trades/${id}/contact`, seller, { contact: demoContact('seller', id) });
await call('POST', `/trades/${id}/ready`, buyer);
await call('POST', `/trades/${id}/ready`, seller);
await until(() => state('ESCROW_PENDING'));
const v = await call('GET', `/trades/${id}`, seller);
const esc = demoEscrow(v.groupPubkey, cfg.network);
await call('POST', `/trades/${id}/escrow`, seller, { groupPubkey: v.groupPubkey, ufvk: esc.ufvk, orchardAddress: esc.address, refundUa: demoAddress(cfg.network) });
await call('POST', `/trades/${id}/receive-address`, buyer, { ua: demoAddress(cfg.network) });
await until(() => state('FUNDED'));
await call('POST', `/trades/${id}/details-sent`, seller);
await call('POST', `/trades/${id}/fiat-sent`, buyer);

await sodium.ready;
const V = sodium.base64_variants.URLSAFE_NO_PADDING;
const receipt = new TextEncoder().encode(JSON.stringify({ name: 'receipt.txt', type: 'text/plain' }) + '\nTransfer of 11.25 USD, reference SD-DEMO, 6 Oct 2026');
const sealed = sodium.to_base64(sodium.crypto_box_seal(receipt, sodium.from_base64(cfg.arbiterBoxPubkey, V)), V);
await call('POST', `/trades/${id}/dispute`, buyer, { evidenceSealed: sealed });
console.log(`disputed trade ${id}`);
console.log(`buyer:  ${base}/t/${id}#k=${buyer}`);
console.log(`seller: ${base}/t/${id}#k=${seller}`);
