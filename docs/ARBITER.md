# Arbiter runbook

The arbiter is the desk operator. For every escrow the desk process holds one of the three key shares, in a
**per-trade** frost-client config: `$DATA_DIR/frost/trade-<id>.toml`. It coordinates every signing session and co-signs
only disputes and refunds.

## One-time setup

```bash
pnpm arbiter token         # ARBITER_TOKEN (keep) + ARBITER_TOKEN_HASH (server env)
pnpm arbiter box-keypair   # ARBITER_BOX_PUBKEY (server env) + ARBITER_BOX_SECRET (keep OFFLINE)
```

Open the console at `https://desk.example.com/admin#k=<ARBITER_TOKEN>`. The token stays in the URL fragment, so it
never reaches the server or any log.

## Daily start

- [ ] frostd is up behind TLS: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://frost.example.com/challenge` prints `200`.
- [ ] zwatch `/health` reports a fresh tip.
- [ ] The desk is running: `curl -s https://desk.example.com/api/health`.
- [ ] Today's backup of `$DATA_DIR/frost/` exists, encrypted (for example `tar c frost | age -r <key> > frost-<date>.tar.age`).
      Without those files the arbiter can't sign disputes or refunds.

## Disputes

1. The console lists disputes first. Open the trade; each party may have added sealed evidence.
2. Read the evidence **offline**: paste `ARBITER_BOX_SECRET` into the console (it stays in that browser tab and decrypts
   locally), or download the sealed file and run
   `ARBITER_BOX_PUBKEY=… ARBITER_BOX_SECRET=… pnpm arbiter open evidence.sealed out.bin`.
3. Decide using the published policy:
   - the buyer's proof of payment must match the amount and the reference from the seller's memo;
   - reversible payment methods need extra checks;
   - when in doubt, refund the seller.
4. Click **Release to buyer** or **Refund to seller** (or `POST /api/admin/trades/:id/resolve {"to": "buyer" | "seller"}`).
5. The worker opens a signing session in which the arbiter signs after checking that the session message equals the
   SIGHASH `zcash-sign` computed. The winning party must come online and join with `frost-client participant`.
   If neither party ever returns, the funds stay in escrow.

## Other cases

| Situation | What happens | What you do |
|---|---|---|
| `NEEDS_ATTENTION`: more than one payment reached the escrow | trade paused | Check with the seller. **Accept funding** to continue (each note needs its own signature, which the worker handles one prompt at a time), or **Refund to seller**. |
| Funds reach the escrow of a cancelled trade | the ticker moves it to `REFUNDING` automatically | Make sure the seller knows to join the refund. |
| A settlement keeps failing | `last_error` and the worker log show why; it retries with backoff, resuming from the PCZT files in `$DATA_DIR/work/<id>/` | Fix the cause (lightwalletd down, participants offline). Never delete `x.signed` or `x.txid`. |
| The value-cap check fires | settlement stops and is not retried | Investigate: something tried to move more than amount + fee. |

## Keys

- `ARBITER_BOX_SECRET` lives offline only. The server has the public key.
- `$DATA_DIR/frost/` is `chmod 700`, each config `chmod 600`, and the process runs with `umask 077`.
- Seven days after a trade ends, the desk deletes its arbiter config, wallet and work files along with the trade row.
