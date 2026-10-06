import { resolve } from 'node:path';
import type { Network } from '../core/unified';

export type Config = {
  host: string;
  port: number;
  production: boolean;
  /** DESK_DRY_RUN=1: zwatch and the signing worker are mocks; no funds, no signatures. */
  dryRun: boolean;
  network: Network;
  dbPath: string;
  /** Where the built web UI lives; served by the API process when present. */
  webDir: string;
  /** host:port of frostd, exactly as frost-client's --server-url / -s expects it. */
  frostdUrl: string;
  /** Per-trade arbiter frost-client configs (they hold key shares: chmod 700). */
  frostDir: string;
  workDir: string;
  walletsDir: string;
  /** Light wallet server for zcash-devtool (-s): 'zecrocks' or a URL. */
  lightwalletd: string;
  /** zcash-devtool --connection: 'direct' or 'tor'. */
  connection: string;
  zwatchUrl?: string;
  zwatchToken?: string;
  /** SHA-256 of the arbiter console token; the token itself is never stored. */
  arbiterTokenHash?: string;
  /** libsodium crypto_box public key (base64url) that dispute evidence is sealed to. */
  arbiterBoxPubkey?: string;
  /** Upper bound of the random delay before a tape row is published. */
  tapeMaxDelayMs: number;
  bins: { frostClient: string; zcashSign: string; zcashDevtool: string };
};

const truthy = (v?: string) => v === '1' || v === 'true' || v === 'yes';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const dryRun = truthy(env.DESK_DRY_RUN);
  if (dryRun && production) {
    throw new Error('Refusing to start: DESK_DRY_RUN=1 is not allowed with NODE_ENV=production.');
  }
  const network = (env.ZCASH_NETWORK ?? 'main') as Network;
  if (network !== 'main' && network !== 'test') throw new Error('ZCASH_NETWORK must be main or test');

  const dataDir = resolve(env.DATA_DIR ?? 'data');
  const cfg: Config = {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8787),
    production,
    dryRun,
    network,
    dbPath: env.DB_PATH ?? resolve(dataDir, dryRun ? 'desk-dryrun.sqlite' : 'desk.sqlite'),
    webDir: resolve(env.WEB_DIR ?? 'dist/web'),
    frostdUrl: env.FROSTD_URL ?? 'localhost:2744',
    frostDir: resolve(env.FROST_DIR ?? resolve(dataDir, 'frost')),
    workDir: resolve(env.WORK_DIR ?? resolve(dataDir, 'work')),
    walletsDir: resolve(env.WALLETS_DIR ?? resolve(dataDir, 'wallets')),
    lightwalletd: env.LIGHTWALLETD ?? 'zecrocks',
    connection: env.ZCASH_CONNECTION ?? 'direct',
    zwatchUrl: env.ZWATCH_URL,
    zwatchToken: env.ZWATCH_TOKEN,
    arbiterTokenHash: env.ARBITER_TOKEN_HASH,
    arbiterBoxPubkey: env.ARBITER_BOX_PUBKEY,
    tapeMaxDelayMs: Number(env.TAPE_MAX_DELAY_MS ?? (dryRun ? 60_000 : 3_600_000)),
    bins: {
      frostClient: env.FROST_CLIENT_BIN ?? 'frost-client',
      zcashSign: env.ZCASH_SIGN_BIN ?? 'zcash-sign',
      zcashDevtool: env.ZCASH_DEVTOOL_BIN ?? 'zcash-devtool',
    },
  };
  if (!dryRun && production) {
    const missing = (['zwatchUrl', 'arbiterTokenHash', 'arbiterBoxPubkey'] as const).filter((k) => !cfg[k]);
    if (missing.length) throw new Error(`Missing configuration for a real desk: ${missing.join(', ')}`);
  }
  return cfg;
}
