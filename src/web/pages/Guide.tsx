import { Cmd, useConfig } from '../components/ui';

const LEAKS: [string, string][] = [
  ['Blockchain observer', 'Ordinary shielded transactions: funding, details memo, release. Not that it’s an escrow, not the amount, not the parties. A FROST signature looks like a single-signer one.'],
  ['Desk server', 'Offers (price, range, method), trade amounts, the escrow viewing key (so it sees escrow activity) and the buyer’s receive address. Never bank details. It holds no funds and no keys.'],
  ['Arbiter', 'The same as the server, plus dispute evidence, but only if a dispute is opened. Holds 1 of 3 key shares.'],
  ['Counterparty', 'Only what the fiat payment needs: the seller’s bank details go to the buyer, and the buyer’s fresh address goes to the seller.'],
  ['frostd relay', 'Which public keys take part in a session, and when. Message contents are end-to-end encrypted.'],
  ['Public', 'The tape: price, size range, hour.'],
  ['Banks', 'The fiat transfer between buyer and seller.'],
];

export function Guide() {
  const config = useConfig();
  const net = config?.network ?? 'main';
  const frostd = config?.frostdUrl ?? '<frostd-host:port>';
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="panel stack">
        <h1>How a trade works</h1>
        <ol>
          <li>The seller posts an offer: price per ZEC, amount range, payment method.</li>
          <li>A buyer takes it. Buyer, seller and the arbiter run a FROST key generation for this trade only.</li>
          <li>The seller derives the escrow address from the group key and funds it from their own wallet.</li>
          <li>The seller sends bank details to the buyer’s fresh shielded address as an encrypted memo.</li>
          <li>The buyer pays in local currency and clicks “I’ve paid”.</li>
          <li>The seller confirms receipt. Buyer and seller co-sign the release; the buyer receives shielded ZEC.</li>
          <li>If something goes wrong, the arbiter co-signs with the honest party: release to the buyer, or refund to the seller.</li>
        </ol>
      </div>

      <div className="panel stack">
        <h2>Participant guide</h2>
        <p>You need three command-line tools from the Zcash Foundation and ECC. Install once (Rust required):</p>
        <Cmd>{`cargo install --git https://github.com/ZcashFoundation/frost-tools.git --locked frost-client zcash-sign
cargo install --git https://github.com/zcash/zcash-devtool.git --locked`}</Cmd>
        <p>
          For <strong>each</strong> trade, use a fresh config so your trades can’t be linked through your FROST identity. The trade room
          fills in the exact commands; this is the shape of them:
        </p>
        <Cmd>{`mkdir -p ~/.shadowdesk && cd ~/.shadowdesk
frost-client init -c trade-<id>.toml
frost-client export --name <role>-<id> -c trade-<id>.toml     # paste the zffrost1… line into the room
frost-client import <arbiter-contact> -c trade-<id>.toml
frost-client import <counterparty-contact> -c trade-<id>.toml

# Key generation: when the room says Go
frost-client dkg -d trade-<id> -s ${frostd} -t 2 -C redpallas -c trade-<id>.toml
frost-client groups -c trade-<id>.toml          # note the group "Public key"

# Seller only: create the escrow
zcash-sign generate -n ${net} --ak <group-public-key>

# When asked to sign: verify first, then
zcash-devtool pczt inspect ~/Downloads/shadowdesk-<id>.created
echo | zcash-sign sign -n ${net} --tx-plan ~/Downloads/shadowdesk-<id>.created -o /dev/null 2>/dev/null | grep SIGHASH
frost-client participant -c trade-<id>.toml --server-url ${frostd} --group <group-public-key>`}</Cmd>
        <p>
          Keep <code>trade-&lt;id&gt;.toml</code> until the trade is released or refunded. It holds your key share: without it you
          can’t sign, and it must never be shared.
        </p>
      </div>

      <div className="panel">
        <h2>What leaks to whom</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              {LEAKS.map(([who, what]) => (
                <tr key={who}>
                  <th style={{ textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text)', width: 170 }}>{who}</th>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel stack">
        <h2>Arbiter policy</h2>
        <ul>
          <li>The buyer’s proof of payment must match the amount and the reference in the seller’s memo.</li>
          <li>Reversible payment methods need extra checks before a release.</li>
          <li>When in doubt, the escrow is refunded to the seller.</li>
          <li>The winning party must come online to co-sign with the arbiter. If neither ever returns, the funds stay in escrow.</li>
        </ul>
      </div>

      <div className="panel stack">
        <h2>Honest limits</h2>
        <ul>
          <li><strong>2-of-3 trust.</strong> The arbiter colluding with either party can move the funds. That’s inherent to 2-of-3 escrow.</li>
          <li><strong>Coordinator honesty.</strong> A malicious coordinator could ask you to sign a different transaction. Verify-before-sign is the defence: always compare the SIGHASH.</li>
          <li><strong>Quantum recoverability.</strong> ZIP 2005 asks FROST key generation to use the <code>use_qsk</code> derivation, which <code>zcash-sign</code> doesn’t do yet. These escrows work and are spendable today but wouldn’t be recoverable under a future quantum-recovery protocol, which is one reason trades are capped at 0.01 ZEC.</li>
          <li><strong>The fiat leg.</strong> Banks see the transfer, and reversible payment methods allow chargeback fraud.</li>
          <li><strong>Usability.</strong> You need command-line tools today. A signer app is the obvious next step.</li>
          <li><strong>Demo-grade tooling.</strong> frost-tools and zcash-devtool are not production software. This is a hackathon prototype, not legal advice.</li>
        </ul>
      </div>
    </div>
  );
}
