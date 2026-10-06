// frost-client from the arbiter's side. Each trade gets its own arbiter config (data/frost/trade-<id>.toml): a fresh
// identity per trade, no shared file that two DKGs could both rewrite, and never more than one session per identity.

import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseContacts, parseExport, parseGroups, parseParticipantMessage } from './parse';
import { runText, spawnLines } from './run';

export type FrostEnv = { bin: string; serverUrl: string };

const exists = (p: string) => access(p).then(() => true, () => false);

/** Creates (once) and exports the arbiter identity for a trade. */
export async function arbiterIdentity(env: FrostEnv, configPath: string, name: string) {
  if (!(await exists(configPath))) await runText(env.bin, ['init', '-c', configPath], { timeoutMs: 30_000 });
  return parseExport(await runText(env.bin, ['export', '--name', name, '-c', configPath], { timeoutMs: 30_000 }));
}

/** Imports a contact unless an identical one is there; replaces a stale one with the same name. */
export async function ensureContact(env: FrostEnv, configPath: string, contact: string, name: string, pubkey: string) {
  const existing = parseContacts(await runText(env.bin, ['contacts', '-c', configPath], { timeoutMs: 30_000 }));
  const same = existing.find((c) => c.name === name);
  if (same?.pubkey === pubkey) return;
  if (same) await runText(env.bin, ['remove-contact', '-c', configPath, '-p', same.pubkey], { timeoutMs: 30_000 });
  await runText(env.bin, ['import', contact, '-c', configPath], { timeoutMs: 30_000 });
}

export async function groupKeys(env: FrostEnv, configPath: string) {
  return parseGroups(await runText(env.bin, ['groups', '-c', configPath], { timeoutMs: 30_000 }));
}

/**
 * Runs the arbiter's side of a 2-of-3 RedPallas DKG. The arbiter creates the session; `onOpen` fires once it exists,
 * which is when the buyer and seller must run their own `frost-client dkg`. Returns the new group's public key.
 */
export async function runDkg(env: FrostEnv, o: {
  configPath: string;
  description: string;
  participants: [string, string];
  onOpen: () => void;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const before = new Set((await groupKeys(env, o.configPath)).map((g) => g.pubkey));
  let opened = false;
  const proc = spawnLines(env.bin, ['dkg', '-d', o.description, '-s', env.serverUrl, '-S', o.participants.join(','), '-t', '2', '-C', 'redpallas', '-c', o.configPath], (line) => {
    if (!opened && /Getting session info|Waiting for other participants/.test(line)) {
      opened = true;
      o.onOpen();
    }
  }, o.signal);
  const timer = setTimeout(() => proc.p.kill('SIGKILL'), o.timeoutMs);
  const { code, text } = await proc.exited.finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`frost-client dkg exited ${code}: ${text.slice(-1500)}`);
  const created = (await groupKeys(env, o.configPath)).filter((g) => g.description === o.description && !before.has(g.pubkey));
  if (created.length !== 1) throw new Error('DKG finished but no new group was found');
  if (created[0].threshold !== undefined && created[0].threshold !== 2) throw new Error('unexpected threshold');
  return created[0].pubkey;
}

/**
 * One FROST signing session: the arbiter coordinates; if the arbiter is also a signer, it joins as a participant and
 * signs only after checking that the message it is shown is the SIGHASH zcash-sign computed.
 * Returns the 64-byte signature as hex (frost-client writes it raw with -o).
 */
export async function frostSign(env: FrostEnv, o: {
  configPath: string;
  group: string;
  signers: [string, string];
  sighash: string;
  randomizer: string;
  workDir: string;
  arbiterSigns: boolean;
  onOpen: () => void;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const m = join(o.workDir, 'sighash.bin');
  const r = join(o.workDir, 'randomizer.bin');
  const sigPath = join(o.workDir, 'sig.bin');
  await writeFile(m, Buffer.from(o.sighash, 'hex'));
  await writeFile(r, Buffer.from(o.randomizer, 'hex'));
  await rm(sigPath, { force: true });

  const abort = new AbortController(); // the coordinator
  const abortParticipant = new AbortController();
  o.signal?.addEventListener('abort', () => (abort.abort(), abortParticipant.abort()), { once: true });
  let participant: ReturnType<typeof spawnLines> | null = null;
  let participantError: Error | null = null;

  const startParticipant = () => {
    let answered = false;
    participant = spawnLines(env.bin, ['participant', '-c', o.configPath, '--server-url', env.serverUrl, '--group', o.group], (line, p) => {
      if (answered || !/Do you want to sign it\?/.test(line)) return;
      answered = true;
      const shown = parseParticipantMessage(participant!.output());
      if (shown === o.sighash) p.stdin.write('y\n');
      else {
        participantError = new Error(`refusing to sign: session message ${shown} is not the SIGHASH ${o.sighash}`);
        p.stdin.end('n\n');
        abort.abort();
      }
    }, abortParticipant.signal);
  };

  let opened = false;
  const coord = spawnLines(env.bin, ['coordinator', '-c', o.configPath, '--server-url', env.serverUrl, '--group', o.group, '-S', o.signers.join(','), '-m', m, '-r', r, '-o', sigPath], (line) => {
    if (!opened && /Waiting for participants/.test(line)) {
      opened = true;
      o.onOpen();
      if (o.arbiterSigns) startParticipant();
    }
  }, abort.signal);
  const timer = setTimeout(() => (abort.abort(), abortParticipant.abort()), o.timeoutMs);
  try {
    const { code, text } = await coord.exited;
    const pr = participant ? await (participant as ReturnType<typeof spawnLines>).exited : null;
    if (participantError) throw participantError;
    if (code !== 0) throw new Error(`frost-client coordinator exited ${code}: ${text.slice(-1500)}`);
    if (pr && pr.code !== 0) throw new Error(`arbiter participant exited ${pr.code}: ${pr.text.slice(-800)}`);
    const sig = await readFile(sigPath);
    if (sig.length !== 64) throw new Error(`expected a 64-byte signature, got ${sig.length}`);
    return sig.toString('hex');
  } finally {
    clearTimeout(timer);
    abort.abort();
    abortParticipant.abort();
  }
}
