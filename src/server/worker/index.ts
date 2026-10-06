// The signing worker loop. Runs inside the desk process: it watches the trades table and drives the arbiter's side of
// every trade — identity, DKG, settlement — with one job per trade at a time (in-process map plus a DB lease, so even
// two processes can't settle the same trade twice).

import type { SessionInfo } from '../../core/api';
import { paysBuyer } from '../../core/state';
import { DeskError, type Desk } from '../desk';
import type { TradeRow } from '../repo';
import type { Backend, SignSession } from './backend';
import { CapError } from './settle';

const LEASE_MS = 5 * 60_000;

export class Worker {
  private jobs = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private rescan = false;
  private retryAt = new Map<string, number>();

  constructor(
    private desk: Desk,
    private backend: Backend,
    private now: () => number = Date.now,
  ) {}

  start(intervalMs = 2000) {
    this.timer = setInterval(() => this.poke(), intervalMs);
    this.poke();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.jobs.values()) c.abort();
  }

  /** Something changed: look for work now. */
  poke() {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    try {
      this.scan();
    } finally {
      this.scanning = false;
    }
    if (this.rescan) {
      this.rescan = false;
      queueMicrotask(() => this.poke());
    }
  }

  /** Resolves when every running job has finished (tests). */
  async idle() {
    while (this.jobs.size) await new Promise((r) => setTimeout(r, 5));
  }

  private scan() {
    const repo = this.desk.repo;
    for (const t of repo.tradesInStates(['TAKEN'])) if (!t.arbiter_contact) this.job(t, 'identity', () => this.identity(t));
    for (const t of repo.tradesInStates(['KEYGEN'])) this.job(t, 'keygen', (s) => this.keygen(t, s));
    for (const t of repo.tradesInStates(['RELEASING', 'REFUNDING'])) {
      if ((this.retryAt.get(t.id) ?? 0) > this.now()) continue;
      this.job(t, 'settle', (s) => this.settle(t, s));
    }
    // Abort jobs whose trade moved on (a DKG whose trade timed out, for example).
    for (const [id, ctl] of this.jobs) {
      const t = repo.getTrade(id);
      if (!t || !['TAKEN', 'KEYGEN', 'RELEASING', 'REFUNDING'].includes(t.state)) ctl.abort();
    }
  }

  private job(t: TradeRow, name: string, fn: (signal: AbortSignal) => Promise<void>) {
    if (this.jobs.has(t.id)) return;
    const repo = this.desk.repo;
    if (!repo.leaseTrade(t.id, this.now(), LEASE_MS)) return;
    const ctl = new AbortController();
    this.jobs.set(t.id, ctl);
    const heartbeat = setInterval(() => repo.updateTrade(t.id, { worker_lease: this.now() + LEASE_MS }), LEASE_MS / 3);
    fn(ctl.signal)
      .catch((e) => {
        if (ctl.signal.aborted) return;
        const msg = (e as Error).message;
        repo.event(t.id, this.now(), 'error', `${name}: ${msg.slice(0, 2000)}`);
        repo.updateTrade(t.id, { last_error: `${name}: ${msg.slice(0, 500)}` });
        console.error(`[worker] ${name} ${t.id}: ${msg.split('\n')[0]}`);
      })
      .finally(() => {
        clearInterval(heartbeat);
        repo.releaseLease(t.id);
        this.jobs.delete(t.id);
        this.desk.hooks.onChange?.(repo.getTrade(t.id) ?? t);
      });
  }

  private setSession(id: string, s: SessionInfo) {
    this.desk.repo.updateTrade(id, { session: JSON.stringify(s) });
  }

  private async identity(t: TradeRow) {
    const { contact, pub } = await this.backend.arbiterIdentity(t);
    this.desk.repo.updateTrade(t.id, { arbiter_contact: contact, arbiter_pub: pub });
    this.desk.repo.event(t.id, this.now(), 'worker', 'arbiter identity ready');
  }

  private async keygen(t: TradeRow, signal: AbortSignal) {
    for (let attempt = 1; !signal.aborted; attempt++) {
      const cur = this.desk.repo.getTrade(t.id);
      if (cur?.state !== 'KEYGEN') return;
      this.setSession(t.id, { type: 'dkg', status: 'starting', attempt, at: this.now() });
      try {
        const group = await this.backend.keygen(cur, () => this.setSession(t.id, { type: 'dkg', status: 'open', attempt, at: this.now() }), signal);
        this.desk.apply(t.id, 'keygen_ok', 'system', { group_pubkey: group });
        return;
      } catch (e) {
        if (signal.aborted) return;
        const error = (e as Error).message.split('\n')[0].slice(0, 300);
        this.setSession(t.id, { type: 'dkg', status: 'failed', attempt, error, at: this.now() });
        this.desk.repo.event(t.id, this.now(), 'error', `dkg attempt ${attempt}: ${(e as Error).message.slice(0, 2000)}`);
        // Participants re-run their command; the KEYGEN deadline cancels the trade eventually.
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async settle(t: TradeRow, signal: AbortSignal) {
    const kind = t.settle_kind;
    if (!kind) throw new Error('no settle kind');
    const publish = (s: SignSession) => this.setSession(t.id, s);
    const log = (type: string, detail: string) => this.desk.repo.event(t.id, this.now(), type, detail);
    try {
      const txid = await this.backend.settle(t, kind, publish, log, signal);
      const last = this.desk.repo.getTrade(t.id)?.session;
      const done = last ? { ...(JSON.parse(last) as SignSession), status: 'done' as const, at: this.now() } : null;
      this.desk.apply(t.id, 'settled', 'system', {
        [paysBuyer(kind) ? 'release_txid' : 'refund_txid']: txid,
        session: done ? JSON.stringify(done) : null,
      });
      this.retryAt.delete(t.id);
    } catch (e) {
      if (e instanceof DeskError) throw e;
      // Funds are in escrow: keep trying (resuming from the files on disk), backing off up to 5 minutes.
      // A value-cap violation is never retried automatically.
      const prev = this.retryAt.has(t.id) ? 2 : 1;
      if (!(e instanceof CapError)) this.retryAt.set(t.id, this.now() + Math.min(300_000, 30_000 * prev));
      else this.retryAt.set(t.id, Number.MAX_SAFE_INTEGER);
      const last = this.desk.repo.getTrade(t.id)?.session;
      if (last) this.setSession(t.id, { ...(JSON.parse(last) as SignSession), status: 'failed', error: (e as Error).message.split('\n')[0].slice(0, 300), at: this.now() });
      throw e;
    }
  }
}
