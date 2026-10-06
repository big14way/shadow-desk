import { describe, expect, it } from 'vitest';
import { demoAddress, demoContact, demoEscrow, demoPubkey } from '../../src/core/demo';
import { encodeUnified, TYPECODE } from '../../src/core/unified';
import { loadConfig } from '../../src/server/config';
import { ARBITER_TOKEN, setup } from './helpers';

const MIN = 60_000;

async function newOffer(s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
  const r = await s.call('POST', '/offers', {
    body: { minZat: '100000', maxZat: '1000000', priceMinor: '5000000', currency: 'NGN', method: 'bank_transfer', payWindowMin: 30, ...over },
  });
  expect(r.status).toBe(201);
  return r.json as { offerId: string; makerToken: string; sellerLink: string };
}

async function newTrade(s: ReturnType<typeof setup>, amountZat = '100000') {
  const offer = await newOffer(s);
  const take = await s.call('POST', `/offers/${offer.offerId}/take`, { body: { amountZat } });
  expect(take.status).toBe(201);
  const claim = await s.call('POST', `/offers/${offer.offerId}/trades/${take.json.tradeId}/claim`, { token: offer.makerToken });
  expect(claim.status).toBe(200);
  return { offer, id: take.json.tradeId as string, buyer: take.json.buyerToken as string, seller: claim.json.sellerToken as string };
}

/** What the worker does in real mode: a per-trade arbiter identity, then a DKG. */
function arbiterIdentity(s: ReturnType<typeof setup>, id: string) {
  const pub = demoPubkey();
  s.repo.updateTrade(id, { arbiter_contact: demoContact('arbiter', id, pub), arbiter_pub: pub });
}

async function toEscrowPending(s: ReturnType<typeof setup>, t: Awaited<ReturnType<typeof newTrade>>) {
  arbiterIdentity(s, t.id);
  expect((await s.call('POST', `/trades/${t.id}/contact`, { token: t.buyer, body: { contact: demoContact('buyer', t.id) } })).status).toBe(200);
  expect((await s.call('POST', `/trades/${t.id}/contact`, { token: t.seller, body: { contact: demoContact('seller', t.id) } })).status).toBe(200);
  await s.call('POST', `/trades/${t.id}/ready`, { token: t.buyer });
  const r = await s.call('POST', `/trades/${t.id}/ready`, { token: t.seller });
  expect(r.json.state).toBe('KEYGEN');
  const group = demoPubkey();
  s.desk.apply(t.id, 'keygen_ok', 'system', { group_pubkey: group });
  return group;
}

async function toAwaitingFunding(s: ReturnType<typeof setup>, t: Awaited<ReturnType<typeof newTrade>>) {
  const group = await toEscrowPending(s, t);
  const esc = demoEscrow(group, 'main');
  let r = await s.call('POST', `/trades/${t.id}/escrow`, {
    token: t.seller,
    body: { groupPubkey: group, ufvk: esc.ufvk, orchardAddress: esc.address, refundUa: demoAddress('main') },
  });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe('ESCROW_PENDING');
  r = await s.call('POST', `/trades/${t.id}/receive-address`, { token: t.buyer, body: { ua: demoAddress('main') } });
  expect(r.json.state).toBe('AWAITING_FUNDING');
  return s.repo.getTrade(t.id)!.zwatch_account_id!;
}

async function toFunded(s: ReturnType<typeof setup>, t: Awaited<ReturnType<typeof newTrade>>) {
  const acct = await toAwaitingFunding(s, t);
  s.zwatch.pay(acct, BigInt(s.repo.getTrade(t.id)!.amount_zat) + 10_000n);
  await s.desk.tick();
  expect(s.repo.getTrade(t.id)!.state).toBe('FUNDED');
  return acct;
}

