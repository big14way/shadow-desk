// FROST spike, part 2 (docs/SPIKE.md): real Mainnet escrows, signed and broadcast by the desk's own worker code.
//
// Each escrow lives in ~/sd/<T> (made by scripts/spike-local.sh: three frost-client configs, a 2-of-3 DKG and the
// Orchard-only escrow address) and has a watch-only wallet in ~/sd/wallets/escrow-<T>. This script then runs the same
// settle() the desk runs for a trade: create the PCZT, check it, FROST-sign each spend, prove, combine, broadcast.
// The arbiter's side runs inside settle(); the buyer and seller participants run here, and each one signs only after
// checking that the session message is the SIGHASH zcash-sign computed.
//
//   pnpm spike:mainnet fund                         # both escrow addresses, funding links and QR codes
//   pnpm spike:mainnet status T1                    # sync the escrow wallet and show its balance
//   pnpm spike:mainnet settle T1 --to <u1…>         # buyer + seller release the whole escrow to <u1…>
//   pnpm spike:mainnet settle T2 --to <u1…> --kind dispute-release   # arbiter + buyer
//
// Options: --kind release | dispute-release | refund | dispute-refund (default release)
//          --frostd host:port (default: a local frostd with TLS, started from the escrow's directory)
//          --root dir (default ~/sd)

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { FEE_ZAT, MAX_TRADE_ZAT, zatToZec } from '../src/core/money';
import { signersFor, type SettleKind } from '../src/core/state';
import { checkEscrowAddress, checkShieldedAddress } from '../src/core/unified';
import { buildZip321 } from '../src/core/zip321';
import type { Config } from '../src/server/config';
import type { TradeRow } from '../src/server/repo';
import { parseParticipantMessage } from '../src/server/worker/parse';
import { runText, spawnLines } from '../src/server/worker/run';
import { settle } from '../src/server/worker/settle';

const FUND_ZAT = 100_000n + FEE_ZAT; // 0.001 ZEC to the buyer plus the release fee
const KINDS: SettleKind[] = ['release', 'dispute-release', 'refund', 'dispute-refund'];

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [command, label] = positional;
const root = opt('root') ?? join(homedir(), 'sd');
const devtool = process.env.ZCASH_DEVTOOL_BIN ?? 'zcash-devtool';
const lwd = ['-s', process.env.LIGHTWALLETD ?? 'zecrocks'];

const die = (msg: string): never => {
  console.error(`\n${msg}`);
  process.exit(1);
};
const exists = (p: string) => access(p).then(() => true, () => false);

type Escrow = { label: string; dir: string; wallet: string; group: string; address: string; ufvk: string; pubs: Record<'buyer' | 'seller' | 'arbiter', string> };

async function loadEscrow(t: string): Promise<Escrow> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(t)) die(`bad escrow label: ${t}`);
  const dir = join(root, t);
  if (!(await exists(join(dir, 'out', 'escrow.txt')))) die(`${dir} has no escrow. Make one with: scripts/spike-local.sh ${dir}`);
  const [group, address, ufvk] = (await readFile(join(dir, 'out', 'escrow.txt'), 'utf8')).trim().split('\n');
  const pub = async (r: string) => {
    const m = (await readFile(join(dir, 'out', `export-${r}.txt`), 'utf8')).match(/^Public Key: ([0-9a-f]{64})\s*$/m);
    return m?.[1] ?? die(`no public key in out/export-${r}.txt`);
  };
  const check = checkEscrowAddress(address);
  if (!check.ok) die(`${t}: ${check.reason}`);
  return { label: t, dir, wallet: join(root, 'wallets', `escrow-${t}`), group, address, ufvk, pubs: { buyer: await pub('buyer'), seller: await pub('seller'), arbiter: await pub('arbiter') } };
}

async function ensureWallet(e: Escrow) {
  if (await exists(e.wallet)) return;
  await mkdir(join(root, 'wallets'), { recursive: true, mode: 0o700 });
  // Birthday: the current tip (zcash-devtool's default). Fund the escrow only after this has run.
  await runText(devtool, ['wallet', '-w', e.wallet, 'init-fvk', '--name', `escrow-${e.label}`, '--fvk', e.ufvk, ...lwd], { timeoutMs: 120_000 });
}

