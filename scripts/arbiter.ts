// Arbiter tooling, run offline: `pnpm arbiter <command>`.
//
//   token                     a new arbiter console token, and the hash to put in ARBITER_TOKEN_HASH
//   box-keypair               a libsodium key pair for sealed dispute evidence (ARBITER_BOX_PUBKEY)
//   open <file> [out]         decrypt a sealed evidence file with ARBITER_BOX_PUBKEY + ARBITER_BOX_SECRET

import { readFileSync, writeFileSync } from 'node:fs';
import sodium from 'libsodium-wrappers';
import { hashToken, newToken } from '../src/server/tokens';

await sodium.ready;
const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'token': {
    const token = newToken();
    console.log(`ARBITER_TOKEN=${token}        # keep it secret; open /admin#k=<token>`);
    console.log(`ARBITER_TOKEN_HASH=${hashToken(token)}`);
    break;
  }
  case 'box-keypair': {
    const kp = sodium.crypto_box_keypair();
    console.log(`ARBITER_BOX_PUBKEY=${sodium.to_base64(kp.publicKey, B64)}`);
    console.log(`ARBITER_BOX_SECRET=${sodium.to_base64(kp.privateKey, B64)}   # keep offline, never on the server`);
    break;
  }
  case 'open': {
    const [file, out] = args;
    const pk = process.env.ARBITER_BOX_PUBKEY;
    const sk = process.env.ARBITER_BOX_SECRET;
    if (!file || !pk || !sk) {
      console.error('usage: ARBITER_BOX_PUBKEY=… ARBITER_BOX_SECRET=… pnpm arbiter open <sealed-file> [out-file]');
      process.exit(2);
    }
    const plain = sodium.crypto_box_seal_open(readFileSync(file), sodium.from_base64(pk, B64), sodium.from_base64(sk, B64));
    if (out) writeFileSync(out, plain, { mode: 0o600 });
    else process.stdout.write(plain);
    break;
  }
  default:
    console.error('commands: token | box-keypair | open <file> [out]');
    process.exit(2);
}
