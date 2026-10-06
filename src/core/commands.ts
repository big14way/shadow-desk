// The exact commands the trade room shows each party (build guide §13), pre-filled for this trade.
// Flags follow the pinned tools in versions.lock.

import type { Role } from './api';

export type CommandParams = {
  tradeId: string;
  role: Role;
  frostdUrl: string;
  network: 'main' | 'test';
  arbiterContact?: string | null;
  counterpartyContact?: string | null;
  groupPubkey?: string | null;
};

export const configFile = (tradeId: string) => `trade-${tradeId}.toml`;
export const groupName = (tradeId: string) => `trade-${tradeId}`;
export const contactName = (role: Role, tradeId: string) => `${role}-${tradeId}`;

export function identityCommands(p: CommandParams): string[] {
  const cfg = configFile(p.tradeId);
  return [
    'mkdir -p ~/.shadowdesk && cd ~/.shadowdesk',
    `frost-client init -c ${cfg}`,
    `frost-client export --name ${contactName(p.role, p.tradeId)} -c ${cfg}`,
  ];
}

export function importCommands(p: CommandParams): string[] {
  const cfg = configFile(p.tradeId);
  return [
    `frost-client import ${p.arbiterContact ?? '<arbiter-contact>'} -c ${cfg}`,
    `frost-client import ${p.counterpartyContact ?? '<counterparty-contact>'} -c ${cfg}`,
  ];
}

export function dkgCommands(p: CommandParams): string[] {
  const cfg = configFile(p.tradeId);
  return [
    `frost-client dkg -d ${groupName(p.tradeId)} -s ${p.frostdUrl} -t 2 -C redpallas -c ${cfg}`,
    `frost-client groups -c ${cfg}`,
  ];
}

export function generateEscrowCommand(p: CommandParams): string {
  return `zcash-sign generate -n ${p.network} --ak ${p.groupPubkey ?? '<group-public-key>'}`;
}

export const pcztFileName = (tradeId: string) => `shadowdesk-${tradeId}.created`;

/**
 * Verify-before-sign (§11.9), on the PCZT downloaded from the trade room: check recipient and amount, then compute
 * the SIGHASH locally. zcash-sign prints it, then fails on the empty signature, which is expected.
 */
export function verifyCommands(p: CommandParams, path = `~/Downloads/${pcztFileName(p.tradeId)}`): string[] {
  return [
    `zcash-devtool pczt inspect ${path}`,
    `echo | zcash-sign sign -n ${p.network} --tx-plan ${path} -o /dev/null 2>/dev/null | grep SIGHASH`,
  ];
}

export function participantCommand(p: CommandParams): string {
  return `frost-client participant -c ${configFile(p.tradeId)} --server-url ${p.frostdUrl} --group ${p.groupPubkey ?? '<group-public-key>'}`;
}
