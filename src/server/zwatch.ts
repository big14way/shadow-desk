// Client for zwatch, the view-only watcher built for Ghostpass (GHOSTPASS.md §7). Shadow Desk uses it unchanged:
// one account per escrow (build guide §8). The JSON shapes it accepts are documented in docs/ZWATCH.md.

import { FEE_ZAT } from '../core/money';

export type ReceivedOutput = { txid: string; valueZat: bigint; confirmations: number };

export interface Zwatch {
  createAccount(a: { name: string; ufvk: string; birthday?: number }): Promise<{ id: string; birthday?: number }>;
  received(accountId: string): Promise<ReceivedOutput[]>;
  /** Confirmed, spendable balance. */
  balance(accountId: string): Promise<bigint>;
  health(): Promise<{ ok: boolean; tip?: number }>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);
const zat = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`zwatch: bad zatoshi value ${JSON.stringify(v)}`);
};

/** Accepts camelCase or snake_case field names, and either a bare array or `{outputs: [...]}`. */
export function normalizeReceived(body: unknown): ReceivedOutput[] {
  const list = Array.isArray(body) ? body : (body as { outputs?: unknown[]; received?: unknown[] })?.outputs ?? (body as { received?: unknown[] })?.received;
  if (!Array.isArray(list)) throw new Error('zwatch: unexpected /received response');
  return list.map((o) => {
    const r = o as Record<string, unknown>;
    return {
      txid: String(r.txid ?? r.tx_id ?? ''),
      valueZat: zat(r.valueZat ?? r.value_zat ?? r.value),
      confirmations: num(r.confirmations ?? r.confs) ?? 0,
    };
  });
}

export function normalizeBalance(body: unknown): bigint {
  const r = body as Record<string, unknown>;
  return zat(r.spendableZat ?? r.spendable_zat ?? r.spendable ?? r.confirmedZat ?? r.confirmed_zat);
}

export function httpZwatch(baseUrl: string, token?: string, fetchImpl: typeof fetch = fetch): Zwatch {
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`zwatch ${init?.method ?? 'GET'} ${path}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  return {
    async createAccount(a) {
      const r = (await call('/accounts', { method: 'POST', body: JSON.stringify(a) })) as Record<string, unknown>;
      const id = r.id ?? r.accountId ?? r.account_id;
      if (id === undefined) throw new Error('zwatch: no account id in response');
      return { id: String(id), birthday: num(r.birthday) };
    },
    received: async (id) => normalizeReceived(await call(`/accounts/${encodeURIComponent(id)}/received`)),
    balance: async (id) => normalizeBalance(await call(`/accounts/${encodeURIComponent(id)}/balance`)),
    async health() {
      const r = (await call('/health')) as Record<string, unknown>;
      return { ok: r.ok !== false, tip: num(r.tip ?? r.tipHeight ?? r.tip_height ?? r.height) };
    },
  };
}

export const MIN_CONFIRMATIONS = 2;

export type Funding =
  | { status: 'none' }
  | { status: 'pending'; seenZat: bigint; confirmations: number }
  | { status: 'funded'; seenZat: bigint; confirmations: number }
  | { status: 'underfunded'; seenZat: bigint; confirmations: number }
  | { status: 'multi_note'; seenZat: bigint; notes: number };

/**
 * Build guide §8: funded means one output of ≥ amount + fee with ≥ 2 confirmations. More than one output needs a
 * human (a release could need one signature per note). A single confirmed output that is too small is refunded.
 */
export function fundingStatus(outputs: ReceivedOutput[], amountZat: bigint): Funding {
  if (!outputs.length) return { status: 'none' };
  const seenZat = outputs.reduce((s, o) => s + o.valueZat, 0n);
  if (outputs.length > 1) return { status: 'multi_note', seenZat, notes: outputs.length };
  const { confirmations } = outputs[0];
  if (confirmations < MIN_CONFIRMATIONS) return { status: 'pending', seenZat, confirmations };
  return seenZat >= amountZat + FEE_ZAT ? { status: 'funded', seenZat, confirmations } : { status: 'underfunded', seenZat, confirmations };
}
