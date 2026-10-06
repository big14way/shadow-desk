#!/usr/bin/env bash
# The no-funds half of the FROST spike (build guide §7), on one machine with three configs:
#   1. frostd with TLS            2. three identities + contacts      3. a 2-of-3 RedPallas DKG
#   4. zcash-sign generate        5. a buyer+seller and an arbiter+buyer FROST signing session
#      over the SIGHASH/randomizer of a real Ironwood v6 PCZT (frost-tools' own test fixture).
#
# Everything it prints is saved under $WORK/out so it can become parser fixtures (fixtures/).
# It never touches funds. Steps 5–9 of §7 (fund, create, sign, prove, send) need Mainnet ZEC;
# run them by hand following docs/SPIKE.md.
#
# Usage: scripts/spike-local.sh [work-dir]      (default: ~/sd/frost-local)
# Needs: frostd, frost-client, zcash-sign, zcash-devtool, openssl.
set -euo pipefail

WORK=${1:-$HOME/sd/frost-local}
PORT=${PORT:-2744}
SERVER="localhost:$PORT"
FT_FIXTURE=${FT_FIXTURE:-$(ls -d "$HOME"/.cargo/git/checkouts/frost-tools-*/*/zcash-sign/tests/fixtures/ironwood_v6.pczt 2>/dev/null | head -1 || true)}

mkdir -p "$WORK/out" && cd "$WORK"
umask 077
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# --- 1. TLS for frostd: a throwaway CA, trusted only by these processes (rustls reads SSL_CERT_FILE)
if [[ ! -f server.pem ]]; then
  log "Creating a throwaway CA and a localhost certificate"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -days 30 \
    -subj "/CN=Shadow Desk spike CA" -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout server-key.pem -out server.csr -subj "/CN=localhost" 2>/dev/null
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > san.ext
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server.pem -days 30 -extfile san.ext 2>/dev/null
fi
export SSL_CERT_FILE="$WORK/ca.pem"

log "Starting frostd on $SERVER"
frostd --ip 127.0.0.1 --port "$PORT" --tls-cert server.pem --tls-key server-key.pem > out/frostd.log 2>&1 &
FROSTD=$!
trap 'kill $FROSTD 2>/dev/null || true' EXIT
for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null && break; sleep 0.2; done

# --- 2. Identities and contacts
log "Identities and contacts"
rm -f buyer.toml seller.toml arbiter.toml
for r in buyer seller arbiter; do frost-client init -c "$r.toml" 2> "out/init-$r.txt"; done
frost-client export --name buyer-T1  -c buyer.toml   2> out/export-buyer.txt
frost-client export --name seller-T1 -c seller.toml  2> out/export-seller.txt
frost-client export --name arbiter   -c arbiter.toml 2> out/export-arbiter.txt
contact() { grep -E '^zffrost1' "out/export-$1.txt" | tail -1; }
pub() { sed -n 's/^Public Key: //p' "out/export-$1.txt" | head -1; }
B_C=$(contact buyer); S_C=$(contact seller); A_C=$(contact arbiter)
B_P=$(pub buyer); S_P=$(pub seller); A_P=$(pub arbiter)
frost-client import "$S_C" -c buyer.toml   2> out/import.txt
frost-client import "$A_C" -c buyer.toml   2>> out/import.txt
frost-client import "$B_C" -c seller.toml  2>> out/import.txt
frost-client import "$A_C" -c seller.toml  2>> out/import.txt
frost-client import "$B_C" -c arbiter.toml 2>> out/import.txt
frost-client import "$S_C" -c arbiter.toml 2>> out/import.txt
frost-client contacts -c arbiter.toml 2> out/contacts-arbiter.txt
printf 'buyer %s\nseller %s\narbiter %s\n' "$B_C" "$S_C" "$A_C" > out/contact-strings.txt

# --- 3. DKG: 2-of-3 RedPallas. The arbiter creates the session; all three run at once.
log "DKG (2-of-3, redpallas)"
frost-client dkg -d trade-T1 -s "$SERVER" -S "$B_P,$S_P" -t 2 -C redpallas -c arbiter.toml > out/dkg-arbiter.txt 2>&1 &
D1=$!
sleep 1
frost-client dkg -d trade-T1 -s "$SERVER" -t 2 -C redpallas -c buyer.toml  > out/dkg-buyer.txt 2>&1 &
D2=$!
frost-client dkg -d trade-T1 -s "$SERVER" -t 2 -C redpallas -c seller.toml > out/dkg-seller.txt 2>&1 &
D3=$!
wait $D1 $D2 $D3
for r in buyer seller arbiter; do frost-client groups -c "$r.toml" 2> "out/groups-$r.txt"; done
GROUP=$(sed -n 's/^Public key //p' out/groups-arbiter.txt | head -1)
for r in buyer seller; do
  [[ "$(sed -n 's/^Public key //p' "out/groups-$r.txt" | head -1)" == "$GROUP" ]] || { echo "group keys differ" >&2; exit 1; }
done
echo "group public key: $GROUP"

# --- 4. Escrow keys (the seller runs this)
log "zcash-sign generate"
zcash-sign generate -n main --ak "$GROUP" > out/zcash-sign-generate.txt
cat out/zcash-sign-generate.txt
UA=$(sed -n 's/^Orchard-only unified address: "\(.*\)"$/\1/p' out/zcash-sign-generate.txt)
UFVK=$(sed -n 's/^Unified Full Viewing Key: "\(.*\)"$/\1/p' out/zcash-sign-generate.txt)
zcash-devtool inspect "$UA"   > out/inspect-address.txt 2>&1 || true
zcash-devtool inspect "$UFVK" > out/inspect-ufvk.txt 2>&1 || true
printf '%s\n%s\n%s\n' "$GROUP" "$UA" "$UFVK" > out/escrow.txt

# --- 5. Signing sessions over a real Ironwood v6 PCZT (no funds: frost-tools' test fixture)
if [[ -z "$FT_FIXTURE" || ! -f "$FT_FIXTURE" ]]; then
  echo "frost-tools fixture ironwood_v6.pczt not found; skipping signing" >&2
  exit 0
fi
cp "$FT_FIXTURE" out/fixture.created
log "pczt inspect"
zcash-devtool pczt inspect out/fixture.created > out/pczt-inspect.txt 2>&1 || true
log "zcash-sign sign (twice, to check the SIGHASH is deterministic)"
for i in 1 2; do echo "" | zcash-sign sign -n test --tx-plan out/fixture.created -o out/fixture.signed > "out/zcash-sign-sign-$i.txt" 2>&1 || true; done
SIGHASH=$(sed -n 's/^SIGHASH: //p' out/zcash-sign-sign-1.txt)
RAND=$(sed -n 's/^Randomizer #[0-9]* ([a-z]*): //p' out/zcash-sign-sign-1.txt | head -1)
diff -q <(grep -E '^(SIGHASH|Randomizer)' out/zcash-sign-sign-1.txt) <(grep -E '^(SIGHASH|Randomizer)' out/zcash-sign-sign-2.txt) \
  && echo "deterministic: same SIGHASH and randomizer on both runs"
printf '%s' "$SIGHASH" | xxd -r -p > out/sighash.bin
printf '%s' "$RAND" | xxd -r -p > out/randomizer.bin

sign_session() { # $1 label, $2 signers, then participant configs
  local label=$1 signers=$2; shift 2
  frost-client coordinator -c arbiter.toml --server-url "$SERVER" --group "$GROUP" -S "$signers" \
    -m out/sighash.bin -r out/randomizer.bin -o "out/sig-$label.bin" > "out/coordinator-$label.txt" 2>&1 &
  local C=$!
  # A participant can only join once the session exists.
  for _ in $(seq 50); do grep -q 'Waiting for participants' "out/coordinator-$label.txt" && break; sleep 0.2; done
  local pids=()
  for cfg in "$@"; do
    echo y | frost-client participant -c "$cfg" --server-url "$SERVER" --group "$GROUP" > "out/participant-$label-${cfg%.toml}.txt" 2>&1 &
    pids+=($!)
  done
  wait "$C" "${pids[@]}"
  xxd -p -c 64 "out/sig-$label.bin" > "out/sig-$label.hex"
}
log "Signing session: buyer + seller"
sign_session release "$B_P,$S_P" buyer.toml seller.toml
log "Signing session: arbiter + buyer (the coordinator also signs)"
sign_session dispute "$A_P,$B_P" arbiter.toml buyer.toml

log "Feeding a signature to zcash-sign (expected to be rejected: the fixture belongs to another key)"
zcash-sign sign -n test --tx-plan out/fixture.created -o out/fixture.signed < out/sig-release.hex > out/zcash-sign-apply.txt 2>&1 || true
cat out/zcash-sign-apply.txt

log "Done. Outputs in $WORK/out"
