// Shapes shared by the API and the web UI. Amounts in zatoshis and minor units are decimal strings.

import type { SettleKind, TradeState } from './state';

export type Role = 'buyer' | 'seller';
export type Signer = Role | 'arbiter';

export type OfferPublic = {
  id: string;
  minZat: string;
  maxZat: string;
  remainingZat: string;
  priceMinor: string;
  currency: string;
  method: string;
  payWindowMin: number;
  createdHour: number;
};

export type TradeSummary = {
  id: string;
  state: TradeState;
  amountZat: string;
  fiatMinor: string;
  createdAt: number;
  stateDeadline: number | null;
  claimed: boolean;
};

export type MakerView = { offer: OfferPublic & { status: string }; trades: TradeSummary[] };

export type SessionInfo =
  | { type: 'dkg'; status: 'starting' | 'open' | 'done' | 'failed'; attempt: number; error?: string; at: number }
  | {
      type: 'sign';
      kind: SettleKind;
      signers: Signer[];
      status: 'preparing' | 'open' | 'finishing' | 'done' | 'failed';
      /** `zcash-devtool pczt inspect` of the created PCZT, for verify-before-sign. */
      inspect?: string;
      to?: string;
      valueZat?: string;
      sighash?: string;
      randomizer?: string;
      spend?: number;
      error?: string;
      at: number;
    };

export type TradeView = {
  id: string;
  role: Role;
  state: TradeState;
  stateDeadline: number | null;
  now: number;
  dryRun: boolean;
  network: 'main' | 'test';
  amountZat: string;
  feeZat: string;
  priceMinor: string;
  fiatMinor: string;
  currency: string;
  method: string;
  payWindowMin: number;
  frostdUrl: string;
  groupName: string;
  arbiter: { contact: string | null; pub: string | null };
  buyer: { contact: string | null; pub: string | null; ready: boolean; receiveUa: string | null };
  seller: { contact: string | null; pub: string | null; ready: boolean; refundUa: string | null };
  groupPubkey: string | null;
  escrow: { address: string | null; ufvk: string | null };
  funding: { seenZat: string | null; confirmations: number | null; notes: number | null };
  settleKind: SettleKind | null;
  session: SessionInfo | null;
  disputeBy: string | null;
  releaseTxid: string | null;
  refundTxid: string | null;
  lastError: string | null;
  arbiterBoxPubkey: string | null;
  next: string;
};

export type TapeEntry = { hour: number; currency: string; priceMinor: string; size: string };

/** One line telling a party what to do now. */
export function nextAction(v: Pick<TradeView, 'state' | 'role' | 'buyer' | 'seller' | 'escrow' | 'session' | 'settleKind'>): string {
  const me = v.role === 'buyer' ? v.buyer : v.seller;
  const signing = v.session?.type === 'sign' && v.session.signers.includes(v.role);
  switch (v.state) {
    case 'TAKEN':
      if (!me.contact) return 'Create a fresh frost-client identity and paste your contact string.';
      if (!me.ready) return 'Import the other two contacts, then click Ready.';
      return 'Waiting for the other party to get ready.';
    case 'KEYGEN':
      return v.session?.type === 'dkg' && v.session.status === 'open'
        ? 'Go: run your frost-client dkg command now.'
        : 'The arbiter is opening the key generation session…';
    case 'ESCROW_PENDING':
      if (v.role === 'seller') return v.escrow.address ? 'Waiting for the buyer’s receive address.' : 'Run zcash-sign generate and submit the escrow.';
      return v.buyer.receiveUa ? 'Waiting for the seller to create the escrow.' : 'Submit a fresh shielded receive address.';
    case 'AWAITING_FUNDING':
      return v.role === 'seller' ? 'Fund the escrow in one transaction.' : 'Waiting for the seller to fund the escrow.';
    case 'FUNDED':
      return v.role === 'seller' ? 'Send your payment details to the buyer as an encrypted memo.' : 'Waiting for the seller’s payment details memo.';
    case 'DETAILS_SENT':
      return v.role === 'buyer' ? 'Read the memo in your wallet, pay, then click “I’ve paid”.' : 'Waiting for the buyer to pay.';
    case 'FIAT_SENT':
      return v.role === 'seller' ? 'Check your account. Click “Received” once the money is there.' : 'Waiting for the seller to confirm receipt.';
    case 'DISPUTE':
      return 'The arbiter is reviewing the dispute. Add sealed evidence if you have it.';
    case 'RELEASING':
    case 'REFUNDING':
      return signing ? 'Verify the transaction, then join the signing session.' : 'The escrow is being settled.';
    case 'RELEASED':
      return 'Done: the ZEC was released to the buyer.';
    case 'REFUNDED':
      return 'Done: the ZEC was refunded to the seller.';
    case 'CANCELLED':
      return 'This trade was cancelled.';
    case 'NEEDS_ATTENTION':
      return 'The escrow received more than one payment. The arbiter will contact you here.';
  }
}
