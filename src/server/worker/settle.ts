// A release or refund, end to end (build guide §12): create → sign (FROST) ∥ prove → combine → send.
// Every intermediate PCZT is kept on disk, so a crash resumes where it stopped instead of signing a new transaction.

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionInfo, Signer } from '../../core/api';
import { FEE_ZAT } from '../../core/money';
import { paysBuyer, signersFor, type SettleKind } from '../../core/state';
import type { Config } from '../config';
import type { TradeRow } from '../repo';
import { frostSign, type FrostEnv } from './frost';
import { parseInspect, parseSendTxid } from './parse';
import { arbiterConfigPath, escrowWalletDir, settleDir } from './paths';
import { run, runText } from './run';
import { startZcashSign } from './zcashSign';

const exists = (p: string) => access(p).then(() => true, () => false);

export class CapError extends Error {}

/** The value a settlement pays, and the cap from §12: never more than amount + fee leaves the escrow. */
export function settlementValue(kind: SettleKind, spendableZat: bigint, amountZat: bigint): bigint {
  const available = spendableZat - FEE_ZAT;
  if (available <= 0n) throw new Error('escrow balance too low to pay the fee');
  // A release pays the buyer exactly what they bought; anything above that stays for the seller.
  const value = paysBuyer(kind) ? (available < amountZat ? available : amountZat) : available;
  if (value > amountZat + FEE_ZAT) throw new CapError(`refusing to sign ${value} zat: more than amount + fee (${amountZat + FEE_ZAT})`);
  return value;
}

export type SettleDeps = {
  cfg: Config;
  balance: (t: TradeRow) => Promise<bigint>;
  publish: (s: Extract<SessionInfo, { type: 'sign' }>) => void;
  log: (type: string, detail: string) => void;
  signal?: AbortSignal;
  now?: () => number;
};

