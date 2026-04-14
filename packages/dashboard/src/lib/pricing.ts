import { CONFIG } from '../config';

// Day of the month the Cloudflare billing cycle starts on. Invoices
// and tier limits reset on this day each month. Edit in config.ts.
export const CF_BILLING_DAY = CONFIG.cfBillingDay;

// Cloudflare Workers Paid plan ($5/mo) included tiers + overage rates.
// Source: https://developers.cloudflare.com/workers/platform/pricing/
export const CF_TIERS = {
  workers: {
    includedRequests: 10_000_000,
    overagePerMillion: 0.3,
    // Standard model bills CPU time only (wall time is NOT billed).
    includedCpuMs: 30_000_000,
    cpuOveragePerMillionMs: 0.02,
  },
  d1: {
    includedRowsRead: 25_000_000_000,
    readOveragePerMillion: 0.001,
    // Remember: an INSERT with N indexed columns = N+1 rows_written.
    includedRowsWritten: 50_000_000,
    writeOveragePerMillion: 1.0,
    includedStorageGB: 5,
    storageOveragePerGB: 0.75,
  },
  r2: {
    includedStorageGB: 10,
    storageOveragePerGB: 0.015,
    includedClassAOps: 1_000_000,
    classAOveragePerMillion: 4.5,
    includedClassBOps: 10_000_000,
    classBOveragePerMillion: 0.36,
  },
  kv: {
    // Workers KV on the Paid plan. Note: null/404 reads ARE billed.
    includedReads: 10_000_000,
    readOveragePerMillion: 0.5,
    includedWrites: 1_000_000,
    writeOveragePerMillion: 5.0,
    includedDeletes: 1_000_000,
    deleteOveragePerMillion: 5.0,
    includedLists: 1_000_000,
    listOveragePerMillion: 5.0,
    includedStorageGB: 1,
    storageOveragePerGB: 0.5,
  },
  observability: {
    // Workers Logs (Observability) — 20M events/month included on the
    // Paid plan, $0.60 per additional million. Source:
    // https://developers.cloudflare.com/workers/platform/pricing/
    // No documented GraphQL dataset for the event-count usage yet, so
    // the billing screen renders the ceiling + rate and links to the
    // CF dashboard for the live number.
    includedEvents: 20_000_000,
    overagePerMillion: 0.6,
  },
  pagesBuilds: {
    // Legacy Pages plan: hard 500 build/month cap on Free, no overage.
    // Workers Builds (newer): 3000 build-minutes/month free, then
    // $0.005/minute on Paid. Track count for awareness until we know
    // which plan is in play.
    includedBuilds: 500,
    overagePerBuild: 0, // hard cap on Free, no overage billed
    includedBuildMinutes: 3000,
    buildMinuteOverage: 0.005,
  },
  basePlan: 5,
};

interface UsageCostParams {
  workersRequests: number;
  workersCpuMs: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  d1StorageGB: number;
  r2StorageGB: number;
  r2ClassAOps: number;
  r2ClassBOps: number;
  kvReads: number;
  kvWrites: number;
  kvDeletes: number;
  kvLists: number;
  kvStorageGB: number;
}

function overage(used: number, included: number, perMillion: number): number {
  const excess = Math.max(0, used - included);
  return (excess / 1_000_000) * perMillion;
}

function gbOverage(
  used: number,
  included: number,
  perGB: number,
): number {
  return Math.max(0, used - included) * perGB;
}

export function estimateCloudflareCost(usage: UsageCostParams) {
  const workers =
    overage(usage.workersRequests, CF_TIERS.workers.includedRequests, CF_TIERS.workers.overagePerMillion) +
    overage(usage.workersCpuMs, CF_TIERS.workers.includedCpuMs, CF_TIERS.workers.cpuOveragePerMillionMs);

  const d1 =
    overage(usage.d1RowsRead, CF_TIERS.d1.includedRowsRead, CF_TIERS.d1.readOveragePerMillion) +
    overage(usage.d1RowsWritten, CF_TIERS.d1.includedRowsWritten, CF_TIERS.d1.writeOveragePerMillion) +
    gbOverage(usage.d1StorageGB, CF_TIERS.d1.includedStorageGB, CF_TIERS.d1.storageOveragePerGB);

  const r2 =
    gbOverage(usage.r2StorageGB, CF_TIERS.r2.includedStorageGB, CF_TIERS.r2.storageOveragePerGB) +
    overage(usage.r2ClassAOps, CF_TIERS.r2.includedClassAOps, CF_TIERS.r2.classAOveragePerMillion) +
    overage(usage.r2ClassBOps, CF_TIERS.r2.includedClassBOps, CF_TIERS.r2.classBOveragePerMillion);

  const kv =
    overage(usage.kvReads, CF_TIERS.kv.includedReads, CF_TIERS.kv.readOveragePerMillion) +
    overage(usage.kvWrites, CF_TIERS.kv.includedWrites, CF_TIERS.kv.writeOveragePerMillion) +
    overage(usage.kvDeletes, CF_TIERS.kv.includedDeletes, CF_TIERS.kv.deleteOveragePerMillion) +
    overage(usage.kvLists, CF_TIERS.kv.includedLists, CF_TIERS.kv.listOveragePerMillion) +
    gbOverage(usage.kvStorageGB, CF_TIERS.kv.includedStorageGB, CF_TIERS.kv.storageOveragePerGB);

  const total = CF_TIERS.basePlan + workers + d1 + r2 + kv;
  return { base: CF_TIERS.basePlan, workers, d1, r2, kv, total };
}

// Zero-filled usage so callers can spread and only set the fields they have.
export const EMPTY_USAGE: UsageCostParams = {
  workersRequests: 0,
  workersCpuMs: 0,
  d1RowsRead: 0,
  d1RowsWritten: 0,
  d1StorageGB: 0,
  r2StorageGB: 0,
  r2ClassAOps: 0,
  r2ClassBOps: 0,
  kvReads: 0,
  kvWrites: 0,
  kvDeletes: 0,
  kvLists: 0,
  kvStorageGB: 0,
};

// Returns a 0..1 progress value, capped at 1.
export function tierProgress(used: number, included: number): number {
  if (included <= 0) return 0;
  return Math.min(1, used / included);
}

export function tierColor(progress: number): 'ok' | 'warning' | 'danger' {
  if (progress < 0.6) return 'ok';
  if (progress < 0.85) return 'warning';
  return 'danger';
}

// Anthropic model pricing ($/MTok) for reference displays.
export const ANTHROPIC_PRICING: Record<
  string,
  {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  }
> = {
  'claude-opus-4-6': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 7.5,
  },
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 4.5,
  },
  'claude-haiku-4-5': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 1.5,
  },
};
