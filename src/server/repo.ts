// Data access. Everything SQL lives here.

import type { SQLInputValue } from 'node:sqlite';
import type { SettleKind, TradeState } from '../core/state';
import type { DB } from './db';

export type OfferRow = {
  id: string;
  min_zat: number;
  max_zat: number;
  remaining_zat: number;
  price_minor: number;
  currency: string;
  method: string;
  pay_window_min: number;
  maker_token_hash: string;
  status: 'OPEN' | 'FILLED' | 'CLOSED';
  created_at: number;
};

export type TradeRow = {
  id: string;
  offer_id: string;
  amount_zat: number;
  price_minor: number;
  currency: string;
  method: string;
  pay_window_min: number;
  buyer_token_hash: string;
  seller_token_hash: string | null;
  arbiter_contact: string | null;
  arbiter_pub: string | null;
  buyer_contact: string | null;
  seller_contact: string | null;
  buyer_pub: string | null;
  seller_pub: string | null;
  buyer_ready: number;
  seller_ready: number;
  group_pubkey: string | null;
  ufvk: string | null;
  escrow_address: string | null;
  seller_refund_ua: string | null;
  buyer_receive_ua: string | null;
  zwatch_account_id: string | null;
  birthday: number | null;
  funding_zat: number | null;
  funding_conf: number | null;
  funding_notes: number | null;
  state: TradeState;
  state_deadline: number | null;
  settle_kind: SettleKind | null;
  session: string | null;
  worker_lease: number | null;
  last_error: string | null;
  dispute_by: string | null;
  release_txid: string | null;
  refund_txid: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
};

export type TapeRow = { hour_bucket: number; currency: string; price_minor: number; size_bucket: string };
export type EventRow = { trade_id: string; ts: number; type: string; detail: string | null };

const TRADE_COLUMNS = new Set<string>([
  'seller_token_hash', 'arbiter_contact', 'arbiter_pub', 'buyer_contact', 'seller_contact', 'buyer_pub', 'seller_pub',
  'buyer_ready', 'seller_ready', 'group_pubkey', 'ufvk', 'escrow_address', 'seller_refund_ua', 'buyer_receive_ua',
  'zwatch_account_id', 'birthday', 'funding_zat', 'funding_conf', 'funding_notes', 'state', 'state_deadline',
  'settle_kind', 'session', 'worker_lease', 'last_error', 'dispute_by', 'release_txid', 'refund_txid', 'updated_at', 'ended_at',
]);

export type TradeUpdate = Partial<Omit<TradeRow, 'id' | 'offer_id' | 'amount_zat' | 'created_at'>>;

function setClause(fields: TradeUpdate): { sql: string; values: SQLInputValue[] } {
  const keys = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);
  for (const k of keys) if (!TRADE_COLUMNS.has(k)) throw new Error(`unknown trade column ${k}`);
  return {
    sql: keys.map((k) => `${k} = ?`).join(', '),
    values: keys.map((k) => (fields as Record<string, SQLInputValue>)[k]),
  };
}

export class Repo {
  constructor(readonly db: DB) {}

