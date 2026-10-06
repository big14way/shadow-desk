// The trade state machine (build guide §6). Pure: callers persist the result.

export const STATES = [
  'TAKEN',
  'KEYGEN',
  'ESCROW_PENDING',
  'AWAITING_FUNDING',
  'FUNDED',
  'DETAILS_SENT',
  'FIAT_SENT',
  'DISPUTE',
  'RELEASING',
  'REFUNDING',
  'RELEASED',
  'REFUNDED',
  'CANCELLED',
  'NEEDS_ATTENTION',
] as const;

export type TradeState = (typeof STATES)[number];
export type Actor = 'buyer' | 'seller' | 'arbiter' | 'system';

export const TERMINAL: readonly TradeState[] = ['RELEASED', 'REFUNDED', 'CANCELLED'];
export const isTerminal = (s: TradeState) => TERMINAL.includes(s);

/** Which signing session settles the trade, and who signs it. */
export type SettleKind = 'release' | 'refund' | 'dispute-release' | 'dispute-refund';

type Rule = { from: readonly TradeState[]; to: TradeState; by: readonly Actor[]; settle?: SettleKind };

const PRE_ESCROW = ['TAKEN', 'KEYGEN', 'ESCROW_PENDING'] as const;

export const RULES = {
  /** Both contacts are in and both parties clicked Ready: the arbiter starts the DKG. */
  start_keygen: [{ from: ['TAKEN'], to: 'KEYGEN', by: ['system'] }],
  keygen_ok: [{ from: ['KEYGEN'], to: 'ESCROW_PENDING', by: ['system'] }],
  keygen_failed: [{ from: ['KEYGEN'], to: 'CANCELLED', by: ['system'] }],
  /** Seller submitted the escrow, buyer submitted a receive address, escrow imported into zwatch. */
  escrow_ready: [{ from: ['ESCROW_PENDING'], to: 'AWAITING_FUNDING', by: ['system'] }],
  /** ≥ amount + fee, ≥ 2 confirmations, exactly one note. */
  funded: [{ from: ['AWAITING_FUNDING'], to: 'FUNDED', by: ['system'] }],
  /** Partial or late funding: send back whatever arrived. */
  underfunded: [{ from: ['AWAITING_FUNDING'], to: 'REFUNDING', by: ['system'], settle: 'refund' }],
  /** More than one note arrived: a release could need several signatures, so a human looks first. */
  multi_note: [{ from: ['AWAITING_FUNDING'], to: 'NEEDS_ATTENTION', by: ['system'] }],
  details_sent: [{ from: ['FUNDED'], to: 'DETAILS_SENT', by: ['seller'] }],
  fiat_sent: [{ from: ['DETAILS_SENT'], to: 'FIAT_SENT', by: ['buyer'] }],
  confirm_received: [{ from: ['FIAT_SENT', 'DISPUTE'], to: 'RELEASING', by: ['seller'], settle: 'release' }],
  cancel: [
    { from: [...PRE_ESCROW, 'AWAITING_FUNDING'], to: 'CANCELLED', by: ['buyer'] },
    { from: PRE_ESCROW, to: 'CANCELLED', by: ['seller'] },
    { from: ['FUNDED', 'DETAILS_SENT'], to: 'REFUNDING', by: ['buyer'], settle: 'refund' },
  ],
  dispute: [{ from: ['FIAT_SENT'], to: 'DISPUTE', by: ['buyer', 'seller'] }],
  resolve_buyer: [{ from: ['DISPUTE'], to: 'RELEASING', by: ['arbiter'], settle: 'dispute-release' }],
  resolve_seller: [
    { from: ['DISPUTE'], to: 'REFUNDING', by: ['arbiter'], settle: 'dispute-refund' },
    // Late funds after a cancel, or a multi-note escrow: the arbiter and seller send it back.
    { from: ['NEEDS_ATTENTION', 'CANCELLED'], to: 'REFUNDING', by: ['arbiter'], settle: 'refund' },
  ],
  /** Funds reached the escrow of a cancelled trade: send them back to the seller. */
  late_funds: [{ from: ['CANCELLED'], to: 'REFUNDING', by: ['system'], settle: 'refund' }],
  /** The arbiter checked a multi-note escrow and accepts it. */
  accept_funding: [{ from: ['NEEDS_ATTENTION'], to: 'FUNDED', by: ['arbiter'] }],
  settled: [
    { from: ['RELEASING'], to: 'RELEASED', by: ['system'] },
    { from: ['REFUNDING'], to: 'REFUNDED', by: ['system'] },
  ],
  timeout: [
    { from: PRE_ESCROW, to: 'CANCELLED', by: ['system'] },
    { from: ['AWAITING_FUNDING'], to: 'CANCELLED', by: ['system'] },
    { from: ['FUNDED', 'DETAILS_SENT'], to: 'REFUNDING', by: ['system'], settle: 'refund' },
    { from: ['FIAT_SENT'], to: 'DISPUTE', by: ['system'] },
  ],
} as const satisfies Record<string, readonly Rule[]>;

export type TradeEvent = keyof typeof RULES;

export class TransitionError extends Error {
  constructor(
    readonly state: TradeState,
    readonly event: TradeEvent,
    readonly actor: Actor,
  ) {
    super(`${actor} cannot ${event} a trade in ${state}`);
  }
}

export function findRule(state: TradeState, event: TradeEvent, actor: Actor): Rule | undefined {
  return (RULES[event] as readonly Rule[]).find((r) => r.from.includes(state) && r.by.includes(actor));
}

export function transition(state: TradeState, event: TradeEvent, actor: Actor): { to: TradeState; settle?: SettleKind } {
  const rule = findRule(state, event, actor);
  if (!rule) throw new TransitionError(state, event, actor);
  return { to: rule.to, settle: rule.settle };
}

export const canTransition = (state: TradeState, event: TradeEvent, actor: Actor) => !!findRule(state, event, actor);

const MIN = 60_000;

/** How long a trade may sit in a state before the ticker applies `timeout`. */
export function stateTimeoutMs(state: TradeState, payWindowMin: number): number | null {
  switch (state) {
    case 'TAKEN':
      return 30 * MIN;
    case 'KEYGEN':
      return 10 * MIN;
    case 'ESCROW_PENDING':
      return 30 * MIN;
    case 'AWAITING_FUNDING':
      return 60 * MIN;
    case 'FUNDED':
    case 'DETAILS_SENT':
      return payWindowMin * MIN;
    case 'FIAT_SENT':
      return 60 * MIN;
    default:
      return null;
  }
}

export const deadlineFor = (state: TradeState, now: number, payWindowMin: number) => {
  const ms = stateTimeoutMs(state, payWindowMin);
  return ms === null ? null : now + ms;
};

/** The two FROST signers for a settlement. The arbiter coordinates every session. */
export function signersFor(kind: SettleKind): ['buyer', 'seller'] | ['arbiter', 'buyer'] | ['arbiter', 'seller'] {
  switch (kind) {
    case 'release':
      return ['buyer', 'seller'];
    case 'dispute-release':
      return ['arbiter', 'buyer'];
    case 'refund':
    case 'dispute-refund':
      return ['arbiter', 'seller'];
  }
}

export const paysBuyer = (kind: SettleKind) => kind === 'release' || kind === 'dispute-release';
