// The desk: offers, trades and the state machine, with every rule from build guide §6–§11.
// HTTP lives in app.ts; long-running FROST and Zcash work lives in worker/.

import { nextAction, type MakerView, type OfferPublic, type Role, type SessionInfo, type TapeEntry, type TradeSummary, type TradeView } from '../core/api';
import { isCurrency, isMethod } from '../core/catalog';
import { contactName, groupName } from '../core/commands';
import { isHex32, parseContact } from '../core/contact';
import { FEE_ZAT, fiatMinorFor, MAX_TRADE_ZAT } from '../core/money';
import { deadlineFor, isTerminal, transition, TransitionError, type Actor, type TradeEvent, type TradeState } from '../core/state';
import { hourBucket, sizeBucket, tapeDelay } from '../core/tape';
import { checkEscrowAddress, checkShieldedAddress, ufvkOrchardAk } from '../core/unified';
import type { Config } from './config';
import { tx } from './db';
import type { OfferRow, Repo, TradeRow, TradeUpdate } from './repo';
import { hashToken, newId, newToken, sameHash } from './tokens';
import { fundingStatus, type Zwatch } from './zwatch';

export class DeskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const bad = (msg: string) => new DeskError(400, msg);
const RETENTION_MS = 7 * 24 * 3_600_000;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024 + 48; // 2 MB plus the sealed-box overhead

export type DeskHooks = {
  /** Called after trades are purged, so the worker can delete their files. */
  onPurge?: (ids: string[]) => void;
  /** Called after any state change, so the worker can wake up. */
  onChange?: (t: TradeRow) => void;
};

function intInput(v: unknown, what: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,18}$/.test(v)) return BigInt(v);
  throw bad(`${what} must be a non-negative integer`);
}

export class Desk {
  private escrowInflight = new Set<string>();

  constructor(
    readonly repo: Repo,
    readonly cfg: Config,
    readonly zwatch: Zwatch,
    readonly now: () => number = Date.now,
    readonly random: () => number = Math.random,
    readonly hooks: DeskHooks = {},
  ) {}

  // ---------------------------------------------------------------- offers

  createOffer(input: Record<string, unknown>): { offerId: string; makerToken: string } {
    const minZat = intInput(input.minZat, 'minZat');
    const maxZat = intInput(input.maxZat, 'maxZat');
    const priceMinor = intInput(input.priceMinor, 'priceMinor');
    const payWindowMin = input.payWindowMin === undefined ? 30 : Number(input.payWindowMin);
    if (!(minZat > 0n && minZat <= maxZat && maxZat <= MAX_TRADE_ZAT)) {
      throw bad(`need 0 < min ≤ max ≤ ${MAX_TRADE_ZAT} zatoshis (0.01 ZEC during the hackathon)`);
    }
    if (priceMinor <= 0n) throw bad('price must be positive');
    if (!isCurrency(input.currency)) throw bad('unknown currency');
    if (!isMethod(input.method)) throw bad('unknown payment method');
    if (!Number.isInteger(payWindowMin) || payWindowMin < 15 || payWindowMin > 180) throw bad('payment window must be 15–180 minutes');

    const makerToken = newToken();
    const offer: OfferRow = {
      id: newId(),
      min_zat: Number(minZat),
      max_zat: Number(maxZat),
      remaining_zat: Number(maxZat),
      price_minor: Number(priceMinor),
      currency: input.currency,
      method: input.method,
      pay_window_min: payWindowMin,
      maker_token_hash: hashToken(makerToken),
      status: 'OPEN',
      created_at: this.now(),
    };
    this.repo.insertOffer(offer);
    return { offerId: offer.id, makerToken };
  }

  private offerPublic(o: OfferRow): OfferPublic {
    return {
      id: o.id,
      minZat: String(o.min_zat),
      maxZat: String(o.max_zat),
      remainingZat: String(o.remaining_zat),
      priceMinor: String(o.price_minor),
      currency: o.currency,
      method: o.method,
      payWindowMin: o.pay_window_min,
      // Hour only: the exact creation time would help link an offer to its seller's activity.
      createdHour: hourBucket(o.created_at),
    };
  }

  listOffers(filter: { currency?: string; method?: string }): OfferPublic[] {
    return this.repo.listOpenOffers(filter).map((o) => this.offerPublic(o));
  }

