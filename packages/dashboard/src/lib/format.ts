const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const WHOLE = new Intl.NumberFormat('en-US');

export function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return WHOLE.format(n);
}

export function formatCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return COMPACT.format(n);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  const decimals = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[idx]}`;
}

export function formatUSD(dollars: number | null | undefined): string {
  if (dollars == null || Number.isNaN(dollars)) return '—';
  if (dollars < 1) return `$${dollars.toFixed(4)}`;
  if (dollars < 100) return `$${dollars.toFixed(2)}`;
  return `$${WHOLE.format(Math.round(dollars))}`;
}

export function formatPercent(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatRelativeTime(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Anthropic cost API returns amount in cents as a decimal string.
export function centsToDollars(amount: string | number): number {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (Number.isNaN(n)) return 0;
  return n / 100;
}

export function isoNow(): string {
  return new Date().toISOString();
}

// Stable "now" rounded to the current UTC hour. Used as the upper bound
// for cached Anthropic / CF API queries so the cache key doesn't change
// on every millisecond and actually hit.
export function stableNowIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function startOfMonthIso(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Cloudflare bills on a custom cycle that starts on the day you signed
// up (configurable via CONFIG.cfBillingDay). Returns the ISO timestamp
// of the current cycle's start.
export function startOfBillingCycleIso(day: number): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const cycleStart =
    now.getUTCDate() >= day
      ? new Date(Date.UTC(year, month, day))
      : new Date(Date.UTC(year, month - 1, day));
  cycleStart.setUTCHours(0, 0, 0, 0);
  return cycleStart.toISOString();
}

// Next cycle boundary from today, for "X days remaining" displays.
export function nextBillingCycleStart(day: number): Date {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return now.getUTCDate() >= day
    ? new Date(Date.UTC(year, month + 1, day))
    : new Date(Date.UTC(year, month, day));
}
