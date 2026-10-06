import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { MakerView } from '../../core/api';
import { zatToZec } from '../../core/money';
import { api, post, saveLink, savedLinks, tokenFromHash } from '../api';
import { ErrorText, fiat, StateBadge, useAction, useConfig, useInterval, zec } from '../components/ui';

export function Maker() {
  const { id = '' } = useParams();
  const token = tokenFromHash();
  const config = useConfig();
  const navigate = useNavigate();
  const [view, setView] = useState<MakerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAction();

  const load = () => {
    if (!token) return;
    api<MakerView>(`/offers/${id}/maker`, { token }).then(setView, (e) => setError(e.message));
  };
  useEffect(load, [id, token]);
  useInterval(load, 5000);

  if (!token) return <div className="panel">This page needs the full offer link, including the part after <code>#</code>.</div>;
  if (error && !view) return <div className="panel error">{error}</div>;
  if (!view) return <div className="empty">Loading…</div>;
  const o = view.offer;

  const open = (tradeId: string) =>
    action.run(async () => {
      // Each claim issues a fresh seller link and revokes the previous one, so reuse a link this browser already has.
      const known = savedLinks().find((l) => l.kind === 'trade' && l.id === tradeId && l.role === 'seller');
      if (known) {
        const ok = await api(`/trades/${tradeId}`, { token: new URLSearchParams(known.path.split('#')[1]).get('k') ?? '' }).then(() => true, () => false);
        if (ok) return navigate(known.path);
      }
      const r = await post<{ sellerToken: string; sellerLink: string }>(`/offers/${id}/trades/${tradeId}/claim`, token);
      saveLink({ kind: 'trade', id: tradeId, role: 'seller', path: r.sellerLink, label: `Selling (trade ${tradeId.slice(0, 6)})` });
      navigate(r.sellerLink);
    });

  return (
    <div className="stack">
      <div className="panel">
        <div className="spread">
          <h1>Your offer</h1>
          <span className={`badge ${o.status === 'OPEN' ? 'ok' : ''}`}>{o.status.toLowerCase()}</span>
        </div>
        <dl className="kv">
          <dt>Price</dt>
          <dd className="price">{fiat(o.priceMinor, o.currency)} per ZEC</dd>
          <dt>Range</dt>
          <dd>
            {zatToZec(BigInt(o.minZat))}–{zatToZec(BigInt(o.maxZat))} ZEC, {zatToZec(BigInt(o.remainingZat))} ZEC left
          </dd>
          <dt>Method</dt>
          <dd>{config?.methods[o.method] ?? o.method}, pay within {o.payWindowMin} min</dd>
        </dl>
        {o.status === 'OPEN' && (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="danger" disabled={action.busy} onClick={() => action.run(async () => (await post(`/offers/${id}/close`, token), load()))}>
              Close offer
            </button>
            <span className="small muted">Closing stops new trades. Trades in progress continue.</span>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Trades</h2>
        {view.trades.length === 0 ? (
          <div className="empty">No one has taken this offer yet. This page refreshes on its own.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Buyer pays</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.trades.map((t) => (
                  <tr key={t.id}>
                    <td>{zec(t.amountZat)}</td>
                    <td>{fiat(t.fiatMinor, o.currency)}</td>
                    <td>
                      <StateBadge state={t.state} />
                    </td>
                    <td className="num">
                      <button className={t.state === 'TAKEN' && !t.claimed ? 'primary small' : 'small'} onClick={() => open(t.id)} disabled={action.busy}>
                        Open trade room
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorText error={action.error} />
      </div>
    </div>
  );
}
