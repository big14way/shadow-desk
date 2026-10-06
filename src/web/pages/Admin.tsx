import { useEffect, useState } from 'react';
import type { TradeView } from '../../core/api';
import type { TradeState } from '../../core/state';
import { api, ApiError, post, tokenFromHash } from '../api';
import { openSealed } from '../seal';
import { ErrorText, fiat, StateBadge, useAction, useConfig, useInterval, zec } from '../components/ui';

type Summary = { id: string; state: TradeState; amountZat: string; currency: string; stateDeadline: number | null; settleKind: string | null; disputeBy: string | null; lastError: string | null; updatedAt: number; evidence: number };
type Detail = TradeView & { events: { ts: number; type: string; detail: string | null }[]; evidence: { index: number; role: string; bytes: number; createdAt: number }[] };

function EvidenceRow({ tradeId, e, token, secret }: { tradeId: string; e: Detail['evidence'][number]; token: string; secret: string }) {
  const config = useConfig();
  const act = useAction();
  const save = (bytes: Uint8Array, name: string, type = 'application/octet-stream') => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const fetchSealed = async () => {
    const res = await fetch(`/api/admin/trades/${tradeId}/evidence/${e.index}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return (
    <li>
      From the <strong>{e.role}</strong>, {(e.bytes / 1024).toFixed(1)} KB, {new Date(e.createdAt).toLocaleString()}{' '}
      <button className="small" disabled={act.busy} onClick={() => act.run(async () => save(await fetchSealed(), `evidence-${tradeId.slice(0, 6)}-${e.index}.sealed`))}>
        Download sealed
      </button>{' '}
      <button
        className="small"
        disabled={act.busy || !secret || !config?.arbiterBoxPubkey}
        onClick={() =>
          act.run(async () => {
            const f = await openSealed(await fetchSealed(), config!.arbiterBoxPubkey!, secret);
            save(f.body, f.name || `evidence-${e.index}`, f.type || undefined);
          })
        }
      >
        Open here
      </button>
      <ErrorText error={act.error} />
    </li>
  );
}

export function Admin() {
  const token = tokenFromHash();
  const [list, setList] = useState<Summary[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = useAction();

  const load = () => {
    if (!token) return;
    api<Summary[]>('/admin/trades', { token }).then(setList, (e: ApiError) => setError(e.status === 403 ? 'Wrong arbiter token.' : e.message));
    if (sel) api<Detail>(`/admin/trades/${sel}`, { token }).then(setDetail, () => setDetail(null));
  };
  useEffect(load, [token, sel]);
  useInterval(load, 5000);

  if (!token) return <div className="panel">Open the arbiter console with its link: <code>/admin#k=&lt;token&gt;</code>.</div>;
  if (error) return <div className="panel error">{error}</div>;

  const needs = (t: Summary) => t.state === 'DISPUTE' || t.state === 'NEEDS_ATTENTION' || !!t.lastError;
  const resolve = (to: 'buyer' | 'seller' | 'accept') =>
    act.run(async () => {
      if (!window.confirm(`Resolve trade ${sel?.slice(0, 8)}: ${to}?`)) return;
      setDetail(await post<Detail>(`/admin/trades/${sel}/resolve`, token, { to }));
    });

  return (
    <div className="grid two" style={{ alignItems: 'start' }}>
      <div className="panel">
        <h1>Arbiter console</h1>
        <p className="small muted">Disputes first. The arbiter holds one key share per escrow and co-signs only disputes and refunds.</p>
        {list && list.length === 0 && <div className="empty">No active trades.</div>}
        {list && list.length > 0 && (
          <div className="table-wrap">
            <table>
              <tbody>
                {[...list].sort((a, b) => Number(needs(b)) - Number(needs(a))).map((t) => (
                  <tr key={t.id} onClick={() => setSel(t.id)} style={{ cursor: 'pointer', background: sel === t.id ? 'var(--panel-2)' : undefined }}>
                    <td className="mono small">{t.id.slice(0, 8)}</td>
                    <td>{zec(t.amountZat)}</td>
                    <td><StateBadge state={t.state} /></td>
                    <td className="small">{t.evidence ? `${t.evidence} evidence` : ''} {t.lastError ? <span className="warn">error</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel stack">
        {!detail ? (
          <div className="empty">Select a trade.</div>
        ) : (
          <>
            <div className="spread">
              <h2 className="mono">{detail.id.slice(0, 12)}…</h2>
              <StateBadge state={detail.state} />
            </div>
            <dl className="kv small">
              <dt>Amount</dt><dd>{zec(detail.amountZat)} for {fiat(detail.fiatMinor, detail.currency)}</dd>
              <dt>Disputed by</dt><dd>{detail.disputeBy ?? '—'}</dd>
              <dt>Settlement</dt><dd>{detail.settleKind ?? '—'} {detail.session?.type === 'sign' ? `(${detail.session.status})` : ''}</dd>
              <dt>Group key</dt><dd className="mono">{detail.groupPubkey ?? '—'}</dd>
              <dt>Buyer receives at</dt><dd className="mono">{detail.buyer.receiveUa ?? '—'}</dd>
              <dt>Seller refund to</dt><dd className="mono">{detail.seller.refundUa ?? '—'}</dd>
              <dt>Funding seen</dt><dd>{detail.funding.seenZat ? `${zec(detail.funding.seenZat)} in ${detail.funding.notes} note(s)` : '—'}</dd>
              <dt>Txid</dt><dd className="mono">{detail.releaseTxid ?? detail.refundTxid ?? '—'}</dd>
            </dl>

            {detail.state === 'DISPUTE' && (
              <div className="row">
                <button className="primary" disabled={act.busy} onClick={() => resolve('buyer')}>Release to buyer</button>
                <button disabled={act.busy} onClick={() => resolve('seller')}>Refund to seller</button>
              </div>
            )}
            {detail.state === 'NEEDS_ATTENTION' && (
              <div className="row">
                <button disabled={act.busy} onClick={() => resolve('accept')}>Accept funding</button>
                <button disabled={act.busy} onClick={() => resolve('seller')}>Refund to seller</button>
              </div>
            )}
            <ErrorText error={act.error} />

            <h3>Sealed evidence</h3>
            {detail.evidence.length === 0 ? (
              <p className="small muted">None.</p>
            ) : (
              <>
                <label htmlFor="sk">Evidence secret key (stays in this browser tab)</label>
                <input id="sk" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" placeholder="ARBITER_BOX_SECRET" />
                <ul className="small">
                  {detail.evidence.map((e) => <EvidenceRow key={e.index} tradeId={detail.id} e={e} token={token} secret={secret} />)}
                </ul>
              </>
            )}

            <h3>Worker log</h3>
            <pre className="out">
              {detail.events.map((e) => `${new Date(e.ts).toLocaleTimeString()}  ${e.type.padEnd(8)} ${e.detail ?? ''}`).join('\n')}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
