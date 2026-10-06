// Drives `zcash-sign sign` interactively. It prints the SIGHASH, then for each spend a randomizer and a prompt for
// that spend's signature, one spend at a time (frost-tools zcash-sign/src/sign.rs). One FROST session per prompt.

import { parseSignLine } from './parse';
import { spawnLines } from './run';

export type SpendPrompt = { sighash: string; randomizer: string; index: number; pool: string };

export type ZcashSignSession = {
  /** The next spend that needs a signature, or null once the signed transaction is written. */
  next(): Promise<SpendPrompt | null>;
  provide(sigHex: string): void;
  kill(): void;
};

export function startZcashSign(bin: string, network: string, createdPath: string, signedPath: string, signal?: AbortSignal): ZcashSignSession {
  let sighash: string | null = null;
  let randomizer: { index: number; pool: string; hex: string } | null = null;
  const queue: (SpendPrompt | null)[] = [];
  const waiters: { resolve: (v: SpendPrompt | null) => void; reject: (e: Error) => void }[] = [];
  let failure: Error | null = null;

  const push = (v: SpendPrompt | null) => {
    const w = waiters.shift();
    if (w) w.resolve(v);
    else queue.push(v);
  };
  const fail = (e: Error) => {
    failure = e;
    for (const w of waiters.splice(0)) w.reject(e);
  };

  const proc = spawnLines(bin, ['sign', '-n', network, '--tx-plan', createdPath, '-o', signedPath], (line) => {
    const l = parseSignLine(line);
    if (!l) return;
    if (l.kind === 'sighash') sighash = l.hex;
    else if (l.kind === 'randomizer') randomizer = l;
    else if (l.kind === 'prompt') {
      if (!sighash || !randomizer || randomizer.index !== l.index) return fail(new Error('zcash-sign: prompt before its randomizer'));
      push({ sighash, randomizer: randomizer.hex, index: l.index, pool: l.pool });
    }
  }, signal);

  proc.exited.then(
    ({ code, text }) => {
      if (code === 0 && /Tx written to/.test(text)) push(null);
      else fail(new Error(`zcash-sign exited ${code}: ${text.slice(-1500)}`));
    },
    (e) => fail(e as Error),
  );

  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    provide(sigHex) {
      if (!/^[0-9a-f]{128}$/.test(sigHex)) throw new Error('signature must be 64 bytes of hex');
      proc.p.stdin.write(`${sigHex}\n`);
    },
    kill() {
      proc.p.kill('SIGKILL');
    },
  };
}
