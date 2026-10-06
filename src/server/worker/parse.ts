// Parsers for the CLI output of the pinned tools. Each one is tested against fixtures/spike/ (real captured output).

/** `frost-client export` (stderr): "Public Key: <hex>" and the zffrost1… contact string. */
export function parseExport(text: string): { contact: string; pubkey: string } {
  const contact = text.match(/^(zffrost1[02-9ac-hj-np-z]+)\s*$/m)?.[1];
  const pubkey = text.match(/^Public Key: ([0-9a-f]{64})\s*$/m)?.[1];
  if (!contact || !pubkey) throw new Error('could not read frost-client export output');
  return { contact, pubkey };
}

/** `frost-client contacts` (stderr): blocks of "Name: x" / "Public Key: y". */
export function parseContacts(text: string): { name: string; pubkey: string }[] {
  const out: { name: string; pubkey: string }[] = [];
  const re = /^Name: (.*)\nPublic Key: ([0-9a-f]{64})$/gm;
  for (const m of text.matchAll(re)) out.push({ name: m[1], pubkey: m[2] });
  return out;
}

/** `frost-client groups` (stderr): `Group "<description>"` followed by `Public key <hex>`. */
export function parseGroups(text: string): { description: string; pubkey: string; threshold?: number; participants: string[] }[] {
  const groups: { description: string; pubkey: string; threshold?: number; participants: string[] }[] = [];
  for (const block of text.split(/^(?=Group ")/m)) {
    const description = block.match(/^Group "(.*)"$/m)?.[1];
    const pubkey = block.match(/^Public key ([0-9a-f]{64})$/m)?.[1];
    if (description === undefined || !pubkey) continue;
    const threshold = Number(block.match(/^Threshold: (\d+)$/m)?.[1]) || undefined;
    const participants = [...block.matchAll(/^\t[^\t]*\t\(([0-9a-f]{64})\)$/gm)].map((m) => m[1]);
    groups.push({ description, pubkey, threshold, participants });
  }
  return groups;
}

/** `zcash-sign generate`: Debug-quoted strings. */
export function parseGenerate(text: string): { address: string; ufvk: string } {
  const address = text.match(/^Orchard-only unified address: "([^"]+)"$/m)?.[1];
  const ufvk = text.match(/^Unified Full Viewing Key: "([^"]+)"$/m)?.[1];
  if (!address || !ufvk) throw new Error('could not read zcash-sign generate output');
  return { address, ufvk };
}

export type SignLine =
  | { kind: 'sighash'; hex: string }
  | { kind: 'randomizer'; index: number; pool: string; hex: string }
  | { kind: 'prompt'; index: number; pool: string }
  | { kind: 'written'; path: string };

/** One line of `zcash-sign sign` output. */
export function parseSignLine(line: string): SignLine | null {
  let m = line.match(/^SIGHASH: ([0-9a-f]{64})\s*$/);
  if (m) return { kind: 'sighash', hex: m[1] };
  m = line.match(/^Randomizer #(\d+) \(([a-z]+)\): ([0-9a-f]{64})\s*$/);
  if (m) return { kind: 'randomizer', index: Number(m[1]), pool: m[2], hex: m[3] };
  m = line.match(/^Input hex-encoded signature #(\d+) \(([a-z]+)\):\s*$/);
  if (m) return { kind: 'prompt', index: Number(m[1]), pool: m[2] };
  m = line.match(/^Tx written to (.+)$/);
  if (m) return { kind: 'written', path: m[1] };
  return null;
}

/** `frost-client participant`: the message shown before "Do you want to sign it? (y/n)". */
export function parseParticipantMessage(text: string): string | null {
  return text.match(/Message to be signed \(hex-encoded\):\s*\n([0-9a-f]+)\s*\n/)?.[1] ?? null;
}

/** `zcash-devtool pczt send`: "Sending transaction..." then the txid on its own line. */
export function parseSendTxid(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const txid = lines.filter((l) => /^[0-9a-f]{64}$/.test(l)).pop();
  if (!txid) throw new Error('no txid in pczt send output');
  return txid;
}

export type InspectOutput = { valueZat: bigint; address: string | null };

/** `zcash-devtool pczt inspect`: shielded outputs, with the recipient address when the PCZT carries it. */
export function parseInspect(text: string): { outputs: InspectOutput[]; txid: string | null } {
  const outputs: InspectOutput[] = [];
  // Orchard-style actions (Orchard and Ironwood bundles): "  - Output: <n> zatoshis[ to <address>]".
  for (const m of text.matchAll(/^\s*- Output: (\d+) zatoshis(?: to (\S+))?/gm)) {
    outputs.push({ valueZat: BigInt(m[1]), address: m[2] ?? null });
  }
  const txid = text.match(/^TxID: ([0-9a-f]{64})$/m)?.[1] ?? null;
  return { outputs, txid };
}
