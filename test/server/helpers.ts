import { createApp } from '../../src/server/app';
import { loadConfig, type Config } from '../../src/server/config';
import { openDb } from '../../src/server/db';
import { Desk } from '../../src/server/desk';
import { Repo } from '../../src/server/repo';
import { hashToken } from '../../src/server/tokens';
import type { ReceivedOutput, Zwatch } from '../../src/server/zwatch';

export const ARBITER_TOKEN = 'arbiter-test-token';

export class FakeZwatch implements Zwatch {
  accounts = new Map<string, { name: string; ufvk: string; birthday?: number }>();
  outputs = new Map<string, ReceivedOutput[]>();
  tip = 3_500_000;
  fail = false;
  async createAccount(a: { name: string; ufvk: string; birthday?: number }) {
    if (this.fail) throw new Error('zwatch down');
    const id = `acct-${this.accounts.size + 1}`;
    this.accounts.set(id, a);
    return { id, birthday: a.birthday };
  }
  async received(id: string) {
    if (this.fail) throw new Error('zwatch down');
    return this.outputs.get(id) ?? [];
  }
  async balance(id: string) {
    return (this.outputs.get(id) ?? []).reduce((s, o) => s + o.valueZat, 0n);
  }
  async health() {
    return { ok: true, tip: this.tip };
  }
  pay(id: string, valueZat: bigint, confirmations = 2) {
    this.outputs.set(id, [...(this.outputs.get(id) ?? []), { txid: `tx${Math.random()}`, valueZat, confirmations }]);
  }
}

export function setup(env: Record<string, string> = {}, opts: { zwatch?: (repo: Repo, now: () => number) => Zwatch } = {}) {
  const clock = { t: Date.UTC(2026, 9, 6, 12) };
  const cfg: Config = loadConfig({
    NODE_ENV: 'test',
    DB_PATH: ':memory:',
    ARBITER_TOKEN_HASH: hashToken(ARBITER_TOKEN),
    ARBITER_BOX_PUBKEY: 'test-box-pubkey',
    TAPE_MAX_DELAY_MS: '3600000',
    ...env,
  } as NodeJS.ProcessEnv);
  const repo = new Repo(openDb(':memory:'));
  const fake = new FakeZwatch();
  const zwatch = fake;
  const watcher = opts.zwatch ? opts.zwatch(repo, () => clock.t) : fake;
  const purged: string[] = [];
  const hooks: { onPurge: (ids: string[]) => void; onChange?: () => void } = { onPurge: (ids) => purged.push(...ids) };
  const desk = new Desk(repo, cfg, watcher, () => clock.t, () => 0.5, hooks);
  const app = createApp(desk, cfg);

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };

  return { cfg, repo, desk, zwatch, app, clock, call, purged, hooks };
}