describe('offers', () => {
  it('validates offers', async () => {
    const s = setup();
    const bad = [
      { minZat: '0' },
      { minZat: '2000', maxZat: '1000' },
      { maxZat: '1000001' },
      { priceMinor: '0' },
      { currency: 'XYZ' },
      { method: 'cheque' },
      { payWindowMin: 5 },
      { minZat: 1.5 },
    ];
    for (const b of bad) {
      const r = await s.call('POST', '/offers', {
        body: { minZat: '100000', maxZat: '1000000', priceMinor: '5000000', currency: 'NGN', method: 'bank_transfer', ...b },
      });
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
  });

  it('lists open offers without maker identity', async () => {
    const s = setup();
    await newOffer(s);
    await newOffer(s, { currency: 'USD', priceMinor: '4500' });
    const all = await s.call('GET', '/offers');
    expect(all.json).toHaveLength(2);
    expect(Object.keys(all.json[0]).sort()).toEqual(['createdHour', 'currency', 'id', 'maxZat', 'method', 'minZat', 'payWindowMin', 'priceMinor', 'remainingZat'].sort());
    expect(JSON.stringify(all.json)).not.toMatch(/token|hash/i);
    expect((await s.call('GET', '/offers?currency=USD')).json).toHaveLength(1);
  });

  it('uses up the range and gives it back when a trade is cancelled', async () => {
    const s = setup();
    const o = await newOffer(s, { minZat: '400000', maxZat: '1000000' });
    expect((await s.call('POST', `/offers/${o.offerId}/take`, { body: { amountZat: '300000' } })).status).toBe(400);
    const a = await s.call('POST', `/offers/${o.offerId}/take`, { body: { amountZat: '600000' } });
    expect(a.status).toBe(201);
    // 400,000 left: exactly the minimum
    expect((await s.call('POST', `/offers/${o.offerId}/take`, { body: { amountZat: '500000' } })).status).toBe(400);
    const b = await s.call('POST', `/offers/${o.offerId}/take`, { body: { amountZat: '400000' } });
    expect(b.status).toBe(201);
    expect((await s.call('GET', '/offers')).json).toHaveLength(0);
    expect(s.repo.getOffer(o.offerId)!.status).toBe('FILLED');
    await s.call('POST', `/trades/${a.json.tradeId}/cancel`, { token: a.json.buyerToken });
    expect(s.repo.getOffer(o.offerId)).toMatchObject({ status: 'OPEN', remaining_zat: 600_000 });
  });

  it('lets only the maker see trades and close the offer', async () => {
    const s = setup();
    const o = await newOffer(s);
    await s.call('POST', `/offers/${o.offerId}/take`, { body: { amountZat: '100000' } });
    expect((await s.call('GET', `/offers/${o.offerId}/maker`)).status).toBe(403);
    expect((await s.call('GET', `/offers/${o.offerId}/maker`, { token: 'nope' })).status).toBe(403);
    const v = await s.call('GET', `/offers/${o.offerId}/maker`, { token: o.makerToken });
    expect(v.json.trades).toHaveLength(1);
    expect(v.json.trades[0]).toMatchObject({ state: 'TAKEN', fiatMinor: '5000', claimed: false });
    expect((await s.call('POST', `/offers/${o.offerId}/close`, { token: o.makerToken })).status).toBe(200);
    expect((await s.call('POST', `/offers/${o.offerId}/take`, { body: { amountZat: '100000' } })).status).toBe(404);
  });
});

describe('capability links', () => {
  it('resolves roles from tokens and hides trades from everyone else', async () => {
    const s = setup();
    const t = await newTrade(s);
    expect((await s.call('GET', `/trades/${t.id}`, { token: t.buyer })).json.role).toBe('buyer');
    expect((await s.call('GET', `/trades/${t.id}`, { token: t.seller })).json.role).toBe('seller');
    expect((await s.call('GET', `/trades/${t.id}`)).status).toBe(404);
    expect((await s.call('GET', `/trades/${t.id}`, { token: 'x'.repeat(43) })).status).toBe(404);
    expect((await s.call('GET', `/trades/${t.id}`, { token: t.offer.makerToken })).status).toBe(404);
    expect((await s.call('GET', '/trades/not-an-id', { token: t.buyer })).status).toBe(404);
  });

  it('stores only token hashes', async () => {
    const s = setup();
    const t = await newTrade(s);
    const dump = JSON.stringify([s.repo.getTrade(t.id), s.repo.getOffer(t.offer.offerId)]);
    for (const tok of [t.buyer, t.seller, t.offer.makerToken]) expect(dump).not.toContain(tok);
  });

  it('rotates the seller token on every claim', async () => {
    const s = setup();
    const t = await newTrade(s);
    const again = await s.call('POST', `/offers/${t.offer.offerId}/trades/${t.id}/claim`, { token: t.offer.makerToken });
    expect((await s.call('GET', `/trades/${t.id}`, { token: t.seller })).status).toBe(404);
    expect((await s.call('GET', `/trades/${t.id}`, { token: again.json.sellerToken })).json.role).toBe('seller');
    expect((await s.call('POST', `/offers/${t.offer.offerId}/trades/${t.id}/claim`, { token: t.buyer })).status).toBe(403);
  });

  it('enforces who may do what', async () => {
    const s = setup();
    const t = await newTrade(s);
    await toFunded(s, t);
    expect((await s.call('POST', `/trades/${t.id}/details-sent`, { token: t.buyer })).status).toBe(409);
    expect((await s.call('POST', `/trades/${t.id}/details-sent`, { token: t.seller })).status).toBe(200);
    expect((await s.call('POST', `/trades/${t.id}/fiat-sent`, { token: t.seller })).status).toBe(409);
    expect((await s.call('POST', `/trades/${t.id}/fiat-sent`, { token: t.buyer })).status).toBe(200);
    expect((await s.call('POST', `/trades/${t.id}/confirm-received`, { token: t.buyer })).status).toBe(409);
    expect((await s.call('POST', `/trades/${t.id}/cancel`, { token: t.buyer })).status).toBe(409);
  });
});

describe('key generation and escrow', () => {
  it('checks contact strings', async () => {
    const s = setup();
    const t = await newTrade(s);
    arbiterIdentity(s, t.id);
    const post = (token: string, contact: string) => s.call('POST', `/trades/${t.id}/contact`, { token, body: { contact } });
    expect((await post(t.buyer, 'hello')).status).toBe(400);
    expect((await post(t.buyer, demoContact('seller', t.id))).json.error).toMatch(/--name buyer-/);
    const pub = demoPubkey();
    expect((await post(t.buyer, demoContact('buyer', t.id, pub))).status).toBe(200);
    expect((await post(t.seller, demoContact('seller', t.id, pub))).json.error).toMatch(/fresh/);
    // Ready needs your own contact first
    expect((await s.call('POST', `/trades/${t.id}/ready`, { token: t.seller })).status).toBe(400);
  });

  it('shows each party the other contacts to import', async () => {
    const s = setup();
    const t = await newTrade(s);
    arbiterIdentity(s, t.id);
    await s.call('POST', `/trades/${t.id}/contact`, { token: t.seller, body: { contact: demoContact('seller', t.id) } });
    const v = (await s.call('GET', `/trades/${t.id}`, { token: t.buyer })).json;
    expect(v.arbiter.contact).toMatch(/^zffrost1/);
    expect(v.seller.contact).toMatch(/^zffrost1/);
    expect(v.groupName).toBe(`trade-${t.id}`);
  });

  it('only accepts an escrow derived from this trade’s group key', async () => {
    const s = setup();
    const t = await newTrade(s);
    const group = await toEscrowPending(s, t);
    const good = demoEscrow(group, 'main');
    const send = (b: Record<string, string>) =>
      s.call('POST', `/trades/${t.id}/escrow`, { token: t.seller, body: { groupPubkey: group, ufvk: good.ufvk, orchardAddress: good.address, refundUa: demoAddress('main'), ...b } });

    expect((await send({ groupPubkey: demoPubkey() })).json.error).toMatch(/group key/);
    expect((await send({ ufvk: demoEscrow(demoPubkey(), 'main').ufvk })).json.error).toMatch(/not generated from this trade/);
    const saplingAndOrchard = encodeUnified('u', [
      { typecode: TYPECODE.SAPLING, data: new Uint8Array(43).fill(1) },
      { typecode: TYPECODE.ORCHARD, data: new Uint8Array(43).fill(2) },
    ]);
    expect((await send({ orchardAddress: saplingAndOrchard })).json.error).toMatch(/Orchard-only/);
    const transparent = encodeUnified('u', [
      { typecode: TYPECODE.P2PKH, data: new Uint8Array(20).fill(1) },
      { typecode: TYPECODE.ORCHARD, data: new Uint8Array(43).fill(2) },
    ]);
    expect((await send({ refundUa: transparent })).json.error).toMatch(/transparent/);
    expect((await send({ orchardAddress: demoAddress('test') })).status).toBe(400);
    expect((await s.call('POST', `/trades/${t.id}/escrow`, { token: t.buyer, body: {} })).status).toBe(403);
    expect((await send({})).status).toBe(200);
  });

  it('rejects receive addresses with a transparent receiver', async () => {
    const s = setup();
    const t = await newTrade(s);
    const transparent = encodeUnified('u', [
      { typecode: TYPECODE.P2PKH, data: new Uint8Array(20).fill(1) },
      { typecode: TYPECODE.ORCHARD, data: new Uint8Array(43).fill(2) },
    ]);
    const r = await s.call('POST', `/trades/${t.id}/receive-address`, { token: t.buyer, body: { ua: transparent } });
    expect(r.json.error).toMatch(/transparent/);
    expect((await s.call('POST', `/trades/${t.id}/receive-address`, { token: t.buyer, body: { ua: 't1abc' } })).status).toBe(400);
    expect((await s.call('POST', `/trades/${t.id}/receive-address`, { token: t.seller, body: { ua: demoAddress('main') } })).status).toBe(403);
  });

  it('imports the escrow into zwatch with the current tip as birthday', async () => {
    const s = setup();
    const t = await newTrade(s);
    const acct = await toAwaitingFunding(s, t);
    expect(s.zwatch.accounts.get(acct)).toMatchObject({ name: `escrow-${t.id}`, birthday: 3_500_000 });
    expect(s.repo.getTrade(t.id)!.birthday).toBe(3_500_000);
  });

  it('retries the zwatch import from the ticker', async () => {
    const s = setup();
    const t = await newTrade(s);
    const group = await toEscrowPending(s, t);
    s.zwatch.fail = true;
    const esc = demoEscrow(group, 'main');
    await s.call('POST', `/trades/${t.id}/escrow`, { token: t.seller, body: { groupPubkey: group, ufvk: esc.ufvk, orchardAddress: esc.address, refundUa: demoAddress('main') } });
    await s.call('POST', `/trades/${t.id}/receive-address`, { token: t.buyer, body: { ua: demoAddress('main') } });
    expect(s.repo.getTrade(t.id)).toMatchObject({ state: 'ESCROW_PENDING', last_error: expect.stringMatching(/zwatch/) });
    s.zwatch.fail = false;
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)!.state).toBe('AWAITING_FUNDING');
  });
});

