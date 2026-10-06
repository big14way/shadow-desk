import { participantCommand, pcztFileName, verifyCommands } from '../../../core/commands';
import { download } from '../../api';
import { Cmd, CopyButton, ErrorText, Leak, useAction, Value, zec } from '../ui';
import { commandParams, type StepProps } from './types';

const KIND_LABEL = {
  release: 'Release to the buyer',
  'dispute-release': 'Release to the buyer (arbiter ruling)',
  refund: 'Refund to the seller',
  'dispute-refund': 'Refund to the seller (arbiter ruling)',
} as const;

export function Release({ v, token }: StepProps) {
  const p = commandParams(v);
  const s = v.session?.type === 'sign' ? v.session : null;
  const iSign = !!s?.signers.includes(v.role);
  const dl = useAction();
  const done = v.state === 'RELEASED' || v.state === 'REFUNDED';
  const txid = v.releaseTxid ?? v.refundTxid;

  return (
    <div className="panel stack">
      <div className="spread">
        <h2>{v.settleKind ? KIND_LABEL[v.settleKind] : 'Settlement'}</h2>
        {s && <span className="badge accent">signers: {s.signers.join(' + ')}</span>}
      </div>

      {done && txid && (
        <div className="notice ok stack">
          <div>
            <strong>{v.state === 'RELEASED' ? 'Released.' : 'Refunded.'}</strong> Transaction ID:
          </div>
          <Value>{txid}</Value>
          {v.dryRun && <div className="small">Dry run: no transaction was broadcast.</div>}
          <div className="small muted">You can delete <code>trade-{v.id}.toml</code> once the transaction has a few confirmations.</div>
        </div>
      )}

      {!done && !s && <p>The arbiter is preparing the transaction…</p>}

      {!done && s && (
        <>
          {s.status === 'failed' && <div className="notice danger">The last attempt failed ({s.error}). The desk retries automatically, resuming where it stopped.</div>}
          <dl className="kv">
            <dt>Pays</dt>
            <dd>{s.valueZat ? zec(s.valueZat) : '…'}</dd>
            <dt>To</dt>
            <dd className="mono small">{s.to}</dd>
            <dt>Status</dt>
            <dd>{s.status === 'open' ? 'Signing session open' : s.status === 'finishing' ? 'Signed; proving and broadcasting' : 'Preparing'}</dd>
          </dl>

          {iSign ? (
            <>
              <h3>1. Verify before you sign</h3>
              <p className="small">
                Download the unsigned transaction, check its recipient and amount, and compute its SIGHASH on your own machine. Don’t trust
                the desk’s numbers: a dishonest coordinator could ask you to sign something else.
              </p>
              {v.dryRun ? (
                <p className="small warn">Dry run: there is no real PCZT to download. In a real trade you would download it here.</p>
              ) : (
                <div className="row">
                  <button disabled={dl.busy} onClick={() => dl.run(() => download(`/trades/${v.id}/pczt`, token, pcztFileName(v.id)))}>
                    Download {pcztFileName(v.id)}
                  </button>
                </div>
              )}
              <ErrorText error={dl.error} />
              {verifyCommands(p).map((c) => <Cmd key={c}>{c}</Cmd>)}
              {s.sighash && (
                <>
                  <label>The SIGHASH you should see</label>
                  <Value>{s.sighash}</Value>
                </>
              )}

              <h3>2. Sign</h3>
              {s.status === 'open' ? (
                <>
                  <p className="small">
                    Run this now. It shows the message to sign: answer <code>y</code> only if it equals the SIGHASH you computed.
                  </p>
                  <Cmd>{participantCommand(p)}</Cmd>
                </>
              ) : (
                <p className="small muted">Wait for the session to open; this page updates by itself.</p>
              )}
            </>
          ) : (
            <p>
              {s.signers.filter((x) => x !== 'arbiter').map((x) => `the ${x}`).join(' and ')}
              {s.signers.includes('arbiter') ? ' and the arbiter are' : ' are'} signing. Nothing to do on your side.
            </p>
          )}

          {s.inspect && (
            <details>
              <summary className="small">pczt inspect, as the desk sees it</summary>
              <pre className="out">{s.inspect}</pre>
              <CopyButton text={s.inspect} />
            </details>
          )}
        </>
      )}
      <Leak>
        On-chain, a FROST 2-of-3 signature looks like an ordinary single signature. The tape gets this trade’s price, a size range and an
        hour, after a random delay.
      </Leak>
    </div>
  );
}