type Balance = { total: bigint; spendable: bigint; height: number };

async function syncAndBalance(e: Escrow): Promise<Balance> {
  await ensureWallet(e);
  await runText(devtool, ['wallet', '-w', e.wallet, 'sync', ...lwd], { timeoutMs: 600_000 });
  const text = await runText(devtool, ['wallet', '-w', e.wallet, 'balance'], { timeoutMs: 60_000 });
  const zec = (re: RegExp) => {
    const m = text.match(re);
    if (!m) die(`could not read the wallet balance:\n${text.slice(-1200)}`);
    const [whole, frac] = m![1].split('.');
    return BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0'));
  };
  return {
    total: zec(/^\s*Balance:\s+([0-9.]+) ZEC/m),
    // FROST controls only the Orchard-protocol spend key; Ironwood and Orchard notes both use it.
    spendable: zec(/^\s*Ironwood Spendable:\s+([0-9.]+) ZEC/m) + zec(/^\s*Orchard Spendable:\s+([0-9.]+) ZEC/m),
    height: Number(text.match(/^\s*Height:\s+(\d+)/m)?.[1] ?? 0),
  };
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

async function startLocalFrostd(e: Escrow): Promise<ChildProcess | null> {
  if (await portOpen(2744)) {
    console.log('frostd is already listening on 127.0.0.1:2744; using it (it must use this escrow\'s certificate).');
    return null;
  }
  const p = spawn('frostd', ['--ip', '127.0.0.1', '--port', '2744', '--tls-cert', join(e.dir, 'server.pem'), '--tls-key', join(e.dir, 'server-key.pem')], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await portOpen(2744)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await portOpen(2744))) die('frostd did not start on 127.0.0.1:2744');
  return p;
}

async function fund() {
  for (const t of positional.slice(1).length ? positional.slice(1) : ['T1', 'T2']) {
    const e = await loadEscrow(t);
    await ensureWallet(e);
    const uri = buildZip321(e.address, FUND_ZAT);
    console.log(`\n== ${t}: send exactly ${zatToZec(FUND_ZAT)} ZEC, in one transaction, to\n${e.address}\n\n${uri}\n`);
    console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  }
}

async function status(e: Escrow) {
  const b = await syncAndBalance(e);
  console.log(`${e.label}  height ${b.height}  balance ${zatToZec(b.total)} ZEC  spendable ${zatToZec(b.spendable)} ZEC`);
  if (b.total > b.spendable) console.log('  (funds seen but not yet spendable: wait for more confirmations)');
  return b;
}

