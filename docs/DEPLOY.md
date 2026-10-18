# Deploying

Two services on one small VPS: **frostd** (the FROST relay) and **the desk** (API, web UI, ticker, signing worker).
Both sit behind nginx with Let's Encrypt and keep no access logs. zwatch runs alongside (docs/ZWATCH.md).

## Tools

```bash
sudo apt install -y build-essential pkg-config libssl-dev clang protobuf-compiler sqlite3 git curl nginx certbot python3-certbot-nginx
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# The exact builds the desk was tested against (versions.lock):
cargo install --git https://github.com/ZcashFoundation/frost-tools.git --rev 06c0dbdb1bac9b99cd255e74ba2f387c295e660 --locked frostd frost-client zcash-sign
cargo install --git https://github.com/zcash/zcash-devtool.git --rev 5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8 --locked
sudo install ~/.cargo/bin/{frostd,frost-client,zcash-sign,zcash-devtool} /usr/local/bin/
```

Node.js 22.13 or newer (the desk uses the built-in `node:sqlite`), and `corepack enable` for pnpm.

## frostd

```bash
sudo useradd --system frostd
sudo cp deploy/frostd.service /etc/systemd/system/ && sudo systemctl enable --now frostd
sudo cp deploy/nginx-frostd.conf /etc/nginx/sites-enabled/frostd.conf   # edit server_name
sudo certbot --nginx -d frost.example.com
```

frostd listens on `127.0.0.1:2744` without TLS (`--no-tls-very-insecure`); nginx terminates TLS and rate-limits
`/challenge` and `/create_new_session`. Participants use `--server-url frost.example.com:443` (frost-client prepends
`https://`). frostd only relays: frost-client encrypts every message end to end. It does see which public keys take
part in a session, and when.

## The desk

```bash
sudo useradd --system --create-home shadowdesk
sudo mkdir -p /var/lib/shadow-desk && sudo chown shadowdesk: /var/lib/shadow-desk && sudo chmod 700 /var/lib/shadow-desk
sudo git clone https://github.com/big14way/shadow-desk /opt/shadow-desk && cd /opt/shadow-desk
pnpm install --frozen-lockfile && pnpm build
sudo cp .env.example /etc/shadow-desk.env    # fill it in: FROSTD_URL, ZWATCH_URL, ARBITER_* (docs/ARBITER.md)
sudo cp deploy/shadow-desk.service /etc/systemd/system/ && sudo systemctl enable --now shadow-desk
sudo cp deploy/nginx-desk.conf /etc/nginx/sites-enabled/desk.conf && sudo certbot --nginx -d desk.example.com
```

The service refuses to start with `DESK_DRY_RUN=1` under `NODE_ENV=production`, and refuses to start a real desk
without `ZWATCH_URL`, `ARBITER_TOKEN_HASH` and `ARBITER_BOX_PUBKEY`.

## The free hosted demo (Render)

The judges' demo is a dry-run desk on Render's free plan, set up by `render.yaml`: Render → **New** → **Blueprint**
→ this repo. It needs no tools, keys or funds. What the free plan means for it:

- Render sets `NODE_ENV=production`, so the blueprint starts `pnpm start:demo`, which sets `NODE_ENV=demo`. Dry run
  is still refused under `NODE_ENV=production`.
- It sleeps after 15 idle minutes and takes about a minute to wake. The SQLite file is lost on every sleep or restart,
  so the demo starts empty.
- With `ARBITER_TOKEN_HASH` and `ARBITER_BOX_PUBKEY` empty, every start prints a new arbiter link and evidence key in
  the Render logs. Set both (`pnpm arbiter token`, `pnpm arbiter box-keypair`) to get one link that survives restarts.
- There is no nginx in front, so no rate limit, and Render and its Cloudflare edge (`server: cloudflare`) see visitor
  IP addresses. The desk itself still logs none. The README says so next to the demo link.

Live at <https://shadow-desk-demo.onrender.com> since 18 Oct 2026 (build 33 s). Checked there the same day:
`scripts/demo-dispute.ts` drove a trade to a dispute, the arbiter API released it to the buyer with the fixed demo
token, and the trade ended `RELEASED` with a `dryrun-` txid.

## Optional: an onion mirror

Add a Tor hidden service pointing at `127.0.0.1:8787`. The desk serves only same-origin assets, so it works unchanged.

## Checklist (build guide §17)

- [ ] `access_log off` on both nginx sites; no `X-Forwarded-For` to the desk
- [ ] `/var/lib/shadow-desk` is mode 700, owned by the service user
- [ ] An encrypted, off-site backup of `/var/lib/shadow-desk/frost/`
- [ ] `ARBITER_BOX_SECRET` is not on the server
