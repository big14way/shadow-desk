import { describe, expect, it } from 'vitest';
import { RULES, STATES, canTransition, deadlineFor, signersFor, transition, type Actor, type TradeEvent, type TradeState } from '../../src/core/state';

const ACTORS: Actor[] = ['buyer', 'seller', 'arbiter', 'system'];

// The allowed transitions, written out independently of RULES.
const ALLOWED: [TradeState, TradeEvent, Actor, TradeState][] = [
  ['TAKEN', 'start_keygen', 'system', 'KEYGEN'],
  ['KEYGEN', 'keygen_ok', 'system', 'ESCROW_PENDING'],
  ['KEYGEN', 'keygen_failed', 'system', 'CANCELLED'],
  ['ESCROW_PENDING', 'escrow_ready', 'system', 'AWAITING_FUNDING'],
  ['AWAITING_FUNDING', 'funded', 'system', 'FUNDED'],
  ['AWAITING_FUNDING', 'underfunded', 'system', 'REFUNDING'],
  ['AWAITING_FUNDING', 'multi_note', 'system', 'NEEDS_ATTENTION'],
  ['FUNDED', 'details_sent', 'seller', 'DETAILS_SENT'],
  ['DETAILS_SENT', 'fiat_sent', 'buyer', 'FIAT_SENT'],
  ['FIAT_SENT', 'confirm_received', 'seller', 'RELEASING'],
  ['DISPUTE', 'confirm_received', 'seller', 'RELEASING'],
  ['TAKEN', 'cancel', 'buyer', 'CANCELLED'],
  ['KEYGEN', 'cancel', 'buyer', 'CANCELLED'],
  ['ESCROW_PENDING', 'cancel', 'buyer', 'CANCELLED'],
  ['AWAITING_FUNDING', 'cancel', 'buyer', 'CANCELLED'],
  ['TAKEN', 'cancel', 'seller', 'CANCELLED'],
  ['KEYGEN', 'cancel', 'seller', 'CANCELLED'],
  ['ESCROW_PENDING', 'cancel', 'seller', 'CANCELLED'],
  ['FUNDED', 'cancel', 'buyer', 'REFUNDING'],
  ['DETAILS_SENT', 'cancel', 'buyer', 'REFUNDING'],
  ['FIAT_SENT', 'dispute', 'buyer', 'DISPUTE'],
  ['FIAT_SENT', 'dispute', 'seller', 'DISPUTE'],
  ['DISPUTE', 'resolve_buyer', 'arbiter', 'RELEASING'],
  ['DISPUTE', 'resolve_seller', 'arbiter', 'REFUNDING'],
  ['NEEDS_ATTENTION', 'resolve_seller', 'arbiter', 'REFUNDING'],
  ['CANCELLED', 'resolve_seller', 'arbiter', 'REFUNDING'],
  ['NEEDS_ATTENTION', 'accept_funding', 'arbiter', 'FUNDED'],
  ['RELEASING', 'settled', 'system', 'RELEASED'],
  ['REFUNDING', 'settled', 'system', 'REFUNDED'],
  ['TAKEN', 'timeout', 'system', 'CANCELLED'],
  ['KEYGEN', 'timeout', 'system', 'CANCELLED'],
  ['ESCROW_PENDING', 'timeout', 'system', 'CANCELLED'],
  ['AWAITING_FUNDING', 'timeout', 'system', 'CANCELLED'],
  ['FUNDED', 'timeout', 'system', 'REFUNDING'],
  ['DETAILS_SENT', 'timeout', 'system', 'REFUNDING'],
  ['FIAT_SENT', 'timeout', 'system', 'DISPUTE'],
];

describe('state machine', () => {
  it('allows every listed transition', () => {
    for (const [from, ev, actor, to] of ALLOWED) expect(transition(from, ev, actor).to, `${from} ${ev} ${actor}`).toBe(to);
  });

  it('rejects every other (state, event, actor) combination', () => {
    const allowed = new Set(ALLOWED.map(([f, e, a]) => `${f}|${e}|${a}`));
    let rejected = 0;
    for (const s of STATES) {
      for (const e of Object.keys(RULES) as TradeEvent[]) {
        for (const a of ACTORS) {
          if (allowed.has(`${s}|${e}|${a}`)) continue;
          expect(canTransition(s, e, a), `${s} ${e} ${a}`).toBe(false);
          expect(() => transition(s, e, a)).toThrow();
          rejected++;
        }
      }
    }
    expect(rejected).toBeGreaterThan(500);
  });

  it('never lets the buyer cancel after paying', () => {
    for (const s of ['FIAT_SENT', 'DISPUTE', 'RELEASING', 'RELEASED'] as TradeState[]) expect(canTransition(s, 'cancel', 'buyer')).toBe(false);
  });

  it('nothing leaves an end state except an arbiter refund of late funds', () => {
    for (const e of Object.keys(RULES) as TradeEvent[]) {
      for (const a of ACTORS) {
        expect(canTransition('RELEASED', e, a)).toBe(false);
        expect(canTransition('REFUNDED', e, a)).toBe(false);
        if (!(e === 'resolve_seller' && a === 'arbiter')) expect(canTransition('CANCELLED', e, a)).toBe(false);
      }
    }
  });

  it('records which session settles the trade', () => {
    expect(transition('FIAT_SENT', 'confirm_received', 'seller').settle).toBe('release');
    expect(transition('DISPUTE', 'resolve_buyer', 'arbiter').settle).toBe('dispute-release');
    expect(transition('DISPUTE', 'resolve_seller', 'arbiter').settle).toBe('dispute-refund');
    expect(transition('DETAILS_SENT', 'timeout', 'system').settle).toBe('refund');
    expect(transition('FUNDED', 'cancel', 'buyer').settle).toBe('refund');
    expect(signersFor('release')).toEqual(['buyer', 'seller']);
    expect(signersFor('dispute-release')).toEqual(['arbiter', 'buyer']);
    expect(signersFor('refund')).toEqual(['arbiter', 'seller']);
  });

  it('sets deadlines per state', () => {
    const now = 1_000_000;
    expect(deadlineFor('TAKEN', now, 30)).toBe(now + 30 * 60_000);
    expect(deadlineFor('AWAITING_FUNDING', now, 30)).toBe(now + 60 * 60_000);
    expect(deadlineFor('DETAILS_SENT', now, 45)).toBe(now + 45 * 60_000);
    expect(deadlineFor('FIAT_SENT', now, 30)).toBe(now + 60 * 60_000);
    expect(deadlineFor('DISPUTE', now, 30)).toBeNull();
    expect(deadlineFor('RELEASING', now, 30)).toBeNull();
  });
});
