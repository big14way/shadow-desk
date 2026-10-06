import type { TradeView } from '../../../core/api';
import type { CommandParams } from '../../../core/commands';

export type StepProps = {
  v: TradeView;
  token: string;
  update: (v: TradeView) => void;
  reload: () => void;
};

export function commandParams(v: TradeView): CommandParams {
  const other = v.role === 'buyer' ? v.seller : v.buyer;
  return {
    tradeId: v.id,
    role: v.role,
    frostdUrl: v.frostdUrl,
    network: v.network,
    arbiterContact: v.arbiter.contact,
    counterpartyContact: other.contact,
    groupPubkey: v.groupPubkey,
  };
}
