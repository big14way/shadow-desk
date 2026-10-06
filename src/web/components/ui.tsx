import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { currencyExponent } from '../../core/catalog';
import { formatMinor, zatToZec } from '../../core/money';
import type { TradeState } from '../../core/state';

export type DeskConfig = {
  dryRun: boolean;
  network: 'main' | 'test';
  frostdUrl: string;
  maxTradeZat: string;
  currencies: Record<string, { name: string; exponent: number }>;
  methods: Record<string, string>;
  arbiterBoxPubkey: string | null;
};

export const ConfigContext = createContext<DeskConfig | null>(null);
export const useConfig = () => useContext(ConfigContext);

export const zec = (zat: string | bigint) => `${zatToZec(BigInt(zat))} ZEC`;
export const fiat = (minor: string | bigint, currency: string) => `${formatMinor(BigInt(minor), currencyExponent(currency))} ${currency}`;

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function CopyButton({ text, label = 'Copy', className = 'small' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`copy ${className}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked; the text is selectable */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Cmd({ children }: { children: string }) {
  return (
    <div className="cmd">
      <pre>{children}</pre>
      <CopyButton text={children} />
    </div>
  );
}

export function Value({ children, copy = true }: { children: string; copy?: boolean }) {
  return (
    <div className="cmd">
      <pre className="mono">{children}</pre>
      {copy && <CopyButton text={children} />}
    </div>
  );
}

export function Leak({ children }: { children: ReactNode }) {
  return (
    <div className="leak">
      <strong>What leaks here.</strong> {children}
    </div>
  );
}

export function Countdown({ deadline, skew }: { deadline: number | null; skew: number }) {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), deadline ? 1000 : null);
  if (!deadline) return null;
  const ms = deadline - (now + skew);
  if (ms <= 0) return <span className="badge warn">deadline passed</span>;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return (
    <span className={`badge ${m < 5 ? 'warn' : ''} deadline`}>
      {m}:{String(s).padStart(2, '0')} left
    </span>
  );
}

const STATE_TONE: Partial<Record<TradeState, string>> = {
  RELEASED: 'ok',
  REFUNDED: 'ok',
  FUNDED: 'accent',
  DISPUTE: 'danger',
  NEEDS_ATTENTION: 'danger',
  CANCELLED: '',
  RELEASING: 'accent',
  REFUNDING: 'accent',
};

export function StateBadge({ state }: { state: TradeState }) {
  return <span className={`badge ${STATE_TONE[state] ?? ''}`}>{state.replace(/_/g, ' ').toLowerCase()}</span>;
}

export function QR({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    import('qrcode').then((QRCode) => {
      if (live && ref.current) QRCode.toCanvas(ref.current, text, { margin: 1, width: 392, errorCorrectionLevel: 'M' });
    });
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <div className="qr">
      <canvas ref={ref} aria-label="QR code" />
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}

/** Runs an async action, tracking busy state and the error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--panel-2)" />
      <path d="M8 11h16l-11 10h11" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 6v3M16 23v3" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function formatHour(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