async function writeAtomic(path: string, data: Buffer | string) {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

export async function settle(t: TradeRow, kind: SettleKind, d: SettleDeps): Promise<string> {
  const { cfg } = d;
  const now = d.now ?? Date.now;
  const devtool = cfg.bins.zcashDevtool;
  const lwd = ['-s', cfg.lightwalletd, '--connection', cfg.connection];
  const dir = settleDir(cfg, t.id, kind);
  await mkdir(dir, { recursive: true });
  const f = (n: string) => join(dir, n);

  if (await exists(f('x.txid'))) return (await readFile(f('x.txid'), 'utf8')).trim();
  if (!t.ufvk || !t.group_pubkey || !t.buyer_pub || !t.seller_pub || !t.arbiter_pub) throw new Error('trade is missing escrow data');

  const signerRoles = signersFor(kind) as Signer[];
  const pubOf = { buyer: t.buyer_pub, seller: t.seller_pub, arbiter: t.arbiter_pub };
  const signers = signerRoles.map((r) => pubOf[r as keyof typeof pubOf]) as [string, string];
  const to = paysBuyer(kind) ? t.buyer_receive_ua : t.seller_refund_ua;
  if (!to) throw new Error('no destination address');
  const session: Extract<SessionInfo, { type: 'sign' }> = { type: 'sign', kind, signers: signerRoles, status: 'preparing', to, at: now() };
  const publish = (patch: Partial<typeof session>) => {
    Object.assign(session, patch, { at: now() });
    d.publish({ ...session });
  };
  publish({});

  // 0. The worker's own view-only wallet for this escrow (separate from zwatch's).
  const wallet = escrowWalletDir(cfg, t.id);
  if (!(await exists(wallet))) {
    const birthday = t.birthday ? ['--birthday', String(t.birthday)] : [];
    await runText(devtool, ['wallet', '-w', wallet, 'init-fvk', '--name', `escrow-${t.id}`, '--fvk', t.ufvk, ...birthday, ...lwd], { timeoutMs: 120_000, signal: d.signal });
    d.log('worker', 'escrow wallet initialised');
  }

  // 1. Create the PCZT (once), and check it pays what we expect before anyone signs it.
  if (!(await exists(f('x.created')))) {
    await runText(devtool, ['wallet', '-w', wallet, 'sync', ...lwd], { timeoutMs: 600_000, signal: d.signal });
    const value = settlementValue(kind, await d.balance(t), BigInt(t.amount_zat));
    await run(devtool, ['pczt', '-w', wallet, 'create', '--address', to, '--value', String(value), '--memo', `Shadow Desk ${t.id}`, '--output', f('x.created.tmp')], { timeoutMs: 300_000, signal: d.signal });
    await rename(f('x.created.tmp'), f('x.created'));
    await writeFile(f('x.meta.json'), JSON.stringify({ to, value: String(value) }));
    d.log('worker', `created ${kind} PCZT for ${value} zat`);
  }
  const meta = JSON.parse(await readFile(f('x.meta.json'), 'utf8')) as { to: string; value: string };
  const inspect = await runText(devtool, ['pczt', 'inspect', f('x.created')], { timeoutMs: 120_000, signal: d.signal });
  const payment = parseInspect(inspect).outputs.filter((o) => o.valueZat === BigInt(meta.value));
  if (!payment.length || payment.some((o) => o.address !== null && o.address !== meta.to)) {
    throw new Error('the created PCZT does not pay the expected address and amount');
  }
  if (BigInt(meta.value) > BigInt(t.amount_zat) + FEE_ZAT) throw new CapError('created PCZT exceeds amount + fee');
  publish({ inspect: inspect.trim(), valueZat: meta.value });

  // 2. Prove in parallel with signing; both start from the created PCZT.
  const proving = (async () => {
    if (await exists(f('x.proven'))) return;
    await run(devtool, ['pczt', '-w', wallet, 'prove', f('x.created'), '--output', f('x.proven.tmp')], { timeoutMs: 900_000, signal: d.signal });
    await rename(f('x.proven.tmp'), f('x.proven'));
    d.log('worker', 'proved');
  })();
  proving.catch(() => {}); // awaited below

  // 3. FROST-sign each spend.
  if (!(await exists(f('x.signed')))) {
    const env: FrostEnv = { bin: cfg.bins.frostClient, serverUrl: cfg.frostdUrl };
    const zs = startZcashSign(cfg.bins.zcashSign, cfg.network, f('x.created'), f('x.signed.tmp'), d.signal);
    try {
      for (let prompt = await zs.next(); prompt; prompt = await zs.next()) {
        publish({ status: 'preparing', sighash: prompt.sighash, randomizer: prompt.randomizer, spend: prompt.index });
        const sig = await frostSign(env, {
          configPath: arbiterConfigPath(cfg, t.id),
          group: t.group_pubkey,
          signers,
          sighash: prompt.sighash,
          randomizer: prompt.randomizer,
          workDir: dir,
          arbiterSigns: signerRoles.includes('arbiter'),
          onOpen: () => publish({ status: 'open' }),
          timeoutMs: 30 * 60_000,
          signal: d.signal,
        });
        d.log('worker', `spend #${prompt.index} signed`);
        zs.provide(sig);
      }
    } catch (e) {
      zs.kill();
      throw e;
    }
    await rename(f('x.signed.tmp'), f('x.signed'));
  }
  publish({ status: 'finishing' });
  await proving;

  // 4. Combine and broadcast. The txid is known before sending, so a crash after broadcast is recoverable.
  if (!(await exists(f('x.combined')))) {
    await run(devtool, ['pczt', 'combine', '-i', f('x.signed'), '-i', f('x.proven'), '-o', f('x.combined.tmp')], { timeoutMs: 120_000, signal: d.signal });
    await rename(f('x.combined.tmp'), f('x.combined'));
  }
  const expected = parseInspect(await runText(devtool, ['pczt', 'inspect', f('x.combined')], { timeoutMs: 120_000 })).txid;
  const resent = await exists(f('x.sending'));
  await writeAtomic(f('x.sending'), expected ?? '');
  let txid: string;
  try {
    txid = parseSendTxid(await runText(devtool, ['pczt', '-w', wallet, 'send', ...lwd, f('x.combined')], { timeoutMs: 300_000, signal: d.signal }));
  } catch (e) {
    // A previous attempt may have broadcast it already.
    if (resent && expected && /already|duplicate|exists/i.test((e as Error).message)) txid = expected;
    else throw e;
  }
  await writeAtomic(f('x.txid'), txid);
  d.log('worker', `broadcast ${txid}`);
  return txid;
}