describe('funding (build guide §8)', () => {
  it('waits for two confirmations of one note covering amount + fee', async () => {
    const s = setup();
    const t = await newTrade(s);
    const acct = await toAwaitingFunding(s, t);
    s.zwatch.pay(acct, 110_000n, 1);
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)).toMatchObject({ state: 'AWAITING_FUNDING', funding_zat: 110_000, funding_conf: 1 });
    s.zwatch.outputs.get(acct)![0].confirmations = 2;
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)!.state).toBe('FUNDED');
  });

  it('refunds a single confirmed note that is too small', async () => {
    const s = setup();
    const t = await newTrade(s);
    const acct = await toAwaitingFunding(s, t);
    s.zwatch.pay(acct, 109_999n);
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)).toMatchObject({ state: 'REFUNDING', settle_kind: 'refund' });
  });

  it('asks for a human when more than one note arrives', async () => {
    const s = setup();
    const t = await newTrade(s);
    const acct = await toAwaitingFunding(s, t);
    s.zwatch.pay(acct, 60_000n);
    s.zwatch.pay(acct, 60_000n);
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)!.state).toBe('NEEDS_ATTENTION');
  });

  it('cancels after 60 minutes with nothing, but waits for unconfirmed money', async () => {
    const s = setup();
    const a = await newTrade(s);
    await toAwaitingFunding(s, a);
    const b = await newTrade(s);
    const acctB = await toAwaitingFunding(s, b);
    s.zwatch.pay(acctB, 110_000n, 0);
    s.clock.t += 61 * MIN;
    await s.desk.tick();
    expect(s.repo.getTrade(a.id)!.state).toBe('CANCELLED');
    expect(s.repo.getTrade(b.id)!.state).toBe('AWAITING_FUNDING');
    s.zwatch.outputs.get(acctB)![0].confirmations = 3;
    await s.desk.tick();
    expect(s.repo.getTrade(b.id)!.state).toBe('FUNDED');
  });

  it('refunds funds that reach a cancelled trade’s escrow', async () => {
    const s = setup();
    const t = await newTrade(s);
    const acct = await toAwaitingFunding(s, t);
    await s.call('POST', `/trades/${t.id}/cancel`, { token: t.buyer });
    expect(s.repo.getTrade(t.id)!.state).toBe('CANCELLED');
    s.zwatch.pay(acct, 110_000n);
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)).toMatchObject({ state: 'REFUNDING', settle_kind: 'refund' });
  });
});

