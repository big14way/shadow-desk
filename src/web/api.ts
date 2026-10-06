// Talks to the desk API. Capability tokens come from the URL fragment (#k=…), which browsers never send to servers.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function tokenFromHash(hash = location.hash): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('k') ?? undefined;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const post = <T>(path: string, token?: string, body: unknown = {}) => api<T>(path, { method: 'POST', token, body });

export async function download(path: string, token: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` }, credentials: 'omit' });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Links you were handed, kept only in this browser so a closed tab doesn't lose a trade. */
export type SavedLink = { kind: 'offer' | 'trade'; id: string; role?: 'buyer' | 'seller'; path: string; label: string; at: number };
const KEY = 'shadowdesk.links';

export function savedLinks(): SavedLink[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedLink[];
  } catch {
    return [];
  }
}

export function saveLink(l: Omit<SavedLink, 'at'>) {
  try {
    const rest = savedLinks().filter((x) => !(x.kind === l.kind && x.id === l.id && x.role === l.role));
    localStorage.setItem(KEY, JSON.stringify([{ ...l, at: Date.now() }, ...rest].slice(0, 30)));
  } catch {
    // storage unavailable (private window): the link in the address bar is the only copy
  }
}

export function forgetLinks() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
