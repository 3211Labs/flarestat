import { useEffect, useState } from 'react';
import {
  batch,
  CloudflareQueries,
  AnthropicQueries,
  type BatchResult,
  type Query,
} from '../../lib/api';
import {
  formatUSD,
  formatCompact,
  formatRelativeTime,
  isoNow,
  stableNowIso,
  daysAgoIso,
  stableHoursAgoIso,
  startOfBillingCycleIso,
  nextBillingCycleStart,
} from '../../lib/format';
import {
  unwrapAnthropic,
  sumCost,
  filterBucketsFromMonth,
  type CostBucket,
} from '../../lib/anthropic';
import MetricCard from '../cards/MetricCard';
import UsageBar from '../cards/UsageBar';
import { SkeletonGrid, SkeletonStack } from '../cards/Skeleton';
import {
  CF_TIERS,
  CF_BILLING_DAY,
  estimateCloudflareCost,
} from '../../lib/pricing';

interface BillingChargeItem {
  id: string;
  type?: string;
  action?: string;
  description?: string;
  amount: number;
  amount_to_pay?: number;
  currency?: string;
  occurred_at?: string;
  status?: string;
  invoice_id?: string;
  receipt_id?: string;
  source?: string;
  zone?: { name?: string };
}

interface UsageTotals {
  workersRequests: number;
  workersErrors: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  kvReads: number;
  kvWrites: number;
  kvDeletes: number;
  kvLists: number;
  r2ClassAOps: number;
  r2ClassBOps: number;
}

// CPU time is NOT queryable as a sum on workersInvocationsAdaptive —
// only as quantiles (P50/P99) in microseconds. Multiplying by the request
// count gives a heavy-tail-biased under-estimate (confirmed against the
// CF billing dashboard: 52× under). We drop CPU from billing tracking
// and rely on Logpush workers_trace_events for the real billable total.
// scriptName is added so we can exclude pages-worker--* invocations
// client-side.
const WORKERS_TOTAL_QUERY = `
  query WorkersTotal($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests errors subrequests }
          dimensions { scriptName }
        }
      }
    }
  }
`;

const D1_TOTAL_QUERY = `
  query D1Total($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { rowsRead rowsWritten }
        }
      }
    }
  }
`;

// KV operations grouped by actionType so we can separate reads / writes /
// deletes / lists. `requests` is the count of ops per dimension.
const KV_OPERATIONS_QUERY = `
  query KvOps($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests }
          dimensions { actionType }
        }
      }
    }
  }
`;

// KV storage is a point-in-time metric — we take the latest sample.
const KV_STORAGE_QUERY = `
  query KvStorage($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvStorageAdaptiveGroups(
          limit: 10000
          orderBy: [datetime_DESC]
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          max { byteCount keyCount }
          dimensions { namespaceId }
        }
      }
    }
  }
`;

// R2 operations grouped by actionType. Class B = GetObject / HeadObject /
// HeadBucket; everything else is Class A.
const R2_OPS_QUERY = `
  query R2Ops($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        r2OperationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests }
          dimensions { actionType }
        }
      }
    }
  }
`;

// R2 storage is point-in-time: latest sample per bucket.
const R2_STORAGE_QUERY = `
  query R2Storage($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(
          limit: 10000
          orderBy: [datetime_DESC]
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          max { payloadSize metadataSize objectCount }
          dimensions { bucketName }
        }
      }
    }
  }
`;

function chargeLabel(c: BillingChargeItem): string {
  if (c.description) return c.description;
  if (c.action) return c.action;
  if (c.receipt_id) return `Invoice ${c.receipt_id}`;
  if (c.type) return c.type.charAt(0).toUpperCase() + c.type.slice(1);
  return 'Charge';
}

