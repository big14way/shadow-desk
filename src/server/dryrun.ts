// DESK_DRY_RUN=1: a pretend zwatch. A few seconds after an escrow is imported, one note of exactly amount + fee
// "arrives" and gains a confirmation every few seconds.

import { demoTxid } from '../core/demo';
import { FEE_ZAT } from '../core/money';
import type { Repo } from './repo';
import type { ReceivedOutput, Zwatch } from './zwatch';

export class DryRunZwatch implements Zwatch {
  private created = new Map<string, number>();
  private txids = new Map<string, string>();

  constructor(
    private repo: Repo,
    private now: () => number = Date.now,
    private arriveAfterMs = 5000,
    private confirmEveryMs = 3000,
  ) {}

  async createAccount(a: { name: string; ufvk: string; birthday?: number }) {
    const id = `dryrun-${a.name}`;
    this.created.set(id, this.now());
    return { id, birthday: a.birthday ?? 3_500_000 };
  }

  async received(id: string): Promise<ReceivedOutput[]> {
    const tradeId = id.replace(/^dryrun-escrow-/, '');
    const t = this.repo.getTrade(tradeId);
    // After a restart the import time is lost; treat the escrow as funded long ago.
    const since = this.now() - (this.created.get(id) ?? 0) - this.arriveAfterMs;
    if (!t || since < 0) return [];
    if (!this.txids.has(id)) this.txids.set(id, demoTxid());
    return [{ txid: this.txids.get(id)!, valueZat: BigInt(t.amount_zat) + FEE_ZAT, confirmations: 1 + Math.floor(since / this.confirmEveryMs) }];
  }

  async balance(id: string) {
    return (await this.received(id)).reduce((s, o) => s + o.valueZat, 0n);
  }

  async health() {
    return { ok: true, tip: 3_500_000 };
  }
}