  private makerOffer(offerId: string, token: string): OfferRow {
    const o = this.repo.getOffer(offerId);
    if (!o) throw new DeskError(404, 'offer not found');
    if (!sameHash(hashToken(token), o.maker_token_hash)) throw new DeskError(403, 'not your offer');
    return o;
  }

  makerView(offerId: string, token: string): MakerView {
    const o = this.makerOffer(offerId, token);
    const trades: TradeSummary[] = this.repo.tradesForOffer(o.id).map((t) => ({
      id: t.id,
      state: t.state,
      amountZat: String(t.amount_zat),
      fiatMinor: String(fiatMinorFor(BigInt(t.amount_zat), BigInt(t.price_minor))),
      createdAt: t.created_at,
      stateDeadline: t.state_deadline,
      claimed: !!t.seller_token_hash,
    }));
    return { offer: { ...this.offerPublic(o), status: o.status }, trades };
  }

  closeOffer(offerId: string, token: string) {
    this.makerOffer(offerId, token);
    this.repo.closeOffer(offerId);
  }

  takeOffer(offerId: string, amountInput: unknown): { tradeId: string; buyerToken: string } {
    const amountZat = intInput(amountInput, 'amountZat');
    const buyerToken = newToken();
    const id = newId();
    const now = this.now();
    tx(this.repo.db, () => {
      const o = this.repo.getOffer(offerId);
      if (!o || o.status !== 'OPEN') throw new DeskError(404, 'offer not available');
      if (amountZat < BigInt(o.min_zat) || amountZat > BigInt(o.remaining_zat)) {
        throw bad(`amount must be between ${o.min_zat} and ${o.remaining_zat} zatoshis`);
      }
      if (!this.repo.reserveOffer(o.id, Number(amountZat))) throw new DeskError(409, 'offer changed; try again');
      this.repo.insertTrade({
        id,
        offer_id: o.id,
        amount_zat: Number(amountZat),
        price_minor: o.price_minor,
        currency: o.currency,
        method: o.method,
        pay_window_min: o.pay_window_min,
        buyer_token_hash: hashToken(buyerToken),
        state: 'TAKEN',
        state_deadline: deadlineFor('TAKEN', now, o.pay_window_min),
        created_at: now,
        updated_at: now,
      });
      this.repo.event(id, now, 'state', '→TAKEN');
    });
    this.changed(id);
    return { tradeId: id, buyerToken };
  }

  /**
   * The seller reaches a trade through their offer link: this issues a fresh per-trade seller token (and revokes the
   * previous one), so a leaked trade link never exposes the offer and vice versa.
   */
  claimSellerLink(offerId: string, tradeId: string, makerToken: string): { sellerToken: string } {
    this.makerOffer(offerId, makerToken);
    const t = this.repo.getTrade(tradeId);
    if (!t || t.offer_id !== offerId) throw new DeskError(404, 'trade not found');
    const sellerToken = newToken();
    this.repo.updateTrade(t.id, { seller_token_hash: hashToken(sellerToken) });
    return { sellerToken };
  }

  // ---------------------------------------------------------------- trades: access

  getTrade(id: string): TradeRow {
    const t = this.repo.getTrade(id);
    if (!t) throw new DeskError(404, 'trade not found');
    return t;
  }

  roleFor(tradeId: string, token: string | undefined): { trade: TradeRow; role: Role } {
    const trade = this.getTrade(tradeId);
    if (token) {
      const h = hashToken(token);
      if (sameHash(h, trade.buyer_token_hash)) return { trade, role: 'buyer' };
      if (sameHash(h, trade.seller_token_hash)) return { trade, role: 'seller' };
    }
    // Same answer as an unknown trade: a wrong token learns nothing.
    throw new DeskError(404, 'trade not found');
  }

