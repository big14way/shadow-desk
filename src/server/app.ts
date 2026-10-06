// HTTP API (build guide §10). No accounts: callers prove their role with a capability token from a URL fragment,
// sent as `Authorization: Bearer <token>`. No request logging, so no IP addresses anywhere.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CURRENCIES, METHODS } from '../core/catalog';
import { MAX_TRADE_ZAT } from '../core/money';
import type { Config } from './config';
import { DeskError, type Desk } from './desk';
import { hashToken, isId, sameHash } from './tokens';
import { createdPcztPath } from './worker/paths';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const bearer = (c: Context) => {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
};

async function body(c: Context): Promise<Record<string, unknown>> {
  if (!c.req.header('content-type')?.includes('application/json')) return {};
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    throw new DeskError(400, 'invalid JSON');
  }
}

export function createApp(desk: Desk, cfg: Config) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    if (err instanceof DeskError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) });
  const large = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) });

  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true }));

  api.get('/config', (c) =>
    c.json({
      dryRun: cfg.dryRun,
      network: cfg.network,
      frostdUrl: cfg.frostdUrl,
      maxTradeZat: String(MAX_TRADE_ZAT),
      currencies: CURRENCIES,
      methods: METHODS,
      arbiterBoxPubkey: cfg.arbiterBoxPubkey ?? null,
    }),
  );

  // ------------------------------------------------------------- offers
  api.post('/offers', small, async (c) => {
    const { offerId, makerToken } = desk.createOffer(await body(c));
    return c.json({ offerId, makerToken, sellerLink: `/o/${offerId}#k=${makerToken}` }, 201);
  });

  api.get('/offers', (c) => c.json(desk.listOffers({ currency: c.req.query('currency') || undefined, method: c.req.query('method') || undefined })));

  const offerId = (c: Context) => {
    const id = c.req.param('id');
    if (!isId(id)) throw new DeskError(404, 'offer not found');
    return id;
  };

  api.get('/offers/:id/maker', (c) => c.json(desk.makerView(offerId(c), bearer(c) ?? '')));

  api.post('/offers/:id/close', small, (c) => {
    desk.closeOffer(offerId(c), bearer(c) ?? '');
    return c.json({ ok: true });
  });

  api.post('/offers/:id/take', small, async (c) => {
    const { tradeId, buyerToken } = desk.takeOffer(offerId(c), (await body(c)).amountZat);
    return c.json({ tradeId, buyerToken, buyerLink: `/t/${tradeId}#k=${buyerToken}` }, 201);
  });

  api.post('/offers/:id/trades/:tradeId/claim', small, (c) => {
    const tradeId = c.req.param('tradeId');
    if (!isId(tradeId)) throw new DeskError(404, 'trade not found');
    const { sellerToken } = desk.claimSellerLink(offerId(c), tradeId, bearer(c) ?? '');
    return c.json({ sellerToken, sellerLink: `/t/${tradeId}#k=${sellerToken}` });
  });

  // ------------------------------------------------------------- trades (buyer or seller)
  const party = (c: Context) => {
    const id = c.req.param('id');
    if (!isId(id)) throw new DeskError(404, 'trade not found');
    return desk.roleFor(id, bearer(c));
  };
  const viewOf = (c: Context) => {
    const { trade, role } = party(c);
    return c.json(desk.view(desk.getTrade(trade.id), role));
  };

  api.get('/trades/:id', (c) => viewOf(c));

  api.post('/trades/:id/contact', small, async (c) => {
    const { trade, role } = party(c);
    desk.submitContact(trade.id, role, (await body(c)).contact);
    return viewOf(c);
  });

  api.post('/trades/:id/ready', small, (c) => {
    const { trade, role } = party(c);
    desk.setReady(trade.id, role);
    return viewOf(c);
  });

  api.post('/trades/:id/escrow', small, async (c) => {
    const { trade, role } = party(c);
    await desk.submitEscrow(trade.id, role, await body(c));
    return viewOf(c);
  });

  api.post('/trades/:id/receive-address', small, async (c) => {
    const { trade, role } = party(c);
    await desk.submitReceiveAddress(trade.id, role, (await body(c)).ua);
    return viewOf(c);
  });

  for (const [path, action] of [
    ['details-sent', 'detailsSent'],
    ['fiat-sent', 'fiatSent'],
    ['confirm-received', 'confirmReceived'],
    ['cancel', 'cancel'],
  ] as const) {
    api.post(`/trades/:id/${path}`, small, (c) => {
      const { trade, role } = party(c);
      desk[action](trade.id, role);
      return viewOf(c);
    });
  }

  api.post('/trades/:id/dispute', large, async (c) => {
    const { trade, role } = party(c);
    desk.dispute(trade.id, role, (await body(c)).evidenceSealed);
    return viewOf(c);
  });

  api.post('/trades/:id/evidence', large, async (c) => {
    const { trade, role } = party(c);
    desk.addEvidence(trade.id, role, (await body(c)).evidenceSealed);
    return viewOf(c);
  });

  api.get('/trades/:id/signing', (c) => {
    const { trade } = party(c);
    const v = desk.view(desk.getTrade(trade.id), 'buyer');
    return c.json(v.session?.type === 'sign' ? v.session : null);
  });

  api.get('/trades/:id/pczt', async (c) => {
    const { trade } = party(c);
    const t = desk.getTrade(trade.id);
    if (!t.settle_kind || !['RELEASING', 'REFUNDING'].includes(t.state)) throw new DeskError(404, 'no signing session');
    let bytes: Buffer;
    try {
      bytes = await readFile(createdPcztPath(cfg, t.id, t.settle_kind));
    } catch {
      throw new DeskError(404, 'the PCZT is not ready yet');
    }
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="shadowdesk-${t.id}.created"`,
    });
  });

  // ------------------------------------------------------------- arbiter
  const arbiter = new Hono();
  arbiter.use('*', async (c, next) => {
    const token = bearer(c);
    if (!cfg.arbiterTokenHash || !token || !sameHash(hashToken(token), cfg.arbiterTokenHash)) {
      return c.json({ error: 'arbiter only' }, 403);
    }
    await next();
  });
  const tradeParam = (c: Context) => {
    const id = c.req.param('id');
    if (!isId(id)) throw new DeskError(404, 'trade not found');
    return id;
  };
  arbiter.get('/trades', (c) => c.json(desk.arbiterTrades()));
  arbiter.get('/trades/:id', (c) => c.json(desk.arbiterTrade(tradeParam(c))));
  arbiter.post('/trades/:id/resolve', small, async (c) => {
    desk.resolve(tradeParam(c), (await body(c)).to);
    return c.json(desk.arbiterTrade(tradeParam(c)));
  });
  arbiter.get('/trades/:id/evidence/:n', (c) => {
    const bytes = desk.evidenceFile(tradeParam(c), Number(c.req.param('n')));
    return c.body(new Uint8Array(bytes), 200, { 'content-type': 'application/octet-stream' });
  });
  api.route('/admin', arbiter);

  // ------------------------------------------------------------- public
  api.get('/tape', (c) => c.json(desk.tape(c.req.query('currency') || undefined)));

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // ------------------------------------------------------------- the web UI (single-page app)
  const root = normalize(cfg.webDir);
  app.get('*', async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname);
    const file = normalize(join(root, rel));
    const inside = file === root || file.startsWith(root + sep);
    const candidate = inside && extname(file) ? file : join(root, 'index.html');
    try {
      if (!(await stat(candidate)).isFile()) throw new Error('not a file');
      const bytes = await readFile(candidate);
      const immutable = candidate.includes(`${sep}assets${sep}`);
      return c.body(new Uint8Array(bytes), 200, {
        'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    } catch {
      return c.text('Shadow Desk: the web UI is not built. Run `pnpm build`, or use `pnpm dev` for development.', 404);
    }
  });

  return app;
}
