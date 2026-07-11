// Demo mode — client-side masking so the dashboard can be screenshotted
// (or live-demoed) against real data without leaking real names or
// domains. Activated by appending `?demo=1` to any URL; flag persists
// via sessionStorage so navigation keeps it on.
//
// Transform runs inside lib/api.ts between the fetch and the caller, so
// every screen sees already-masked values with zero changes required.
// When demo mode is off, maskIfDemo is an identity early-return.
//
// Design choices:
// - Only human-readable labels are masked (worker/zone/app names,
//   domains, emails). Opaque IDs/tags/UUIDs are left alone — they're
//   random hex with no personal info, and masking them breaks screens
//   that use IDs as filter keys on follow-up API calls.
// - Each unique real string maps to a unique fake (monotonic index into
//   the pool, with numeric suffix once the pool is exhausted). No hash
//   collisions, no duplicate pills.
// - Metric numbers are jittered ~±30% with a seeded PRNG so sparklines
//   stay coherent across re-renders.

const DEMO_KEY = 'flarestat:demo';

export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).has('demo')) {
    sessionStorage.setItem(DEMO_KEY, '1');
    return true;
  }
  return sessionStorage.getItem(DEMO_KEY) === '1';
}

// Brand-level overrides for values that come from local CONFIG rather
// than the API (HomeScreen title, Self card script name). Components
// that render these check demoBrand() manually since they never hit
// the API pipeline.
export function demoBrand(real: string): string {
  return isDemoMode() ? 'flarestat' : real;
}
export function demoSelfScript(real: string): string {
  return isDemoMode() ? 'flarestat-demo' : real;
}

// Worker script names arrive under the CF REST key `id`, which the masking
// pipeline leaves untouched (id = join key). Mask them for display via the
// same `worker` pool the GraphQL scriptName dimension uses, so seeded-by-id
// entries and metric entries collapse to the same fake in demo mode.
export function maskWorkerName(real: string): string {
  return isDemoMode() ? assignFromPool('worker', FAKE_WORKERS, real) : real;
}

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
  'feed-dispatcher',
  'queue-drain',
];
const FAKE_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'acme-shop.com',
  'widget-co.io',
  'demo-labs.dev',
  'atlas-app.com',
  'parcel.io',
  'harbor-cloud.net',
  'orbit-tech.co',
];
const FAKE_APPS = [
  'acme',
  'widget',
  'ledger',
  'parcel',
  'atlas',
  'beacon',
  'harbor',
  'orbit',
  'relay',
  'vault',
  'mesa',
  'pulse',
];
const FAKE_EMAILS = ['demo@example.com', 'team@example.com', 'ops@example.com'];

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return h >>> 0;
}

function seededFactor(seed: string): number {
  let s = djb2(seed) || 1;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return 0.7 + r * 0.6;
}

// Maps real string → assigned fake, keyed by pool name so the same real
// string in different contexts doesn't cross-pollinate pools.
const assignments = new Map<string, string>();
const poolCursors = new Map<string, number>();

function assignFromPool(poolName: string, pool: string[], real: string): string {
  const cacheKey = `${poolName}:${real}`;
  const cached = assignments.get(cacheKey);
  if (cached) return cached;
  const cursor = poolCursors.get(poolName) ?? 0;
  const base = pool[cursor % pool.length];
  const round = Math.floor(cursor / pool.length);
  const fake = round === 0 ? base : `${base}-${round + 1}`;
  assignments.set(cacheKey, fake);
  poolCursors.set(poolName, cursor + 1);
  return fake;
}

function isDomain(v: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+){1,}$/i.test(v) && v.includes('.');
}

function maskString(key: string, value: string): string {
  // Skip enum-ish / structural values.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(value)) return value;
  if (/^claude-/.test(value)) return value;
  if (value === 'production' || value === 'staging' || value === 'development')
    return value;

  const lk = key.toLowerCase();

  if (lk === 'email' || value.includes('@')) {
    return assignFromPool('email', FAKE_EMAILS, value);
  }

  if (
    lk.includes('zone') ||
    lk === 'host' ||
    lk === 'hostname' ||
    lk === 'pattern' ||
    isDomain(value)
  ) {
    return assignFromPool('domain', FAKE_DOMAINS, value);
  }

  if (
    lk.includes('script') ||
    lk === 'name' ||
    lk === 'title' ||
    lk.includes('worker')
  ) {
    return assignFromPool('worker', FAKE_WORKERS, value);
  }

  if (lk === 'app' || lk === 'appid' || lk === 'app_id' || lk === 'label') {
    return assignFromPool('app', FAKE_APPS, value);
  }

  return value;
}

const METRIC_KEY = /count|requests|bytes|invocations|errors|storage|rows|tokens|cost|amount|spend|billed|subrequests|latency|p50|p99|hit|miss|threats|bandwidth|usage|quota|ops|reads|writes|duration|size|total|rate/i;

function fuzzNumber(key: string, value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const fuzzed = value * seededFactor(key + ':' + value);
  return Number.isInteger(value)
    ? Math.round(fuzzed)
    : Number(fuzzed.toFixed(4));
}

// CF GraphQL often returns large integers as strings to survive JSON.
// If a string key looks metric-shaped and the value parses cleanly as a
// number, fuzz it as a number and return as string.
function maybeFuzzStringAsNumber(key: string, value: string): string | null {
  if (!METRIC_KEY.test(key)) return null;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return String(fuzzNumber(key, n));
}

function walk(value: unknown, keyHint: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const numeric = maybeFuzzStringAsNumber(keyHint, value);
    if (numeric !== null) return numeric;
    return maskString(keyHint, value);
  }
  if (typeof value === 'number') {
    return METRIC_KEY.test(keyHint) ? fuzzNumber(keyHint, value) : value;
  }
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
