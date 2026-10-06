import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { TradeView } from '../../core/api';
import type { TradeState } from '../../core/state';
import { api, ApiError, post, saveLink, tokenFromHash } from '../api';
import { Details } from '../components/trade/Details';
import { Escrow } from '../components/trade/Escrow';
import { Fiat } from '../components/trade/Fiat';
import { Funding } from '../components/trade/Funding';
import { Keys } from '../components/trade/Keys';
import { Release } from '../components/trade/Release';
import type { StepProps } from '../components/trade/types';
import { Countdown, ErrorText, fiat, StateBadge, useAction, useInterval, zec } from '../components/ui';

const STEPS = ['Keys', 'Escrow', 'Funding', 'Details', 'Fiat', 'Release'] as const;

const STEP_OF: Record<TradeState, number> = {
  TAKEN: 0,
  KEYGEN: 0,
  ESCROW_PENDING: 1,
  AWAITING_FUNDING: 2,
  NEEDS_ATTENTION: 2,
  FUNDED: 3,
  DETAILS_SENT: 4,
  FIAT_SENT: 4,
  DISPUTE: 4,
  RELEASING: 5,
  REFUNDING: 5,
  RELEASED: 5,
  REFUNDED: 5,
  CANCELLED: -1,
};

export function Trade() {
  const { id = '' } = useParams();
  const token = tokenFromHash();
  const [v, setV] = useState<TradeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useAction();

  const load = () => {
    if (!token) return;
    api<TradeView>(`/trades/${id}`, { token }).then(
      (view) => {
        setV(view);
        setError(null);
      },
      (e: ApiError) => setError(e.status === 404 ? 'This trade link is not valid (or the trade was purged 7 days after it ended).' : e.message),
    );
  };
  useEffect(load, [id, token]);
  useEffect(() => {
    if (v && token) saveLink({ kind: 'trade', id: v.id, role: v.role, path: `/t/${v.id}#k=${token}`, label: `${v.role === 'buyer' ? 'Buying' : 'Selling'} ${zec(v.amountZat)}` });
  }, [v?.id, v?.role]);
  useInterval(load, v && ['RELEASED', 'REFUNDED', 'CANCELLED'].includes(v.state) ? 15_000 : v?.dryRun ? 1500 : 3000);

  if (!token) return <div className="panel">This page needs the full trade link, including the part after <code>#</code>.</div>;
  if (!v) return error ? <div className="panel error">{error}</div> : <div className="empty">Loading…</div>;

  const step = STEP_OF[v.state];
  const skew = v.now - Date.now();
  const props: StepProps = { v, token, update: setV, reload: load };
  const canCancel = v.role === 'buyer' ? ['TAKEN', 'KEYGEN', 'ESCROW_PENDING', 'AWAITING_FUNDING', 'FUNDED', 'DETAILS_SENT'].includes(v.state) : ['TAKEN', 'KEYGEN', 'ESCROW_PENDING'].includes(v.state);
  const funded = ['FUNDED', 'DETAILS_SENT'].includes(v.state);

  return (
    <div className="stack">
      <div className="panel">
        <div className="spread">
          <div>
            <div className="small muted">
              Trade <span className="mono">{v.id.slice(0, 10)}…</span> · you are the <strong>{v.role}</strong>
            </div>
            <h1 style={{ margin: '4px 0' }}>
              {v.role === 'buyer' ? 'Buy' : 'Sell'} {zec(v.amountZat)} for {fiat(v.fiatMinor, v.currency)}
            </h1>
          </div>
          <div className="row">
            <Countdown deadline={v.stateDeadline} skew={skew} />
            <StateBadge state={v.state} />
          </div>
        </div>
        <p style={{ margin: '6px 0 0' }}>
          <strong>Next:</strong> {v.next}
        </p>
        {v.lastError && <p className="small warn">Desk notice: {v.lastError}</p>}
        <ErrorText error={error} />
      </div>

      {step >= 0 && (
        <ol className="stepper" aria-label="Trade progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? 'done' : i === step ? 'current' : ''} aria-current={i === step ? 'step' : undefined}>
              {i + 1}<span>. {s}</span>
            </li>
          ))}
        </ol>
      )}

      {v.state === 'CANCELLED' && (
        <div className="panel notice">
          This trade was cancelled. If you already funded the escrow, the desk notices and refunds it: the arbiter and the seller sign
          the refund, so keep your <code>trade-{v.id}.toml</code>.
        </div>
      )}
      {v.state === 'NEEDS_ATTENTION' && (
        <div className="panel notice danger">
          The escrow received more than one payment. A release could need several signatures, so the arbiter checks it first. Keep
          this page and your <code>trade-{v.id}.toml</code>.
        </div>
      )}

      {step === 0 && <Keys {...props} />}
      {step === 1 && <Escrow {...props} />}
      {step === 2 && v.state === 'AWAITING_FUNDING' && <Funding {...props} />}
      {step === 3 && <Details {...props} />}
      {step === 4 && <Fiat {...props} />}
      {step === 5 && <Release {...props} />}

      {canCancel && (
        <div className="row small">
          <button
            className="danger small"
            disabled={cancel.busy}
            onClick={() => {
              const msg = funded
                ? 'Cancel and refund the escrow to the seller? The seller and the arbiter will sign the refund.'
                : 'Cancel this trade?';
              if (window.confirm(msg)) cancel.run(async () => setV(await post<TradeView>(`/trades/${v.id}/cancel`, token)));
            }}
          >
            {funded ? 'Cancel and refund' : 'Cancel trade'}
          </button>
          <span className="muted">{v.role === 'buyer' ? 'Possible until you click “I’ve paid”.' : 'Possible until the escrow exists.'}</span>
          <ErrorText error={cancel.error} />
        </div>
      )}
      <p className="small muted">
        Keep this link private: anyone who has it can act as the {v.role}. New to this? Read the <Link to="/guide">participant guide</Link>.
      </p>
    </div>
  );
}
