import { useEffect, useState } from 'react';
import {
  batch,
  CloudflareQueries,
  type BatchResult,
  type Query,
} from '../../lib/api';
import {
  formatBytes,
  formatCompact,
  formatRelativeTime,
  isoNow,
  stableNowIso,
  daysAgoIso,
} from '../../lib/format';
import { SkeletonStack } from '../cards/Skeleton';

type Range = '1' | '7' | '30';

interface D1Database {
  uuid: string;
  name: string;
  created_at: string;
  version: string;
  num_tables: number;
  file_size: number;
}

interface R2Bucket {
  name: string;
  creation_date: string;
  location?: string;
}

interface KVNamespace {
  id: string;
  title: string;
}

interface D1Metrics {
  readQueries: number;
  writeQueries: number;
  rowsRead: number;
  rowsWritten: number;
}

interface State {
  loading: boolean;
  error: string | null;
  warnings: string[];
  refreshedAt: string;
  d1: D1Database[];
  r2: R2Bucket[];
  r2Enabled: boolean;
  kv: KVNamespace[];
  d1Metrics: Record<string, D1Metrics>;
  range: Range;
  selectedD1: string | null;
}

// CF error code 10042 = "Please enable R2 through the Cloudflare Dashboard".
// Treat it as "service not provisioned" rather than a failure.
function isServiceNotEnabled(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return (
    errorMessage.includes('10042') ||
    errorMessage.includes('enable R2') ||
    errorMessage.includes('Please enable')
  );
}

const EMPTY_METRICS: D1Metrics = {
  readQueries: 0,
  writeQueries: 0,
  rowsRead: 0,
  rowsWritten: 0,
};

const D1_BY_DATABASE_QUERY = `
  query D1ByDatabase($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { readQueries writeQueries rowsRead rowsWritten }
          dimensions { databaseId }
        }
      }
    }
  }
`;

