# The FROST spike

Go/no-go gate: **two FROST-signed Mainnet transactions confirmed**, one signed by buyer + seller and one by
arbiter + buyer. Tool versions: `versions.lock`.

## Part 1 — no funds (automated)

```bash
scripts/spike-local.sh ~/sd/frost-local
```

This runs steps 1–4 below plus two signing sessions over a real Ironwood v6 PCZT, and saves every output
under `~/sd/frost-local/out`. The copies in `fixtures/spike/` came from this script.

**Verified on 6 Oct 2026 with the pinned tools:**

- [x] frostd with TLS; frost-client trusts a throwaway CA through `SSL_CERT_FILE` (rustls native roots), so
      `mkcert -install` is optional.
- [x] Three identities, contacts and a 2-of-3 RedPallas DKG. All three configs report the same group key.
- [x] `zcash-sign generate` prints an **Orchard-only** Unified Address and a UFVK whose Orchard `ak` **equals
      the FROST group key**. The desk checks this when the seller submits the escrow.
- [x] `zcash-sign sign` prints `SIGHASH: <hex>`, then for each spend `Randomizer #<i> (<pool>): <hex>` and
      `Input hex-encoded signature #<i> (<pool>):`. **Two runs on the same PCZT printed the same SIGHASH and
      randomizer**, so verify-before-sign (§11.9) works.
- [x] `frost-client participant` prints `Message to be signed (hex-encoded):`, the SIGHASH, and asks
      `Do you want to sign it? (y/n)`. It only joins a session that already exists, so participants start
      after the coordinator prints `Waiting for participants to send their commitments`.
- [x] `frost-client coordinator … -o sig.bin` writes the raw 64-byte signature to a file: no output parsing.
- [x] The arbiter can coordinate and sign in the same session (two processes, same config).
- [x] zcash-sign checks each signature against its spend before writing (`InvalidExternalSignature` otherwise).
- [ ] DKG with the three parties on **separate machines** through a TLS frostd (§16).

**Corrections to the build guide:**

- `zcash-sign generate` takes `-n main` / `--network main`. `--net main` is rejected (clap does not expand
  abbreviations).
- `frost-client contacts` re-encodes stored contacts **without** a version byte; only the `export` string is
  importable.
- With several spends, zcash-sign prompts for one signature per spend, one at a time; the worker runs one FROST
  session per prompt.

## Part 2 — Mainnet (manual, ~0.003 ZEC)

Run from the directory part 1 used (it holds `buyer.toml`, `seller.toml`, `arbiter.toml` and the CA).
`export SSL_CERT_FILE=$PWD/ca.pem`, and start frostd again if it isn't running:

```bash
frostd --ip 127.0.0.1 --port 2744 --tls-cert server.pem --tls-key server-key.pem &
GROUP=<Public key from: frost-client groups -c arbiter.toml>
```

**5. Watch-only escrow wallet** (arbiter side). Birthday: the current Mainnet tip, from a block explorer.

```bash
zcash-devtool wallet -w ~/sd/wallets/escrow-T1 init-fvk --name escrow-T1 \
  --fvk "<UFVK>" --birthday <tip-height> -s zecrocks
```

**6. Fund it** with **0.0011 ZEC** to the Orchard-only address, in **one** transaction, from Zodl or the `hot`
wallet. Then:

```bash
zcash-devtool wallet -w ~/sd/wallets/escrow-T1 sync -s zecrocks
zcash-devtool wallet -w ~/sd/wallets/escrow-T1 balance
```

**7. Create the release PCZT** paying the buyer 100,000 zatoshis:

```bash
zcash-devtool pczt -w ~/sd/wallets/escrow-T1 create --address <buyer-UA> --value 100000 \
  --memo "Shadow Desk T1" --output T1.created
zcash-devtool pczt inspect T1.created
```

**8. FROST-sign it.**

```bash
# A: prints SIGHASH and Randomizer, then waits for the signature on stdin
zcash-sign sign -n main --tx-plan T1.created -o T1.signed
# B: coordinator — copy the two values from A into binary files first
printf %s <SIGHASH>    | xxd -r -p > sighash.bin
printf %s <RANDOMIZER> | xxd -r -p > randomizer.bin
frost-client coordinator -c arbiter.toml --server-url localhost:2744 --group $GROUP \
  -S <buyerPub>,<sellerPub> -m sighash.bin -r randomizer.bin -o sig.bin
# C, D: once B prints "Waiting for participants…"; check the message equals the SIGHASH, then answer y
frost-client participant -c buyer.toml  --server-url localhost:2744 --group $GROUP
frost-client participant -c seller.toml --server-url localhost:2744 --group $GROUP
# Paste the signature into A:
xxd -p -c 64 sig.bin
```

**9. Prove, combine, broadcast.** Save the output of `send` as `fixtures/spike/pczt-send.txt`.

```bash
zcash-devtool pczt -w ~/sd/wallets/escrow-T1 prove T1.created --output T1.proven
zcash-devtool pczt combine -i T1.signed -i T1.proven -o T1.combined
zcash-devtool pczt -w ~/sd/wallets/escrow-T1 send -s zecrocks T1.combined
```

**10. Dispute path.** Fund a second escrow (T2: new DKG, new address) and repeat step 8 with
`-S <arbiterPub>,<buyerPub>`, plus a participant run with `-c arbiter.toml`.

Record both txids in the README's Mainnet evidence table.

## If the gate fails

Switch to single-arbiter escrow: the arbiter holds a normal shielded wallet, buyer and seller get its viewing key.
Only `src/server/worker/` changes; say clearly in the README that custody is trusted.
