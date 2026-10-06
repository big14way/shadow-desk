import { useState } from 'react';
import type { TradeView } from '../../../core/api';
import { dkgCommands, identityCommands, importCommands } from '../../../core/commands';
import { demoContact } from '../../../core/demo';
import { post } from '../../api';
import { Cmd, ErrorText, Leak, useAction } from '../ui';
import { commandParams, type StepProps } from './types';

export function Keys({ v, token, update }: StepProps) {
  const p = commandParams(v);
  const me = v.role === 'buyer' ? v.buyer : v.seller;
  const other = v.role === 'buyer' ? v.seller : v.buyer;
  const otherRole = v.role === 'buyer' ? 'seller' : 'buyer';
  const [contact, setContact] = useState('');
  const submit = useAction();
  const ready = useAction();

  if (v.state === 'KEYGEN') {
    const s = v.session?.type === 'dkg' ? v.session : null;
    return (
      <div className="panel stack">
        <h2>Key generation</h2>
        {(!s || s.status === 'starting') && <p>The arbiter is opening a 2-of-3 key generation session for this trade. Keep your terminal ready.</p>}
        {s?.status === 'open' && (
          <>
            <div className="notice ok">
              <strong>Go.</strong> Run this now. The session waits about five minutes for both of you.
            </div>
            {dkgCommands(p).map((c) => <Cmd key={c}>{c}</Cmd>)}
            <p className="small muted">
              <code>frost-client groups</code> prints the group’s <em>Public key</em>. You will see it again in the next step; it should
              match.
            </p>
          </>
        )}
        {s?.status === 'failed' && (
          <div className="notice danger">
            Attempt {s.attempt} failed ({s.error}). The arbiter is retrying: run your <code>frost-client dkg</code> command again when this
            page says Go.
          </div>
        )}
        <Leak>frostd relays the DKG messages, end-to-end encrypted. It sees which three public keys take part, and when.</Leak>
      </div>
    );
  }

  return (
    <div className="panel stack">
      <h2>1. Create a fresh identity for this trade</h2>
      <p className="muted">
        A new frost-client config per trade means your trades can’t be linked through your FROST identity. The file holds your key
        share: keep it until the trade ends.
      </p>
      {identityCommands(p).map((c) => <Cmd key={c}>{c}</Cmd>)}

      {me.contact ? (
        <p className="ok small">✓ Your contact is in. Public key <span className="mono">{me.pub?.slice(0, 16)}…</span></p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit.run(async () => update(await post<TradeView>(`/trades/${v.id}/contact`, token, { contact })));
          }}
        >
          <label htmlFor="contact">Paste the zffrost1… line that export printed</label>
          <textarea id="contact" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="zffrost1…" required />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={submit.busy || !contact.trim()}>Submit contact</button>
            {v.dryRun && (
              <button type="button" onClick={() => setContact(demoContact(v.role, v.id))}>
                Use a simulated contact
              </button>
            )}
          </div>
          <ErrorText error={submit.error} />
        </form>
      )}

      <hr />
      <h2>2. Import the arbiter and the {otherRole}</h2>
      {!v.arbiter.contact && <p className="muted">Waiting for the arbiter’s identity for this trade…</p>}
      {!other.contact && <p className="muted">Waiting for the {otherRole} to submit their contact…</p>}
      {v.arbiter.contact && other.contact && importCommands(p).map((c) => <Cmd key={c}>{c}</Cmd>)}

      <div className="row">
        <button
          className="primary"
          disabled={ready.busy || !me.contact || !other.contact || !v.arbiter.contact || me.ready}
          onClick={() => ready.run(async () => update(await post<TradeView>(`/trades/${v.id}/ready`, token)))}
        >
          {me.ready ? 'Ready ✓' : 'I’ve imported both: Ready'}
        </button>
        <span className="small muted">
          {other.ready ? `The ${otherRole} is ready.` : `The ${otherRole} isn’t ready yet.`} Key generation starts when you both are.
        </span>
      </div>
      <ErrorText error={ready.error} />
      <Leak>
        The desk stores your contact string: a fresh public key, nothing else. It never holds a key share for you or the {otherRole}.
      </Leak>
    </div>
  );
}
