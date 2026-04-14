import { useEffect, useState } from 'react';
import {
  batch,
  CloudflareQueries,
  AnthropicQueries,
  type BatchResult,
  type Query,
} from '../../lib/api';
import {
  formatRelativeTime,
  formatUSD,
  isoNow,
  stableNowIso,
  daysAgoIso,
} from '../../lib/format';
import {
  unwrapAnthropic,
  type UsageBucket,
} from '../../lib/anthropic';
import { ANTHROPIC_PRICING } from '../../lib/pricing';
import { type AnthropicApiKey } from '../../lib/agents';
import {
  detectApps,
  deriveAppId,
  loadOverrides,
  setAppOverride,
  toggleResourceMembership,
  type DetectedApp,
} from '../../lib/apps';
import MetricCard from '../cards/MetricCard';
import { SkeletonGrid, SkeletonStack } from '../cards/Skeleton';
import Sparkline from '../charts/Sparkline';
import LineChart from '../charts/LineChart';

interface WorkerScript {
  id: string;
}

interface GatewayItem {
  id: string;
  name?: string | null;
}

// Relevant bindings extracted from /workers/scripts/:name/settings.
// Each linked Worker contributes its bindings to the parent app.
interface WorkerBindings {
  d1Ids: string[];
  kvIds: string[];
  r2Buckets: string[];
}

type TileMetric = 'invocations' | 'errors' | 'spend';

interface WorkerMetricGroup {
  sum: { requests: number; errors: number; subrequests: number };
  quantiles?: {
    cpuTimeP50?: number;
    cpuTimeP99?: number;
    wallTimeP50?: number;
    wallTimeP99?: number;
  };
  dimensions: { datetime: string; scriptName: string };
}

interface AppMetrics {
  invocations: number;
  errors: number;
  subrequests: number;
  anthropicSpend: number;
  series: number[];
  errorSeries: number[];
  // Aggregated P50/P99 across member Workers weighted by invocations.
  cpuP50: number | null;
  cpuP99: number | null;
}

// Per-datetime metrics so we can plot a 24h sparkline per app (sum of
// the member Workers' buckets at each timestamp).
// Per-binding usage queries — same datasets as BillingScreen but
// with the resource-id dimension so we can attribute usage to apps.
const D1_PER_DB_QUERY = `
  query D1PerDb($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { rowsRead rowsWritten }
          dimensions { databaseId }
        }
      }
    }
  }
`;

const KV_PER_NS_QUERY = `
  query KvPerNs($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests }
          dimensions { namespaceId actionType }
        }
      }
    }
  }
`;

const KV_STORAGE_PER_NS_QUERY = `
  query KvStoragePerNs($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvStorageAdaptiveGroups(
          limit: 10000
          orderBy: [datetime_DESC]
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          max { byteCount }
          dimensions { namespaceId }
        }
      }
    }
  }
`;

const R2_PER_BUCKET_QUERY = `
  query R2PerBucket($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        r2OperationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests }
          dimensions { bucketName actionType }
        }
      }
    }
  }
`;

const R2_STORAGE_PER_BUCKET_QUERY = `
  query R2StoragePerBucket($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(
          limit: 10000
          orderBy: [datetime_DESC]
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          max { payloadSize metadataSize }
          dimensions { bucketName }
        }
      }
    }
  }
`;

const WORKERS_TIMESERIES_QUERY = `
  query WorkersTimeseries($accountTag: string!, $since: string!, $until: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
          dimensions { datetime scriptName }
        }
      }
    }
  }
`;

