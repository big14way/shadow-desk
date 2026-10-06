import { join } from 'node:path';
import type { SettleKind } from '../../core/state';
import type { Config } from '../config';

/** Per-trade arbiter frost-client config. Holds the arbiter's key share for this escrow. */
export const arbiterConfigPath = (cfg: Config, tradeId: string) => join(cfg.frostDir, `trade-${tradeId}.toml`);

/** The worker's own view-only wallet for an escrow, separate from zwatch's (build guide §8). */
export const escrowWalletDir = (cfg: Config, tradeId: string) => join(cfg.walletsDir, `escrow-${tradeId}`);

export const settleDir = (cfg: Config, tradeId: string, kind: SettleKind) => join(cfg.workDir, tradeId, kind);

/** The created (unsigned) PCZT participants download for verify-before-sign. */
export const createdPcztPath = (cfg: Config, tradeId: string, kind: SettleKind) => join(settleDir(cfg, tradeId, kind), 'x.created');
