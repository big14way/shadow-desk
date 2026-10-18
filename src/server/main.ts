// Shadow Desk server: API + web UI + ticker + signing worker, in one process.

import { serve } from '@hono/node-server';
import sodium from 'libsodium-wrappers';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { Desk } from './desk';
import { DryRunZwatch } from './dryrun';
import { Repo } from './repo';
import { hashToken, newToken } from './tokens';
import { DryRunBackend, RealBackend } from './worker/backend';
import { Worker } from './worker/index';
import { httpZwatch, type Zwatch } from './zwatch';

const cfg = loadConfig();
// Key shares, wallets and PCZTs created by this process and its children are private to this user.
process.umask(0o077);

const banner: string[] = [];
if (cfg.dryRun) {
  banner.push('DRY RUN: no real funds or signatures. Escrow, funding and signing are simulated.');
  if (!cfg.arbiterTokenHash) {
    const token = newToken();
    cfg.arbiterTokenHash = hashToken(token);
    // On Render the public URL is in RENDER_EXTERNAL_URL; the bind address (0.0.0.0) is not a link anyone can open.
    const origin = process.env.RENDER_EXTERNAL_URL ?? `http://${cfg.host}:${cfg.port}`;
    banner.push(`Arbiter console:   ${origin}/admin#k=${token}`);
  }
  if (!cfg.arbiterBoxPubkey) {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
    cfg.arbiterBoxPubkey = b64(kp.publicKey);
    banner.push(`Evidence key (paste into the arbiter console to open sealed evidence): ${b64(kp.privateKey)}`);
  }
}

const repo = new Repo(openDb(cfg.dbPath));

let zwatch: Zwatch;
if (cfg.dryRun) zwatch = new DryRunZwatch(repo);
else if (cfg.zwatchUrl) zwatch = httpZwatch(cfg.zwatchUrl, cfg.zwatchToken);
else {
  console.warn('ZWATCH_URL is not set: escrows cannot be watched. Set it, or run with DESK_DRY_RUN=1.');
  const missing = async (): Promise<never> => {
    throw new Error('ZWATCH_URL is not set');
  };
  zwatch = { createAccount: missing, received: missing, balance: missing, health: async () => ({ ok: false }) };
}

const backend = cfg.dryRun ? new DryRunBackend() : new RealBackend(cfg, zwatch);
let worker: Worker;
const desk = new Desk(repo, cfg, zwatch, Date.now, Math.random, {
  onChange: () => worker?.poke(),
  onPurge: (ids) => ids.forEach((id) => backend.cleanup(id).catch((e) => console.error(`[cleanup] ${id}: ${e}`))),
});
worker = new Worker(desk, backend);
worker.start(cfg.dryRun ? 1000 : 2000);

// The ticker: timeouts, funding checks, purges. Every 30 s (3 s in dry run, so the click-through is quick).
let ticking = false;
const tickMs = Number(process.env.TICK_MS ?? (cfg.dryRun ? 3000 : 30_000));
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await desk.tick();
  } catch (e) {
    console.error('[ticker]', e);
  } finally {
    ticking = false;
  }
}, tickMs);

const app = createApp(desk, cfg);
serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  console.log(`Shadow Desk listening on http://${info.address}:${info.port} (${cfg.dryRun ? 'DRY RUN' : `${cfg.network}net`})`);
  for (const line of banner) console.log(line);
});