export default function DataScreen() {
  const [state, setState] = useState<State>({
    loading: true,
    error: null,
    warnings: [],
    refreshedAt: isoNow(),
    d1: [],
    r2: [],
    r2Enabled: true,
    kv: [],
    d1Metrics: {},
    range: '1',
    selectedD1: null,
  });

  async function load(range: Range = state.range) {
    setState((s) => ({ ...s, loading: true, error: null, warnings: [] }));
    try {
      const firstBatch = await batch([
        CloudflareQueries.listD1(),
        CloudflareQueries.listR2(),
        CloudflareQueries.listKV(),
        {
          type: 'rest',
          path: '/accounts',
          cacheTtl: 600,
        } as Query,
      ]);

      const [d1Res, r2Res, kvRes, accountsRes] = firstBatch;

      const warnings: string[] = [];
      if (!d1Res.ok) warnings.push(`d1: ${d1Res.error ?? 'failed'}`);
      if (!r2Res.ok && !isServiceNotEnabled(r2Res.error)) {
        warnings.push(`r2: ${r2Res.error ?? 'failed'}`);
      }
      if (!kvRes.ok) warnings.push(`kv: ${kvRes.error ?? 'failed'}`);

      const r2Enabled = r2Res.ok || !isServiceNotEnabled(r2Res.error);
      const d1List = unwrap<D1Database[]>(d1Res) ?? [];
      const r2List = unwrapR2(r2Res) ?? [];
      const kvList = unwrap<KVNamespace[]>(kvRes) ?? [];
      const accounts = unwrap<Array<{ id: string }>>(accountsRes) ?? [];
      const accountId = accounts[0]?.id ?? null;

      // Second query: D1 analytics grouped by databaseId for the range.
      let d1Metrics: Record<string, D1Metrics> = {};
      if (accountId) {
        const metricsRes = await batch([
          {
            type: 'graphql',
            query: D1_BY_DATABASE_QUERY,
            variables: {
              accountTag: accountId,
              since: daysAgoIso(parseInt(range, 10)),
              until: stableNowIso(),
            },
          },
        ]);

        const mRes = metricsRes[0];
        if (!mRes.ok) {
          warnings.push(`d1 analytics: ${mRes.error ?? 'failed'}`);
        } else if (mRes.data) {
          const data = mRes.data as {
            data?: {
              viewer?: {
                accounts?: Array<{
                  d1AnalyticsAdaptiveGroups: Array<{
                    sum: {
                      readQueries: number;
                      writeQueries: number;
                      rowsRead: number;
                      rowsWritten: number;
                    };
                    dimensions: { databaseId: string };
                  }>;
                }>;
              };
            };
          };
          const groups =
            data.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
          for (const g of groups) {
            const id = g.dimensions.databaseId;
            const current = d1Metrics[id] ?? { ...EMPTY_METRICS };
            current.readQueries += g.sum.readQueries ?? 0;
            current.writeQueries += g.sum.writeQueries ?? 0;
            current.rowsRead += g.sum.rowsRead ?? 0;
            current.rowsWritten += g.sum.rowsWritten ?? 0;
            d1Metrics[id] = current;
          }
        }
      }

      setState({
        loading: false,
        error: null,
        warnings,
        refreshedAt: isoNow(),
        d1: d1List,
        r2: r2List,
        r2Enabled,
        kv: kvList,
        d1Metrics,
        range,
        selectedD1: state.selectedD1,
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
    load(state.range);
  }, []);

  const totalD1Size = state.d1.reduce((acc, d) => acc + (d.file_size ?? 0), 0);
  const totalTables = state.d1.reduce((acc, d) => acc + (d.num_tables ?? 0), 0);

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-title">Data Stores</div>
          <div className="page-meta">
            {state.loading
              ? 'Loading…'
              : state.error
              ? `Error: ${state.error}`
              : `Updated ${formatRelativeTime(state.refreshedAt)}`}
          </div>
        </div>
        <button className="pill" onClick={() => load(state.range)}>
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

      {state.loading && state.d1.length === 0 ? (
        <>
          <div className="section-header">D1</div>
          <SkeletonStack count={4} height={84} />
          <div className="section-header">R2</div>
          <SkeletonStack count={1} height={60} />
          <div className="section-header">KV</div>
          <SkeletonStack count={2} height={52} />
        </>
      ) : (
        <>
      <div className="section-header">
        D1 · {state.d1.length} database{state.d1.length === 1 ? '' : 's'}
      </div>

      <div className="tabs">
        {(['1', '7', '30'] as Range[]).map((r) => (
          <button
            key={r}
            className="tab"
            aria-pressed={state.range === r}
            onClick={() => load(r)}
          >
            {r === '1' ? '24h' : `${r}d`}
          </button>
        ))}
      </div>

      <div className="stack">
        {state.d1.length === 0 && !state.loading && (
          <div className="empty">No D1 databases</div>
        )}
        {[...state.d1]
          .sort((a, b) => {
            const am = state.d1Metrics[a.uuid] ?? EMPTY_METRICS;
            const bm = state.d1Metrics[b.uuid] ?? EMPTY_METRICS;
            return (
              (bm.rowsRead + bm.rowsWritten) - (am.rowsRead + am.rowsWritten)
            );
          })
          .map((db) => {
          const metrics = state.d1Metrics[db.uuid] ?? EMPTY_METRICS;
          const isSelected = state.selectedD1 === db.uuid;
          return (
            <div
              key={db.uuid}
              className="card"
              style={{
                cursor: 'pointer',
                borderColor: isSelected ? 'var(--accent-cyan)' : undefined,
              }}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  selectedD1: isSelected ? null : db.uuid,
                }))
              }
            >
              <div className="card-label">
                <span>{db.name}</span>
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  {formatBytes(db.file_size ?? 0)} · {db.num_tables ?? 0} tables
                </span>
              </div>
              <div
                className="card-value"
                style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}
              >
                <span>
                  {formatCompact(metrics.rowsRead)}
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      marginLeft: 4,
                    }}
                  >
                    reads
                  </span>
                </span>
                <span>
                  {formatCompact(metrics.rowsWritten)}
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      marginLeft: 4,
                    }}
                  >
                    writes
                  </span>
                </span>
              </div>
              {isSelected && (
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border)',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 10,
                  }}
                >
                  <Stat label="Read queries" value={metrics.readQueries} />
                  <Stat label="Write queries" value={metrics.writeQueries} />
                  <Stat label="Rows read" value={metrics.rowsRead} />
                  <Stat label="Rows written" value={metrics.rowsWritten} />
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--text-muted)',
                    }}
                  >
                    v{db.version ?? '—'} · created {db.created_at?.slice(0, 10)}
                    <br />
                    {db.uuid}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {state.d1.length > 0 && (
          <div
            className="card"
            style={{ background: 'transparent', borderStyle: 'dashed' }}
          >
            <div className="card-label">
              <span>Total</span>
              <span className="mono" style={{ color: 'var(--text-muted)' }}>
                {formatCompact(totalTables)} tables
              </span>
            </div>
            <div className="card-value">{formatBytes(totalD1Size)}</div>
          </div>
        )}
      </div>

      <div className="section-header">
        R2{' '}
        {state.r2Enabled
          ? `· ${state.r2.length} bucket${state.r2.length === 1 ? '' : 's'}`
          : '· not enabled'}
      </div>
      <div className="stack">
        {!state.r2Enabled && (
          <div className="card" style={{ borderStyle: 'dashed' }}>
            <div className="card-delta" style={{ marginTop: 0 }}>
              R2 hasn't been activated on this account. Visit{' '}
              <a
                href="https://dash.cloudflare.com/?to=/:account/r2"
                target="_blank"
                rel="noreferrer"
              >
                Cloudflare R2
              </a>{' '}
              to enable it (free tier: 10 GB storage).
            </div>
          </div>
        )}
        {state.r2Enabled && state.r2.length === 0 && !state.loading && (
          <div className="empty">No R2 buckets</div>
        )}
        {state.r2.map((bucket) => (
          <div key={bucket.name} className="card">
            <div className="card-label">
              <span>{bucket.name}</span>
              {bucket.location && (
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  {bucket.location}
                </span>
              )}
            </div>
            <div className="card-delta" style={{ marginTop: 6 }}>
              created {bucket.creation_date?.slice(0, 10)}
            </div>
          </div>
        ))}
      </div>

      <div className="section-header">
        KV · {state.kv.length} namespace{state.kv.length === 1 ? '' : 's'}
      </div>
      <div className="stack">
        {state.kv.length === 0 && !state.loading && (
          <div className="empty">No KV namespaces</div>
        )}
        {state.kv.map((ns) => (
          <div key={ns.id} className="card">
            <div className="card-label">
              <span>{ns.title}</span>
              <span className="mono" style={{ color: 'var(--text-muted)' }}>
                …{ns.id.slice(-6)}
              </span>
            </div>
          </div>
        ))}
      </div>
        </>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--text-secondary)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 16,
          color: 'var(--text-primary)',
          marginTop: 2,
        }}
      >
        {formatCompact(value)}
      </div>
    </div>
  );
}

function unwrap<T>(result: BatchResult): T | null {
  if (!result.ok || !result.data) return null;
  const data = result.data as { result?: T };
  return data.result ?? null;
}

function unwrapR2(result: BatchResult): R2Bucket[] | null {
  if (!result.ok || !result.data) return null;
  const data = result.data as { result?: { buckets?: R2Bucket[] } };
  return data.result?.buckets ?? null;
}
