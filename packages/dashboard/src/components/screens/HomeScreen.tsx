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
  formatRelativeTime,
  daysAgoIso,
  isoNow,
  stableNowIso,
} from '../../lib/format';
import {
  unwrapAnthropic,
  sumCost,
  sumCostForToday,
  filterBucketsFromMonth,
  aggregateByDay,
  type CostBucket,
} from '../../lib/anthropic';
import MetricCard from '../cards/MetricCard';
import StatusCard from '../cards/StatusCard';
import { SkeletonGrid, SkeletonStack } from '../cards/Skeleton';

interface ZoneListItem {
  id: string;
  name: string;
  status: string;
}

interface WorkerScript {
  id: string;
  created_on: string;
}

interface AccountItem {
  id: string;
  name: string;
}

interface WorkerMetricGroup {
  sum: { requests: number; errors: number };
  dimensions: { datetime: string; scriptName: string };
}

interface WorkerSummary {
  script: string;
  invocations: number;
  errors: number;
  series: number[];
}

interface WorkerDeployment {
  id: string;
  source?: string;
  strategy?: string;
  author_email?: string;
  created_on?: string;
  versions?: Array<{ version_id: string; percentage: number }>;
}

// The script that runs this very dashboard. Used for the Self card.
import { CONFIG } from '../../config';
const SELF_SCRIPT_NAME = CONFIG.selfScriptName;

interface HomeState {
  loading: boolean;
  error: string | null;
  warnings: string[];
  lastRefresh: string;
  zones: ZoneListItem[];
  workers: WorkerScript[];
  d1Count: number;
  mtdSpend: number;
  todaySpend: number;
  sevenDayCosts: number[];
  workerMetrics: WorkerSummary[];
  selfDeployment: WorkerDeployment | null;
}

const EMPTY: HomeState = {
  loading: true,
  error: null,
  warnings: [],
  lastRefresh: isoNow(),
  zones: [],
  workers: [],
  d1Count: 0,
  mtdSpend: 0,
  todaySpend: 0,
  sevenDayCosts: [],
  workerMetrics: [],
  selfDeployment: null,
};

// Single query that returns metrics for ALL scripts grouped by scriptName.
// Replaces an N+1 fan-out of one query per script — now 1 call total.
const WORKERS_ALL_METRICS_QUERY = `
  query WorkersAllMetrics(
    $accountTag: string!
    $since: string!
    $until: string!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000
          filter: {
            datetime_geq: $since
            datetime_leq: $until
          }
        ) {
          sum { requests errors }
          dimensions { datetime scriptName }
        }
      }
    }
  }
`;