async function settleEscrow(e: Escrow) {
  const kind = (opt('kind') ?? 'release') as SettleKind;
  if (!KINDS.includes(kind)) die(`--kind must be one of ${KINDS.join(', ')}`);
  const to = opt('to') ?? die('--to <u1…> is required: the Unified Address that receives the escrow');
  const toCheck = checkShieldedAddress(to);
  if (!toCheck.ok) die(`--to: ${toCheck.reason}`);

  const b = await status(e);
  if (b.spendable < FEE_ZAT * 2n) die('nothing spendable in the escrow yet');
  if (b.spendable > MAX_TRADE_ZAT + FEE_ZAT) die(`the escrow holds more than the ${zatToZec(MAX_TRADE_ZAT)} ZEC cap; refusing`);
  const amount = b.spendable - FEE_ZAT;

  // Point the worker's paths at the spike's files: data/frost/trade-<T>.toml is the escrow's arbiter.toml.
  const desk = join(e.dir, 'desk');
  const frostDir = join(desk, 'frost');
  await mkdir(frostDir, { recursive: true, mode: 0o700 });
  const arbiterLink = join(frostDir, `trade-${e.label}.toml`);
  if (!(await exists(arbiterLink))) await symlink(join(e.dir, 'arbiter.toml'), arbiterLink);

  const frostdUrl = opt('frostd') ?? 'localhost:2744';
  const frostd = opt('frostd') ? null : await startLocalFrostd(e);
  if (!opt('frostd')) process.env.SSL_CERT_FILE = join(e.dir, 'ca.pem');

  const cfg = {
    network: 'main',
    frostdUrl,
    frostDir,
    workDir: join(desk, 'work'),
    walletsDir: join(root, 'wallets'),
    lightwalletd: lwd[1],
    connection: process.env.ZCASH_CONNECTION ?? 'direct',
    bins: { frostClient: 'frost-client', zcashSign: 'zcash-sign', zcashDevtool: devtool },
  } as Config;
  const trade = {
    id: e.label,
    amount_zat: Number(amount),
    funding_zat: Number(b.spendable),
    ufvk: e.ufvk,
    group_pubkey: e.group,
    buyer_pub: e.pubs.buyer,
    seller_pub: e.pubs.seller,
    arbiter_pub: e.pubs.arbiter,
    buyer_receive_ua: to,
    seller_refund_ua: to,
    birthday: null,
  } as TradeRow;

  // The buyer's and seller's side: join each signing session the worker opens, sign only the expected SIGHASH.
  const external = signersFor(kind).filter((r) => r !== 'arbiter') as ('buyer' | 'seller')[];
  const running: Promise<void>[] = [];
  const abort = new AbortController();
  let refusal: Error | undefined;
  let lastOpened: string | undefined;
  let shownInspect = false;
  const participant = (role: 'buyer' | 'seller', sighash: string) =>
    new Promise<void>((resolve, reject) => {
      let answered = false;
      const p = spawnLines('frost-client', ['participant', '-c', join(e.dir, `${role}.toml`), '--server-url', frostdUrl, '--group', e.group], (line, proc) => {
        if (answered || !/Do you want to sign it\?/.test(line)) return;
        answered = true;
        const shown = parseParticipantMessage(p.output());
        if (shown === sighash) proc.stdin.write('y\n');
        else (proc.stdin.end('n\n'), reject(new Error(`${role} refused: message ${shown} is not the SIGHASH ${sighash}`)));
      });
      p.exited.then(({ code, text }) => (code === 0 ? resolve() : reject(new Error(`${role} participant exited ${code}: ${text.slice(-800)}`))), reject);
    });

  console.log(`\n${kind}: ${zatToZec(amount)} ZEC to ${to}\nsigners: ${signersFor(kind).join(' + ')}  ·  frostd ${frostdUrl}\n`);
  try {
    const txid = await settle(trade, kind, {
      cfg,
      balance: async () => (await syncAndBalance(e)).spendable,
      log: (_type, detail) => console.log(`  worker: ${detail}`),
      signal: abort.signal,
      publish: (s) => {
        if (s.inspect && !shownInspect) {
          shownInspect = true;
          console.log(`  PCZT checked:\n${s.inspect.replace(/^/gm, '    ')}`);
        }
        if (s.status === 'open' && s.sighash && lastOpened !== `${s.spend}:${s.sighash}`) {
          lastOpened = `${s.spend}:${s.sighash}`;
          console.log(`  signing spend #${s.spend}: SIGHASH ${s.sighash}`);
          for (const role of external) {
            running.push(participant(role, s.sighash!).catch((err: Error) => {
              refusal ??= err;
              console.error(`  ${err.message}`);
              abort.abort();
            }));
          }
        }
        if (s.status === 'finishing') console.log('  signed; combining and broadcasting');
      },
    });
    await Promise.all(running);
    if (refusal) throw refusal;
    await writeFile(join(e.dir, 'out', `txid-${kind}.txt`), `${txid}\n`);
    console.log(`\nBroadcast. txid ${txid}\nSaved to ${join(e.dir, 'out', `txid-${kind}.txt`)}`);
  } catch (err) {
    die(`Stopped: ${(refusal ?? (err as Error)).message}\nEverything done so far is kept in ${join(desk, 'work', e.label)}; run the same command again to resume.`);
  } finally {
    frostd?.kill();
  }
}

if (command === 'fund') await fund();
else if (command === 'status' && label) await status(await loadEscrow(label));
else if (command === 'settle' && label) await settleEscrow(await loadEscrow(label));
else die('usage: pnpm spike:mainnet fund [T…] | status <T> | settle <T> --to <u1…> [--kind release|dispute-release|refund|dispute-refund] [--frostd host:port]');