export default function AppsScreen() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refreshedAt, setRefreshedAt] = useState(isoNow());
  const [apps, setApps] = useState<DetectedApp[]>([]);
  const [metrics, setMetrics] = useState<Record<string, AppMetrics>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [tileMetric, setTileMetric] = useState<TileMetric>('invocations');
  // Read ?id=foo&mode=edit from URL. mode is 'detail' (default) or 'edit'.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('id');
  });
  const [mode, setMode] = useState<'detail' | 'edit'>(() => {
    if (typeof window === 'undefined') return 'detail';
    return new URLSearchParams(window.location.search).get('mode') === 'edit'
      ? 'edit'
      : 'detail';
  });
  // Bumped on rename so detectApps re-runs with the new override.
  const [overridesVersion, setOverridesVersion] = useState(0);
  // Cached raw inventory so renames don't re-fetch.
  const [inventory, setInventory] = useState<{
    workerScripts: string[];
    anthropicKeys: AnthropicApiKey[];
    gateways: GatewayItem[];
    workerByScript: Map<
      string,
      {
        invocations: number;
        errors: number;
        subrequests: number;
        cpuP50Samples: Array<{ value: number; weight: number }>;
        cpuP99Samples: Array<{ value: number; weight: number }>;
        byTime: Map<string, number>;
        errorByTime: Map<string, number>;
      }
    >;
    datetimes: string[];
    spendByKey: Map<string, number>;
    usageBuckets: UsageBucket[];
    // Bindings discovered from /workers/scripts/:name/settings.
    bindingsByScript: Map<string, WorkerBindings>;
    // Per-binding usage + storage, keyed by resource id. Filtered
    // client-side to an app's linked bindings in the Storage/IO tabs.
    d1ById: Map<string, { rowsRead: number; rowsWritten: number }>;
    d1StorageById: Map<string, number>; // bytes
    d1NameById: Map<string, string>;
    kvById: Map<string, { reads: number; writes: number; deletes: number; lists: number }>;
    kvStorageById: Map<string, number>; // bytes
    r2ByBucket: Map<string, { classA: number; classB: number }>;
    r2StorageByBucket: Map<string, number>; // bytes
  } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setWarnings([]);
    try {
      const stableNow = stableNowIso();
      const since30 = daysAgoIso(30);
      const since1 = daysAgoIso(1);

      const firstBatch = await batch([
        CloudflareQueries.listWorkers(),
        {
          type: 'rest',
          path: '/accounts',
          cacheTtl: 600,
        } as Query,
        CloudflareQueries.listAiGateways(),
        AnthropicQueries.apiKeys(),
        AnthropicQueries.usageDailyByKey(since30, stableNow),
      ]);

      const [
        workersRes,
        accountsRes,
        gatewaysRes,
        keysRes,
        usageRes,
      ] = firstBatch;

      const nextWarnings: string[] = [];
      if (!workersRes.ok)
        nextWarnings.push(`workers: ${workersRes.error ?? 'failed'}`);
      if (!gatewaysRes.ok)
        nextWarnings.push(`gateways: ${gatewaysRes.error ?? 'failed'}`);
      if (!keysRes.ok)
        nextWarnings.push(`keys: ${keysRes.error ?? 'failed'}`);
      if (!usageRes.ok)
        nextWarnings.push(`usage: ${usageRes.error ?? 'failed'}`);

      const workerScripts = unwrapList<WorkerScript>(workersRes).map(
        (w) => w.id,
      );
      const gateways = unwrapList<GatewayItem>(gatewaysRes);
      const anthropicKeys = unwrapAnthropic<AnthropicApiKey>(keysRes);

      // Per-script time-bucketed metrics over 24h. Tile sparklines sum
      // member Workers' buckets; CPU quantiles are collected as
      // (value, weight=requests) samples so we can compute an
      // invocation-weighted mean per app in the detail view.
      const workerByScript = new Map<
        string,
        {
          invocations: number;
          errors: number;
          subrequests: number;
          cpuP50Samples: Array<{ value: number; weight: number }>;
          cpuP99Samples: Array<{ value: number; weight: number }>;
          byTime: Map<string, number>;
          errorByTime: Map<string, number>;
        }
      >();
      const datetimeSet = new Set<string>();
      const accountId = unwrapList<{ id: string }>(accountsRes)[0]?.id ?? null;
      if (accountId) {
        const [workersMetricsRes] = await batch([
          {
            type: 'graphql',
            query: WORKERS_TIMESERIES_QUERY,
            variables: { accountTag: accountId, since: since1, until: stableNow },
          },
        ]);
        if (workersMetricsRes.ok && workersMetricsRes.data) {
          const data = workersMetricsRes.data as {
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
          for (const g of groups) {
            const script = g.dimensions.scriptName;
            if (!script || script.startsWith('pages-worker--')) continue;
            const dt = g.dimensions.datetime ?? '';
            datetimeSet.add(dt);
            const entry =
              workerByScript.get(script) ??
              {
                invocations: 0,
                errors: 0,
                subrequests: 0,
                cpuP50Samples: [],
                cpuP99Samples: [],
                byTime: new Map<string, number>(),
                errorByTime: new Map<string, number>(),
              };
            const reqs = g.sum.requests ?? 0;
            const errs = g.sum.errors ?? 0;
            entry.invocations += reqs;
            entry.errors += errs;
            entry.subrequests += g.sum.subrequests ?? 0;
            entry.byTime.set(dt, (entry.byTime.get(dt) ?? 0) + reqs);
            entry.errorByTime.set(dt, (entry.errorByTime.get(dt) ?? 0) + errs);
            if (g.quantiles?.cpuTimeP50 != null && reqs > 0) {
              entry.cpuP50Samples.push({
                value: g.quantiles.cpuTimeP50,
                weight: reqs,
              });
            }
            if (g.quantiles?.cpuTimeP99 != null && reqs > 0) {
              entry.cpuP99Samples.push({
                value: g.quantiles.cpuTimeP99,
                weight: reqs,
              });
            }
            workerByScript.set(script, entry);
          }
        } else if (workersMetricsRes && !workersMetricsRes.ok) {
          nextWarnings.push(
            `worker metrics: ${workersMetricsRes.error ?? 'failed'}`,
          );
        }
      }
      const datetimes = Array.from(datetimeSet).sort();

      // Anthropic 30d cost per API key (estimated from token usage ×
      // pricing table — same approach as AiSpendScreen).
      const usageBuckets = unwrapAnthropic<UsageBucket>(usageRes);
      const spendByKey = estimateSpendByKey(usageBuckets);

      // Bindings discovery: fetch each Worker's settings in parallel
      // to learn which D1/KV/R2 resources it uses. Cached 10min at
      // the Worker so iteration is cheap.
      const bindingsByScript = new Map<string, WorkerBindings>();
      const d1NameById = new Map<string, string>();
      const d1StorageById = new Map<string, number>();
      if (workerScripts.length > 0) {
        const bindingResults = await batch(
          workerScripts.map((s) => CloudflareQueries.workerSettings(s)),
        );
        for (let i = 0; i < workerScripts.length; i++) {
          const res = bindingResults[i];
          const script = workerScripts[i];
          if (!res.ok || !res.data) continue;
          const data = res.data as {
            result?: { bindings?: Array<Record<string, unknown>> };
          };
          const parsed = parseBindings(data.result?.bindings ?? []);
          bindingsByScript.set(script, parsed);
        }
      }

      // D1 storage + names come from the inventory REST list (already
      // in the first batch if d1Res was present — but we only fetched
      // workers/accounts/gateways/keys/usage. Issue a follow-up call
      // if any app binds D1).
      const needsD1 = Array.from(bindingsByScript.values()).some(
        (b) => b.d1Ids.length > 0,
      );
      if (needsD1) {
        const [d1ListRes] = await batch([CloudflareQueries.listD1()]);
        if (d1ListRes.ok && d1ListRes.data) {
          const d1data = d1ListRes.data as {
            result?: Array<{ uuid: string; name?: string; file_size?: number }>;
          };
          for (const db of d1data.result ?? []) {
            if (db.name) d1NameById.set(db.uuid, db.name);
            if (db.file_size != null) d1StorageById.set(db.uuid, db.file_size);
          }
        }
      }

      // Per-binding usage (D1 ops, KV ops+storage, R2 ops+storage) over
      // the CF billing cycle so the Storage/IO tabs show meaningful
      // totals, not just 24h slices.
      const d1ById = new Map<string, { rowsRead: number; rowsWritten: number }>();
      const kvById = new Map<
        string,
        { reads: number; writes: number; deletes: number; lists: number }
      >();
      const kvStorageById = new Map<string, number>();
      const r2ByBucket = new Map<string, { classA: number; classB: number }>();
      const r2StorageByBucket = new Map<string, number>();

      if (accountId && bindingsByScript.size > 0) {
        const since30d = since30; // 30 days of usage data
        const vars = { accountTag: accountId, since: since30d, until: stableNow };
        const usageBatch = await batch([
          { type: 'graphql', query: D1_PER_DB_QUERY, variables: vars },
          { type: 'graphql', query: KV_PER_NS_QUERY, variables: vars },
          { type: 'graphql', query: KV_STORAGE_PER_NS_QUERY, variables: vars },
          { type: 'graphql', query: R2_PER_BUCKET_QUERY, variables: vars },
          { type: 'graphql', query: R2_STORAGE_PER_BUCKET_QUERY, variables: vars },
        ]);
        const [d1Res, kvOpsRes, kvStorageRes, r2OpsRes, r2StorageRes] = usageBatch;

        // D1 rows read/written per database
        if (d1Res.ok && d1Res.data) {
          const gs = unwrapGraphQL<{
            sum: { rowsRead: number; rowsWritten: number };
            dimensions: { databaseId: string };
          }>(d1Res, 'd1AnalyticsAdaptiveGroups');
          for (const g of gs) {
            const id = g.dimensions.databaseId;
            if (!id) continue;
            const entry = d1ById.get(id) ?? { rowsRead: 0, rowsWritten: 0 };
            entry.rowsRead += g.sum.rowsRead ?? 0;
            entry.rowsWritten += g.sum.rowsWritten ?? 0;
            d1ById.set(id, entry);
          }
        }

        // KV ops per (namespace, actionType)
        if (kvOpsRes.ok && kvOpsRes.data) {
          const gs = unwrapGraphQL<{
            sum: { requests: number };
            dimensions: { namespaceId: string; actionType: string };
          }>(kvOpsRes, 'kvOperationsAdaptiveGroups');
          for (const g of gs) {
            const id = g.dimensions.namespaceId;
            if (!id) continue;
            const entry =
              kvById.get(id) ??
              { reads: 0, writes: 0, deletes: 0, lists: 0 };
            const c = g.sum.requests ?? 0;
            switch ((g.dimensions.actionType ?? '').toLowerCase()) {
              case 'read':
                entry.reads += c;
                break;
              case 'write':
                entry.writes += c;
                break;
              case 'delete':
                entry.deletes += c;
                break;
              case 'list':
                entry.lists += c;
                break;
            }
            kvById.set(id, entry);
          }
        }

        // KV storage — latest sample per namespace
        if (kvStorageRes.ok && kvStorageRes.data) {
          const gs = unwrapGraphQL<{
            max: { byteCount: number };
            dimensions: { namespaceId: string };
          }>(kvStorageRes, 'kvStorageAdaptiveGroups');
          for (const g of gs) {
            const id = g.dimensions.namespaceId;
            if (!id || kvStorageById.has(id)) continue; // take first (newest) only
            kvStorageById.set(id, g.max.byteCount ?? 0);
          }
        }

        // R2 ops per (bucket, Class A/B). Class B = Get/Head; all else = A.
        if (r2OpsRes.ok && r2OpsRes.data) {
          const gs = unwrapGraphQL<{
            sum: { requests: number };
            dimensions: { bucketName: string; actionType: string };
          }>(r2OpsRes, 'r2OperationsAdaptiveGroups');
          for (const g of gs) {
            const b = g.dimensions.bucketName;
            if (!b) continue;
            const entry = r2ByBucket.get(b) ?? { classA: 0, classB: 0 };
            const c = g.sum.requests ?? 0;
            const isClassB = /^(Get|Head)/i.test(g.dimensions.actionType ?? '');
            if (isClassB) entry.classB += c;
            else entry.classA += c;
            r2ByBucket.set(b, entry);
          }
        }

        // R2 storage — latest sample per bucket
        if (r2StorageRes.ok && r2StorageRes.data) {
          const gs = unwrapGraphQL<{
            max: { payloadSize: number; metadataSize: number };
            dimensions: { bucketName: string };
          }>(r2StorageRes, 'r2StorageAdaptiveGroups');
          for (const g of gs) {
            const b = g.dimensions.bucketName;
            if (!b || r2StorageByBucket.has(b)) continue;
            r2StorageByBucket.set(
              b,
              (g.max.payloadSize ?? 0) + (g.max.metadataSize ?? 0),
            );
          }
        }
      }

      setInventory({
        workerScripts,
        anthropicKeys,
        gateways,
        workerByScript,
        datetimes,
        spendByKey,
        usageBuckets,
        bindingsByScript,
        d1ById,
        d1StorageById,
        d1NameById,
        kvById,
        kvStorageById,
        r2ByBucket,
        r2StorageByBucket,
      });
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

  // Re-derive apps whenever inventory or overrides change.
  useEffect(() => {
    if (!inventory) return;
    const overrides = loadOverrides();
    const detected = detectApps({
      workerScripts: inventory.workerScripts,
      anthropicKeys: inventory.anthropicKeys.map((k) => ({
        id: k.id,
        name: k.name,
      })),
      gateways: inventory.gateways.map((g) => ({ id: g.id, name: g.name })),
      overrides,
    });
    setApps(detected);
    const m: Record<string, AppMetrics> = {};
    for (const app of detected) {
      let invocations = 0;
      let errors = 0;
      let subrequests = 0;
      // Sum worker buckets at each timestamp to build the app-level
      // time series — a tile sparkline shows the whole app's traffic
      // pattern, not one Worker's.
      const series: number[] = inventory.datetimes.map(() => 0);
      const errorSeries: number[] = inventory.datetimes.map(() => 0);
      const cpu50: Array<{ value: number; weight: number }> = [];
      const cpu99: Array<{ value: number; weight: number }> = [];
      for (const script of app.workers) {
        const w = inventory.workerByScript.get(script);
        if (!w) continue;
        invocations += w.invocations;
        errors += w.errors;
        subrequests += w.subrequests;
        cpu50.push(...w.cpuP50Samples);
        cpu99.push(...w.cpuP99Samples);
        for (let i = 0; i < inventory.datetimes.length; i++) {
          series[i] += w.byTime.get(inventory.datetimes[i]) ?? 0;
          errorSeries[i] += w.errorByTime.get(inventory.datetimes[i]) ?? 0;
        }
      }
      let spend = 0;
      for (const keyId of app.anthropicKeyIds) {
        spend += inventory.spendByKey.get(keyId) ?? 0;
      }
      m[app.id] = {
        invocations,
        errors,
        subrequests,
        anthropicSpend: spend,
        series,
        errorSeries,
        cpuP50: weightedMean(cpu50),
        cpuP99: weightedMean(cpu99),
      };
    }
    setMetrics(m);
  }, [inventory, overridesVersion]);

  // Keep selectedId + mode in sync with the URL when user uses
  // browser back/fwd.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedId(params.get('id'));
      setMode(params.get('mode') === 'edit' ? 'edit' : 'detail');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function navigateToApp(
    id: string | null,
    nextMode: 'detail' | 'edit' = 'detail',
  ) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (id) {
      url.searchParams.set('id', id);
      if (nextMode === 'edit') url.searchParams.set('mode', 'edit');
      else url.searchParams.delete('mode');
    } else {
      url.searchParams.delete('id');
      url.searchParams.delete('mode');
    }
    window.history.pushState({}, '', url.toString());
    setSelectedId(id);
    setMode(nextMode);
  }

  function startRename(app: DetectedApp) {
    setEditingId(app.id);
    setRenameDraft(app.name);
  }

  function commitRename(app: DetectedApp) {
    const next = renameDraft.trim();
    if (next && next !== app.name) {
      setAppOverride(app.id, { displayName: next });
      setOverridesVersion((v) => v + 1);
    }
    setEditingId(null);
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-title">Apps</div>
          <div className="page-meta">
            {loading
              ? 'Loading…'
              : error
              ? `Error: ${error}`
              : `Updated ${formatRelativeTime(refreshedAt)} · ${apps.length} detected`}
          </div>
        </div>
        <button className="pill" onClick={load} style={{ cursor: 'pointer' }}>
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
              Notes
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

      {loading && apps.length === 0 ? (
        <>
          <SkeletonGrid count={4} />
          <SkeletonStack count={4} height={140} />
        </>
      ) : selectedId && mode === 'edit' ? (
        renderEditMode(
          apps.find((a) => a.id === selectedId) ?? null,
          metrics,
          inventory,
          () => navigateToApp(selectedId, 'detail'),
          (id) => {
            setOverridesVersion((v) => v + 1);
            return id;
          },
        )
      ) : selectedId ? (
        renderDetailView(
          apps.find((a) => a.id === selectedId) ?? null,
          metrics,
          inventory,
          () => navigateToApp(null),
          () => navigateToApp(selectedId, 'edit'),
        )
      ) : (
        <>
          <div className="grid cols-2">
            <MetricCard
              label="Apps detected"
              value={apps.length.toString()}
              tone="cf"
            />
            <MetricCard
              label="Linked Workers"
              value={apps
                .reduce((acc, a) => acc + a.workers.length, 0)
                .toString()}
              tone="cf"
            />
          </div>

          <div
            className="section-header"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>All apps</span>
            <div
              className="tabs"
              style={{ padding: 0, margin: 0, flexShrink: 0 }}
            >
              {(
                [
                  { id: 'invocations' as const, label: 'Invocations' },
                  { id: 'errors' as const, label: 'Errors' },
                  { id: 'spend' as const, label: 'Spend' },
                ]
              ).map((o) => (
                <button
                  key={o.id}
                  className="tab"
                  aria-pressed={tileMetric === o.id}
                  onClick={() => setTileMetric(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {apps.length === 0 ? (
            <div className="empty">
              No apps detected. Add Workers in CF and refresh.
            </div>
          ) : (
            <div className="apps-grid">
              {apps.map((app) => {
                const m = metrics[app.id] ?? {
                  invocations: 0,
                  errors: 0,
                  anthropicSpend: 0,
                  series: [],
                };
                const isEditing = editingId === app.id;
                const hasErrors = m.errors > 0;
                return (
                  <div
                    key={app.id}
                    className="app-tile"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!isEditing) navigateToApp(app.id);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !isEditing) {
                        e.preventDefault();
                        navigateToApp(app.id);
                      }
                    }}
                    style={{
                      cursor: isEditing ? 'default' : 'pointer',
                      borderColor: hasErrors ? 'var(--accent-red)' : undefined,
                    }}
                  >
                    <div className="app-tile-header">
                      {isEditing ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => commitRename(app)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitRename(app);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid var(--border)',
                            color: 'var(--text-primary)',
                            padding: '2px 6px',
                            fontSize: 12,
                            borderRadius: 4,
                            width: '85%',
                          }}
                        />
                      ) : (
                        <div className="app-tile-title">
                          <span>{app.name}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(app);
                            }}
                            className="app-tile-rename"
                            aria-label="Rename app"
                          >
                            ✎
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigateToApp(app.id, 'edit');
                            }}
                            className="app-tile-rename"
                            aria-label="Edit linked components"
                            title="Edit linked components"
                          >
                            ⚙
                          </button>
                        </div>
                      )}
                      <div className="app-tile-components">
                        {app.workers.length}w · {app.anthropicKeyIds.length}k ·{' '}
                        {app.gatewayIds.length}g
                      </div>
                    </div>

                    {(() => {
                      const metricView = tileMetricView(tileMetric, m);
                      return (
                        <>
                          <div className="app-tile-value">
                            {metricView.value}
                            <span className="app-tile-value-unit">
                              {metricView.unit}
                            </span>
                          </div>
                          <div className="app-tile-sparkline">
                            {metricView.series.some((v) => v > 0) ? (
                              <Sparkline
                                values={metricView.series}
                                color={metricView.color}
                                height={48}
                                width={200}
                              />
                            ) : (
                              <div className="app-tile-sparkline-empty">
                                {metricView.empty}
                              </div>
                            )}
                          </div>
                        </>
                      );
                    })()}

                    <div className="app-tile-footer">
                      <span
                        style={{
                          color: hasErrors
                            ? 'var(--accent-red)'
                            : 'var(--text-muted)',
                        }}
                      >
                        {hasErrors ? `${m.errors} err` : '0 err'}
                      </span>
                      <span
                        style={{
                          color:
                            m.anthropicSpend > 0
                              ? 'var(--tone-anthropic)'
                              : 'var(--text-muted)',
                        }}
                      >
                        {m.anthropicSpend > 0
                          ? formatUSD(m.anthropicSpend)
                          : '—'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="section-header">How linking works</div>
          <details className="info-card">
            <summary>Auto-detection rules + how to override</summary>
            <div className="info-body">
              Apps are derived from Worker name prefixes (e.g.{' '}
              <span className="mono">the-edge-api</span> and{' '}
              <span className="mono">the-edge-frontend</span> both group under
              "the-edge"). Anthropic API keys + AI Gateways are matched to
              apps when their name contains the app id. Tap a card to open
              the detail view where you can manually link / unlink any
              Worker, key or gateway. Overrides are stored in your browser
              only.
            </div>
          </details>
        </>
      )}
    </>
  );
}

// ---- Detail view -------------------------------------------------------

interface DetailInventory {
  workerScripts: string[];
  anthropicKeys: AnthropicApiKey[];
  gateways: GatewayItem[];
  workerByScript: Map<
    string,
    {
      invocations: number;
      errors: number;
      subrequests: number;
      cpuP50Samples: Array<{ value: number; weight: number }>;
      cpuP99Samples: Array<{ value: number; weight: number }>;
      byTime: Map<string, number>;
      errorByTime: Map<string, number>;
    }
  >;
  datetimes: string[];
  spendByKey: Map<string, number>;
  usageBuckets: UsageBucket[];
  bindingsByScript: Map<string, WorkerBindings>;
  d1ById: Map<string, { rowsRead: number; rowsWritten: number }>;
  d1StorageById: Map<string, number>;
  d1NameById: Map<string, string>;
  kvById: Map<string, { reads: number; writes: number; deletes: number; lists: number }>;
  kvStorageById: Map<string, number>;
  r2ByBucket: Map<string, { classA: number; classB: number }>;
  r2StorageByBucket: Map<string, number>;
}

function renderEditMode(
  app: DetectedApp | null,
  metrics: Record<string, AppMetrics>,
  inventory: DetailInventory | null,
  goBack: () => void,
  onToggle: (appId: string) => string,
) {
  if (!app || !inventory) {
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        App not found.{' '}
        <button
          onClick={goBack}
          className="pill"
          style={{ marginLeft: 8, cursor: 'pointer' }}
        >
          Back to list
        </button>
      </div>
    );
  }

  const m = metrics[app.id] ?? {
    invocations: 0,
    errors: 0,
    anthropicSpend: 0,
  };

  const handleToggle = (
    type: 'workers' | 'keys' | 'gateways',
    id: string,
    nowMember: boolean,
    autoMatched: boolean,
  ) => {
    toggleResourceMembership(app.id, type, id, nowMember, autoMatched);
    onToggle(app.id);
  };

  // Compute auto-matched sets independent of current overrides so the
  // toggle UI knows whether ticking off a row needs a positive
  // exclusion (auto-matched) vs just removing an include (manual).
  const autoWorkers = new Set(
    inventory.workerScripts.filter((s) => deriveAppId(s) === app.id),
  );
  const autoKeys = new Set(
    inventory.anthropicKeys
      .filter((k) => (k.name ?? '').toLowerCase().includes(app.id))
      .map((k) => k.id),
  );
  const autoGateways = new Set(
    inventory.gateways
      .filter((g) => (g.name ?? '').toLowerCase().includes(app.id))
      .map((g) => g.id),
  );

  const memberWorkers = new Set(app.workers);
  const memberKeys = new Set(app.anthropicKeyIds);
  const memberGateways = new Set(app.gatewayIds);

  return (
    <>
      <div
        className="stack"
        style={{
          marginTop: 4,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button
          onClick={goBack}
          className="pill"
          style={{ cursor: 'pointer' }}
        >
          ← Back
        </button>
        <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          Editing components for <strong>{app.name}</strong>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <MetricCard
          label="24h Invocations"
          value={formatCompact(m.invocations)}
          status={m.errors > 0 ? 'warning' : 'healthy'}
          delta={m.errors > 0 ? `${m.errors} errors` : 'no errors'}
          tone="cf"
        />
        <MetricCard
          label="Anthropic 30d"
          value={formatUSD(m.anthropicSpend)}
          delta={`${app.anthropicKeyIds.length} key${
            app.anthropicKeyIds.length === 1 ? '' : 's'
          }`}
          tone="anthropic"
        />
      </div>

      <ResourceSection
        title="Workers"
        empty="No Workers linked"
        items={inventory.workerScripts
          .filter((s) => !s.startsWith('pages-worker--'))
          .map((script) => ({
            id: script,
            label: script,
            sub: (() => {
              const w = inventory.workerByScript.get(script);
              if (!w) return 'no 24h data';
              return `${formatCompact(w.invocations)} req${
                w.errors > 0 ? ` · ${w.errors} err` : ''
              }`;
            })(),
            checked: memberWorkers.has(script),
            auto: autoWorkers.has(script),
          }))}
        onToggle={(id, checked) =>
          handleToggle('workers', id, checked, autoWorkers.has(id))
        }
      />

      <ResourceSection
        title="Anthropic API keys"
        empty="No Anthropic keys"
        items={inventory.anthropicKeys.map((k) => ({
          id: k.id,
          label: k.name || `Key …${k.id.slice(-6)}`,
          sub: `30d ${formatUSD(inventory.spendByKey.get(k.id) ?? 0)}`,
          checked: memberKeys.has(k.id),
          auto: autoKeys.has(k.id),
        }))}
        onToggle={(id, checked) =>
          handleToggle('keys', id, checked, autoKeys.has(id))
        }
      />

      <ResourceSection
        title="AI Gateways"
        empty="No AI Gateways configured"
        items={inventory.gateways.map((g) => ({
          id: g.id,
          label: g.name || g.id,
          sub: g.id,
          checked: memberGateways.has(g.id),
          auto: autoGateways.has(g.id),
        }))}
        onToggle={(id, checked) =>
          handleToggle('gateways', id, checked, autoGateways.has(id))
        }
      />
    </>
  );
}

interface ResourceItem {
  id: string;
  label: string;
  sub: string;
  checked: boolean;
  auto: boolean;
}

function ResourceSection({
  title,
  empty,
  items,
  onToggle,
}: {
  title: string;
  empty: string;
  items: ResourceItem[];
  onToggle: (id: string, nowChecked: boolean) => void;
}) {
  // Sort: linked first, then auto-matched-but-unchecked, then unrelated.
  const sorted = [...items].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? -1 : 1;
    if (a.auto !== b.auto) return a.auto ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return (
    <>
      <div className="section-header">{title}</div>
      <div className="stack">
        {sorted.length === 0 && <div className="empty">{empty}</div>}
        {sorted.map((it) => (
          <label
            key={it.id}
            className="card"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              cursor: 'pointer',
              opacity: it.checked || it.auto ? 1 : 0.55,
            }}
          >
            <input
              type="checkbox"
              checked={it.checked}
              onChange={(e) => onToggle(it.id, e.target.checked)}
              style={{ width: 18, height: 18, cursor: 'pointer' }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="card-label"
                style={{ display: 'block', marginBottom: 2 }}
              >
                {it.label}
                {it.auto && (
                  <span
                    style={{
                      marginLeft: 8,
                      color: 'var(--text-muted)',
                      fontSize: 9,
                    }}
                  >
                    auto
                  </span>
                )}
              </div>
              <div
                className="card-delta"
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  fontSize: 10,
                }}
              >
                {it.sub}
              </div>
            </div>
          </label>
        ))}
      </div>
    </>
  );
}


