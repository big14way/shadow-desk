import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

// Build guide §9, plus what the implementation needs. No bank details and no IP addresses, ever.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE offers (
    id               TEXT PRIMARY KEY,          -- 128-bit random, base32
    min_zat          INTEGER NOT NULL,
    max_zat          INTEGER NOT NULL,          -- capped at 1,000,000 (0.01 ZEC) during the hackathon
    remaining_zat    INTEGER NOT NULL,          -- what is left of the range to take
    price_minor      INTEGER NOT NULL,          -- price of 1 ZEC in the currency's minor unit
    currency         TEXT    NOT NULL,
    method           TEXT    NOT NULL,
    pay_window_min   INTEGER NOT NULL DEFAULT 30,
    maker_token_hash TEXT    NOT NULL,          -- SHA-256 of the seller's capability token
    status           TEXT    NOT NULL DEFAULT 'OPEN',   -- OPEN | FILLED | CLOSED
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE trades (
    id                TEXT PRIMARY KEY,
    offer_id          TEXT    NOT NULL REFERENCES offers(id),
    amount_zat        INTEGER NOT NULL,
    price_minor       INTEGER NOT NULL,
    currency          TEXT    NOT NULL,
    method            TEXT    NOT NULL,
    pay_window_min    INTEGER NOT NULL,
    buyer_token_hash  TEXT    NOT NULL,
    seller_token_hash TEXT,                     -- set when the seller claims the trade from the offer link
    arbiter_contact   TEXT,                     -- per-trade arbiter frost-client identity
    arbiter_pub       TEXT,
    buyer_contact     TEXT,                     -- frost-client contact strings (public keys only)
    seller_contact    TEXT,
    buyer_pub         TEXT,
    seller_pub        TEXT,
    buyer_ready       INTEGER NOT NULL DEFAULT 0,
    seller_ready      INTEGER NOT NULL DEFAULT 0,
    group_pubkey      TEXT,
    ufvk              TEXT,
    escrow_address    TEXT,
    seller_refund_ua  TEXT,
    buyer_receive_ua  TEXT,
    zwatch_account_id TEXT,
    birthday          INTEGER,
    funding_zat       INTEGER,                  -- last value seen by zwatch
    funding_conf      INTEGER,
    funding_notes     INTEGER,
    state             TEXT    NOT NULL,
    state_deadline    INTEGER,
    settle_kind       TEXT,                     -- release | refund | dispute-release | dispute-refund
    session           TEXT,                     -- JSON: the current DKG or signing session, for the trade room
    worker_lease      INTEGER,                  -- single-flight lock for the worker (ms timestamp)
    last_error        TEXT,
    dispute_by        TEXT,
    release_txid      TEXT,
    refund_txid       TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    ended_at          INTEGER
  );
  CREATE INDEX trades_state ON trades(state);
  CREATE INDEX trades_offer ON trades(offer_id);

  CREATE TABLE evidence (                       -- sealed to the arbiter's key in the browser
    trade_id   TEXT    NOT NULL,
    role       TEXT    NOT NULL,
    sealed     BLOB    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX evidence_trade ON evidence(trade_id);

  CREATE TABLE tape (
    id          INTEGER PRIMARY KEY,
    publish_at  INTEGER NOT NULL,               -- ms; rows are hidden until this time
    hour_bucket INTEGER NOT NULL,               -- unix seconds, floored to the hour
    currency    TEXT    NOT NULL,
    price_minor INTEGER NOT NULL,
    size_bucket TEXT    NOT NULL                -- '<0.1', '0.1-1', '>1' ZEC
  );
  CREATE INDEX tape_publish ON tape(publish_at);

  CREATE TABLE events (                         -- debugging log; purged with the trade
    trade_id TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    type     TEXT NOT NULL,
    detail   TEXT
  );
  CREATE INDEX events_trade ON events(trade_id, ts);
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const { user_version: v } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
