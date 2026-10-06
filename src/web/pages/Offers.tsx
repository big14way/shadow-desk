import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { OfferPublic } from '../../core/api';
import { fiatMinorFor, zatToZec, zecToZat } from '../../core/money';
import { api, forgetLinks, post, saveLink, savedLinks } from '../api';
import { ErrorText, fiat, useAction, useConfig, useInterval, zec } from '../components/ui';

function TakeForm({ offer, onCancel }: { offer: OfferPublic; onCancel: () => void }) {
  const navigate = useNavigate();
  const max = BigInt(offer.remainingZat) < BigInt(offer.maxZat) ? offer.remainingZat : offer.maxZat;
  const [amount, setAmount] = useState(zatToZec(BigInt(offer.minZat)));
  const { busy, error, run } = useAction();
  let zat: bigint | null = null;
  try {
    zat = zecToZat(amount);
  } catch {
    zat = null;
  }
  const valid = zat !== null && zat >= BigInt(offer.minZat) && zat <= BigInt(max);
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        run(async () => {
          const r = await post<{ tradeId: string; buyerLink: string }>(`/offers/${offer.id}/take`, undefined, { amountZat: String(zat) });
          saveLink({ kind: 'trade', id: r.tradeId, role: 'buyer', path: r.buyerLink, label: `Buying ${zec(String(zat))}` });
          navigate(r.buyerLink);
        });
      }}
    >
      <div style={{ flex: '1 1 160px' }}>
        <label htmlFor={`amt-${offer.id}`}>Amount (ZEC)</label>
        <input id={`amt-${offer.id}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus />
        <div className="hint">
          {zatToZec(BigInt(offer.minZat))}–{zatToZec(BigInt(max))} ZEC
          {valid && zat !== null && <> · you pay {fiat(String(fiatMinorFor(zat, BigInt(offer.priceMinor))), offer.currency)}</>}
        </div>
      </div>
      <button className="primary" disabled={!valid || busy}>Take offer</button>
      <button type="button" onClick={onCancel}>Back</button>
      <ErrorText error={error} />
    </form>
  );
}

export function Offers() {
  const config = useConfig();
  const [offers, setOffers] = useState<OfferPublic[] | null>(null);
  const [currency, setCurrency] = useState('');
  const [method, setMethod] = useState('');
  const [taking, setTaking] = useState<string | null>(null);
  const [links, setLinks] = useState(savedLinks());
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    const q = new URLSearchParams({ ...(currency && { currency }), ...(method && { method }) });
    api<OfferPublic[]>(`/offers?${q}`).then(setOffers, (e) => setError(e.message));
  };
  useEffect(load, [currency, method]);
  useInterval(load, taking ? null : 10_000);

  return (
    <div className="stack">
      <section className="hero">
        <h1>Buy ZEC from a peer. Keep it private.</h1>
        <p>
          Each trade gets a fresh FROST 2-of-3 escrow shared by buyer, seller and an arbiter. Bank details travel as encrypted
          Zcash memos the desk never sees. Afterwards the desk publishes only the price, a size range and an hour.
        </p>
        <div className="row">
          <Link to="/sell" className="btn">Sell ZEC</Link>
          <Link to="/guide">How it works →</Link>
        </div>
      </section>

      <div className="panel">
        <div className="spread">
          <h2>Open offers</h2>
          <div className="row">
            <select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All currencies</option>
              {config && Object.keys(config.currencies).map((c) => <option key={c}>{c}</option>)}
            </select>
            <select aria-label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All methods</option>
              {config && Object.entries(config.methods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <ErrorText error={error} />
        {offers && offers.length === 0 && <div className="empty">No open offers. <Link to="/sell">Post the first one.</Link></div>}
        {offers && offers.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Price per ZEC</th>
                  <th>Range</th>
                  <th>Method</th>
                  <th>Pay within</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {offers.map((o) =>
                  taking === o.id ? (
                    <tr key={o.id}>
                      <td colSpan={5}>
                        <div className="small muted" style={{ marginBottom: 8 }}>
                          {fiat(o.priceMinor, o.currency)} per ZEC · {config?.methods[o.method] ?? o.method}
                        </div>
                        <TakeForm offer={o} onCancel={() => setTaking(null)} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={o.id}>
                      <td className="price">{fiat(o.priceMinor, o.currency)}</td>
                      <td className="mono">
                        {zatToZec(BigInt(o.minZat))}–{zatToZec(BigInt(o.remainingZat))}
                      </td>
                      <td>{config?.methods[o.method] ?? o.method}</td>
                      <td>{o.payWindowMin} min</td>
                      <td className="num">
                        <button className="primary small" onClick={() => setTaking(o.id)}>Buy</button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {links.length > 0 && (
        <div className="panel">
          <div className="spread">
            <h3>Your links in this browser</h3>
            <button className="link small" onClick={() => (forgetLinks(), setLinks([]))}>Forget all</button>
          </div>
          <p className="small muted">Kept only in this browser. Anyone with a link can act in that trade, so treat them like keys.</p>
          <ul className="small">
            {links.map((l) => (
              <li key={`${l.kind}-${l.id}-${l.role ?? ''}`}>
                <Link to={l.path}>{l.label}</Link> <span className="muted">· {new Date(l.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
