import { useState } from 'react';
import type { TradeView } from '../../../core/api';
import { generateEscrowCommand } from '../../../core/commands';
import { demoAddress, demoEscrow } from '../../../core/demo';
import { checkEscrowAddress, checkShieldedAddress } from '../../../core/unified';
import { post } from '../../api';
import { Cmd, ErrorText, Leak, useAction, Value } from '../ui';
import { commandParams, type StepProps } from './types';

function SellerEscrow({ v, token, update }: StepProps) {
  const [f, setF] = useState({ groupPubkey: '', ufvk: '', orchardAddress: '', refundUa: '' });
  const act = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value.trim() });
  const esc = f.orchardAddress ? checkEscrowAddress(f.orchardAddress, v.network) : null;
  const ref = f.refundUa ? checkShieldedAddress(f.refundUa, v.network) : null;

  if (v.escrow.address) {
    return (
      <div className="stack">
        <p className="ok">✓ Escrow submitted.</p>
        <p className="muted">Waiting for the buyer’s receive address. Funding starts as soon as it arrives.</p>
      </div>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => update(await post<TradeView>(`/trades/${v.id}/escrow`, token, f)));
      }}
    >
      <p>
        You derive the escrow yourself, from the group key you helped create, so you don’t have to trust an address from the desk. Copy
        the group <em>Public key</em> from <code>frost-client groups</code> on your machine:
      </p>
      <Cmd>{generateEscrowCommand({ ...commandParams(v), groupPubkey: f.groupPubkey || null })}</Cmd>
      <p className="small muted">
        The arbiter’s copy of the group key is <span className="mono">{v.groupPubkey}</span>. Yours must be the same.
      </p>
      <div className="field">
        <label htmlFor="gk">Group public key</label>
        <input id="gk" className="mono" value={f.groupPubkey} onChange={set('groupPubkey')} required />
        {f.groupPubkey && f.groupPubkey !== v.groupPubkey && <div className="error">This doesn’t match the arbiter’s copy.</div>}
      </div>
      <div className="field">
        <label htmlFor="ufvk">Unified Full Viewing Key</label>
        <textarea id="ufvk" value={f.ufvk} onChange={set('ufvk')} placeholder={v.network === 'main' ? 'uview1…' : 'uviewtest1…'} required />
      </div>
      <div className="field">
        <label htmlFor="oa">Orchard-only unified address</label>
        <textarea id="oa" value={f.orchardAddress} onChange={set('orchardAddress')} placeholder={v.network === 'main' ? 'u1…' : 'utest1…'} required />
        {esc && !esc.ok && <div className="error">{esc.reason}</div>}
        <div className="hint">
          Fund only this address. FROST controls only the Orchard spend key: ZEC sent to any other receiver of this account is
          unspendable.
        </div>
      </div>
      <div className="field">
        <label htmlFor="ref">Your refund address</label>
        <textarea id="ref" value={f.refundUa} onChange={set('refundUa')} placeholder="A Unified Address from your own wallet" required />
        {ref && !ref.ok && <div className="error">{ref.reason}</div>}
        <div className="hint">Where the escrow goes back to if the trade is cancelled or a dispute goes your way. Shielded receivers only.</div>
      </div>
      <div className="row">
        <button className="primary" disabled={act.busy}>Submit escrow</button>
        {v.dryRun && v.groupPubkey && (
          <button
            type="button"
            onClick={() => {
              const d = demoEscrow(v.groupPubkey!, v.network);
              setF({ groupPubkey: v.groupPubkey!, ufvk: d.ufvk, orchardAddress: d.address, refundUa: demoAddress(v.network) });
            }}
          >
            Fill with simulated zcash-sign output
          </button>
        )}
      </div>
      <ErrorText error={act.error} />
    </form>
  );
}

function BuyerAddress({ v, token, update }: StepProps) {
  const [ua, setUa] = useState('');
  const act = useAction();
  const check = ua ? checkShieldedAddress(ua.trim(), v.network) : null;
  if (v.buyer.receiveUa) {
    return (
      <div className="stack">
        <p className="ok">✓ Receive address submitted.</p>
        <Value>{v.buyer.receiveUa}</Value>
        <p className="muted">{v.escrow.address ? 'The escrow is ready.' : 'Waiting for the seller to create the escrow.'}</p>
      </div>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => update(await post<TradeView>(`/trades/${v.id}/receive-address`, token, { ua: ua.trim() })));
      }}
    >
      <p>
        Give a <strong>fresh</strong> shielded address from your wallet (in Zodl: Receive → a new address). The seller sends your bank
        details there as an encrypted memo, and the ZEC arrives there.
      </p>
      <div className="field">
        <label htmlFor="ua">Unified Address</label>
        <textarea id="ua" value={ua} onChange={(e) => setUa(e.target.value)} placeholder={v.network === 'main' ? 'u1…' : 'utest1…'} required />
        {check && !check.ok && <div className="error">{check.reason}</div>}
        {check?.ok && <div className="hint ok">Receivers: {check.receivers.join(', ')}</div>}
        <div className="hint">No transparent receivers: they would put your address on the public chain.</div>
      </div>
      <div className="row">
        <button className="primary" disabled={act.busy || !check?.ok}>Submit address</button>
        {v.dryRun && <button type="button" onClick={() => setUa(demoAddress(v.network))}>Use a simulated address</button>}
      </div>
      <ErrorText error={act.error} />
    </form>
  );
}

export function Escrow(props: StepProps) {
  return (
    <div className="panel stack">
      <h2>{props.v.role === 'seller' ? 'Create the escrow' : 'Your receive address'}</h2>
      {props.v.role === 'seller' ? <SellerEscrow {...props} /> : <BuyerAddress {...props} />}
      <Leak>
        The desk gets the escrow’s viewing key, so it can see the escrow’s activity, and the buyer’s receive address. It never gets a
        spend key or a key share of yours.
      </Leak>
    </div>
  );
}