// ---- Detail view (read-only stats) ------------------------------------

type DetailTab = 'traffic' | 'compute' | 'storage' | 'io' | 'ai';
const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'traffic', label: 'Traffic' },
  { id: 'compute', label: 'Compute' },
  { id: 'storage', label: 'Storage' },
  { id: 'io', label: 'IO' },
  { id: 'ai', label: 'AI' },
];

function renderDetailView(
  app: DetectedApp | null,
  metrics: Record<string, AppMetrics>,
  inventory: DetailInventory | null,
  goBack: () => void,
  openEdit: () => void,
) {
  if (!app || !inventory) {
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        App not found.{' '}
        <button
          onClick={goBack}
          className="pill"
          style={{ marginLeft: 8, cursor: 'pointer' }}
        >
          Back to list
        </button>
      </div>
    );
  }
  return (
    <AppDetailView
      app={app}
      metrics={metrics[app.id]}
      inventory={inventory}
      goBack={goBack}
      openEdit={openEdit}
    />
  );
}

function AppDetailView({
  app,
  metrics,
  inventory,
  goBack,
  openEdit,
}: {
  app: DetectedApp;
  metrics?: AppMetrics;
  inventory: DetailInventory;
  goBack: () => void;
  openEdit: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('traffic');
  const m = metrics ?? {
    invocations: 0,
    errors: 0,
    subrequests: 0,
    anthropicSpend: 0,
    series: [],
    errorSeries: [],
    cpuP50: null,
    cpuP99: null,
  };

  return (
    <>
      <div
        className="stack"
        style={{
          marginTop: 4,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button onClick={goBack} className="pill" style={{ cursor: 'pointer' }}>
          ← All apps
        </button>
        <div
          style={{
            flex: 1,
            color: 'var(--text-primary)',
            fontSize: 15,
            fontWeight: 500,
            marginLeft: 4,
          }}
        >
          {app.name}
        </div>
        <button
          onClick={openEdit}
          className="pill"
          style={{ cursor: 'pointer' }}
          aria-label="Edit linked components"
        >
          ⚙ Edit
        </button>
      </div>

      <div className="tabs" style={{ marginTop: 12 }}>
        {DETAIL_TABS.map((t) => (
          <button
            key={t.id}
            className="tab"
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'traffic' && <TrafficTab app={app} m={m} inventory={inventory} />}
      {tab === 'compute' && <ComputeTab m={m} inventory={inventory} app={app} />}
      {tab === 'storage' && <StorageTab app={app} inventory={inventory} />}
      {tab === 'io' && <IoTab app={app} inventory={inventory} />}
      {tab === 'ai' && <AiTab app={app} m={m} inventory={inventory} />}
    </>
  );
}

function TrafficTab({
  app,
  m,
  inventory,
}: {
  app: DetectedApp;
  m: AppMetrics;
  inventory: DetailInventory;
}) {
  const labels = inventory.datetimes.map((dt) => dt.slice(11, 16));
  const errorRate = m.invocations > 0 ? (m.errors / m.invocations) * 100 : 0;

  return (
    <>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <MetricCard
          label="24h Invocations"
          value={formatCompact(m.invocations)}
          status={m.errors > 0 ? 'warning' : 'healthy'}
          delta={`${m.errors} errors · ${errorRate.toFixed(2)}%`}
          tone="cf"
        />
        <MetricCard
          label="Subrequests"
          value={formatCompact(m.subrequests)}
          delta="24h"
          tone="cf"
        />
      </div>

      <div className="section-header tone-cf">Invocations · 24h</div>
      <div className="stack">
        <div className="card">
          {m.series.length > 0 ? (
            <LineChart
              labels={labels}
              values={m.series}
              label="Requests"
              color="#06b6d4"
            />
          ) : (
            <div className="empty">No traffic in last 24h</div>
          )}
        </div>
      </div>

      {m.errors > 0 && (
        <>
          <div className="section-header" style={{ color: 'var(--accent-red)' }}>
            Errors · 24h
          </div>
          <div className="stack">
            <div className="card">
              <LineChart
                labels={labels}
                values={m.errorSeries}
                label="Errors"
                color="#ff4444"
              />
            </div>
          </div>
        </>
      )}

      <div className="section-header">Per Worker · 24h</div>
      <div className="stack">
        {app.workers.length === 0 && (
          <div className="empty">No Workers linked</div>
        )}
        {app.workers.map((script) => {
          const w = inventory.workerByScript.get(script);
          const invocations = w?.invocations ?? 0;
          const errors = w?.errors ?? 0;
          return (
            <div key={script} className="card">
              <div className="card-label">
                <span>{script}</span>
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  {errors > 0 ? `${errors} err` : 'healthy'}
                </span>
              </div>
              <div className="card-value">{formatCompact(invocations)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ComputeTab({
  m,
  inventory,
  app,
}: {
  m: AppMetrics;
  inventory: DetailInventory;
  app: DetectedApp;
}) {
  const errorRate = m.invocations > 0 ? (m.errors / m.invocations) * 100 : 0;
  return (
    <>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <MetricCard
          label="CPU P50"
          value={m.cpuP50 != null ? `${formatMs(m.cpuP50)}` : '—'}
          delta="per-request median"
          tone="cf"
        />
        <MetricCard
          label="CPU P99"
          value={m.cpuP99 != null ? `${formatMs(m.cpuP99)}` : '—'}
          delta="tail latency"
          tone="cf"
        />
        <MetricCard
          label="Error Rate"
          value={`${errorRate.toFixed(2)}%`}
          status={errorRate > 1 ? 'error' : errorRate > 0.1 ? 'warning' : 'healthy'}
          delta={`${m.errors} / ${formatCompact(m.invocations)}`}
          tone="cf"
        />
        <MetricCard
          label="Subrequests / req"
          value={
            m.invocations > 0
              ? (m.subrequests / m.invocations).toFixed(2)
              : '—'
          }
          delta="fan-out factor"
          tone="cf"
        />
      </div>

      <div className="section-header">Per Worker · CPU</div>
      <div className="stack">
        {app.workers.map((script) => {
          const w = inventory.workerByScript.get(script);
          const p50 = w ? weightedMean(w.cpuP50Samples) : null;
          const p99 = w ? weightedMean(w.cpuP99Samples) : null;
          return (
            <div key={script} className="card">
              <div className="card-label">
                <span>{script}</span>
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  {p50 != null ? `P50 ${formatMs(p50)}` : 'no CPU data'}
                  {p99 != null ? ` · P99 ${formatMs(p99)}` : ''}
                </span>
              </div>
              <div
                className="card-delta"
                style={{ marginTop: 6, color: 'var(--text-muted)' }}
              >
                CF exposes CPU as a quantile, not a sum — exact billable CPU
                needs Logpush.
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function AiTab({
  app,
  m,
  inventory,
}: {
  app: DetectedApp;
  m: AppMetrics;
  inventory: DetailInventory;
}) {
  const appKeyIds = new Set(app.anthropicKeyIds);
  // Aggregate tokens by model for this app's API keys.
  const byModel = new Map<
    string,
    { input: number; output: number; cacheRead: number; cost: number }
  >();
  for (const bucket of inventory.usageBuckets) {
    for (const item of bucket.results ?? []) {
      const keyId = item.api_key_id ?? 'console';
      if (!appKeyIds.has(keyId)) continue;
      const entry =
        byModel.get(item.model) ??
        { input: 0, output: 0, cacheRead: 0, cost: 0 };
      const uncachedInput = item.uncached_input_tokens ?? 0;
      const cacheRead = item.cache_read_input_tokens ?? 0;
      const cache5m = item.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      const cache1h = item.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const output = item.output_tokens ?? 0;
      entry.input += uncachedInput + cache5m + cache1h;
      entry.cacheRead += cacheRead;
      entry.output += output;
      const pricing = resolvePricing(item.model);
      if (pricing) {
        entry.cost +=
          (uncachedInput / 1_000_000) * pricing.input +
          (cacheRead / 1_000_000) * pricing.cacheRead +
          (cache5m / 1_000_000) * pricing.cacheWrite5m +
          (cache1h / 1_000_000) * pricing.cacheWrite1h +
          (output / 1_000_000) * pricing.output;
      }
      byModel.set(item.model, entry);
    }
  }
  const modelRows = Array.from(byModel.entries())
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.cost - a.cost);
  const totalTokens = modelRows.reduce(
    (acc, r) => acc + r.input + r.output + r.cacheRead,
    0,
  );

  return (
    <>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <MetricCard
          label="Anthropic 30d"
          value={formatUSD(m.anthropicSpend)}
          delta={`${app.anthropicKeyIds.length} key${
            app.anthropicKeyIds.length === 1 ? '' : 's'
          }`}
          tone="anthropic"
        />
        <MetricCard
          label="Total Tokens 30d"
          value={formatCompact(totalTokens)}
          delta="input + output + cache"
          tone="anthropic"
        />
      </div>

      <div className="section-header tone-anthropic">By Model · 30d</div>
      <div className="stack">
        {modelRows.length === 0 && (
          <div className="empty">No Anthropic usage for this app</div>
        )}
        {modelRows.map((r) => (
          <div key={r.model} className="card">
            <div className="card-label">
              <span>{r.model}</span>
              <span className="mono" style={{ color: 'var(--text-muted)' }}>
                {formatUSD(r.cost)}
              </span>
            </div>
            <div
              className="card-delta"
              style={{ marginTop: 6, color: 'var(--text-muted)' }}
            >
              in {formatCompact(r.input)} · out {formatCompact(r.output)} ·
              cache {formatCompact(r.cacheRead)}
            </div>
          </div>
        ))}
      </div>

      {app.gatewayIds.length > 0 && (
        <>
          <div className="section-header tone-cf">AI Gateways</div>
          <div className="stack">
            {app.gatewayIds.map((gid) => {
              const g = inventory.gateways.find((x) => x.id === gid);
              return (
                <div key={gid} className="card">
                  <div className="card-label">
                    <span>{g?.name || gid}</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      {gid}
                    </span>
                  </div>
                  <div
                    className="card-delta"
                    style={{ marginTop: 6, color: 'var(--text-muted)' }}
                  >
                    See AI tab → Gateways for live counts
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

// Union of every D1/KV/R2 binding across the app's linked Workers,
// deduped so a resource bound by two Workers is counted once.
function appBindings(
  app: DetectedApp,
  inventory: DetailInventory,
): WorkerBindings {
  const d1 = new Set<string>();
  const kv = new Set<string>();
  const r2 = new Set<string>();
  for (const script of app.workers) {
    const b = inventory.bindingsByScript.get(script);
    if (!b) continue;
    b.d1Ids.forEach((x) => d1.add(x));
    b.kvIds.forEach((x) => kv.add(x));
    b.r2Buckets.forEach((x) => r2.add(x));
  }
  return {
    d1Ids: Array.from(d1),
    kvIds: Array.from(kv),
    r2Buckets: Array.from(r2),
  };
}

function StorageTab({
  app,
  inventory,
}: {
  app: DetectedApp;
  inventory: DetailInventory;
}) {
  const b = appBindings(app, inventory);
  const d1TotalBytes = b.d1Ids.reduce(
    (acc, id) => acc + (inventory.d1StorageById.get(id) ?? 0),
    0,
  );
  const kvTotalBytes = b.kvIds.reduce(
    (acc, id) => acc + (inventory.kvStorageById.get(id) ?? 0),
    0,
  );
  const r2TotalBytes = b.r2Buckets.reduce(
    (acc, name) => acc + (inventory.r2StorageByBucket.get(name) ?? 0),
    0,
  );

  const totalBindings = b.d1Ids.length + b.kvIds.length + b.r2Buckets.length;
  if (totalBindings === 0) {
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        No D1, KV, or R2 bindings found on linked Workers.
      </div>
    );
  }

  return (
    <>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <MetricCard
          label="D1 Storage"
          value={formatGB(d1TotalBytes)}
          delta={`${b.d1Ids.length} database${b.d1Ids.length === 1 ? '' : 's'}`}
          tone="cf"
        />
        <MetricCard
          label="KV Storage"
          value={formatGB(kvTotalBytes)}
          delta={`${b.kvIds.length} namespace${b.kvIds.length === 1 ? '' : 's'}`}
          tone="cf"
        />
        <MetricCard
          label="R2 Storage"
          value={formatGB(r2TotalBytes)}
          delta={`${b.r2Buckets.length} bucket${b.r2Buckets.length === 1 ? '' : 's'}`}
          tone="cf"
        />
        <MetricCard
          label="Combined"
          value={formatGB(d1TotalBytes + kvTotalBytes + r2TotalBytes)}
          delta="all storage"
          tone="cf"
        />
      </div>

      {b.d1Ids.length > 0 && (
        <>
          <div className="section-header tone-cf">D1 Databases</div>
          <div className="stack">
            {b.d1Ids.map((id) => (
              <div key={id} className="card">
                <div className="card-label">
                  <span>{inventory.d1NameById.get(id) ?? id}</span>
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>
                    {formatGB(inventory.d1StorageById.get(id) ?? 0)}
                  </span>
                </div>
                <div
                  className="card-delta"
                  style={{ marginTop: 6, color: 'var(--text-muted)' }}
                >
                  {id}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {b.kvIds.length > 0 && (
        <>
          <div className="section-header tone-cf">KV Namespaces</div>
          <div className="stack">
            {b.kvIds.map((id) => (
              <div key={id} className="card">
                <div className="card-label">
                  <span>{id.slice(0, 16)}…</span>
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>
                    {formatGB(inventory.kvStorageById.get(id) ?? 0)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {b.r2Buckets.length > 0 && (
        <>
          <div className="section-header tone-cf">R2 Buckets</div>
          <div className="stack">
            {b.r2Buckets.map((name) => (
              <div key={name} className="card">
                <div className="card-label">
                  <span>{name}</span>
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>
                    {formatGB(inventory.r2StorageByBucket.get(name) ?? 0)}
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

function IoTab({
  app,
  inventory,
}: {
  app: DetectedApp;
  inventory: DetailInventory;
}) {
  const b = appBindings(app, inventory);

  const d1RowsRead = b.d1Ids.reduce(
    (acc, id) => acc + (inventory.d1ById.get(id)?.rowsRead ?? 0),
    0,
  );
  const d1RowsWritten = b.d1Ids.reduce(
    (acc, id) => acc + (inventory.d1ById.get(id)?.rowsWritten ?? 0),
    0,
  );
  const kvReads = b.kvIds.reduce(
    (acc, id) => acc + (inventory.kvById.get(id)?.reads ?? 0),
    0,
  );
  const kvWrites = b.kvIds.reduce(
    (acc, id) =>
      acc +
      (inventory.kvById.get(id)?.writes ?? 0) +
      (inventory.kvById.get(id)?.deletes ?? 0) +
      (inventory.kvById.get(id)?.lists ?? 0),
    0,
  );
  const r2ClassA = b.r2Buckets.reduce(
    (acc, name) => acc + (inventory.r2ByBucket.get(name)?.classA ?? 0),
    0,
  );
  const r2ClassB = b.r2Buckets.reduce(
    (acc, name) => acc + (inventory.r2ByBucket.get(name)?.classB ?? 0),
    0,
  );

  const totalBindings = b.d1Ids.length + b.kvIds.length + b.r2Buckets.length;
  if (totalBindings === 0) {
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        No D1, KV, or R2 bindings found on linked Workers.
      </div>
    );
  }

  return (
    <>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <MetricCard
          label="D1 Rows Read · 30d"
          value={formatCompact(d1RowsRead)}
          delta={`${formatCompact(d1RowsWritten)} written`}
          tone="cf"
        />
        <MetricCard
          label="KV Reads · 30d"
          value={formatCompact(kvReads)}
          delta={`${formatCompact(kvWrites)} writes+deletes+lists`}
          tone="cf"
        />
        <MetricCard
          label="R2 Class A · 30d"
          value={formatCompact(r2ClassA)}
          delta="writes, lists"
          tone="cf"
        />
        <MetricCard
          label="R2 Class B · 30d"
          value={formatCompact(r2ClassB)}
          delta="reads, head"
          tone="cf"
        />
      </div>

      {b.d1Ids.length > 0 && (
        <>
          <div className="section-header tone-cf">D1 · per database</div>
          <div className="stack">
            {b.d1Ids.map((id) => {
              const ops = inventory.d1ById.get(id);
              return (
                <div key={id} className="card">
                  <div className="card-label">
                    <span>{inventory.d1NameById.get(id) ?? id}</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      {formatCompact(ops?.rowsRead ?? 0)} read ·{' '}
                      {formatCompact(ops?.rowsWritten ?? 0)} written
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {b.kvIds.length > 0 && (
        <>
          <div className="section-header tone-cf">KV · per namespace</div>
          <div className="stack">
            {b.kvIds.map((id) => {
              const ops = inventory.kvById.get(id);
              return (
                <div key={id} className="card">
                  <div className="card-label">
                    <span>{id.slice(0, 16)}…</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      {formatCompact(ops?.reads ?? 0)}r ·{' '}
                      {formatCompact(ops?.writes ?? 0)}w ·{' '}
                      {formatCompact(ops?.deletes ?? 0)}d ·{' '}
                      {formatCompact(ops?.lists ?? 0)}l
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {b.r2Buckets.length > 0 && (
        <>
          <div className="section-header tone-cf">R2 · per bucket</div>
          <div className="stack">
            {b.r2Buckets.map((name) => {
              const ops = inventory.r2ByBucket.get(name);
              return (
                <div key={name} className="card">
                  <div className="card-label">
                    <span>{name}</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      A {formatCompact(ops?.classA ?? 0)} · B{' '}
                      {formatCompact(ops?.classB ?? 0)}
                    </span>
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

function tileMetricView(
  metric: TileMetric,
  m: AppMetrics,
): { value: string; unit: string; series: number[]; color: string; empty: string } {
  switch (metric) {
    case 'errors':
      return {
        value: m.errors.toString(),
        unit: '/24h',
        series: m.errorSeries,
        color: 'var(--accent-red)',
        empty: 'no errors',
      };
    case 'spend':
      return {
        value: formatUSD(m.anthropicSpend),
        unit: '/30d',
        // No per-timestamp spend series — fall back to invocation
        // pattern so the tile isn't a flat line. Value still correct.
        series: m.series,
        color: 'var(--tone-anthropic)',
        empty: 'no spend',
      };
    case 'invocations':
    default:
      return {
        value: formatCompact(m.invocations),
        unit: '/24h',
        series: m.series,
        color:
          m.errors > 0 ? 'var(--accent-red)' : 'var(--accent-cyan)',
        empty: 'no traffic',
      };
  }
}

function formatGB(bytes: number): string {
  if (bytes === 0) return '0 GB';
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1_000_000;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1_000;
  return `${kb.toFixed(1)} KB`;
}

// Invocation-weighted mean of a set of quantile samples — rolls up
// multiple Workers' (or time-bucketed) CPU readings into one headline
// figure weighted by how much traffic each Worker took.
function weightedMean(
  samples: Array<{ value: number; weight: number }>,
): number | null {
  if (samples.length === 0) return null;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += s.value * s.weight;
    den += s.weight;
  }
  return den > 0 ? num / den : null;
}

// CF's cpuTime quantiles are in microseconds. Format as ms when the
// value is big enough to make the number readable, else show µs.
function formatMs(microseconds: number): string {
  if (microseconds >= 1000) return `${(microseconds / 1000).toFixed(2)} ms`;
  return `${Math.round(microseconds)} µs`;
}

function unwrapList<T>(result: BatchResult): T[] {
  if (!result.ok || !result.data) return [];
  const data = result.data as { result?: T[] };
  return data.result ?? [];
}

// Pull an AdaptiveGroups array out of a GraphQL response shape.
function unwrapGraphQL<T>(result: BatchResult, nodeName: string): T[] {
  if (!result.ok || !result.data) return [];
  const data = result.data as {
    data?: { viewer?: { accounts?: Array<Record<string, unknown>> } };
  };
  const acct = data.data?.viewer?.accounts?.[0];
  if (!acct) return [];
  return (acct[nodeName] as T[] | undefined) ?? [];
}

// Extract D1/KV/R2 binding ids from a Worker settings.bindings[]
// payload. Shape varies by type — see CF Worker bindings docs.
function parseBindings(
  bindings: Array<Record<string, unknown>>,
): WorkerBindings {
  const d1Ids: string[] = [];
  const kvIds: string[] = [];
  const r2Buckets: string[] = [];
  for (const b of bindings) {
    const type = (b.type as string | undefined) ?? '';
    switch (type) {
      case 'd1':
      case 'd1_database': {
        const id = (b.id as string | undefined) ?? (b.database_id as string | undefined);
        if (id) d1Ids.push(id);
        break;
      }
      case 'kv_namespace': {
        const id =
          (b.namespace_id as string | undefined) ??
          (b.id as string | undefined);
        if (id) kvIds.push(id);
        break;
      }
      case 'r2_bucket': {
        const name = (b.bucket_name as string | undefined) ?? (b.name as string | undefined);
        if (name) r2Buckets.push(name);
        break;
      }
    }
  }
  return { d1Ids, kvIds, r2Buckets };
}

function formatCompact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

// Per-key 30d Anthropic spend, using the same pricing-table estimator
// as AiSpendScreen. Returns Map<keyId, USD>.
function estimateSpendByKey(buckets: UsageBucket[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const bucket of buckets) {
    for (const item of bucket.results ?? []) {
      const keyId = item.api_key_id ?? 'console';
      const pricing = resolvePricing(item.model);
      if (!pricing) continue;
      const uncachedInput = item.uncached_input_tokens ?? 0;
      const cacheRead = item.cache_read_input_tokens ?? 0;
      const cache5m = item.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      const cache1h = item.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const output = item.output_tokens ?? 0;
      const cost =
        (uncachedInput / 1_000_000) * pricing.input +
        (cacheRead / 1_000_000) * pricing.cacheRead +
        (cache5m / 1_000_000) * pricing.cacheWrite5m +
        (cache1h / 1_000_000) * pricing.cacheWrite1h +
        (output / 1_000_000) * pricing.output;
      m.set(keyId, (m.get(keyId) ?? 0) + cost);
    }
  }
  return m;
}

function resolvePricing(
  model: string,
): (typeof ANTHROPIC_PRICING)[string] | null {
  if (ANTHROPIC_PRICING[model]) return ANTHROPIC_PRICING[model];
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return ANTHROPIC_PRICING['claude-opus-4-6'];
  if (lower.includes('sonnet')) return ANTHROPIC_PRICING['claude-sonnet-4-6'];
  if (lower.includes('haiku')) return ANTHROPIC_PRICING['claude-haiku-4-5'];
  return null;
}