  view(t: TradeRow, role: Role): TradeView {
    const session = t.session ? (JSON.parse(t.session) as SessionInfo) : null;
    const v: Omit<TradeView, 'next'> = {
      id: t.id,
      role,
      state: t.state,
      stateDeadline: t.state_deadline,
      now: this.now(),
      dryRun: this.cfg.dryRun,
      network: this.cfg.network,
      amountZat: String(t.amount_zat),
      feeZat: String(FEE_ZAT),
      priceMinor: String(t.price_minor),
      fiatMinor: String(fiatMinorFor(BigInt(t.amount_zat), BigInt(t.price_minor))),
      currency: t.currency,
      method: t.method,
      payWindowMin: t.pay_window_min,
      frostdUrl: this.cfg.frostdUrl,
      groupName: groupName(t.id),
      arbiter: { contact: t.arbiter_contact, pub: t.arbiter_pub },
      buyer: { contact: t.buyer_contact, pub: t.buyer_pub, ready: !!t.buyer_ready, receiveUa: t.buyer_receive_ua },
      // The refund address is the seller's business only.
      seller: { contact: t.seller_contact, pub: t.seller_pub, ready: !!t.seller_ready, refundUa: role === 'seller' ? t.seller_refund_ua : null },
      groupPubkey: t.group_pubkey,
      escrow: { address: t.escrow_address, ufvk: t.ufvk },
      funding: {
        seenZat: t.funding_zat === null ? null : String(t.funding_zat),
        confirmations: t.funding_conf,
        notes: t.funding_notes,
      },
      settleKind: t.settle_kind,
      session,
      disputeBy: t.dispute_by,
      releaseTxid: t.release_txid,
      refundTxid: t.refund_txid,
      lastError: t.last_error,
      arbiterBoxPubkey: this.cfg.arbiterBoxPubkey ?? null,
    };
    return { ...v, next: nextAction(v) };
  }

  // ---------------------------------------------------------------- transitions

  /**
   * Applies a state-machine event with a compare-and-set on the current state, so two callers can never both move the
   * same trade (the single-flight rule of §12). Side effects of entering a state happen here.
   */
  apply(tradeId: string, event: TradeEvent, actor: Actor, fields: TradeUpdate = {}): TradeRow {
    const now = this.now();
    const t = this.getTrade(tradeId);
    let r: ReturnType<typeof transition>;
    try {
      r = transition(t.state, event, actor);
    } catch (e) {
      if (e instanceof TransitionError) throw new DeskError(409, e.message);
      throw e;
    }
    const to: TradeState = r.to;
    const update: TradeUpdate = {
      ended_at: isTerminal(to) ? now : null,
      last_error: null,
      session: null,
      ...fields,
      state: to,
      state_deadline: deadlineFor(to, now, t.pay_window_min),
      updated_at: now,
    };
    if (r.settle) update.settle_kind = r.settle;
    tx(this.repo.db, () => {
      if (!this.repo.casTrade(t.id, t.state, update)) throw new DeskError(409, 'trade changed; reload');
      this.repo.event(t.id, now, 'state', `${t.state}→${to} (${event} by ${actor})`);
      if (to === 'RELEASED') this.recordTape(t);
      if ((to === 'CANCELLED' || to === 'REFUNDED') && t.state !== 'CANCELLED') this.repo.releaseOffer(t.offer_id, t.amount_zat);
    });
    return this.changed(t.id);
  }

  private changed(id: string): TradeRow {
    const t = this.getTrade(id);
    this.hooks.onChange?.(t);
    return t;
  }

  private recordTape(t: TradeRow) {
    const publishAt = this.now() + tapeDelay(this.cfg.tapeMaxDelayMs, this.random);
    this.repo.insertTape({
      publish_at: publishAt,
      hour_bucket: hourBucket(publishAt),
      currency: t.currency,
      price_minor: t.price_minor,
      size_bucket: sizeBucket(BigInt(t.amount_zat)),
    });
  }

  // ---------------------------------------------------------------- trades: party actions

  submitContact(tradeId: string, role: Role, contact: unknown) {
    const t = this.getTrade(tradeId);
    if (t.state !== 'TAKEN') throw new DeskError(409, 'contacts can only change before key generation');
    if (typeof contact !== 'string') throw bad('contact must be a string');
    let parsed;
    try {
      parsed = parseContact(contact);
    } catch (e) {
      throw bad(`not a frost-client contact string: ${(e as Error).message}`);
    }
    const expected = contactName(role, t.id);
    if (parsed.name !== expected) throw bad(`export your contact with --name ${expected}`);
    const others = [t.arbiter_pub, role === 'buyer' ? t.seller_pub : t.buyer_pub];
    if (others.includes(parsed.pubkey)) throw bad('use a fresh frost-client config for each trade');
    this.repo.updateTrade(t.id, {
      [`${role}_contact`]: contact.trim(),
      [`${role}_pub`]: parsed.pubkey,
      [`${role}_ready`]: 0,
      updated_at: this.now(),
    } as TradeUpdate);
    this.repo.event(t.id, this.now(), 'contact', role);
    this.changed(t.id);
  }