describe('timeouts', () => {
  it('cancels untouched trades after 30 minutes', async () => {
    const s = setup();
    const t = await newTrade(s);
    s.clock.t += 29 * MIN;
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)!.state).toBe('TAKEN');
    s.clock.t += 2 * MIN;
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)!.state).toBe('CANCELLED');
  });

  it('refunds when the buyer never pays, and opens a dispute when the seller goes silent', async () => {
    const s = setup();
    const a = await newTrade(s);
    await toFunded(s, a);
    await s.call('POST', `/trades/${a.id}/details-sent`, { token: a.seller });
    s.clock.t += 31 * MIN;
    await s.desk.tick();
    expect(s.repo.getTrade(a.id)).toMatchObject({ state: 'REFUNDING', settle_kind: 'refund' });

    const b = await newTrade(s);
    await toFunded(s, b);
    await s.call('POST', `/trades/${b.id}/details-sent`, { token: b.seller });
    await s.call('POST', `/trades/${b.id}/fiat-sent`, { token: b.buyer });
    s.clock.t += 61 * MIN;
    await s.desk.tick();
    expect(s.repo.getTrade(b.id)!.state).toBe('DISPUTE');
  });
});

describe('settlement, disputes and the tape', () => {
  it('runs the happy path and publishes a delayed tape row', async () => {
    const s = setup();
    const t = await newTrade(s, '1000000');
    await toFunded(s, t);
    await s.call('POST', `/trades/${t.id}/details-sent`, { token: t.seller });
    await s.call('POST', `/trades/${t.id}/fiat-sent`, { token: t.buyer });
    const r = await s.call('POST', `/trades/${t.id}/confirm-received`, { token: t.seller });
    expect(r.json).toMatchObject({ state: 'RELEASING', settleKind: 'release', fiatMinor: '50000' });
    s.desk.apply(t.id, 'settled', 'system', { release_txid: 'ab'.repeat(32) });
    expect((await s.call('GET', `/trades/${t.id}`, { token: t.buyer })).json).toMatchObject({ state: 'RELEASED', releaseTxid: 'ab'.repeat(32) });

    // random() = 0.5 → published 30 minutes later
    expect((await s.call('GET', '/tape')).json).toEqual([]);
    s.clock.t += 30 * MIN;
    const tape = (await s.call('GET', '/tape')).json;
    expect(tape).toEqual([{ hour: expect.any(Number), currency: 'NGN', priceMinor: '5000000', size: '<0.1' }]);
    expect(tape[0].hour % 3600).toBe(0);
  });

  it('lets the arbiter resolve a dispute either way, with sealed evidence', async () => {
    const s = setup();
    const t = await newTrade(s);
    await toFunded(s, t);
    await s.call('POST', `/trades/${t.id}/details-sent`, { token: t.seller });
    await s.call('POST', `/trades/${t.id}/fiat-sent`, { token: t.buyer });
    const sealed = Buffer.alloc(100, 7).toString('base64url');
    const d = await s.call('POST', `/trades/${t.id}/dispute`, { token: t.buyer, body: { evidenceSealed: sealed } });
    expect(d.json).toMatchObject({ state: 'DISPUTE', disputeBy: 'buyer' });
    expect((await s.call('POST', `/trades/${t.id}/evidence`, { token: t.seller, body: { evidenceSealed: 'not base64!' } })).status).toBe(400);
    await s.call('POST', `/trades/${t.id}/evidence`, { token: t.seller, body: { evidenceSealed: sealed } });

    expect((await s.call('GET', '/admin/trades')).status).toBe(403);
    expect((await s.call('GET', '/admin/trades', { token: t.buyer })).status).toBe(403);
    const list = await s.call('GET', '/admin/trades', { token: ARBITER_TOKEN });
    expect(list.json.find((x: any) => x.id === t.id)).toMatchObject({ state: 'DISPUTE', evidence: 2 });
    const ev = await s.app.request(`/api/admin/trades/${t.id}/evidence/0`, { headers: { authorization: `Bearer ${ARBITER_TOKEN}` } });
    expect(Buffer.from(await ev.arrayBuffer())).toEqual(Buffer.alloc(100, 7));

    const r = await s.call('POST', `/admin/trades/${t.id}/resolve`, { token: ARBITER_TOKEN, body: { to: 'buyer' } });
    expect(r.json).toMatchObject({ state: 'RELEASING', settleKind: 'dispute-release' });
  });

  it('refunds when the buyer cancels after funding', async () => {
    const s = setup();
    const t = await newTrade(s);
    await toFunded(s, t);
    const r = await s.call('POST', `/trades/${t.id}/cancel`, { token: t.buyer });
    expect(r.json).toMatchObject({ state: 'REFUNDING', settleKind: 'refund' });
  });

  it('purges ended trades after 7 days and keeps the tape', async () => {
    const s = setup();
    const t = await newTrade(s);
    await toFunded(s, t);
    await s.call('POST', `/trades/${t.id}/details-sent`, { token: t.seller });
    await s.call('POST', `/trades/${t.id}/fiat-sent`, { token: t.buyer });
    await s.call('POST', `/trades/${t.id}/confirm-received`, { token: t.seller });
    s.desk.apply(t.id, 'settled', 'system', { release_txid: 'cd'.repeat(32) });
    s.clock.t += 6 * 24 * 60 * MIN;
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)).toBeDefined();
    s.clock.t += 2 * 24 * 60 * MIN;
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)).toBeUndefined();
    expect(s.repo.events(t.id)).toEqual([]);
    expect(s.purged).toEqual([t.id]);
    expect((await s.call('GET', '/tape')).json).toHaveLength(1);
  });
});

describe('http', () => {
  it('sends privacy headers', async () => {
    const s = setup();
    const r = await s.call('GET', '/offers');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses dry-run mode in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DESK_DRY_RUN: '1' } as NodeJS.ProcessEnv)).toThrow(/Refusing/);
  });
});
