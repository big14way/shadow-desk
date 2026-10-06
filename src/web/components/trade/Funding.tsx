import { FEE_ZAT } from '../../../core/money';
import { buildZip321 } from '../../../core/zip321';
import { CopyButton, Leak, QR, Value, zec } from '../ui';
import type { StepProps } from './types';

export function Funding({ v }: StepProps) {
  const total = BigInt(v.amountZat) + FEE_ZAT;
  const uri = v.escrow.address ? buildZip321(v.escrow.address, total) : null;
  const seen = v.funding.seenZat;
  return (
    <div className="panel stack">
      <h2>Fund the escrow</h2>
      {v.role === 'seller' && uri ? (
        <div className="grid two">
          <div className="stack">
            <p>
              Send exactly <strong>{zec(total)}</strong> ({zec(v.amountZat)} for the buyer plus {zec(FEE_ZAT)} for the release fee) in{' '}
              <strong>one transaction</strong>. Scan the code with Zodl, or copy the payment link.
            </p>
            <div className="cmd">
              <pre className="mono">{uri}</pre>
              <CopyButton text={uri} />
            </div>
            {v.dryRun && (
              <p className="small warn">Dry run: this is a Testnet-format address no Mainnet wallet accepts. Funding is simulated.</p>
            )}
            <p className="small muted">Two payments into one escrow would need two signatures to release, so the desk pauses the trade if that happens.</p>
          </div>
          <div>
            <QR text={uri} />
          </div>
        </div>
      ) : (
        <p>The seller is funding the escrow. You can watch it yourself with the viewing key below in any wallet that imports one.</p>
      )}
      <dl className="kv">
        <dt>Seen</dt>
        <dd>{seen ? `${zec(seen)} · ${v.funding.confirmations ?? 0} of 2 confirmations` : 'nothing yet'}</dd>
      </dl>
      {v.role === 'buyer' && v.escrow.ufvk && (
        <details>
          <summary className="small">Escrow address and viewing key</summary>
          <Value>{v.escrow.address ?? ''}</Value>
          <Value>{v.escrow.ufvk}</Value>
        </details>
      )}
      <Leak>On-chain this is an ordinary shielded payment: observers can’t tell it’s an escrow, how much it holds, or who is trading.</Leak>
    </div>
  );
}