// CF's billing/history returns `amount_to_pay` equal to the amount on
// closed invoices that have been paid from credit balance — it's the
// invoice total, not what's still owed. Trust the `status` field first.
function invoiceState(c: BillingChargeItem): {
  label: string;
  color: string;
} {
  const status = (c.status ?? '').toUpperCase();
  if (status === 'CLOSED' || status === 'PAID') {
    return { label: 'Paid', color: 'var(--text-muted)' };
  }
  if (status === 'OPEN' || status === 'PENDING') {
    return { label: 'Due', color: 'var(--accent-yellow)' };
  }
  return { label: status || '—', color: 'var(--text-muted)' };
}

export default function BillingScreen() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refreshedAt, setRefreshedAt] = useState(isoNow());
  const [charges, setCharges] = useState<BillingChargeItem[]>([]);
  const [anthropicMtd, setAnthropicMtd] = useState(0);
  const [usage, setUsage] = useState<UsageTotals>(emptyUsageTotals());
  // Last 24h totals — used for the rolling-rate projection so a mid-cycle
  // optimization (or regression) is reflected in the forecast immediately.
  const [last24h, setLast24h] = useState<UsageTotals>(emptyUsageTotals());
  const [d1StorageGB, setD1StorageGB] = useState(0);
  const [kvStorageGB, setKvStorageGB] = useState(0);
  const [r2StorageGB, setR2StorageGB] = useState(0);
  const [pagesBuilds, setPagesBuilds] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setWarnings([]);
    try {
      const cycleStart = startOfBillingCycleIso(CF_BILLING_DAY);
      const stableNow = stableNowIso();

      // First batch: billing history + account list + Anthropic costs +
      // D1 inventory (for storage sum). We need the account ID before we
      // can run the GraphQL usage queries.
      const firstBatch = await batch([
        CloudflareQueries.billingHistory(),
        {
          type: 'rest',
          path: '/accounts',
          cacheTtl: 600,
        } as Query,
        AnthropicQueries.costDaily(daysAgoIso(30), stableNow),
        CloudflareQueries.listD1(),
      ]);

      const [billingRes, accountsRes, anthropicRes, d1ListRes] = firstBatch;

      const nextWarnings: string[] = [];
      if (!billingRes.ok) nextWarnings.push(`billing: ${billingRes.error ?? 'failed'}`);
      if (!accountsRes.ok) nextWarnings.push(`accounts: ${accountsRes.error ?? 'failed'}`);
      if (!anthropicRes.ok) nextWarnings.push(`anthropic cost: ${anthropicRes.error ?? 'failed'}`);
      if (!d1ListRes.ok) nextWarnings.push(`d1 list: ${d1ListRes.error ?? 'failed'}`);

      if (billingRes.ok && billingRes.data) {
        const data = billingRes.data as { result?: BillingChargeItem[] };
        setCharges(data.result ?? []);
      }

      // Sum file_size across all D1 databases → total storage GB. Source
      // is the REST list endpoint we already fetch; no extra query needed.
      if (d1ListRes.ok && d1ListRes.data) {
        const data = d1ListRes.data as {
          result?: Array<{ file_size?: number }>;
        };
        const totalBytes = (data.result ?? []).reduce(
          (acc, db) => acc + (db.file_size ?? 0),
          0,
        );
        setD1StorageGB(totalBytes / 1_000_000_000);
      }

      const buckets = unwrapAnthropic<CostBucket>(anthropicRes);
      setAnthropicMtd(sumCost(filterBucketsFromMonth(buckets)));

      const accounts = accountsRes.ok
        ? ((accountsRes.data as { result?: Array<{ id: string }> }).result ?? [])
        : [];
      const accountId = accounts[0]?.id ?? null;

      // Second batch: GraphQL aggregations over (a) the CF billing cycle
      // for the usage-vs-tier bars and (b) the last 24h for the rolling-
      // rate projection. Need the account ID from the first batch, so
      // we can't combine these into the first call.
      if (accountId) {
        const since24h = stableHoursAgoIso(24);
        const cycleVars = { accountTag: accountId, since: cycleStart, until: stableNow };
        const dayVars = { accountTag: accountId, since: since24h, until: stableNow };

        const secondBatch = await batch([
          // Cycle-to-date
          { type: 'graphql', query: WORKERS_TOTAL_QUERY, variables: cycleVars },
          { type: 'graphql', query: D1_TOTAL_QUERY, variables: cycleVars },
          { type: 'graphql', query: KV_OPERATIONS_QUERY, variables: cycleVars },
          { type: 'graphql', query: KV_STORAGE_QUERY, variables: cycleVars },
          { type: 'graphql', query: R2_OPS_QUERY, variables: cycleVars },
          { type: 'graphql', query: R2_STORAGE_QUERY, variables: cycleVars },
          // Last 24h for rolling-rate projection
          { type: 'graphql', query: WORKERS_TOTAL_QUERY, variables: dayVars },
          { type: 'graphql', query: D1_TOTAL_QUERY, variables: dayVars },
          { type: 'graphql', query: KV_OPERATIONS_QUERY, variables: dayVars },
          { type: 'graphql', query: R2_OPS_QUERY, variables: dayVars },
        ]);

        const [
          workersRes,
          d1Res,
          kvOpsRes,
          kvStorageRes,
          r2OpsRes,
          r2StorageRes,
          workers24hRes,
          d124hRes,
          kvOps24hRes,
          r2Ops24hRes,
        ] = secondBatch;

        if (!workersRes.ok)
          nextWarnings.push(`workers usage: ${workersRes.error ?? 'failed'}`);
        if (!d1Res.ok) nextWarnings.push(`d1 usage: ${d1Res.error ?? 'failed'}`);
        if (!kvOpsRes.ok) nextWarnings.push(`kv ops: ${kvOpsRes.error ?? 'failed'}`);
        if (!kvStorageRes.ok)
          nextWarnings.push(`kv storage: ${kvStorageRes.error ?? 'failed'}`);
        if (!r2OpsRes.ok) nextWarnings.push(`r2 ops: ${r2OpsRes.error ?? 'failed'}`);
        if (!r2StorageRes.ok)
          nextWarnings.push(`r2 storage: ${r2StorageRes.error ?? 'failed'}`);
        if (!workers24hRes.ok)
          nextWarnings.push(`workers 24h: ${workers24hRes.error ?? 'failed'}`);
        if (!d124hRes.ok) nextWarnings.push(`d1 24h: ${d124hRes.error ?? 'failed'}`);
        if (!kvOps24hRes.ok)
          nextWarnings.push(`kv ops 24h: ${kvOps24hRes.error ?? 'failed'}`);
        if (!r2Ops24hRes.ok)
          nextWarnings.push(`r2 ops 24h: ${r2Ops24hRes.error ?? 'failed'}`);

        const nextUsage = emptyUsageTotals();
        const next24h = emptyUsageTotals();

        addWorkersTotals(workersRes, nextUsage);
        addD1Totals(d1Res, nextUsage);
        addKvOps(kvOpsRes, nextUsage);
        addR2Ops(r2OpsRes, nextUsage);
        addWorkersTotals(workers24hRes, next24h);
        addD1Totals(d124hRes, next24h);
        addKvOps(kvOps24hRes, next24h);
        addR2Ops(r2Ops24hRes, next24h);

        setUsage(nextUsage);
        setLast24h(next24h);
        setKvStorageGB(extractKvStorageGB(kvStorageRes));
        setR2StorageGB(extractR2StorageGB(r2StorageRes));
      }

      setWarnings(nextWarnings);
      setRefreshedAt(isoNow());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const cycleStart = new Date(startOfBillingCycleIso(CF_BILLING_DAY));
  const cycleEnd = nextBillingCycleStart(CF_BILLING_DAY);
  const daysRemaining = Math.max(
    0,
    Math.ceil((cycleEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
  );

  // CF charges in the current billing cycle (23rd → 23rd)
  const cfCycleTotal = charges
    .filter((c) => {
      if (!c.occurred_at) return false;
      const d = new Date(c.occurred_at);
      return d >= cycleStart && d < cycleEnd;
    })
    .reduce((acc, c) => acc + (c.amount || 0), 0);

  // Rolling-rate projection: extrapolate the last-24h rate over the
  // remaining days in the cycle and add to what's already been used.
  // Storage metrics (D1, KV) are treated as point-in-time — no rolling
  // projection, just use the current value as the forecast.
  const projectedUsage = {
    workersRequests: usage.workersRequests + last24h.workersRequests * daysRemaining,
    // CPU time is not queryable as a sum via CF GraphQL. Set to 0 so
    // the estimator doesn't claim overage we can't measure.
    workersCpuMs: 0,
    d1RowsRead: usage.d1RowsRead + last24h.d1RowsRead * daysRemaining,
    d1RowsWritten:
      usage.d1RowsWritten + last24h.d1RowsWritten * daysRemaining,
    d1StorageGB,
    r2StorageGB,
    r2ClassAOps: usage.r2ClassAOps + last24h.r2ClassAOps * daysRemaining,
    r2ClassBOps: usage.r2ClassBOps + last24h.r2ClassBOps * daysRemaining,
    kvReads: usage.kvReads + last24h.kvReads * daysRemaining,
    kvWrites: usage.kvWrites + last24h.kvWrites * daysRemaining,
    kvDeletes: usage.kvDeletes + last24h.kvDeletes * daysRemaining,
    kvLists: usage.kvLists + last24h.kvLists * daysRemaining,
    kvStorageGB,
  };
  const cfCostEstimate = estimateCloudflareCost(projectedUsage);
  const workersOverage = cfCostEstimate.workers;
  const d1Overage = cfCostEstimate.d1;
  const r2Overage = cfCostEstimate.r2;
  const kvOverage = cfCostEstimate.kv;
  const totalCfOverage = workersOverage + d1Overage + r2Overage + kvOverage;
  const projectedCycleTotal = cfCostEstimate.total;

  // Per-bar overage USD based on CYCLE-TO-DATE usage (what's already
  // billable), not the projection. The bars show where you are, the
  // top-card "Projected" shows where you'll end up.
  const perMillionOverage = (used: number, included: number, rate: number) =>
    (Math.max(0, used - included) / 1_000_000) * rate;
  const perGbOverage = (used: number, included: number, rate: number) =>
    Math.max(0, used - included) * rate;

  const workersReqOverUsd = perMillionOverage(
    usage.workersRequests,
    CF_TIERS.workers.includedRequests,
    CF_TIERS.workers.overagePerMillion,
  );
  // CPU overage intentionally not calculated — see note in projectedUsage.
  const d1ReadOverUsd = perMillionOverage(
    usage.d1RowsRead,
    CF_TIERS.d1.includedRowsRead,
    CF_TIERS.d1.readOveragePerMillion,
  );
  const d1WriteOverUsd = perMillionOverage(
    usage.d1RowsWritten,
    CF_TIERS.d1.includedRowsWritten,
    CF_TIERS.d1.writeOveragePerMillion,
  );
  const d1StorageOverUsd = perGbOverage(
    d1StorageGB,
    CF_TIERS.d1.includedStorageGB,
    CF_TIERS.d1.storageOveragePerGB,
  );
  const kvReadOverUsd = perMillionOverage(
    usage.kvReads,
    CF_TIERS.kv.includedReads,
    CF_TIERS.kv.readOveragePerMillion,
  );
  const kvWriteOverUsd = perMillionOverage(
    usage.kvWrites,
    CF_TIERS.kv.includedWrites,
    CF_TIERS.kv.writeOveragePerMillion,
  );
  const kvDeleteOverUsd = perMillionOverage(
    usage.kvDeletes,
    CF_TIERS.kv.includedDeletes,
    CF_TIERS.kv.deleteOveragePerMillion,
  );
  const kvStorageOverUsd = perGbOverage(
    kvStorageGB,
    CF_TIERS.kv.includedStorageGB,
    CF_TIERS.kv.storageOveragePerGB,
  );
  const r2StorageOverUsd = perGbOverage(
    r2StorageGB,
    CF_TIERS.r2.includedStorageGB,
    CF_TIERS.r2.storageOveragePerGB,
  );
  const r2ClassAOverUsd = perMillionOverage(
    usage.r2ClassAOps,
    CF_TIERS.r2.includedClassAOps,
    CF_TIERS.r2.classAOveragePerMillion,
  );
  const r2ClassBOverUsd = perMillionOverage(
    usage.r2ClassBOps,
    CF_TIERS.r2.includedClassBOps,
    CF_TIERS.r2.classBOveragePerMillion,
  );

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-title">Billing</div>
          <div className="page-meta">
            {loading
              ? 'Loading…'
              : error
              ? `Error: ${error}`
              : `Updated ${formatRelativeTime(refreshedAt)}`}
          </div>
        </div>
        <button className="pill" onClick={load}>
          Refresh
        </button>
      </header>

      {warnings.length > 0 && (
        <div className="stack">
          <div
            className="card"
            style={{ borderColor: 'var(--accent-yellow)' }}
          >
            <div
              className="card-label"
              style={{ color: 'var(--accent-yellow)' }}
            >
              Partial data
            </div>
            {warnings.map((w, i) => (
              <div
                key={i}
                className="card-delta"
                style={{ marginTop: 4, color: 'var(--text-secondary)' }}
              >
                · {w}
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && charges.length === 0 ? (
        <>
          <SkeletonGrid count={4} />
          <div className="section-header">Usage vs Tier</div>
          <SkeletonStack count={3} height={96} />
          <div className="section-header">Billing History</div>
          <SkeletonStack count={4} height={96} />
        </>
      ) : (
        <>
      <div className="grid cols-2">
        <MetricCard
          label="CF Projected Cycle"
          value={formatUSD(projectedCycleTotal)}
          delta={
            totalCfOverage > 0
              ? `${formatUSD(totalCfOverage)} overage · via 24h rate · ${daysRemaining}d left`
              : `via 24h rate · ${daysRemaining}d remaining`
          }
          status={totalCfOverage > 0 ? 'warning' : 'healthy'}
          tone="cf"
        />
        <MetricCard
          label="Anthropic MTD"
          value={formatUSD(anthropicMtd)}
          delta="calendar month · token usage"
          tone="anthropic"
        />
        <MetricCard
          label="CF Billed So Far"
          value={formatUSD(cfCycleTotal)}
          delta={`base ${formatUSD(CF_TIERS.basePlan)} · cycle ${cycleStart.toISOString().slice(5, 10)}`}
          tone="cf"
        />
        <MetricCard
          label="Combined Projected"
          value={formatUSD(projectedCycleTotal + anthropicMtd)}
          delta="CF cycle + Anthropic MTD"
        />
      </div>

      {totalCfOverage > 0 && (
        <>
          <div className="section-header tone-cf">
            Cloudflare · Projected Overage (rolling 24h rate)
          </div>
          <div className="stack">
            <div className="card tone-cf">
              <div
                className="card-label"
                style={{ color: 'var(--accent-red)' }}
              >
                Forecast overage
              </div>
              <div className="card-value">{formatUSD(totalCfOverage)}</div>
              <div className="card-delta" style={{ marginTop: 8 }}>
                {workersOverage > 0 && (
                  <>Workers: {formatUSD(workersOverage)}<br /></>
                )}
                {d1Overage > 0 && (
                  <>D1: {formatUSD(d1Overage)}<br /></>
                )}
                {kvOverage > 0 && (
                  <>KV: {formatUSD(kvOverage)}<br /></>
                )}
                {r2Overage > 0 && (
                  <>R2: {formatUSD(r2Overage)}<br /></>
                )}
                Assumes last-24h rate continues for {daysRemaining} more day
                {daysRemaining === 1 ? '' : 's'}. Bills on{' '}
                {cycleEnd.toISOString().slice(0, 10)}.
              </div>
            </div>
          </div>
        </>
      )}

      <div className="stack">
        <details className="info-card">
          <summary>Why don't these match my CF invoice exactly?</summary>
          <div className="info-body">
            These numbers come from <strong>CF Analytics GraphQL</strong> —
            sampled observations, not the exact figures on your CF invoice.
            Cloudflare's docs state the dataset{' '}
            <a
              href="https://developers.cloudflare.com/analytics/graphql-api/"
              target="_blank"
              rel="noreferrer"
            >
              should not be used for billing reconciliation
            </a>
            . Expect ~10-50% variance vs the billing page. For exact-billable
            numbers we'd need Logpush{' '}
            <span className="mono">workers_trace_events</span>.
          </div>
        </details>
      </div>

      <div className="section-header tone-cf">
        Cloudflare · Workers · cycle{' '}
        {cycleStart.toISOString().slice(5, 10)} →{' '}
        {cycleEnd.toISOString().slice(5, 10)}
      </div>
      <div className="stack">
        <UsageBar
          label="Requests (excl. Pages)"
          used={usage.workersRequests}
          included={CF_TIERS.workers.includedRequests}
          formatValue={formatCompact}
          overageUsd={workersReqOverUsd}
        />
        <details className="info-card">
          <summary>
            CPU time, observability events &amp; page builds not tracked — view in CF dashboard
          </summary>
          <div className="info-body">
            <div style={{ marginBottom: 10 }}>
              <strong>CPU Time</strong> · billed at $0.02/M ms after 30M ms
              included. CF GraphQL only exposes P50/P99 quantiles, not a
              sum — a P50 × requests estimate under-reports ~50×. Real
              tracking needs Logpush{' '}
              <span className="mono">workers_trace_events</span>.{' '}
              <a
                href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"
                target="_blank"
                rel="noreferrer"
              >
                View →
              </a>
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>Observability Events (Workers Logs)</strong> · 20M
              events/month included, then $0.60/M. No documented GraphQL
              dataset for the event count.{' '}
              <a
                href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"
                target="_blank"
                rel="noreferrer"
              >
                View →
              </a>
            </div>
            <div>
              <strong>Pages Builds</strong> · Legacy Pages: 500 builds/month
              (hard cap). Workers Builds: 3,000 build-minutes/month, then
              $0.005/min. Deployment-count queries land in a future update.{' '}
              <a
                href="https://dash.cloudflare.com/?to=/:account/pages"
                target="_blank"
                rel="noreferrer"
              >
                View →
              </a>
            </div>
          </div>
        </details>
      </div>

      <div className="section-header tone-cf">Cloudflare · D1</div>
      <div className="stack">
        <UsageBar
          label="Rows Read"
          used={usage.d1RowsRead}
          included={CF_TIERS.d1.includedRowsRead}
          formatValue={formatCompact}
          overageUsd={d1ReadOverUsd}
        />
        <UsageBar
          label="Rows Written"
          used={usage.d1RowsWritten}
          included={CF_TIERS.d1.includedRowsWritten}
          formatValue={formatCompact}
          overageUsd={d1WriteOverUsd}
        />
        <UsageBar
          label="Storage"
          used={d1StorageGB}
          included={CF_TIERS.d1.includedStorageGB}
          formatValue={(n) => `${n.toFixed(2)} GB`}
          overageUsd={d1StorageOverUsd}
        />
      </div>

      <div className="section-header tone-cf">Cloudflare · KV</div>
      <div className="stack">
        <UsageBar
          label="Reads"
          used={usage.kvReads}
          included={CF_TIERS.kv.includedReads}
          formatValue={formatCompact}
          overageUsd={kvReadOverUsd}
        />
        <UsageBar
          label="Writes"
          used={usage.kvWrites}
          included={CF_TIERS.kv.includedWrites}
          formatValue={formatCompact}
          overageUsd={kvWriteOverUsd}
        />
        <UsageBar
          label="Deletes"
          used={usage.kvDeletes}
          included={CF_TIERS.kv.includedDeletes}
          formatValue={formatCompact}
          overageUsd={kvDeleteOverUsd}
        />
        <UsageBar
          label="Storage"
          used={kvStorageGB}
          included={CF_TIERS.kv.includedStorageGB}
          formatValue={(n) => `${n.toFixed(3)} GB`}
          overageUsd={kvStorageOverUsd}
        />
      </div>

      <div className="section-header tone-cf">Cloudflare · R2</div>
      <div className="stack">
        <UsageBar
          label="Storage"
          used={r2StorageGB}
          included={CF_TIERS.r2.includedStorageGB}
          formatValue={(n) => `${n.toFixed(2)} GB`}
          overageUsd={r2StorageOverUsd}
        />
        <UsageBar
          label="Class A Ops (writes, lists)"
          used={usage.r2ClassAOps}
          included={CF_TIERS.r2.includedClassAOps}
          formatValue={formatCompact}
          overageUsd={r2ClassAOverUsd}
        />
        <UsageBar
          label="Class B Ops (reads)"
          used={usage.r2ClassBOps}
          included={CF_TIERS.r2.includedClassBOps}
          formatValue={formatCompact}
          overageUsd={r2ClassBOverUsd}
        />
      </div>

      <div className="section-header tone-cf">Cloudflare · Billing History</div>
      <div className="stack">
        {charges.length === 0 && !loading && (
          <div className="empty">No charges</div>
        )}
        {charges.slice(0, 20).map((c) => {
          const state = invoiceState(c);
          return (
            <div key={c.id} className="card">
              <div className="card-label">
                <span>{chargeLabel(c)}</span>
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  {c.occurred_at?.slice(0, 10) ?? '—'}
                </span>
              </div>
              <div className="card-value">
                {formatUSD(c.amount)}
                {c.currency && c.currency.toLowerCase() !== 'usd' && (
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginLeft: 8,
                    }}
                  >
                    {c.currency.toUpperCase()}
                  </span>
                )}
                {c.zone?.name && (
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginLeft: 8,
                    }}
                  >
                    {c.zone.name}
                  </span>
                )}
              </div>
              <div
                className="card-delta"
                style={{ marginTop: 6, color: state.color }}
              >
                {state.label}
                {c.source && ` · ${c.source}`}
              </div>
            </div>
          );
        })}
      </div>
        </>
      )}
    </>
  );
}

function addWorkersTotals(result: BatchResult, target: UsageTotals): void {
  if (!result.ok || !result.data) return;
  const data = result.data as {
    data?: {
      viewer?: {
        accounts?: Array<{
          workersInvocationsAdaptive: Array<{
            sum: { requests: number; errors: number; subrequests: number };
            dimensions: { scriptName: string };
          }>;
        }>;
      };
    };
  };
  const groups =
    data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  for (const g of groups) {
    // Pages-deployed workers use a synthetic `pages-worker--*` script
    // name. These are separately metered and shouldn't count toward the
    // Workers Standard Requests bill. Everything else we pass through
    // knowing it's still "observed invocations", not billable exactly.
    if ((g.dimensions.scriptName ?? '').startsWith('pages-worker--')) {
      continue;
    }
    target.workersRequests += g.sum.requests ?? 0;
    target.workersErrors += g.sum.errors ?? 0;
  }
}

function addKvOps(result: BatchResult, target: UsageTotals): void {
  if (!result.ok || !result.data) return;
  const data = result.data as {
    data?: {
      viewer?: {
        accounts?: Array<{
          kvOperationsAdaptiveGroups: Array<{
            sum: { requests: number };
            dimensions: { actionType: string };
          }>;
        }>;
      };
    };
  };
  const groups =
    data.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];
  for (const g of groups) {
    const count = g.sum.requests ?? 0;
    switch ((g.dimensions.actionType ?? '').toLowerCase()) {
      case 'read':
        target.kvReads += count;
        break;
      case 'write':
        target.kvWrites += count;
        break;
      case 'delete':
        target.kvDeletes += count;
        break;
      case 'list':
        target.kvLists += count;
        break;
    }
  }
}

