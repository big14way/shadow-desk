// Dispute evidence is sealed to the arbiter's libsodium key in the browser (build guide §11.8). The desk stores only the
// sealed box; the arbiter opens it offline with a secret key that never touches the server.

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

async function sodium() {
  const mod = await import('libsodium-wrappers');
  const s = mod.default;
  await s.ready;
  return s;
}

export async function sealForArbiter(file: File, arbiterPkB64url: string): Promise<string> {
  if (file.size > MAX_EVIDENCE_BYTES) throw new Error('evidence files are limited to 2 MB');
  const s = await sodium();
  const v = s.base64_variants.URLSAFE_NO_PADDING;
  // Keep the file name and type with the content so the arbiter can open it as what it is.
  const header = new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type }) + '\n');
  const body = new Uint8Array(await file.arrayBuffer());
  const plain = new Uint8Array(header.length + body.length);
  plain.set(header);
  plain.set(body, header.length);
  return s.to_base64(s.crypto_box_seal(plain, s.from_base64(arbiterPkB64url, v)), v);
}

export async function openSealed(sealed: Uint8Array, pkB64url: string, skB64url: string): Promise<{ name: string; type: string; body: Uint8Array }> {
  const s = await sodium();
  const v = s.base64_variants.URLSAFE_NO_PADDING;
  const plain = s.crypto_box_seal_open(sealed, s.from_base64(pkB64url, v), s.from_base64(skB64url.trim(), v));
  const nl = plain.indexOf(10);
  const meta = JSON.parse(new TextDecoder().decode(plain.subarray(0, nl))) as { name: string; type: string };
  return { ...meta, body: plain.subarray(nl + 1) };
}