  setReady(tradeId: string, role: Role) {
    const t = this.getTrade(tradeId);
    if (t.state !== 'TAKEN') throw new DeskError(409, 'not waiting for keys');
    if (!t[`${role}_contact`]) throw bad('submit your contact first');
    if (!t.arbiter_contact) throw new DeskError(409, 'the arbiter identity is not ready yet');
    this.repo.updateTrade(t.id, { [`${role}_ready`]: 1, updated_at: this.now() } as TradeUpdate);
    const u = this.getTrade(t.id);
    if (u.buyer_ready && u.seller_ready && u.buyer_contact && u.seller_contact) {
      this.apply(t.id, 'start_keygen', 'system', {
        session: JSON.stringify({ type: 'dkg', status: 'starting', attempt: 0, at: this.now() } satisfies SessionInfo),
      });
    } else {
      this.changed(t.id);
    }
  }

  async submitEscrow(tradeId: string, role: Role, input: Record<string, unknown>) {
    if (role !== 'seller') throw new DeskError(403, 'only the seller creates the escrow');
    const t = this.getTrade(tradeId);
    if (t.state !== 'ESCROW_PENDING') throw new DeskError(409, 'not waiting for the escrow');
    const { groupPubkey, ufvk, orchardAddress, refundUa } = input;
    if (typeof groupPubkey !== 'string' || typeof ufvk !== 'string' || typeof orchardAddress !== 'string' || typeof refundUa !== 'string') {
      throw bad('groupPubkey, ufvk, orchardAddress and refundUa are required');
    }
    const group = groupPubkey.trim().toLowerCase();
    if (!isHex32(group)) throw bad('group public key must be 64 hex characters');
    if (group !== t.group_pubkey) throw bad('that is not this trade’s group key (check frost-client groups)');
    let ak: string;
    try {
      ak = ufvkOrchardAk(ufvk.trim(), this.cfg.network);
    } catch (e) {
      throw bad(`viewing key: ${(e as Error).message}`);
    }
    // zcash-sign generate --ak <group key> puts the group key in the UFVK as the Orchard ak.
    if (ak !== group) throw bad('the viewing key was not generated from this trade’s group key');
    const esc = checkEscrowAddress(orchardAddress.trim(), this.cfg.network);
    if (!esc.ok) throw bad(`escrow address: ${esc.reason}`);
    const ref = checkShieldedAddress(refundUa.trim(), this.cfg.network);
    if (!ref.ok) throw bad(`refund address: ${ref.reason}`);
    if (refundUa.trim() === orchardAddress.trim()) throw bad('the refund address must be your own wallet, not the escrow');
    this.repo.updateTrade(t.id, {
      ufvk: ufvk.trim(),
      escrow_address: orchardAddress.trim(),
      seller_refund_ua: refundUa.trim(),
      updated_at: this.now(),
    });
    this.repo.event(t.id, this.now(), 'escrow', 'seller submitted the escrow');
    await this.tryEscrowReady(t.id);
    return this.getTrade(t.id);
  }

  async submitReceiveAddress(tradeId: string, role: Role, ua: unknown) {
    if (role !== 'buyer') throw new DeskError(403, 'only the buyer submits a receive address');
    const t = this.getTrade(tradeId);
    if (!['TAKEN', 'KEYGEN', 'ESCROW_PENDING'].includes(t.state)) throw new DeskError(409, 'too late to change the receive address');
    if (typeof ua !== 'string') throw bad('ua must be a string');
    const r = checkShieldedAddress(ua.trim(), this.cfg.network);
    if (!r.ok) throw bad(r.reason);
    if (ua.trim() === t.escrow_address) throw bad('that is the escrow address');
    this.repo.updateTrade(t.id, { buyer_receive_ua: ua.trim(), updated_at: this.now() });
    this.repo.event(t.id, this.now(), 'receive-address', 'buyer submitted a receive address');
    await this.tryEscrowReady(t.id);
    return this.getTrade(t.id);
  }

