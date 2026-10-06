import { useState } from 'react';
import type { TradeView } from '../../../core/api';
import { post } from '../../api';
import { sealForArbiter } from '../../seal';
import { ErrorText, fiat, Leak, useAction, useConfig } from '../ui';
import type { StepProps } from './types';

function Evidence({ v, token, update, opening }: StepProps & { opening: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const act = useAction();
  const pk = v.arbiterBoxPubkey;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          const evidenceSealed = file && pk ? await sealForArbiter(file, pk) : undefined;
          if (opening) update(await post<TradeView>(`/trades/${v.id}/dispute`, token, { evidenceSealed }));
          else if (evidenceSealed) update(await post<TradeView>(`/trades/${v.id}/evidence`, token, { evidenceSealed }));
          setFile(null);
        });
      }}
    >
      <div className="field">
        <label htmlFor="ev">Evidence (optional, up to 2 MB): a payment receipt, a bank statement screenshot…</label>
        <input id="ev" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={!pk} />
        <div className="hint">
          {pk ? 'Sealed to the arbiter’s key in this browser before upload. The desk stores only the sealed box.' : 'The desk has no arbiter key configured; describe the problem to the arbiter directly.'}
        </div>
      </div>
      <div className="row">
        <button className={opening ? 'danger' : ''} disabled={act.busy || (!opening && !file)}>
          {opening ? 'Open a dispute' : 'Add sealed evidence'}
        </button>
      </div>
      <ErrorText error={act.error} />
    </form>
  );
}

export function Fiat(props: StepProps) {
  const { v, token, update } = props;
  const config = useConfig();
  const act = useAction();
  const amount = fiat(v.fiatMinor, v.currency);
  return (
    <div className="panel stack">
      <h2>{v.state === 'DISPUTE' ? 'Dispute' : 'Fiat payment'}</h2>

      {v.state === 'DETAILS_SENT' && v.role === 'buyer' && (
        <>
          <p>
            Open the memo in your wallet and pay <strong>{amount}</strong> by {config?.methods[v.method] ?? v.method}, using the
            reference it gives. Then confirm here.
          </p>
          <div className="row">
            <button className="primary" disabled={act.busy} onClick={() => act.run(async () => update(await post<TradeView>(`/trades/${v.id}/fiat-sent`, token)))}>
              I’ve paid {amount}
            </button>
          </div>
          <p className="small muted">If the window runs out before you click, the escrow is refunded to the seller.</p>
        </>
      )}
      {v.state === 'DETAILS_SENT' && v.role === 'seller' && <p>Waiting for the buyer to pay {amount}. If they don’t within the window, the escrow is refunded to you.</p>}

      {v.state === 'FIAT_SENT' && v.role === 'seller' && (
        <>
          <p>
            The buyer says they paid <strong>{amount}</strong>. Check your account. Only once the money is really there:
          </p>
          <div className="row">
            <button className="primary" disabled={act.busy} onClick={() => act.run(async () => update(await post<TradeView>(`/trades/${v.id}/confirm-received`, token)))}>
              Received: release the ZEC
            </button>
          </div>
          <p className="small muted">If you don’t confirm or dispute within 60 minutes, the trade goes to the arbiter.</p>
        </>
      )}
      {v.state === 'FIAT_SENT' && v.role === 'buyer' && <p>Waiting for the seller to confirm. If they stay silent for 60 minutes, the arbiter steps in automatically.</p>}

      {v.state === 'FIAT_SENT' && (
        <details>
          <summary>Something wrong? Open a dispute</summary>
          <Evidence {...props} opening />
        </details>
      )}

      {v.state === 'DISPUTE' && (
        <>
          <div className="notice danger">
            {v.disputeBy ? `The ${v.disputeBy === v.role ? 'dispute was opened by you' : `${v.disputeBy} opened a dispute`}.` : 'The seller didn’t respond in time.'} The arbiter decides using the
            published policy: proof of payment must match the amount and the reference, and when in doubt the escrow goes back to the
            seller. The winner co-signs with the arbiter, so keep your <code>trade-{v.id}.toml</code>.
          </div>
          {v.role === 'seller' && (
            <div className="row">
              <button className="primary" disabled={act.busy} onClick={() => act.run(async () => update(await post<TradeView>(`/trades/${v.id}/confirm-received`, token)))}>
                The money arrived after all: release
              </button>
            </div>
          )}
          <Evidence {...props} opening={false} />
        </>
      )}
      <ErrorText error={act.error} />
      <Leak>Your banks see the transfer between you. Dispute evidence is readable only by the arbiter.</Leak>
    </div>
  );
}
