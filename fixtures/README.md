# Fixtures

Real output from the tools, used by the parser tests in `test/`.

## `spike/` — captured by `scripts/spike-local.sh` on 6 Oct 2026

Tools: see `versions.lock` (frost-tools `06c0dbd`, zcash-devtool `5a26ee8`). One machine, three
frost-client configs, a local TLS frostd. No funds were involved.

| File | What it is |
|---|---|
| `export-*.txt` | `frost-client export` (stderr). The `zffrost1…` line is what participants paste. |
| `contacts-arbiter.txt`, `import.txt` | `frost-client contacts` / `import` (stderr). Stored contacts re-encode without a version, so these strings differ from the exported ones. |
| `dkg-*.txt` | `frost-client dkg` for the creator (arbiter, `-S`) and a joiner. |
| `groups-*.txt` | `frost-client groups`: `Group "<description>"` then `Public key <hex>`. |
| `zcash-sign-generate.txt` | `zcash-sign generate -n main --ak <group key>`: the Orchard-only UA and UFVK, Debug-quoted. |
| `inspect-address.txt`, `inspect-ufvk.txt` | `zcash-devtool inspect` on those two strings. |
| `escrow.txt` | group key, escrow UA, UFVK — the UFVK's Orchard `ak` equals the group key. |
| `ironwood_v6.created` | frost-tools' own test PCZT (`zcash-sign/tests/fixtures/ironwood_v6.pczt`, MIT/Apache-2.0): a real unsigned v6 Ironwood transaction on Testnet. |
| `pczt-inspect.txt` | `zcash-devtool pczt inspect` on it. |
| `zcash-sign-sign-1.txt` | `zcash-sign sign -n test` on it: `SIGHASH:`, `Randomizer #i (pool):`, then the signature prompt. Two runs printed identical values. |
| `coordinator-*.txt`, `participant-*.txt` | A buyer+seller session and an arbiter+buyer session (the coordinator also signs) over that SIGHASH. Participants print the message and ask `(y/n)`. |
| `sig-*.hex` | The 64-byte signatures the coordinator wrote with `-o`. |
| `zcash-sign-apply.txt` | Feeding one of those signatures back: `InvalidExternalSignature`, because the fixture PCZT belongs to a different key. zcash-sign checks every signature before writing a transaction. |

**Never fund the address in `escrow.txt`.** Its key shares were throwaway files and are gone.

## Not captured yet

`spike/pczt-send.txt` is written from zcash-devtool's source (`src/commands/pczt/send.rs`: it prints
`Sending transaction...` and then the txid on its own line), with a zero txid. Replace it with real
output after the first Mainnet broadcast (docs/SPIKE.md, step 9).
