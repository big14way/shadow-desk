import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';
import type { TradeRow } from '../../src/server/repo';
import { settleDir } from '../../src/server/worker/paths';
import { CapError, settle, settlementValue } from '../../src/server/worker/settle';

const FAKEBIN = new URL('../fakebin/', import.meta.url).pathname;
let root: string;
let state: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sd-settle-'));
  state = join(root, 'state');
  mkdirSync(state);
  process.env.FAKE_STATE_DIR = state;
  delete process.env.FAKE_WAIT_PARTICIPANT;
  delete process.env.FAKE_TAMPER;
  delete process.env.FAKE_SPENDS;
  delete process.env.FAKE_INSPECT_TO;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cfg() {
  return loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: root,
    FROSTD_URL: 'localhost:2744',
    FROST_CLIENT_BIN: join(FAKEBIN, 'frost-client'),
    ZCASH_SIGN_BIN: join(FAKEBIN, 'zcash-sign'),
    ZCASH_DEVTOOL_BIN: join(FAKEBIN, 'zcash-devtool'),
  } as NodeJS.ProcessEnv);
}

const trade = (over: Partial<TradeRow> = {}): TradeRow =>
  ({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    amount_zat: 1_000_000,
    ufvk: 'uview1fake',
    group_pubkey: 'bb'.repeat(32),
    buyer_pub: '11'.repeat(32),
    seller_pub: '22'.repeat(32),
    arbiter_pub: '33'.repeat(32),
    buyer_receive_ua: 'u1buyer',
    seller_refund_ua: 'u1seller',
    birthday: 3_500_000,
    ...over,
  }) as TradeRow;

const calls = () =>
  existsSync(join(state, 'calls.log'))
    ? readFileSync(join(state, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
    : [];
const did = (tool: string, sub: string) => calls().some((c) => c[0] === tool && c.includes(sub));

function deps(balance = 1_010_000n) {
  const sessions: any[] = [];
  return { sessions, d: { cfg: cfg(), balance: async () => balance, publish: (s: any) => sessions.push(s), log: () => {} } };
}

describe('settlementValue (the §12 value cap)', () => {
  it('pays the buyer exactly the amount', () => {
    expect(settlementValue('release', 1_010_000n, 1_000_000n)).toBe(1_000_000n);
    expect(settlementValue('dispute-release', 5_000_000n, 1_000_000n)).toBe(1_000_000n);
  });
  it('refunds everything that is there, minus the fee', () => {
    expect(settlementValue('refund', 500_000n, 1_000_000n)).toBe(490_000n);
  });
  it('never signs more than amount + fee', () => {
    expect(() => settlementValue('refund', 5_000_000n, 1_000_000n)).toThrow(CapError);
  });
  it('refuses when the fee cannot be paid', () => {
    expect(() => settlementValue('refund', 10_000n, 1_000_000n)).toThrow(/too low/);
  });
});

describe('settle (with fake tools)', () => {
  it('creates, signs, proves, combines and broadcasts a release', async () => {
    const { sessions, d } = deps();
    const txid = await settle(trade(), 'release', d);
    expect(txid).toBe('f'.repeat(64));
    const seq = calls().map((c) => `${c[0]} ${c.find((a, i) => i > 0 && !a.startsWith('-') && !a.startsWith('/'))}`);
    expect(seq).toEqual(expect.arrayContaining(['zcash-devtool wallet', 'zcash-sign sign', 'frost-client coordinator']));
    const create = calls().find((c) => c.includes('create'))!;
    expect(create).toEqual(expect.arrayContaining(['--address', 'u1buyer', '--value', '1000000', '--memo', 'Shadow Desk aaaaaaaaaaaaaaaaaaaaaaaaaa']));
    const coord = calls().find((c) => c.includes('coordinator'))!;
    expect(coord[coord.indexOf('-S') + 1]).toBe(`${'11'.repeat(32)},${'22'.repeat(32)}`);
    expect(did('frost-client', 'participant')).toBe(false); // the arbiter does not sign a release
    expect(sessions.map((s) => s.status)).toEqual(expect.arrayContaining(['preparing', 'open', 'finishing']));
    expect(sessions.find((s) => s.sighash)?.sighash).toBe('a'.repeat(64));
    expect(sessions.at(-1).inspect).toMatch(/Output: 1000000 zatoshis to u1buyer/);
    expect(readFileSync(join(settleDir(d.cfg, trade().id, 'release'), 'x.txid'), 'utf8')).toBe(txid);
  });

  it('has the arbiter co-sign a dispute release after checking the SIGHASH', async () => {
    process.env.FAKE_WAIT_PARTICIPANT = '1';
    const { d } = deps();
    await settle(trade(), 'dispute-release', d);
    const coord = calls().find((c) => c.includes('coordinator'))!;
    expect(coord[coord.indexOf('-S') + 1]).toBe(`${'33'.repeat(32)},${'11'.repeat(32)}`);
    expect(did('frost-client', 'participant')).toBe(true);
    expect(readFileSync(join(state, 'answered'), 'utf8')).toBe('y');
  });

  it('refuses to sign when the session message is not the SIGHASH', async () => {
    process.env.FAKE_WAIT_PARTICIPANT = '1';
    process.env.FAKE_TAMPER = '1';
    const { d } = deps();
    await expect(settle(trade(), 'dispute-refund', d)).rejects.toThrow(/refusing to sign/);
    expect(readFileSync(join(state, 'answered'), 'utf8')).toBe('n');
  });

  it('runs one FROST session per spend', async () => {
    process.env.FAKE_SPENDS = '2';
    const { d } = deps();
    await settle(trade(), 'release', d);
    expect(calls().filter((c) => c.includes('coordinator'))).toHaveLength(2);
  });

  it('refuses a PCZT that pays someone else', async () => {
    process.env.FAKE_INSPECT_TO = 'u1attacker';
    const { d } = deps();
    await expect(settle(trade(), 'release', d)).rejects.toThrow(/does not pay the expected/);
    expect(did('zcash-sign', 'sign')).toBe(false);
  });

  for (const step of ['sync', 'create', 'zcash-sign', 'coordinator', 'prove', 'combine', 'send'] as const) {
    it(`resumes after a crash at ${step} without signing a new transaction`, async () => {
      const { d } = deps();
      writeFileSync(join(state, `fail-${step}`), '');
      await expect(settle(trade(), 'release', d)).rejects.toThrow();
      rmSync(join(state, `fail-${step}`));
      const before = calls().length;
      const createdBefore = existsSync(join(settleDir(d.cfg, trade().id, 'release'), 'x.created'));
      const signedBefore = existsSync(join(settleDir(d.cfg, trade().id, 'release'), 'x.signed'));
      await expect(settle(trade(), 'release', d)).resolves.toBe('f'.repeat(64));
      const after = calls().slice(before);
      // A created PCZT is never re-created, and a signed one never re-signed.
      if (createdBefore) expect(after.some((c) => c.includes('create'))).toBe(false);
      if (signedBefore) expect(after.some((c) => c[0] === 'zcash-sign' || c.includes('coordinator'))).toBe(false);
    });
  }

  it('returns the saved txid without touching the tools once broadcast', async () => {
    const { d } = deps();
    const txid = await settle(trade(), 'release', d);
    const before = calls().length;
    expect(await settle(trade(), 'release', d)).toBe(txid);
    expect(calls().length).toBe(before);
  });
});
