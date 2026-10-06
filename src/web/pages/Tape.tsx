import { useEffect, useState } from 'react';
import type { TapeEntry } from '../../core/api';
import { api } from '../api';
import { fiat, formatHour, useConfig, useInterval } from '../components/ui';

export function Tape() {
  const config = useConfig();
  const [rows, setRows] = useState<TapeEntry[] | null>(null);
  const [currency, setCurrency] = useState('');
  const load = () => {
    api<TapeEntry[]>(`/tape${currency ? `?currency=${currency}` : ''}`).then(setRows, () => setRows([]));
  };
  useEffect(load, [currency]);
  useInterval(load, 15_000);

  return (
    <div className="panel">
      <div className="spread">
        <div>
          <h1>Price tape</h1>
          <p className="muted small">
            Completed trades only: price, a size range and the hour. Each row appears after a random delay of up to an hour, so it
            can’t be matched to a trade’s end time. Nothing else is published.
          </p>
        </div>
        <select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All currencies</option>
          {config && Object.keys(config.currencies).map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      {rows && rows.length === 0 && <div className="empty">No published trades yet.</div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hour</th>
                <th className="num">Price per ZEC</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{formatHour(r.hour)}</td>
                  <td className="num price">{fiat(r.priceMinor, r.currency)}</td>
                  <td>{r.size} ZEC</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
