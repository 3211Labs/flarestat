import { useEffect, useState } from 'react';
import {
  batch,
  CloudflareQueries,
  type BatchResult,
  type Query,
} from '../../lib/api';
import {
  formatRelativeTime,
  isoNow,
  stableNowIso,
  daysAgoIso,
  stableHoursAgoIso,
} from '../../lib/format';
import { maskWorkerName } from '../../lib/demo';
import StatusCard from '../cards/StatusCard';
import { SkeletonGrid, SkeletonStack } from '../cards/Skeleton';

type Range = '1' | '7' | '30';

interface WorkerScript {
  id: string;
  created_on: string;
}

interface WorkerMetricGroup {
  sum: { requests: number; errors: number; subrequests: number };
  dimensions: { datetime: string; scriptName: string };
}

interface WorkerMetrics {
  script: string;
  invocations: number;
  errors: number;
  subrequests: number;
  series: number[];
}

interface ErrorEvent {
  timestamp: string;
  script: string;
  message: string;
  count: number;
}

// One query that returns metrics for every script. We group client-side
// by dimensions.scriptName to avoid the previous N+1 fan-out pattern.
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
          sum { requests errors subrequests }
          dimensions { datetime scriptName }
        }
      }
    }
  }
`;

export default function WorkersScreen() {
  const [scripts, setScripts] = useState<WorkerScript[]>([]);
  const [metrics, setMetrics] = useState<WorkerMetrics[]>([]);
  const [range, setRange] = useState<Range>('1');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string>(isoNow());
  const [accountTag, setAccountTag] = useState<string | null>(null);
  const [errors, setErrors] = useState<ErrorEvent[]>([]);

  async function load(targetRange: Range = range) {
    setLoading(true);
    setError(null);
    setWarnings([]);
    try {
      const firstBatch = await batch([
        CloudflareQueries.listWorkers(),
        {
          type: 'rest',
          path: '/accounts',
          cacheTtl: 600,
        } satisfies Query,
        CloudflareQueries.recentErrors(24, 100),
      ]);

      const nextWarnings: string[] = [];
      const [scriptsRes, accountsRes, errorsRes] = firstBatch;

      if (!errorsRes.ok) {
        nextWarnings.push(`recent errors: ${errorsRes.error ?? 'failed'}`);
      } else {
        setErrors(parseErrorEvents(errorsRes, nextWarnings));
      }

      if (!scriptsRes.ok)
        nextWarnings.push(`workers list: ${scriptsRes.error ?? 'failed'}`);
      if (!accountsRes.ok)
        nextWarnings.push(`accounts: ${accountsRes.error ?? 'failed'}`);

      let scriptList: WorkerScript[] = [];
      if (scriptsRes.ok && scriptsRes.data) {
        const data = scriptsRes.data as { result?: WorkerScript[] };
        scriptList = (data.result ?? []).map((w) => ({
          ...w,
          id: maskWorkerName(w.id),
        }));
        setScripts(scriptList);
      }

      let nextAccountTag: string | null = null;
      if (accountsRes.ok && accountsRes.data) {
        const data = accountsRes.data as { result?: Array<{ id: string }> };
        nextAccountTag = data.result?.[0]?.id ?? null;
        setAccountTag(nextAccountTag);
      }

      if (nextAccountTag && scriptList.length > 0) {
        const metricResults = await batch([
          {
            type: 'graphql',
            query: WORKERS_ALL_METRICS_QUERY,
            variables: {
              accountTag: nextAccountTag,
              since:
                targetRange === '1'
                  ? stableHoursAgoIso(24)
                  : daysAgoIso(parseInt(targetRange, 10)),
              until: stableNowIso(),
            },
          },
        ]);

        const mRes = metricResults[0];
        if (!mRes.ok) {
          nextWarnings.push(`workers metrics: ${mRes.error ?? 'failed'}`);
        } else {
          setMetrics(aggregateWorkerGroups(mRes, scriptList));
        }
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
    load(range);
  }, []);

  useEffect(() => {
    // Re-fetch metrics (not inventory) when the range changes.
    if (accountTag && scripts.length > 0) loadMetricsOnly(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  async function loadMetricsOnly(targetRange: Range) {
    if (!accountTag || scripts.length === 0) return;
    setLoading(true);
    try {
      const metricResults = await batch([
        {
          type: 'graphql',
          query: WORKERS_ALL_METRICS_QUERY,
          variables: {
            accountTag,
            since:
              targetRange === '1'
                ? stableHoursAgoIso(24)
                : daysAgoIso(parseInt(targetRange, 10)),
            until: stableNowIso(),
          },
        },
      ]);

      const mRes = metricResults[0];
      if (mRes.ok) {
        setMetrics(aggregateWorkerGroups(mRes, scripts));
      }
      setRefreshedAt(isoNow());
    } finally {
      setLoading(false);
    }
  }

  const totals = metrics.reduce(
    (acc, m) => {
      acc.invocations += m.invocations;
      acc.errors += m.errors;
      return acc;
    },
    { invocations: 0, errors: 0 },
  );

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-title">Workers</div>
          <div className="page-meta">
            {loading
              ? 'Loading…'
              : error
              ? `Error: ${error}`
              : `Updated ${formatRelativeTime(refreshedAt)}`}
          </div>
        </div>
        <button className="pill" onClick={() => load(range)}>
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

      <div className="tabs">
        {(['1', '7', '30'] as Range[]).map((r) => (
          <button
            key={r}
            className="tab"
            aria-pressed={range === r}
            onClick={() => setRange(r)}
          >
            {r === '1' ? '24h' : `${r}d`}
          </button>
        ))}
      </div>

      {loading && metrics.length === 0 ? (
        <>
          <SkeletonGrid count={2} />
          <div className="section-header">Per Worker</div>
          <SkeletonStack count={6} />
        </>
      ) : (
        <>
          <div className="grid cols-2">
            <StatusCard
              name="Total invocations"
              invocations={totals.invocations}
              errors={totals.errors}
            />
            <StatusCard
              name={`${scripts.length} scripts`}
              invocations={scripts.length}
              errors={0}
            />
          </div>

          <div className="section-header">Per Worker</div>
          <div className="stack">
            {metrics.length === 0 && !loading && (
              <div className="empty">No workers</div>
            )}
            {metrics.map((m) => (
              <StatusCard
                key={m.script}
                name={m.script}
                invocations={m.invocations}
                errors={m.errors}
                sparkline={m.series}
              />
            ))}
          </div>

          <div id="errors" className="section-header">
            Recent errors · 24h
          </div>
          <div className="stack">
            {errors.length === 0 && (
              <div className="empty">No errors logged in the last 24h</div>
            )}
            {errors.map((e, i) => (
              <div key={`${e.timestamp}-${i}`} className="card">
                <div className="card-label">
                  <span>
                    {e.count > 1 && (
                      <span
                        style={{
                          color: 'var(--accent-red)',
                          marginRight: 6,
                          fontWeight: 600,
                        }}
                      >
                        {e.count}×
                      </span>
                    )}
                    {e.script || 'unknown script'}
                  </span>
                  <span
                    className="mono"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {formatRelativeTime(e.timestamp)}
                  </span>
                </div>
                <div
                  className="card-delta"
                  style={{
                    marginTop: 6,
                    color: 'var(--text-secondary)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {e.message}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// Parse the telemetry/query response into a flat list of error events.
// CF's response shape isn't fully documented, so be defensive: try the
// common nestings and push a debug warning if nothing parses.
function parseErrorEvents(
  result: BatchResult,
  warnings: string[],
): ErrorEvent[] {
  if (!result.ok || !result.data) return [];
  const data = result.data as Record<string, unknown>;
  const resultNode = data.result as Record<string, unknown> | unknown[] | undefined;

  // Events live at result.events.events — the outer `events` is a
  // container { events, fields, count, series }.
  let events: unknown[] = [];
  if (resultNode && typeof resultNode === 'object' && !Array.isArray(resultNode)) {
    const r = resultNode as Record<string, unknown>;
    const container = r.events as Record<string, unknown> | undefined;
    if (container && Array.isArray(container.events)) {
      events = container.events as unknown[];
    } else if (Array.isArray(r.events)) {
      events = r.events as unknown[];
    }
  }

  if (!Array.isArray(events)) return [];

  // Keep only events that look like real errors: worker exceptions,
  // known bad outcomes, or explicit error-level logs.
  const ERROR_OUTCOMES = new Set([
    'exception',
    'exceededCpu',
    'exceededMemory',
    'scriptNotFound',
    'unknown',
  ]);
  const filtered = events.filter((raw) => {
    const e = raw as Record<string, unknown>;
    const workers = (e['$workers'] ?? {}) as Record<string, unknown>;
    const meta = (e['$metadata'] ?? {}) as Record<string, unknown>;
    const outcome = workers.outcome as string | undefined;
    if (outcome && ERROR_OUTCOMES.has(outcome)) return true;
    if ((meta.level as string | undefined)?.toLowerCase() === 'error') return true;
    return false;
  });

  if (filtered.length === 0 && events.length > 0) {
    // No client-side match — surface one event's $workers keys so we
    // can refine the predicate if CF marks errors differently than
    // expected.
    const sample = events[0] as Record<string, unknown>;
    const workers = (sample['$workers'] ?? {}) as Record<string, unknown>;
    warnings.push(
      `no errors in ${events.length} recent events ($workers keys: ${Object.keys(workers).join(', ')})`,
    );
    return [];
  }

  const parsed = filtered.map((raw) => {
    const e = raw as Record<string, unknown>;
    const workers = (e['$workers'] ?? {}) as Record<string, unknown>;
    const meta = (e['$metadata'] ?? {}) as Record<string, unknown>;

    const tsRaw = e.timestamp;
    const timestamp =
      typeof tsRaw === 'number'
        ? new Date(tsRaw).toISOString()
        : typeof tsRaw === 'string'
        ? tsRaw
        : new Date().toISOString();

    const script =
      (workers.scriptName as string | undefined) ??
      (meta.service as string | undefined) ??
      '';

    const outcome = workers.outcome as string | undefined;
    const request = (workers.event as Record<string, unknown> | undefined)
      ?.request as Record<string, unknown> | undefined;
    const url = request?.url as string | undefined;
    const method = request?.method as string | undefined;

    const message =
      (meta.error as string | undefined) ??
      (meta.message as string | undefined) ??
      [outcome, method, url].filter(Boolean).join(' ') ??
      JSON.stringify(e).slice(0, 200);

    return { timestamp, script, message };
  });

  // Dedupe by (script, message). Same error firing 10 times collapses
  // to one row with count; keep the most recent timestamp as the
  // displayed one.
  const grouped = new Map<string, ErrorEvent>();
  for (const p of parsed) {
    const key = `${p.script}::${p.message}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      if (p.timestamp > existing.timestamp) existing.timestamp = p.timestamp;
    } else {
      grouped.set(key, { ...p, count: 1 });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 30);
}

