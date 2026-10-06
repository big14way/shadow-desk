# zwatch contract

Shadow Desk doesn't scan the chain itself. It uses **zwatch**, the view-only watcher built for Ghostpass
(GHOSTPASS.md §7), unchanged, with one account per escrow (build guide §8). This file pins down exactly what the
desk sends and accepts (`src/server/zwatch.ts`), so the two sides can be checked against each other.

Base URL: `ZWATCH_URL`. If `ZWATCH_TOKEN` is set, every request carries `Authorization: Bearer <token>`.

| Call | When | Request | Response the desk accepts |
|---|---|---|---|
| `GET /health` | before importing an escrow | — | `{ "ok": true, "tip": 3500000 }`. The tip may also be named `tipHeight`, `tip_height` or `height`; it's optional. |
| `POST /accounts` | the seller has submitted the escrow and the buyer a receive address | `{ "name": "escrow-<tradeId>", "ufvk": "uview1…", "birthday": <tip or omitted> }` | `{ "id": "<account id>", "birthday": <height, optional> }` (`accountId` / `account_id` also accepted) |
| `GET /accounts/:id/received` | every 30 s while funding, and for cancelled trades (late funds) | — | an array, or `{ "outputs": [...] }`, of `{ "txid", "valueZat", "confirmations" }` (`value_zat` / `value`, `confs` accepted). Zatoshi values may be numbers or decimal strings. |
| `GET /accounts/:id/balance` | before creating a release or refund | — | `{ "spendableZat": "1010000" }` (`spendable_zat`, `spendable`, `confirmedZat`, `confirmed_zat` accepted): confirmed and spendable. |

**Funding rule** (`fundingStatus`): exactly one output, at least `amount + 10,000` zatoshis, with at least 2
confirmations. More than one output → `NEEDS_ATTENTION`. One confirmed output that is too small → refund.

**Not used:** deleting accounts. A purged trade's zwatch account is left for zwatch's own retention.

In dry run (`DESK_DRY_RUN=1`) a mock replaces zwatch (`src/server/dryrun.ts`).