export default function HomeScreen() {
  const [state, setState] = useState<HomeState>(EMPTY);

  async function load() {
    setState((s) => ({ ...s, loading: true, error: null, warnings: [] }));
    try {
      // One shared 30d cost fetch — we derive MTD + 7d sparkline from
      // the same dataset to avoid a second Anthropic API call that
      // would double our rate limit pressure.
      const firstBatch = await batch([
        CloudflareQueries.listZones(),
        CloudflareQueries.listWorkers(),
        CloudflareQueries.listD1(),
        {
          type: 'rest',
          path: '/accounts',
          cacheTtl: 600,
        } as Query,
        AnthropicQueries.costDaily(daysAgoIso(30), stableNowIso()),
        CloudflareQueries.workerDeployments(SELF_SCRIPT_NAME),
      ]);

      const [zonesRes, workersRes, d1Res, accountsRes, costRes, selfDeployRes] =
        firstBatch;

      const warnings: string[] = [];
      collectWarning(warnings, 'zones', zonesRes);
      collectWarning(warnings, 'workers', workersRes);
      collectWarning(warnings, 'd1', d1Res);
      collectWarning(warnings, 'anthropic cost', costRes);
      collectWarning(warnings, 'self deployments', selfDeployRes);

      const zones = unwrapCloudflare<ZoneListItem[]>(zonesRes) ?? [];
      const workers = unwrapCloudflare<WorkerScript[]>(workersRes) ?? [];
      const d1List = unwrapCloudflare<{ uuid: string }[]>(d1Res) ?? [];
      const accounts = unwrapCloudflare<AccountItem[]>(accountsRes) ?? [];
      const accountId = accounts[0]?.id ?? null;

      // Latest deployment for the monitoring Worker itself. CF returns
      // deployments newest-first. We take the first row that's running
      // at 100% (there's always one unless a canary is mid-rollout).
      let selfDeployment: WorkerDeployment | null = null;
      if (selfDeployRes.ok && selfDeployRes.data) {
        const data = selfDeployRes.data as {
          result?: { deployments?: WorkerDeployment[] };
        };
        selfDeployment = data.result?.deployments?.[0] ?? null;
      }

      const allBuckets = unwrapAnthropic<CostBucket>(costRes);
      const mtdBuckets = filterBucketsFromMonth(allBuckets);

      // Single-call per-worker metrics: one GraphQL query, grouped by
      // scriptName client-side. Replaces the previous N+1 fan-out.
      let workerMetrics: WorkerSummary[] = [];
      if (accountId && workers.length > 0) {
        const metricResults = await batch([
          {
            type: 'graphql',
            query: WORKERS_ALL_METRICS_QUERY,
            variables: {
              accountTag: accountId,
              since: daysAgoIso(1),
              until: stableNowIso(),
            },
          },
        ]);

        const mRes = metricResults[0];
        if (mRes.ok && mRes.data) {
          const data = mRes.data as {
            data?: {
              viewer?: {
                accounts?: Array<{
                  workersInvocationsAdaptive: WorkerMetricGroup[];
                }>;
              };
            };
          };
          const groups =
            data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
          workerMetrics = aggregateWorkerGroups(groups);
        } else if (!mRes.ok) {
          warnings.push(`workers metrics: ${mRes.error ?? 'failed'}`);
        }
      }

      setState({
        loading: false,
        error: null,
        warnings,
        lastRefresh: isoNow(),
        zones,
        workers,
        d1Count: d1List.length,
        mtdSpend: sumCost(mtdBuckets),
        todaySpend: sumCostForToday(mtdBuckets),
        sevenDayCosts: aggregateByDay(allBuckets, 7),
        workerMetrics,
        selfDeployment,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-title">{CONFIG.brandName}</div>
          <div className="page-meta">
            {state.loading
              ? 'Loading…'
              : state.error
              ? `Error: ${state.error}`
              : `Updated ${formatRelativeTime(state.lastRefresh)}`}
          </div>
        </div>
        <button
          className="pill"
          onClick={load}
          style={{ cursor: 'pointer' }}
        >
          Refresh
        </button>
      </header>

      {state.warnings.length > 0 && (
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
            {state.warnings.map((w, i) => (
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

      <div className="section-header">Quick Stats</div>
      {state.loading && state.zones.length === 0 ? (
        <>
          <SkeletonGrid count={4} />
          <div className="section-header">AI Spend · 7d</div>
          <SkeletonStack count={1} height={100} />
          <div className="section-header">Workers · 24h</div>
          <SkeletonStack count={4} />
        </>
      ) : (
      <><div className="grid cols-2">
        <MetricCard
          label="Zones"
          value={state.zones.length.toString()}
          status={state.zones.length > 0 ? 'healthy' : 'idle'}
          tone="cf"
        />
        <MetricCard
          label="Workers"
          value={state.workers.length.toString()}
          status={state.workers.length > 0 ? 'healthy' : 'idle'}
          tone="cf"
        />
        <a
          href="/data"
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <MetricCard
            label="D1 Databases"
            value={state.d1Count.toString()}
            status={state.d1Count > 0 ? 'healthy' : 'idle'}
            delta="Tap to view →"
            tone="cf"
          />
        </a>
        <MetricCard
          label="Anthropic MTD"
          value={formatUSD(state.mtdSpend)}
          delta={`Token usage · today ${formatUSD(state.todaySpend)}`}
          trend="flat"
          tone="anthropic"
        />
      </div>

      {(() => {
        const totalErrors = state.workerMetrics.reduce(
          (acc, w) => acc + w.errors,
          0,
        );
        return (
          <div className="grid cols-2" style={{ marginTop: 12 }}>
            <a
              href="/workers#errors"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <MetricCard
                label="Errors · 24h"
                value={totalErrors.toString()}
                status={totalErrors > 0 ? 'error' : 'healthy'}
                delta={totalErrors > 0 ? 'Tap to inspect →' : 'No errors'}
                tone="cf"
              />
            </a>
          </div>
        );
      })()}

      <div className="section-header tone-cf">Self · this dashboard</div>
      <div className="stack">
        {(() => {
          const self = state.workerMetrics.find(
            (w) => w.script === SELF_SCRIPT_NAME,
          );
          const invocations = self?.invocations ?? 0;
          const errors = self?.errors ?? 0;
          const errorRate = invocations > 0 ? errors / invocations : 0;
          const deployAge = state.selfDeployment?.created_on
            ? formatRelativeTime(state.selfDeployment.created_on)
            : '—';
          const versionShort =
            state.selfDeployment?.versions?.[0]?.version_id?.slice(0, 8) ??
            state.selfDeployment?.id?.slice(0, 8) ??
            null;
          return (
            <StatusCard
              name={`${SELF_SCRIPT_NAME}${
                versionShort ? ` · ${versionShort}` : ''
              }${deployAge !== '—' ? ` · deployed ${deployAge}` : ''}`}
              invocations={invocations}
              errors={errors}
              sparkline={self?.series ?? []}
            />
          );
        })()}
      </div>

      <div className="section-header tone-anthropic">Anthropic · 7d</div>
      <div className="stack">
        <MetricCard
          label="Daily Token Cost"
          value={formatUSD(state.todaySpend)}
          sparkline={state.sevenDayCosts}
          delta={`MTD ${formatUSD(state.mtdSpend)}`}
          tone="anthropic"
        />
      </div>

      <div className="section-header tone-cf">
        Cloudflare · Workers · 24h
      </div>
      <div className="stack">
        {state.workerMetrics.filter((w) => w.script !== SELF_SCRIPT_NAME)
          .length === 0 && !state.loading && (
          <div className="empty">No worker metrics available</div>
        )}
        {state.workerMetrics
          .filter((w) => w.script !== SELF_SCRIPT_NAME)
          .map((w) => (
            <StatusCard
              key={w.script}
              name={w.script}
              invocations={w.invocations}
              errors={w.errors}
              sparkline={w.series}
            />
          ))}
      </div>
      </>
      )}
    </>
  );
}

function collectWarning(
  warnings: string[],
  label: string,
  result: BatchResult,
): void {
  if (!result.ok) {
    warnings.push(`${label}: ${result.error ?? `status ${result.status}`}`);
  }
}

function unwrapCloudflare<T>(result: BatchResult): T | null {
  if (!result.ok || !result.data) return null;
  const data = result.data as { result?: T };
  return data.result ?? null;
}

// CF returns `__UNKNOWN__` as the scriptName for historical data from
// workers that have since been deleted. Collapse all such rows into a
// single "Deleted workers" entry so it's clear what the number means.
const DELETED_WORKER_LABEL = 'Deleted workers';

function displayScriptName(script: string): string {
  const trimmed = (script ?? '').trim();
  if (!trimmed) return DELETED_WORKER_LABEL;
  const upper = trimmed.toUpperCase();
  if (upper.includes('UNKNOWN') || upper === '(NOT SET)') {
    return DELETED_WORKER_LABEL;
  }
  return trimmed;
}

// Aggregate the flat list of (datetime, scriptName) buckets into a
// per-script summary with time series for sparklines.
export function aggregateWorkerGroups(
  groups: WorkerMetricGroup[],
): WorkerSummary[] {
  const byScript = new Map<
    string,
    { script: string; invocations: number; errors: number; series: number[] }
  >();

  // First pass — build per-script totals + collect datetimes for ordering
  const timestampsByScript = new Map<string, Map<string, number>>();
  for (const g of groups) {
    const script = displayScriptName(g.dimensions.scriptName);
    const current =
      byScript.get(script) ??
      { script, invocations: 0, errors: 0, series: [] as number[] };
    current.invocations += g.sum.requests ?? 0;
    current.errors += g.sum.errors ?? 0;
    byScript.set(script, current);

    const perTime = timestampsByScript.get(script) ?? new Map<string, number>();
    const key = g.dimensions.datetime ?? '';
    perTime.set(key, (perTime.get(key) ?? 0) + (g.sum.requests ?? 0));
    timestampsByScript.set(script, perTime);
  }

  // Second pass — convert per-timestamp maps to ordered series
  for (const [script, summary] of byScript.entries()) {
    const perTime = timestampsByScript.get(script);
    if (!perTime) continue;
    const sorted = Array.from(perTime.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    summary.series = sorted.map(([, v]) => v);
  }

  return Array.from(byScript.values()).sort((a, b) => {
    // Push deleted workers to the bottom of the list
    if (a.script === DELETED_WORKER_LABEL) return 1;
    if (b.script === DELETED_WORKER_LABEL) return -1;
    return b.invocations - a.invocations;
  });
}
