import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { demoAddress, demoContact, demoEscrow } from '../../src/core/demo';
import { DryRunZwatch } from '../../src/server/dryrun';
import type { TradeRow } from '../../src/server/repo';
import { DryRunBackend, RealBackend, type Backend } from '../../src/server/worker/backend';
import { Worker } from '../../src/server/worker/index';
import { setup } from '../server/helpers';

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function takeAndClaim(s: ReturnType<typeof setup>) {
  const o = await s.call('POST', '/offers', { body: { minZat: '100000', maxZat: '1000000', priceMinor: '5000000', currency: 'NGN', method: 'bank_transfer' } });
  const take = await s.call('POST', `/offers/${o.json.offerId}/take`, { body: { amountZat: '200000' } });
  const claim = await s.call('POST', `/offers/${o.json.offerId}/trades/${take.json.tradeId}/claim`, { token: o.json.makerToken });
  return { id: take.json.tradeId as string, buyer: take.json.buyerToken as string, seller: claim.json.sellerToken as string };
}

let workers: Worker[] = [];
afterEach(() => {
  workers.forEach((w) => w.stop());
  workers = [];
});

describe('worker loop', () => {
  it('drives a whole dry-run trade to RELEASED', async () => {
    const s = setup({ DESK_DRY_RUN: '1' }, { zwatch: (repo) => new DryRunZwatch(repo, Date.now, 0, 1) });
    const w = new Worker(s.desk, new DryRunBackend(0.002));
    workers.push(w);
    s.hooks.onChange = () => w.poke();
    const t = await takeAndClaim(s);
    w.poke();
    await until(() => !!s.repo.getTrade(t.id)!.arbiter_contact);

    await s.call('POST', `/trades/${t.id}/contact`, { token: t.buyer, body: { contact: demoContact('buyer', t.id) } });
    await s.call('POST', `/trades/${t.id}/contact`, { token: t.seller, body: { contact: demoContact('seller', t.id) } });
    await s.call('POST', `/trades/${t.id}/ready`, { token: t.buyer });
    await s.call('POST', `/trades/${t.id}/ready`, { token: t.seller });
    await until(() => s.repo.getTrade(t.id)!.state === 'ESCROW_PENDING');

    const v = (await s.call('GET', `/trades/${t.id}`, { token: t.seller })).json;
    expect(v.network).toBe('test');
    const esc = demoEscrow(v.groupPubkey, 'test');
    await s.call('POST', `/trades/${t.id}/escrow`, { token: t.seller, body: { groupPubkey: v.groupPubkey, ufvk: esc.ufvk, orchardAddress: esc.address, refundUa: demoAddress('test') } });
    await s.call('POST', `/trades/${t.id}/receive-address`, { token: t.buyer, body: { ua: demoAddress('test') } });
    expect(s.repo.getTrade(t.id)!.state).toBe('AWAITING_FUNDING');
    await new Promise((r) => setTimeout(r, 5));
    await s.desk.tick();
    expect(s.repo.getTrade(t.id)!.state).toBe('FUNDED');

    await s.call('POST', `/trades/${t.id}/details-sent`, { token: t.seller });
    await s.call('POST', `/trades/${t.id}/fiat-sent`, { token: t.buyer });
    await s.call('POST', `/trades/${t.id}/confirm-received`, { token: t.seller });
    await until(() => s.repo.getTrade(t.id)!.state === 'RELEASED');
    const done = (await s.call('GET', `/trades/${t.id}`, { token: t.buyer })).json;
    expect(done.releaseTxid).toMatch(/^dryrun-[0-9a-f]+$/);
    expect(done.session).toMatchObject({ type: 'sign', status: 'done', kind: 'release', signers: ['buyer', 'seller'] });
  });

  it('runs one settlement per trade, even with two workers', async () => {
    const s = setup();
    let calls = 0;
    let finish!: (txid: string) => void;
    const slow: Backend = {
      arbiterIdentity: async () => ({ contact: 'c', pub: 'p' }),
      keygen: async () => 'g',
      settle: () => {
        calls++;
        return new Promise((r) => (finish = r));
      },
      cleanup: async () => {},
    };
    const t = await takeAndClaim(s);
    s.repo.updateTrade(t.id, { state: 'RELEASING', settle_kind: 'release' } as Partial<TradeRow>);
    const a = new Worker(s.desk, slow);
    const b = new Worker(s.desk, slow);
    workers.push(a, b);
    a.poke();
    a.poke();
    b.poke();
    await until(() => calls > 0);
    a.poke();
    b.poke();
    expect(calls).toBe(1);
    finish('ab'.repeat(32));
    await a.idle();
    expect(s.repo.getTrade(t.id)).toMatchObject({ state: 'RELEASED', release_txid: 'ab'.repeat(32), worker_lease: null });
  });

  it('records a failed settlement and retries later instead of giving up', async () => {
    const s = setup();
    let attempts = 0;
    const flaky: Backend = {
      arbiterIdentity: async () => ({ contact: 'c', pub: 'p' }),
      keygen: async () => 'g',
      settle: async () => {
        attempts++;
        throw new Error('lightwalletd unreachable');
      },
      cleanup: async () => {},
    };
    const t = await takeAndClaim(s);
    s.repo.updateTrade(t.id, { state: 'REFUNDING', settle_kind: 'refund' } as Partial<TradeRow>);
    const w = new Worker(s.desk, flaky, () => s.clock.t);
    workers.push(w);
    w.poke();
    await w.idle();
    expect(s.repo.getTrade(t.id)).toMatchObject({ state: 'REFUNDING', last_error: expect.stringMatching(/lightwalletd/) });
    w.poke();
    await w.idle();
    expect(attempts).toBe(1); // backing off
    s.clock.t += 31_000;
    w.poke();
    await w.idle();
    expect(attempts).toBe(2);
  });

  it('runs the arbiter side of the DKG with the real backend (fake frost-client)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sd-dkg-'));
    process.env.FAKE_STATE_DIR = join(root, 'state');
    try {
      const fakebin = new URL('../fakebin/', import.meta.url).pathname;
      const s = setup({ DATA_DIR: root, FROST_CLIENT_BIN: join(fakebin, 'frost-client') });
      const backend = new RealBackend(s.cfg, s.zwatch);
      const w = new Worker(s.desk, backend);
      workers.push(w);
      s.hooks.onChange = () => w.poke();
      const t = await takeAndClaim(s);
      w.poke();
      await until(() => !!s.repo.getTrade(t.id)!.arbiter_contact, 5000);
      expect(s.repo.getTrade(t.id)!.arbiter_pub).toBe('431a2b9b0f325f73ae1f6878a4c0425e23121ede337740fef5f9ed3d1ee3e149');
      await s.call('POST', `/trades/${t.id}/contact`, { token: t.buyer, body: { contact: demoContact('buyer', t.id) } });
      await s.call('POST', `/trades/${t.id}/contact`, { token: t.seller, body: { contact: demoContact('seller', t.id) } });
      await s.call('POST', `/trades/${t.id}/ready`, { token: t.buyer });
      await s.call('POST', `/trades/${t.id}/ready`, { token: t.seller });
      await until(() => s.repo.getTrade(t.id)!.state === 'ESCROW_PENDING', 5000);
      expect(s.repo.getTrade(t.id)!.group_pubkey).toBe('bbe261cce497936c8eb4f48ad194c78b096a66608ba941defe9631e811d42c39');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
