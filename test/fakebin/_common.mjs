// Shared by the fake CLI tools: log every call, fail on demand, keep state in $FAKE_STATE_DIR.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const state = process.env.FAKE_STATE_DIR;
if (!state) {
  console.error('FAKE_STATE_DIR not set');
  process.exit(3);
}
mkdirSync(state, { recursive: true });

export function logCall(tool, argv) {
  appendFileSync(join(state, 'calls.log'), JSON.stringify([tool, ...argv]) + '\n');
}

export function failIf(step) {
  const f = join(state, `fail-${step}`);
  if (existsSync(f)) {
    console.error(`fake failure at ${step}`);
    process.exit(1);
  }
}

export const arg = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export const readState = (name, fallback = '') => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : fallback);
export const writeState = (name, v) => writeFileSync(join(state, name), v);

export async function readLine() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) resolve(buf.slice(0, i));
    });
    process.stdin.on('end', () => resolve(buf));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