// CF returns `__UNKNOWN__` for historical data from deleted workers.
// Collapse those rows into a labelled "Deleted workers" entry.
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

function aggregateWorkerGroups(
  result: BatchResult,
  knownScripts: WorkerScript[],
): WorkerMetrics[] {
  if (!result.ok || !result.data) return [];
  const data = result.data as {
    data?: {
      viewer?: {
        accounts?: Array<{ workersInvocationsAdaptive: WorkerMetricGroup[] }>;
      };
    };
  };
  const groups =
    data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  // Ensure every known script has an entry even if it had zero invocations.
  const byScript = new Map<string, WorkerMetrics>();
  for (const s of knownScripts) {
    byScript.set(s.id, {
      script: s.id,
      invocations: 0,
      errors: 0,
      subrequests: 0,
      series: [],
    });
  }

  const timestampsByScript = new Map<string, Map<string, number>>();
  for (const g of groups) {
    const script = displayScriptName(g.dimensions.scriptName);
    const current =
      byScript.get(script) ??
      {
        script,
        invocations: 0,
        errors: 0,
        subrequests: 0,
        series: [],
      };
    current.invocations += g.sum.requests ?? 0;
    current.errors += g.sum.errors ?? 0;
    current.subrequests += g.sum.subrequests ?? 0;
    byScript.set(script, current);

    const perTime =
      timestampsByScript.get(script) ?? new Map<string, number>();
    const dt = g.dimensions.datetime ?? '';
    perTime.set(dt, (perTime.get(dt) ?? 0) + (g.sum.requests ?? 0));
    timestampsByScript.set(script, perTime);
  }

  for (const [script, summary] of byScript.entries()) {
    const perTime = timestampsByScript.get(script);
    if (!perTime) continue;
    const sorted = Array.from(perTime.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    summary.series = sorted.map(([, v]) => v);
  }

  return Array.from(byScript.values()).sort((a, b) => {
    if (a.script === DELETED_WORKER_LABEL) return 1;
    if (b.script === DELETED_WORKER_LABEL) return -1;
    return b.invocations - a.invocations;
  });
}