function extractKvStorageGB(result: BatchResult): number {
  if (!result.ok || !result.data) return 0;
  const data = result.data as {
    data?: {
      viewer?: {
        accounts?: Array<{
          kvStorageAdaptiveGroups: Array<{
            max: { byteCount: number; keyCount: number };
            dimensions: { namespaceId: string };
          }>;
        }>;
      };
    };
  };
  const groups =
    data.data?.viewer?.accounts?.[0]?.kvStorageAdaptiveGroups ?? [];
  // Take the most recent sample per namespace and sum across namespaces.
  const latestByNs = new Map<string, number>();
  for (const g of groups) {
    const ns = g.dimensions.namespaceId;
    if (!latestByNs.has(ns)) latestByNs.set(ns, g.max.byteCount ?? 0);
  }
  let totalBytes = 0;
  for (const v of latestByNs.values()) totalBytes += v;
  return totalBytes / 1_000_000_000;
}

function emptyUsageTotals(): UsageTotals {
  return {
    workersRequests: 0,
    workersErrors: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    kvReads: 0,
    kvWrites: 0,
    kvDeletes: 0,
    kvLists: 0,
    r2ClassAOps: 0,
    r2ClassBOps: 0,
  };
}

// Class B: pure-read operations; everything else is Class A (mutating).
const R2_CLASS_B_ACTIONS = new Set([
  'GetObject',
  'HeadObject',
  'HeadBucket',
]);

