// The two escrow backends: real (frost-client, zcash-sign, zcash-devtool) and dry-run (timers and fakes).

import { chmod, mkdir, rm } from 'node:fs/promises';
import type { SessionInfo } from '../../core/api';
import { groupName } from '../../core/commands';
import { demoContact, demoPubkey, demoTxid } from '../../core/demo';
import { FEE_ZAT, zatToZec } from '../../core/money';
import { paysBuyer, signersFor, type SettleKind } from '../../core/state';
import type { Config } from '../config';
import type { TradeRow } from '../repo';
import type { Zwatch } from '../zwatch';
import { arbiterIdentity, ensureContact, runDkg, type FrostEnv } from './frost';
import { arbiterConfigPath, escrowWalletDir } from './paths';
import { settle, type SettleDeps } from './settle';

export type SignSession = Extract<SessionInfo, { type: 'sign' }>;

export interface Backend {
  /** A fresh arbiter frost-client identity for this trade. */
  arbiterIdentity(t: TradeRow): Promise<{ contact: string; pub: string }>;
  /** The arbiter's side of the DKG; `onOpen` tells participants to run theirs. Returns the group public key. */
  keygen(t: TradeRow, onOpen: () => void, signal: AbortSignal): Promise<string>;
  /** Releases or refunds the escrow. Returns the txid. */
  settle(t: TradeRow, kind: SettleKind, publish: (s: SignSession) => void, log: (type: string, detail: string) => void, signal: AbortSignal): Promise<string>;
  /** Deletes a purged trade's key share, wallet and work files. */
  cleanup(tradeId: string): Promise<void>;
}

export class RealBackend implements Backend {
  private env: FrostEnv;

  constructor(
    private cfg: Config,
    private zwatch: Zwatch,
  ) {
    this.env = { bin: cfg.bins.frostClient, serverUrl: cfg.frostdUrl };
  }

  async arbiterIdentity(t: TradeRow) {
    await mkdir(this.cfg.frostDir, { recursive: true, mode: 0o700 });
    const path = arbiterConfigPath(this.cfg, t.id);
    const { contact, pubkey } = await arbiterIdentity(this.env, path, `arbiter-${t.id}`);
    await chmod(path, 0o600);
    return { contact, pub: pubkey };
  }

  async keygen(t: TradeRow, onOpen: () => void, signal: AbortSignal) {
    if (!t.buyer_contact || !t.seller_contact || !t.buyer_pub || !t.seller_pub) throw new Error('contacts missing');
    const path = arbiterConfigPath(this.cfg, t.id);
    await ensureContact(this.env, path, t.buyer_contact, `buyer-${t.id}`, t.buyer_pub);
    await ensureContact(this.env, path, t.seller_contact, `seller-${t.id}`, t.seller_pub);
    return runDkg(this.env, {
      configPath: path,
      description: groupName(t.id),
      participants: [t.buyer_pub, t.seller_pub],
      onOpen,
      timeoutMs: 6 * 60_000,
      signal,
    });
  }

  settle(t: TradeRow, kind: SettleKind, publish: SettleDeps['publish'], log: SettleDeps['log'], signal: AbortSignal) {
    return settle(t, kind, {
      cfg: this.cfg,
      balance: (tr) => this.zwatch.balance(tr.zwatch_account_id!),
      publish,
      log,
      signal,
    });
  }

  async cleanup(tradeId: string) {
    // The arbiter's share is useless once the escrow is settled and the 7-day window has passed.
    await rm(arbiterConfigPath(this.cfg, tradeId), { force: true });
    await rm(escrowWalletDir(this.cfg, tradeId), { recursive: true, force: true });
    await rm(`${this.cfg.workDir}/${tradeId}`, { recursive: true, force: true });
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
  });

const hex32 = () => demoPubkey();

/** DESK_DRY_RUN=1: no FROST, no Zcash. Each step advances on a timer and the txids start with `dryrun-`. */
export class DryRunBackend implements Backend {
  constructor(private speed = 1) {}

  async arbiterIdentity(t: TradeRow) {
    await sleep(300 * this.speed);
    const pub = demoPubkey();
    return { contact: demoContact('arbiter', t.id, pub), pub };
  }

  async keygen(_t: TradeRow, onOpen: () => void, signal: AbortSignal) {
    await sleep(1000 * this.speed, signal);
    onOpen();
    await sleep(4000 * this.speed, signal);
    return demoPubkey();
  }

  async settle(t: TradeRow, kind: SettleKind, publish: (s: SignSession) => void, log: (type: string, detail: string) => void, signal: AbortSignal) {
    const to = (paysBuyer(kind) ? t.buyer_receive_ua : t.seller_refund_ua) ?? '';
    const value = paysBuyer(kind) ? BigInt(t.amount_zat) : BigInt(t.funding_zat ?? t.amount_zat + Number(FEE_ZAT)) - FEE_ZAT;
    const inspect = [
      '2 Orchard actions:',
      '- 0:',
      `  - Spend: ${BigInt(t.amount_zat) + FEE_ZAT} zatoshis`,
      `  - Output: ${value} zatoshis to ${to}`,
      '- 1:',
      '  - Spend: Zero value (likely a dummy)',
      '  - Output: Zero value (likely a dummy)',
      '',
      `(dry run: ${zatToZec(value)} ZEC, fee ${zatToZec(FEE_ZAT)} ZEC)`,
    ].join('\n');
    const base: SignSession = { type: 'sign', kind, signers: signersFor(kind), status: 'preparing', to, valueZat: String(value), inspect, at: Date.now() };
    publish(base);
    await sleep(1500 * this.speed, signal);
    const sighash = hex32();
    publish({ ...base, status: 'open', sighash, randomizer: hex32(), spend: 0, at: Date.now() });
    log('worker', 'dry run: signing session open');
    await sleep(5000 * this.speed, signal);
    publish({ ...base, status: 'finishing', sighash, at: Date.now() });
    await sleep(1500 * this.speed, signal);
    return demoTxid();
  }

  async cleanup() {}
}
