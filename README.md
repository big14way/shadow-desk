# Shadow Desk

**A peer-to-peer ZEC desk where the price is public and the participants are not.**

ZECATHON · Private Markets track · Video: _to be recorded (≤ 3 min, see [the plan](#three-minute-video))_

- The seller's ZEC sits in a **FROST 2-of-3 escrow** shared by buyer, seller and an arbiter.
- Every escrow is a fresh shielded address that looks like any other on-chain.
- Bank details travel as **encrypted Zcash memos** built in the seller's browser. The server never sees them.
- After each trade the desk publishes only **the price, a size range and an hour**, after a random delay.

## The problem

P2P desks see everything. To sell 0.01 ZEC for naira on a typical P2P platform, you hand the platform your name, your
bank account and your trade history. The platform also holds the coins while you wait, and its multisig escrow sits on
a transparent chain for anyone to trace. Shielded ZEC holders need a non-custodial way to buy and cash out that doesn't
undo the privacy they chose.

## How it works

```
 Buyer browser ──┐                                   ┌── Seller browser
 (Tor Browser    │       HTTPS, no IP logging        │   (builds the memo payment
  recommended)   ▼                                   ▼    link locally)
        ┌───────────────── Desk web + API (Node, Hono, React) ──────────────┐
        │ offers · trades · state machine · capability links · price tape  │
        │ SQLite: no bank details, no IP addresses                         │
        └──────┬──────────────────────┬──────────────────────┬────────────┘
               │                      │                      │
        zwatch (view-only,     signing worker (arbiter):   frostd (TLS relay;
        one account per        zcash-devtool pczt,         messages are
        escrow)                zcash-sign, frost-client    end-to-end encrypted)
               │                      │                      ▲
               ▼                      ▼                      │
         zec.rocks light wallet server            frost-client on the buyer's and
                                                  seller's own machines
```

1. The seller posts an offer (price per ZEC, range, payment method) and gets a private offer link.
2. A buyer takes it and gets a private trade link. Links carry a capability token in the URL fragment (`#k=…`), which
   browsers never send to servers; the desk stores only its SHA-256. There are no accounts.
3. Buyer, seller and a **fresh per-trade arbiter identity** run a 2-of-3 RedPallas DKG through frostd.
4. The seller runs `zcash-sign generate --ak <group key>` on their own machine and submits the Orchard-only address
   and viewing key. The desk checks that the viewing key's Orchard `ak` **equals the group key**, so it provably
   belongs to this trade's FROST group, and that the address has no Sapling receiver (funds sent there would be
   unspendable).
5. The seller funds the escrow with amount + 0.0001 ZEC in one transaction (a ZIP 321 QR). zwatch reports it; the
   desk waits for one note with 2 confirmations.
6. The seller types their bank details into a form that never leaves the browser. It becomes a ZIP 321 link with an
   encrypted memo to the buyer's fresh address, sent from the seller's own wallet.
7. The buyer pays in local currency and clicks "I've paid". The seller confirms receipt.
8. The worker creates the release PCZT, checks that it pays the buyer the right amount, and coordinates a FROST
   session. Buyer and seller **verify before signing**: they download the PCZT, inspect it, and compute its SIGHASH
   with `zcash-sign` on their own machines. Proving runs in parallel; then combine and broadcast.
9. Disputes: either party can open one (with evidence sealed to the arbiter's key in the browser), or it opens by
   itself if the seller stays silent for 60 minutes. The arbiter co-signs with the honest party, and signs only if
   the session message equals the SIGHASH it computed itself.

The trade room walks both parties through every step with the exact commands, deadlines and a **What leaks here**
note.

## What leaks to whom

| Who | What they learn |
|---|---|
| Blockchain observer | Ordinary shielded transactions: funding, details memo, release. Not that it's an escrow, not the amount, not the parties. A FROST signature looks like a single-signer one. |
| Desk server | Offers (price, range, method), trade amounts, the escrow viewing key (so it sees escrow activity) and the buyer's receive address. Never bank details. It holds no funds and no keys of the traders. |
| Arbiter | The same as the server, plus dispute evidence, but only if a dispute is opened. Holds 1 of 3 key shares. |
| Counterparty | Only what the fiat payment needs: the seller's bank details go to the buyer, and the buyer's fresh address goes to the seller. |
| frostd relay | Which public keys take part in a session, and when. Message contents are end-to-end encrypted. Every party uses a fresh key per trade. |
| Public | The tape: price, size range (`<0.1`, `0.1-1`, `>1` ZEC), hour, published after a random 0–60 min delay. |
| Banks | The fiat transfer between buyer and seller. |

Checked: after a full dry-run trade driven through the browser (6 Oct 2026), the server's database files held zero
copies of the bank details typed into the seller's form; token hashes only (`test/server/api.test.ts`); no access log and no forwarded IPs
in `deploy/`; no third-party scripts, fonts or analytics (the CSP is `default-src 'self'`).

## Mainnet evidence

| # | Trade | Signers | txid | What it shows |
|---|---|---|---|---|
| 1 | Happy path | buyer + seller | _pending_ | FROST-signed release on Mainnet |
| 2 | Dispute → buyer | arbiter + buyer | _pending_ | the dispute path end to end |
| 3 | Cancel → refund | arbiter + seller | _pending_ | refund to the seller |

**Status, honestly:** the Mainnet trades haven't been run yet. They need funded wallets and a public frostd, and they
are the next step (docs/SPIKE.md, part 2). What *has* run with the real tools, without funds: frostd with TLS, three
identities, a 2-of-3 RedPallas DKG, `zcash-sign generate`, and two complete FROST signing sessions (buyer + seller,
arbiter + buyer) over a real Ironwood v6 PCZT. Their output is in `fixtures/spike/`, and every parser is tested against
it.

## Try it

### Hosted demo

_Link pending._ A dry-run desk on Render's free plan (docs/DEPLOY.md). It sleeps when idle, so the first visit can
take about a minute, and it starts empty after every wake. Render's proxy sees visitor IP addresses; the desk logs
none. A real desk runs behind `deploy/nginx-desk.conf`, which keeps no access log.

### Click through in 2 minutes (dry run)

Needs Node.js ≥ 22.13 and pnpm (`corepack enable`).

```bash
git clone https://github.com/big14way/shadow-desk && cd shadow-desk
pnpm install
pnpm demo                      # builds the UI, starts http://127.0.0.1:8787 with DESK_DRY_RUN=1
```

`DESK_DRY_RUN=1` swaps zwatch and the signing worker for mocks that advance on timers and return `dryrun-` txids, and
the UI shows a red banner. Demo keys and addresses use **Testnet** encodings, so a demo escrow address can never
receive Mainnet ZEC. The server refuses dry run when `NODE_ENV=production`.

1. **Sell ZEC** → post an offer. Keep the offer link it shows you.
2. In another window, **Offers** → **Buy** → take it. You are now the buyer.
3. Back in the first window, open the offer link → **Open trade room**. You are the seller.
4. In each room, click the *simulated* buttons (contact, escrow, address), then **Ready**, and follow the steps.
5. The arbiter console link and the evidence key are printed in the terminal. `pnpm exec tsx scripts/demo-dispute.ts`
   creates a disputed trade for it.

### Run a real trade

You need the tools in `versions.lock`, a funded Mainnet wallet (Zodl), a frostd with TLS and zwatch. See
[docs/SPIKE.md](docs/SPIKE.md) for the manual run, [docs/DEPLOY.md](docs/DEPLOY.md) for the desk,
[docs/ARBITER.md](docs/ARBITER.md) for the operator, and the in-app **How it works** page for participants. Trades are
capped at 0.01 ZEC.

### Develop

```bash
pnpm dev          # API (dry run, watch mode) on :8787 + Vite on :5173
pnpm test         # 100+ tests: core, API, worker (with fake CLI tools), parsers (real fixtures)
pnpm typecheck
pnpm spike        # the no-funds FROST spike with the real tools
```

## Security notes and honest limits

- **2-of-3 trust.** The arbiter colluding with either party can move the funds. That's inherent to 2-of-3 escrow.
- **Coordinator honesty.** A malicious coordinator could ask participants to sign a different transaction.
  Verify-before-sign is the defence. `zcash-sign` printed the same SIGHASH and randomizer on repeated runs over the
  same PCZT, and `frost-client participant` shows the message before asking `(y/n)`.
- **Quantum recoverability.** ZIP 2005 asks FROST key generation to use the `use_qsk` derivation. An open frost-tools
  issue (#609) indicates `zcash-sign` still derives keys the legacy way. These escrows work and are spendable in
  Ironwood today, but wouldn't be recoverable under a future quantum-recovery protocol. That's one reason trades are
  capped at 0.01 ZEC.
- **The fiat leg.** Banks see the transfer, and reversible payment methods allow chargeback fraud. The arbiter policy
  is published in the app.
- **Liveness.** The winning party of a dispute must come online to co-sign. If neither party ever returns, the funds
  stay in escrow.
- **Usability.** Participants need command-line tools today. A signer app wrapping frost-client is the obvious next
  step.
- **Demo-grade tooling.** frost-tools and zcash-devtool are not production software. This is a hackathon prototype,
  not legal advice. Rules for P2P exchange differ by country.

### Design notes

- **Per-trade arbiter identity.** Instead of one `arbiter.toml` holding every group, the desk creates
  `data/frost/trade-<id>.toml` per trade. Concurrent DKGs never rewrite the same file, the arbiter never has two
  sessions on one identity (which would make `frost-client participant` ambiguous), and frostd can't link trades
  through the arbiter's key.
- **Resumable settlement.** `x.created`, `x.signed`, `x.proven`, `x.combined` and `x.txid` stay on disk, and the
  txid is computed before broadcast. A crash at any step resumes there and never signs a second transaction. This is
  tested by crashing at every step.
- **Value cap.** A release pays exactly the amount; no settlement ever moves more than amount + fee.
- **Corrections to the build guide** found while building: `zcash-sign generate` takes `-n`/`--network`, not
  `--net`; `frost-client coordinator -o` writes the signature to a file, so the worker needs no output parsing for it.

## Three-minute video

| Time | Show |
|---|---|
| 0:00–0:20 | The problem: P2P desks see everything; multisig escrow on transparent chains is public |
| 0:20–0:50 | Post an offer; take it in a second browser (Tor) |
| 0:50–1:30 | Three terminals: the DKG; the seller generates the escrow and funds it from Zodl; the desk shows `FUNDED` |
| 1:30–1:50 | Bank details arrive as an encrypted memo in the buyer's Zodl |
| 1:50–2:20 | "I've paid"; "Received"; verify-before-sign; 2-of-3 signing; txid |
| 2:20–2:40 | Dispute clip: arbiter + buyer release |
| 2:40–3:00 | Explorer: ordinary shielded transactions. Tape: price only. The leak table |

## Repository

```
src/core/      shared by server and browser: money, ZIP 321, ZIP 316 decoding, contacts, state machine, commands
src/server/    Hono API, SQLite, ticker, zwatch client, dry-run mocks
src/server/worker/  arbiter identity, DKG, settlement (frost-client, zcash-sign, zcash-devtool)
src/web/       React UI
test/          Vitest: core, API, worker; test/fakebin/ fakes the three CLIs
fixtures/      real output captured from the tools (no funds involved)
docs/          spike, deploy, arbiter runbook, zwatch contract
deploy/        nginx and systemd
```

## Credits

- [frost-tools](https://github.com/ZcashFoundation/frost-tools) (frostd, frost-client, zcash-sign), Zcash Foundation,
  MIT/Apache-2.0. `fixtures/spike/ironwood_v6.created` is its test PCZT.
- [zcash-devtool](https://github.com/zcash/zcash-devtool), MIT/Apache-2.0.
- [zcash-test-vectors](https://github.com/zcash/zcash-test-vectors) (F4Jumble, Unified Address and UFVK vectors), MIT/Apache-2.0.
- [libsodium.js](https://github.com/jedisct1/libsodium.js), [@noble/hashes](https://github.com/paulmillr/noble-hashes),
  [@scure/base](https://github.com/paulmillr/scure-base), [Hono](https://hono.dev), [React](https://react.dev),
  [node-qrcode](https://github.com/soldair/node-qrcode).
- Prior art that shaped the design: ZecVault, zk.poker, Steward, Konclave, Zafe, nightpool, TACIT.

## License

MIT. See [LICENSE](LICENSE).