  // --- offers
  insertOffer(o: OfferRow) {
    this.db
      .prepare(`INSERT INTO offers (id, min_zat, max_zat, remaining_zat, price_minor, currency, method, pay_window_min,
                maker_token_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.id, o.min_zat, o.max_zat, o.remaining_zat, o.price_minor, o.currency, o.method, o.pay_window_min,
        o.maker_token_hash, o.status, o.created_at);
  }

  getOffer(id: string): OfferRow | undefined {
    return this.db.prepare('SELECT * FROM offers WHERE id = ?').get(id) as OfferRow | undefined;
  }

  listOpenOffers(filter: { currency?: string; method?: string } = {}): OfferRow[] {
    return this.db
      .prepare(`SELECT * FROM offers WHERE status = 'OPEN' AND remaining_zat >= min_zat
                AND (?1 IS NULL OR currency = ?1) AND (?2 IS NULL OR method = ?2)
                ORDER BY currency, price_minor ASC, created_at ASC LIMIT 200`)
      .all(filter.currency ?? null, filter.method ?? null) as OfferRow[];
  }

  /** Atomically reserves part of an offer's range. Returns false if it is no longer available. */
  reserveOffer(id: string, amountZat: number): boolean {
    const r = this.db
      .prepare(`UPDATE offers SET remaining_zat = remaining_zat - ?1,
                  status = CASE WHEN remaining_zat - ?1 < min_zat THEN 'FILLED' ELSE status END
                WHERE id = ?2 AND status = 'OPEN' AND ?1 >= min_zat AND ?1 <= remaining_zat`)
      .run(amountZat, id);
    return r.changes === 1;
  }

  /** Gives a cancelled or refunded trade's amount back to its offer, unless the seller closed it. */
  releaseOffer(id: string, amountZat: number) {
    this.db
      .prepare(`UPDATE offers SET remaining_zat = MIN(max_zat, remaining_zat + ?1),
                  status = CASE WHEN status = 'FILLED' AND MIN(max_zat, remaining_zat + ?1) >= min_zat THEN 'OPEN' ELSE status END
                WHERE id = ?2 AND status != 'CLOSED'`)
      .run(amountZat, id);
  }

  closeOffer(id: string) {
    this.db.prepare(`UPDATE offers SET status = 'CLOSED' WHERE id = ?`).run(id);
  }

  // --- trades
  insertTrade(t: Pick<TradeRow, 'id' | 'offer_id' | 'amount_zat' | 'price_minor' | 'currency' | 'method' | 'pay_window_min' |
    'buyer_token_hash' | 'state' | 'state_deadline' | 'created_at' | 'updated_at'>) {
    this.db
      .prepare(`INSERT INTO trades (id, offer_id, amount_zat, price_minor, currency, method, pay_window_min, buyer_token_hash,
                state, state_deadline, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.offer_id, t.amount_zat, t.price_minor, t.currency, t.method, t.pay_window_min, t.buyer_token_hash,
        t.state, t.state_deadline, t.created_at, t.updated_at);
  }

  getTrade(id: string): TradeRow | undefined {
    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as TradeRow | undefined;
  }

  tradesForOffer(offerId: string): TradeRow[] {
    return this.db.prepare('SELECT * FROM trades WHERE offer_id = ? ORDER BY created_at DESC').all(offerId) as TradeRow[];
  }

  tradesInStates(states: readonly TradeState[]): TradeRow[] {
    if (!states.length) return [];
    return this.db
      .prepare(`SELECT * FROM trades WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY updated_at ASC`)
      .all(...states) as TradeRow[];
  }

  tradesPastDeadline(now: number): TradeRow[] {
    return this.db
      .prepare('SELECT * FROM trades WHERE state_deadline IS NOT NULL AND state_deadline <= ? ORDER BY state_deadline')
      .all(now) as TradeRow[];
  }

  updateTrade(id: string, fields: TradeUpdate) {
    const { sql, values } = setClause(fields);
    if (!sql) return;
    this.db.prepare(`UPDATE trades SET ${sql} WHERE id = ?`).run(...values, id);
  }

  /**
   * Compare-and-set on the state column: the row lock that keeps one transition (and one settlement)
   * per trade. Returns true only if exactly this caller moved the trade out of `from`.
   */
  casTrade(id: string, from: TradeState, fields: TradeUpdate): boolean {
    const { sql, values } = setClause(fields);
    return this.db.prepare(`UPDATE trades SET ${sql} WHERE id = ? AND state = ?`).run(...values, id, from).changes === 1;
  }

  /** Takes the worker lease on a trade if nobody holds a live one. */
  leaseTrade(id: string, now: number, ttlMs: number): boolean {
    return this.db
      .prepare('UPDATE trades SET worker_lease = ? WHERE id = ? AND (worker_lease IS NULL OR worker_lease < ?)')
      .run(now + ttlMs, id, now).changes === 1;
  }

  releaseLease(id: string) {
    this.db.prepare('UPDATE trades SET worker_lease = NULL WHERE id = ?').run(id);
  }

  // --- evidence
  insertEvidence(tradeId: string, role: string, sealed: Uint8Array, now: number) {
    this.db.prepare('INSERT INTO evidence (trade_id, role, sealed, created_at) VALUES (?, ?, ?, ?)').run(tradeId, role, sealed, now);
  }

  listEvidence(tradeId: string): { role: string; sealed: Uint8Array; created_at: number }[] {
    return this.db
      .prepare('SELECT role, sealed, created_at FROM evidence WHERE trade_id = ? ORDER BY created_at')
      .all(tradeId) as { role: string; sealed: Uint8Array; created_at: number }[];
  }

  // --- tape
  insertTape(r: TapeRow & { publish_at: number }) {
    this.db
      .prepare('INSERT INTO tape (publish_at, hour_bucket, currency, price_minor, size_bucket) VALUES (?, ?, ?, ?, ?)')
      .run(r.publish_at, r.hour_bucket, r.currency, r.price_minor, r.size_bucket);
  }

  publishedTape(now: number, currency?: string): TapeRow[] {
    return this.db
      .prepare(`SELECT hour_bucket, currency, price_minor, size_bucket FROM tape
                WHERE publish_at <= ?1 AND (?2 IS NULL OR currency = ?2)
                ORDER BY hour_bucket DESC, currency, price_minor LIMIT 200`)
      .all(now, currency ?? null) as TapeRow[];
  }

  // --- events
  event(tradeId: string, ts: number, type: string, detail?: string) {
    this.db.prepare('INSERT INTO events (trade_id, ts, type, detail) VALUES (?, ?, ?, ?)').run(tradeId, ts, type, detail ?? null);
  }

  events(tradeId: string, limit = 200): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE trade_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(tradeId, limit) as EventRow[];
  }

  // --- retention
  /** Deletes ended trades (and their events and evidence) older than the cutoff. Returns their ids. */
  purgeEnded(cutoff: number): string[] {
    const ids = (this.db
      .prepare(`SELECT id FROM trades WHERE ended_at IS NOT NULL AND ended_at < ? AND state IN ('RELEASED','REFUNDED','CANCELLED')`)
      .all(cutoff) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare('DELETE FROM events WHERE trade_id = ?').run(id);
      this.db.prepare('DELETE FROM evidence WHERE trade_id = ?').run(id);
      this.db.prepare('DELETE FROM trades WHERE id = ?').run(id);
    }
    // Offers with no trades left that were closed or filled are no longer useful either.
    this.db
      .prepare(`DELETE FROM offers WHERE status != 'OPEN' AND created_at < ? AND id NOT IN (SELECT offer_id FROM trades)`)
      .run(cutoff);
    return ids;
  }
}
