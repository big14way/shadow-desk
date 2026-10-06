import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseContact } from '../../src/core/contact';
import { checkEscrowAddress, ufvkOrchardAk } from '../../src/core/unified';
import {
  parseContacts,
  parseExport,
  parseGenerate,
  parseGroups,
  parseInspect,
  parseParticipantMessage,
  parseSendTxid,
  parseSignLine,
} from '../../src/server/worker/parse';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/spike/${name}`, import.meta.url), 'utf8');

describe('parsers against real tool output (fixtures/spike)', () => {
  it('frost-client export', () => {
    const r = parseExport(fx('export-buyer.txt'));
    expect(r.pubkey).toBe('1a50f0821c331bd5cbde0549a7784289014b2fe285c694d476e66c8ff3d1376e');
    expect(parseContact(r.contact)).toEqual({ name: 'buyer-T1', pubkey: r.pubkey });
  });

  it('frost-client contacts', () => {
    expect(parseContacts(fx('contacts-arbiter.txt'))).toEqual([
      { name: 'buyer-T1', pubkey: '1a50f0821c331bd5cbde0549a7784289014b2fe285c694d476e66c8ff3d1376e' },
      { name: 'seller-T1', pubkey: 'd29a43c72bffaa73ab3c0d61a142b2ee58b8d40cfd4120b6445c7ce9c0f89e5f' },
    ]);
  });

  it('frost-client groups', () => {
    const [g] = parseGroups(fx('groups-arbiter.txt'));
    expect(g).toEqual({
      description: 'trade-T1',
      pubkey: 'bbe261cce497936c8eb4f48ad194c78b096a66608ba941defe9631e811d42c39',
      threshold: 2,
      participants: [
        '431a2b9b0f325f73ae1f6878a4c0425e23121ede337740fef5f9ed3d1ee3e149',
        'd29a43c72bffaa73ab3c0d61a142b2ee58b8d40cfd4120b6445c7ce9c0f89e5f',
        '1a50f0821c331bd5cbde0549a7784289014b2fe285c694d476e66c8ff3d1376e',
      ],
    });
    expect(parseGroups(fx('groups-buyer.txt'))[0].pubkey).toBe(g.pubkey);
  });

  it('zcash-sign generate, and the desk checks on its output', () => {
    const { address, ufvk } = parseGenerate(fx('zcash-sign-generate.txt'));
    const [group] = fx('escrow.txt').trim().split('\n');
    expect(checkEscrowAddress(address)).toEqual({ ok: true, receivers: ['orchard'] });
    expect(ufvkOrchardAk(ufvk)).toBe(group);
  });

  it('zcash-sign sign prompts', () => {
    const lines = fx('zcash-sign-sign-1.txt').split('\n').map(parseSignLine).filter(Boolean);
    expect(lines).toEqual([
      { kind: 'sighash', hex: '7d48149e6ae74a301bc74c7e1a5af48c52c0d20550a086899db07555e73f53a5' },
      { kind: 'randomizer', index: 3, pool: 'ironwood', hex: 'c8288c6d932fe31bdfacb6394fa22235a23331d00f95a5ea8f3ea1938bb60136' },
      { kind: 'prompt', index: 3, pool: 'ironwood' },
    ]);
  });

  it('frost-client participant shows the SIGHASH before asking', () => {
    expect(parseParticipantMessage(fx('participant-release-buyer.txt'))).toBe('7d48149e6ae74a301bc74c7e1a5af48c52c0d20550a086899db07555e73f53a5');
    expect(parseParticipantMessage(fx('participant-dispute-arbiter.txt'))).toBe('7d48149e6ae74a301bc74c7e1a5af48c52c0d20550a086899db07555e73f53a5');
  });

  it('coordinator wrote a 64-byte signature', () => {
    expect(fx('sig-release.hex').trim()).toMatch(/^[0-9a-f]{128}$/);
    expect(fx('coordinator-release.txt')).toMatch(/Waiting for participants/);
  });

  it('pczt inspect', () => {
    const r = parseInspect(fx('pczt-inspect.txt'));
    expect(r.txid).toBe('a5533fe75575b09d8986a05005d2c0528cf45a1a7e4cc71b304ae76a9e14487d');
    expect(r.outputs).toHaveLength(5);
    expect(r.outputs[4]).toEqual({
      valueZat: 50_000_000n,
      address: 'utest1j87vh0khl3j8uvvjw5ytyj3edgr3e6klcz3kqax8v8s4rea8n53yvyw8rmay0xje0sf04rhr8rg4gd4732tl95npr272wxtq7s2d5sgu',
    });
    expect(r.outputs[0]).toEqual({ valueZat: 12_493_750n, address: null });
  });

  it('pczt send', () => {
    expect(parseSendTxid(fx('pczt-send.txt'))).toBe('0'.repeat(64));
    expect(() => parseSendTxid('Sending transaction...\n')).toThrow();
  });
});
