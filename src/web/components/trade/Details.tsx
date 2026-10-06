import { useState } from 'react';
import type { TradeView } from '../../../core/api';
import { buildZip321, DETAILS_MEMO_ZAT, MAX_MEMO_BYTES, memoBytes, paymentDetailsMemo } from '../../../core/zip321';
import { post } from '../../api';
import { CopyButton, ErrorText, fiat, Leak, QR, useAction, useConfig } from '../ui';
import type { StepProps } from './types';

/**
 * The seller's payment details are typed here and turned into an encrypted-memo payment link in this browser.
 * Nothing in this form is ever sent to the desk (build guide §11.6).
 */
function SellerDetails({ v, token, update }: StepProps) {
  const config = useConfig();
  const [d, setD] = useState({ bank: '', accountNo: '', accountName: '', reference: `SD-${v.id.slice(0, 6).toUpperCase()}` });
  const [built, setBuilt] = useState(false);
  const act = useAction();
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => (setD({ ...d, [k]: e.target.value }), setBuilt(false));
  const memo = paymentDetailsMemo(v.id, d);
  const bytes = memoBytes(memo);
  let uri: string | null = null;
  let err: string | null = null;
  try {
    if (v.buyer.receiveUa) uri = buildZip321(v.buyer.receiveUa, DETAILS_MEMO_ZAT, memo, 'Shadow Desk payment details');
  } catch (e) {
    err = (e as Error).message;
  }
  const filled = d.bank && d.accountNo && d.accountName;
  return (
    <div className="stack">
      <p>
        Tell the buyer where to send <strong>{fiat(v.fiatMinor, v.currency)}</strong> by {config?.methods[v.method] ?? v.method}. These
        fields stay in this page: they become an encrypted memo to the buyer’s address, sent from <em>your</em> wallet.
      </p>
      <div className="fields">
        <div>
          <label htmlFor="bank">Bank / provider</label>
          <input id="bank" value={d.bank} onChange={set('bank')} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="acct">Account number</label>
          <input id="acct" value={d.accountNo} onChange={set('accountNo')} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="name">Account name</label>
          <input id="name" value={d.accountName} onChange={set('accountName')} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="ref">Payment reference</label>
          <input id="ref" value={d.reference} onChange={set('reference')} autoComplete="off" />
        </div>
      </div>
      <div className={`small ${bytes > MAX_MEMO_BYTES ? 'danger' : 'muted'}`}>
        Memo: {bytes} / {MAX_MEMO_BYTES} bytes
      </div>
      <ErrorText error={err} />
      {!built ? (
        <button className="primary" disabled={!filled || !uri} onClick={() => setBuilt(true)}>
          Build the memo payment
        </button>
      ) : (
        uri && (
          <div className="grid two">
            <div className="stack">
              <p className="small">
                Scan with Zodl (it sends 0.00001 ZEC so the memo has an output to ride on), or copy the link. If your wallet drops the
                memo from a scanned link, copy the memo text and paste it into the memo field yourself.
              </p>
              <div className="row">
                <CopyButton text={uri} label="Copy payment link" className="" />
                <CopyButton text={memo} label="Copy memo text" className="" />
              </div>
              <pre className="out">{memo}</pre>
              <button className="primary" disabled={act.busy} onClick={() => act.run(async () => update(await post<TradeView>(`/trades/${v.id}/details-sent`, token)))}>
                I’ve sent the memo
              </button>
              <ErrorText error={act.error} />
            </div>
            <div>
              <QR text={uri} />
            </div>
          </div>
        )
      )}
    </div>
  );
}

export function Details(props: StepProps) {
  return (
    <div className="panel stack">
      <h2>Payment details</h2>
      {props.v.role === 'seller' ? (
        <SellerDetails {...props} />
      ) : (
        <p>
          The escrow is funded. The seller is sending their payment details as an encrypted memo to your receive address. Watch for an
          incoming 0.00001 ZEC payment in your wallet: the memo starts with <code>SHADOWDESK {props.v.id}</code>.
        </p>
      )}
      <Leak>
        Bank details travel only as an encrypted memo between your two wallets. The desk, the arbiter and chain observers never see them.
      </Leak>
    </div>
  );
}