  /** Imports the escrow into zwatch once both sides have submitted their part, then waits for funding. */
  async tryEscrowReady(tradeId: string) {
    const t = this.getTrade(tradeId);
    if (t.state !== 'ESCROW_PENDING' || !t.ufvk || !t.escrow_address || !t.seller_refund_ua || !t.buyer_receive_ua) return;
    if (this.escrowInflight.has(t.id)) return;
    this.escrowInflight.add(t.id);
    try {
      let accountId = t.zwatch_account_id;
      let birthday = t.birthday;
      if (!accountId) {
        const health = await this.zwatch.health().catch(() => ({ ok: false, tip: undefined }));
        const acct = await this.zwatch.createAccount({ name: `escrow-${t.id}`, ufvk: t.ufvk, birthday: health.tip });
        accountId = acct.id;
        birthday = acct.birthday ?? health.tip ?? null;
        this.repo.updateTrade(t.id, { zwatch_account_id: accountId, birthday });
      }
      this.apply(t.id, 'escrow_ready', 'system');
    } catch (e) {
      this.repo.updateTrade(t.id, { last_error: `zwatch import failed: ${(e as Error).message}` });
      this.repo.event(t.id, this.now(), 'error', `zwatch import: ${(e as Error).message}`);
    } finally {
      this.escrowInflight.delete(t.id);
    }
  }

  // The caller's role is the actor: the state machine rejects a buyer confirming receipt, and so on.
  detailsSent(tradeId: string, role: Role) {
    return this.apply(tradeId, 'details_sent', role);
  }

  fiatSent(tradeId: string, role: Role) {
    return this.apply(tradeId, 'fiat_sent', role);
  }

  confirmReceived(tradeId: string, role: Role) {
    return this.apply(tradeId, 'confirm_received', role);
  }

  cancel(tradeId: string, role: Role) {
    return this.apply(tradeId, 'cancel', role);
  }

  dispute(tradeId: string, role: Role, evidenceSealed?: unknown) {
    const t = this.apply(tradeId, 'dispute', role, { dispute_by: role });
    if (evidenceSealed !== undefined && evidenceSealed !== null && evidenceSealed !== '') this.addEvidence(tradeId, role, evidenceSealed);
    return t;
  }

  addEvidence(tradeId: string, role: Role, evidenceSealed: unknown) {
    const t = this.getTrade(tradeId);
    if (t.state !== 'DISPUTE') throw new DeskError(409, 'evidence is only accepted during a dispute');
    if (typeof evidenceSealed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(evidenceSealed)) throw bad('evidenceSealed must be base64url');
    const bytes = Buffer.from(evidenceSealed, 'base64url');
    if (bytes.length < 48 || bytes.length > MAX_EVIDENCE_BYTES) throw bad('evidence must be a sealed box of at most 2 MB');
    if (this.repo.listEvidence(t.id).filter((e) => e.role === role).length >= 5) throw bad('at most 5 evidence files per party');
    this.repo.insertEvidence(t.id, role, bytes, this.now());
    this.repo.event(t.id, this.now(), 'evidence', `${role} added sealed evidence (${bytes.length} bytes)`);
  }

  // ---------------------------------------------------------------- arbiter

  resolve(tradeId: string, to: unknown) {
    const t = this.getTrade(tradeId);
    if (to === 'buyer') return this.apply(t.id, 'resolve_buyer', 'arbiter');
    if (to === 'seller') {
      if (t.state === 'CANCELLED' && !t.zwatch_account_id) throw new DeskError(409, 'this trade never had an escrow');
      return this.apply(t.id, 'resolve_seller', 'arbiter');
    }
    if (to === 'accept') return this.apply(t.id, 'accept_funding', 'arbiter');
    throw bad("to must be 'buyer', 'seller' or 'accept'");
  }

  arbiterTrades() {
    return this.repo
      .tradesInStates(['DISPUTE', 'NEEDS_ATTENTION', 'RELEASING', 'REFUNDING', 'KEYGEN', 'TAKEN', 'ESCROW_PENDING', 'AWAITING_FUNDING', 'FUNDED', 'DETAILS_SENT', 'FIAT_SENT'])
      .map((t) => this.arbiterSummary(t));
  }

  arbiterSummary(t: TradeRow) {
    return {
      id: t.id,
      state: t.state,
      amountZat: String(t.amount_zat),
      currency: t.currency,
      stateDeadline: t.state_deadline,
      settleKind: t.settle_kind,
      disputeBy: t.dispute_by,
      lastError: t.last_error,
      updatedAt: t.updated_at,
      evidence: this.repo.listEvidence(t.id).length,
    };
  }

