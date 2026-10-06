import { useState } from 'react';
import { Link } from 'react-router';
import { currencyExponent } from '../../core/catalog';
import { parseMinor, zatToZec, zecToZat } from '../../core/money';
import { post, saveLink } from '../api';
import { CopyButton, ErrorText, useAction, useConfig } from '../components/ui';

export function NewOffer() {
  const config = useConfig();
  const [form, setForm] = useState({ currency: 'NGN', method: 'bank_transfer', price: '', min: '0.001', max: '0.01', payWindowMin: '30' });
  const [created, setCreated] = useState<{ link: string } | null>(null);
  const { busy, error, run, setError } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const maxZec = config ? zatToZec(BigInt(config.maxTradeZat)) : '0.01';

  if (created) {
    const full = `${location.origin}${created.link}`;
    return (
      <div className="panel stack" style={{ maxWidth: 720 }}>
        <h1>Your offer is live</h1>
        <div className="notice danger">
          <strong>Save this link now.</strong> It is the only way to manage the offer and reach its trades. There is no account and no
          recovery: the desk stores only a hash of it.
        </div>
        <div className="cmd">
          <pre className="mono">{full}</pre>
          <CopyButton text={full} />
        </div>
        <p className="small muted">
          When a buyer takes your offer, it shows up on this page. Open the trade room from there. Keep a terminal ready: you will run
          <code> frost-client</code> and <code>zcash-sign</code> during the trade.
        </p>
        <div className="row">
          <Link to={created.link} className="btn">Open my offer</Link>
          <Link to="/guide">Read the participant guide</Link>
        </div>
      </div>
    );
  }

  return (
    <form
      className="panel stack"
      style={{ maxWidth: 720 }}
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          let body;
          try {
            body = {
              currency: form.currency,
              method: form.method,
              priceMinor: String(parseMinor(form.price, currencyExponent(form.currency))),
              minZat: String(zecToZat(form.min)),
              maxZat: String(zecToZat(form.max)),
              payWindowMin: Number(form.payWindowMin),
            };
          } catch (err) {
            setError((err as Error).message);
            return;
          }
          const r = await post<{ offerId: string; sellerLink: string }>('/offers', undefined, body);
          saveLink({ kind: 'offer', id: r.offerId, path: r.sellerLink, label: `My offer: ${form.min}–${form.max} ZEC @ ${form.price} ${form.currency}` });
          setCreated({ link: r.sellerLink });
        });
      }}
    >
      <div>
        <h1>Sell ZEC</h1>
        <p className="muted">
          Post a price and a range. Takers buy from it until the range is used up or you close the offer. Your ZEC only moves into
          escrow once a buyer has taken the offer and the 2-of-3 key exists.
        </p>
      </div>
      <div className="fields">
        <div>
          <label htmlFor="cur">Currency</label>
          <select id="cur" value={form.currency} onChange={set('currency')}>
            {config && Object.entries(config.currencies).map(([c, v]) => <option key={c} value={c}>{c} · {v.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="price">Price of 1 ZEC ({form.currency})</label>
          <input id="price" value={form.price} onChange={set('price')} inputMode="decimal" placeholder="e.g. 52000.00" required />
        </div>
      </div>
      <div className="fields">
        <div>
          <label htmlFor="min">Minimum per trade (ZEC)</label>
          <input id="min" value={form.min} onChange={set('min')} inputMode="decimal" required />
        </div>
        <div>
          <label htmlFor="max">Total to sell (ZEC)</label>
          <input id="max" value={form.max} onChange={set('max')} inputMode="decimal" required />
          <div className="hint">At most {maxZec} ZEC during the hackathon.</div>
        </div>
      </div>
      <div className="fields">
        <div>
          <label htmlFor="method">Payment method</label>
          <select id="method" value={form.method} onChange={set('method')}>
            {config && Object.entries(config.methods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="win">Payment window (minutes)</label>
          <input id="win" type="number" min={15} max={180} value={form.payWindowMin} onChange={set('payWindowMin')} />
        </div>
      </div>
      <p className="small muted">
        You will fund the escrow with the trade amount plus 0.0001 ZEC for the network fee, in one transaction from your own wallet.
      </p>
      <div className="row">
        <button className="primary" disabled={busy}>Post offer</button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