function addR2Ops(result: BatchResult, target: UsageTotals): void {
  if (!result.ok || !result.data) return;
  const data = result.data as {
    data?: {
      viewer?: {
        accounts?: Array<{
          r2OperationsAdaptiveGroups: Array<{
            sum: { requests: number };
            dimensions: { actionType: string };
          }>;
        }>;
      };
    };
  };
  const groups =
    data.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];
  for (const g of groups) {
    const count = g.sum.requests ?? 0;
    if (R2_CLASS_B_ACTIONS.has(g.dimensions.actionType)) {
      target.r2ClassBOps += count;
    } else {
      target.r2ClassAOps += count;
    }
  }
}

function extractR2StorageGB(result: BatchResult): number {
  if (!result.ok || !result.data) return 0;
  const data = result.data as {
    data?: {
      viewer?: {
        accounts?: Array<{
          r2StorageAdaptiveGroups: Array<{
            max: {
              payloadSize: number;
              metadataSize: number;
              objectCount: number;
            };
            dimensions: { bucketName: string };
          }>;
        }>;
      };
    };
  };
  const groups =
    data.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
  // Take the most recent sample per bucket (first occurrence since the
  // query is ordered DESC by datetime) and sum payload + metadata.
  const latestByBucket = new Map<string, number>();
  for (const g of groups) {
    const bucket = g.dimensions.bucketName;
    if (latestByBucket.has(bucket)) continue;
    latestByBucket.set(
      bucket,
      (g.max.payloadSize ?? 0) + (g.max.metadataSize ?? 0),
    );
  }
  let totalBytes = 0;
  for (const v of latestByBucket.values()) totalBytes += v;
  return totalBytes / 1_000_000_000;
}

function addD1Totals(result: BatchResult, target: UsageTotals): void {
  if (!result.ok || !result.data) return;
  const data = result.data as {
    data?: {
      viewer?: {
        accounts?: Array<{
          d1AnalyticsAdaptiveGroups: Array<{
            sum: { rowsRead: number; rowsWritten: number };
          }>;
        }>;
      };
    };
  };
  const groups =
    data.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  for (const g of groups) {
    target.d1RowsRead += g.sum.rowsRead ?? 0;
    target.d1RowsWritten += g.sum.rowsWritten ?? 0;
  }
}