  arbiterTrade(tradeId: string) {
    const t = this.getTrade(tradeId);
    return {
      ...this.view(t, 'seller'),
      seller: { contact: t.seller_contact, pub: t.seller_pub, ready: !!t.seller_ready, refundUa: t.seller_refund_ua },
      events: this.repo.events(t.id),
      evidence: this.repo.listEvidence(t.id).map((e, i) => ({ index: i, role: e.role, bytes: e.sealed.length, createdAt: e.created_at })),
    };
  }

  evidenceFile(tradeId: string, index: number): Uint8Array {
    const e = this.repo.listEvidence(tradeId)[index];
    if (!e) throw new DeskError(404, 'no such evidence');
    return e.sealed;
  }

  // ---------------------------------------------------------------- public

  tape(currency?: string): TapeEntry[] {
    return this.repo.publishedTape(this.now(), currency).map((r) => ({
      hour: r.hour_bucket,
      currency: r.currency,
      priceMinor: String(r.price_minor),
      size: r.size_bucket,
    }));
  }

  // ---------------------------------------------------------------- the ticker (every 30 s)

  async tick() {
    const now = this.now();
    for (const t of this.repo.tradesInStates(['ESCROW_PENDING'])) await this.tryEscrowReady(t.id);
    for (const t of this.repo.tradesInStates(['AWAITING_FUNDING'])) await this.checkFunding(t, now);
    for (const t of this.repo.tradesPastDeadline(now)) {
      if (t.state === 'AWAITING_FUNDING') continue; // handled by checkFunding
      try {
        this.apply(t.id, 'timeout', 'system');
      } catch (e) {
        if (!(e instanceof DeskError && e.status === 409)) throw e;
      }
    }
    await this.checkLateFunds(now);
    const purged = this.repo.purgeEnded(now - RETENTION_MS);
    if (purged.length) this.hooks.onPurge?.(purged);
  }

  private async checkFunding(t: TradeRow, now: number) {
    if (!t.zwatch_account_id) return;
    let outputs;
    try {
      outputs = await this.zwatch.received(t.zwatch_account_id);
    } catch (e) {
      this.repo.updateTrade(t.id, { last_error: `zwatch: ${(e as Error).message}` });
      return;
    }
    const f = fundingStatus(outputs, BigInt(t.amount_zat));
    if (f.status !== 'none') {
      this.repo.updateTrade(t.id, {
        funding_zat: Number(f.seenZat),
        funding_conf: 'confirmations' in f ? f.confirmations : null,
        funding_notes: outputs.length,
        last_error: null,
      });
    }
    const pastDeadline = t.state_deadline !== null && t.state_deadline <= now;
    try {
      if (f.status === 'funded') this.apply(t.id, 'funded', 'system');
      else if (f.status === 'multi_note') this.apply(t.id, 'multi_note', 'system');
      else if (f.status === 'underfunded') this.apply(t.id, 'underfunded', 'system');
      else if (pastDeadline && f.status === 'none') this.apply(t.id, 'timeout', 'system');
      else if (pastDeadline && f.status === 'pending') {
        // Money is on its way: give it time to confirm instead of cancelling under it.
        this.repo.updateTrade(t.id, { state_deadline: now + 15 * 60_000 });
        this.repo.event(t.id, now, 'deadline', 'funding seen but unconfirmed; deadline extended 15 min');
      }
    } catch (e) {
      if (!(e instanceof DeskError && e.status === 409)) throw e;
    }
    this.changed(t.id);
  }

  /** A cancelled trade whose escrow receives funds anyway: refund them (arbiter + seller sign). */
  private async checkLateFunds(now: number) {
    for (const t of this.repo.tradesInStates(['CANCELLED'])) {
      if (!t.zwatch_account_id || (t.ended_at ?? 0) < now - RETENTION_MS) continue;
      try {
        const outputs = await this.zwatch.received(t.zwatch_account_id);
        const total = outputs.filter((o) => o.confirmations >= 2).reduce((s, o) => s + o.valueZat, 0n);
        if (total > FEE_ZAT) this.apply(t.id, 'late_funds', 'system', { funding_zat: Number(total), funding_notes: outputs.length });
      } catch {
        // zwatch unavailable: try again next tick
      }
    }
  }
}
