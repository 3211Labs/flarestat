// Demo mode — client-side masking so the dashboard can be screenshotted
// (or live-demoed) against real data without leaking real names, IDs,
// domains, or exact numbers. Activated by appending `?demo=1` to any URL;
// flag persists via sessionStorage so navigation keeps it on.
//
// Transform runs inside lib/api.ts between the fetch and the caller, so
// every screen sees already-masked values with zero changes required.
// When demo mode is off, maskIfDemo is an identity early-return.

const DEMO_KEY = 'flarestat:demo';

export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).has('demo')) {
    sessionStorage.setItem(DEMO_KEY, '1');
    return true;
  }
  return sessionStorage.getItem(DEMO_KEY) === '1';
}

// Deterministic fake-name pool. A real string hashes into a slot and
// keeps that mapping forever — so sparklines stay coherent across
// re-renders and "The Edge" always renders as the same demo name.
const FAKE_WORKERS = [
  'acme-api',
  'acme-web',
  'widget-cron',
  'shop-frontend',
  'data-pipeline',
  'notify-worker',
  'cache-edge',
  'auth-service',
  'billing-worker',
  'reports-api',
  'search-indexer',
  'webhook-relay',
  'media-resizer',
  'audit-logger',
];
const FAKE_DOMAINS = [
  'example.com',
  'example.org',
  'shop.example.com',
  'app.example.com',
  'demo.example.com',
  'staging.example.com',
  'api.example.com',
];
const FAKE_APPS = [
  'Acme',
  'Widget',
  'Ledger',
  'Parcel',
  'Atlas',
  'Beacon',
  'Harbor',
  'Orbit',
  'Relay',
  'Vault',
  'Mesa',
];

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return h >>> 0;
}

// Mulberry32 — small, fast, seedable. Used to jitter metric values
// deterministically per-string so the same real worker always gets the
// same fuzz factor (~0.7x–1.3x).
function seededFactor(seed: string): number {
  let s = djb2(seed) || 1;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return 0.7 + r * 0.6;
}

const stringCache = new Map<string, string>();

function fakeFromPool(real: string, pool: string[]): string {
  const cached = stringCache.get(real);
  if (cached) return cached;
  const pick = pool[djb2(real) % pool.length];
  stringCache.set(real, pick);
  return pick;
}

// Treat anything that parses as a UUID / hex hash / CF account-id-shaped
// string as an opaque identifier.
function looksLikeId(v: string): boolean {
  if (v.length < 16) return false;
  return /^[a-f0-9-]{16,}$/i.test(v) || /^[a-zA-Z0-9]{24,}$/.test(v);
}

function isDomain(v: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+){1,}$/i.test(v) && v.includes('.');
}

function maskString(key: string, value: string): string {
  // Enum-ish values we never touch: HTTP methods, ISO timestamps,
  // model slugs, short status codes.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value; // ISO date
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(value)) return value;
  if (/^claude-/.test(value)) return value;
  if (value === 'production' || value === 'staging' || value === 'development')
    return value;

  const lk = key.toLowerCase();

  if (lk === 'email' || value.includes('@')) {
    return fakeFromPool(value, ['demo@example.com', 'team@example.com']);
  }

  if (
    lk.includes('zone') ||
    lk === 'host' ||
    lk === 'hostname' ||
    lk === 'pattern' ||
    isDomain(value)
  ) {
    return fakeFromPool(value, FAKE_DOMAINS);
  }

  if (
    lk.includes('script') ||
    lk === 'name' ||
    lk === 'title' ||
    lk.includes('worker')
  ) {
    return fakeFromPool(value, FAKE_WORKERS);
  }

  if (lk.includes('app') || lk === 'id_pretty' || lk === 'label') {
    return fakeFromPool(value, FAKE_APPS);
  }

  // Opaque IDs — UUID / hex / long tokens
  if (
    looksLikeId(value) ||
    lk === 'id' ||
    lk === 'uuid' ||
    lk.endsWith('_id') ||
    lk.includes('account') ||
    lk.includes('deployment') ||
    lk === 'etag'
  ) {
    return `demo-${(djb2(value) % 0xffffff).toString(16).padStart(8, '0')}`;
  }

  return value;
}

const METRIC_KEY = /count|requests|bytes|invocations|errors|storage|rows|tokens|cost|amount|spend|billed|subrequests|latency|p50|p99|hit|miss|threats|bandwidth|usage|quota|ops|reads|writes|duration|size|total|rate/i;

function maskNumber(key: string, value: number): number {
  if (!METRIC_KEY.test(key)) return value;
  if (!Number.isFinite(value) || value === 0) return value;
  const fuzzed = value * seededFactor(key + ':' + value);
  // Preserve int-vs-float shape
  return Number.isInteger(value) ? Math.round(fuzzed) : Number(fuzzed.toFixed(4));
}

function walk(value: unknown, keyHint: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskString(keyHint, value);
  if (typeof value === 'number') return maskNumber(keyHint, value);
  if (Array.isArray(value)) return value.map((v) => walk(v, keyHint));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, k);
    }
    return out;
  }
  return value;
}

export function maskIfDemo<T>(data: T): T {
  if (!isDemoMode()) return data;
  return walk(data, '') as T;
}
