import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ExecResult = { out: Buffer; err: Buffer };

export class ExecError extends Error {
  constructor(
    message: string,
    readonly stdout = '',
    readonly stderr = '',
  ) {
    super(message);
  }
}

/** Runs a command to completion. `signal` aborts it (SIGKILL). */
export function exec(cmd: string, args: string[], o: { input?: Buffer | string; timeoutMs?: number; signal?: AbortSignal } = {}) {
  return new Promise<ExecResult>((resolve, reject) => {
    let p: ChildProcessWithoutNullStreams;
    try {
      p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const kill = () => p.kill('SIGKILL');
    const timer = setTimeout(() => {
      kill();
      reject(new ExecError(`${cmd} ${args[0] ?? ''} timed out`));
    }, o.timeoutMs ?? 300_000);
    o.signal?.addEventListener('abort', kill, { once: true });
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
      const r = { out: Buffer.concat(out), err: Buffer.concat(err) };
      if (code === 0) resolve(r);
      else reject(new ExecError(`${cmd} ${args[0] ?? ''} exited ${code}: ${r.err.toString().slice(-2000)}`, r.out.toString(), r.err.toString()));
    });
    p.stdin.on('error', () => {}); // the child may exit before reading its input
    p.stdin.end(o.input);
  });
}

/** stdout as bytes (PCZT files). */
export const run = async (cmd: string, args: string[], o?: Parameters<typeof exec>[2]) => (await exec(cmd, args, o)).out;

/** stdout and stderr as text (frost-client prints most things on stderr). */
export const runText = async (cmd: string, args: string[], o?: Parameters<typeof exec>[2]) => {
  const { out, err } = await exec(cmd, args, o);
  return `${out.toString()}\n${err.toString()}`;
};

/** Spawns a long-running interactive process and calls `onLine` for every line of stdout and stderr. */
export function spawnLines(cmd: string, args: string[], onLine: (line: string, p: ChildProcessWithoutNullStreams) => void, signal?: AbortSignal) {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '';
  const feed = (stream: NodeJS.ReadableStream) => {
    let buf = '';
    stream.on('data', (d: Buffer) => {
      const s = d.toString();
      text += s;
      buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''), p);
        buf = buf.slice(i + 1);
      }
      // Prompts often end without a newline.
      if (buf.length) onLine(buf, p), (buf = '');
    });
  };
  feed(p.stdout);
  feed(p.stderr);
  p.stdin.on('error', () => {});
  const kill = () => p.kill('SIGKILL');
  signal?.addEventListener('abort', kill, { once: true });
  const exited = new Promise<{ code: number; text: string }>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      resolve({ code: code ?? -1, text });
    });
  });
  return { p, exited, output: () => text };
}
