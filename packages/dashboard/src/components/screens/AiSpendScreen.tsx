import { useEffect, useState } from 'react';
import {
  batch,
  AnthropicQueries,
  CloudflareQueries,
  type BatchResult,
  type Query,
} from '../../lib/api';
import {
  formatUSD,
  formatCompact,
  formatRelativeTime,
  formatPercent,
  isoNow,
  stableNowIso,
  daysAgoIso,
} from '../../lib/format';
import {
  unwrapAnthropic,
  sumCost,
  sumCostForToday,
  filterBucketsFromMonth,
  dailyCostSeries,
  type CostBucket,
  type UsageBucket,
} from '../../lib/anthropic';
import {
  buildNameMap,
  getAgentName,
  type AnthropicApiKey,
} from '../../lib/agents';
import { ANTHROPIC_PRICING } from '../../lib/pricing';
import MetricCard from '../cards/MetricCard';
import LineChart from '../charts/LineChart';
import { SkeletonGrid, SkeletonStack } from '../cards/Skeleton';

interface AgentSummary {
  apiKeyId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReads: number;
  cacheHitRatio: number;
  estimatedCost: number;
}

interface GatewayListItem {
  id: string;
  name?: string;
}

interface GatewayGroup {
  count: number;
  sum?: { requests?: number; cachedRequests?: number; errors?: number };
  dimensions: { gateway: string };
}

interface GatewaySummary {
  gateway: string;
  requests: number;
  cached: number;
  errors: number;
  cacheRatio: number;
}

const AI_GATEWAY_REQUESTS_QUERY = `
  query AiGatewayRequests(
    $accountTag: string!
    $since: string!
    $until: string!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        aiGatewayRequestsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          count
          dimensions { gateway }
        }
      }
    }
  }
`;

export default function AiSpendScreen() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [estimated, setEstimated] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string>(isoNow());
  const [mtdSpend, setMtdSpend] = useState(0);
  const [todaySpend, setTodaySpend] = useState(0);
  const [dailyCosts, setDailyCosts] = useState<Array<{ date: string; amount: number }>>([]);
  const [byModel, setByModel] = useState<Record<string, number>>({});
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [gateways, setGateways] = useState<GatewaySummary[]>([]);
  const [gatewayConfigured, setGatewayConfigured] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    setWarnings([]);
    setEstimated(false);
    try {
      // Single 30d cost fetch shared with HomeScreen (same cache key).
      // MTD is derived by filtering the 30d buckets. Also fetch the
      // API key list once (cached 1h in the Worker) to resolve friendly
      // agent names.
      const stableNow = stableNowIso();
      const since30 = daysAgoIso(30);
      const results = await batch([
        AnthropicQueries.costDaily(since30, stableNow),
        AnthropicQueries.usageDailyByKey(since30, stableNow),
        AnthropicQueries.apiKeys(),
        CloudflareQueries.listAiGateways(),
        {
          type: 'rest',
          path: '/accounts',
          cacheTtl: 600,
        } as Query,
      ]);

      const [monthlyRes, usageRes, keysRes, gatewaysRes, accountsRes] = results;

      const nextWarnings: string[] = [];
      if (!monthlyRes.ok) nextWarnings.push(`cost 30d: ${monthlyRes.error ?? 'failed'}`);
      if (!usageRes.ok) nextWarnings.push(`usage 30d: ${usageRes.error ?? 'failed'}`);
      if (!keysRes.ok) nextWarnings.push(`keys: ${keysRes.error ?? 'failed'}`);
      if (!gatewaysRes.ok) nextWarnings.push(`ai gateways: ${gatewaysRes.error ?? 'failed'}`);

      const monthlyBuckets = unwrapAnthropic<CostBucket>(monthlyRes);
      const mtdBuckets = filterBucketsFromMonth(monthlyBuckets);
      const usageBuckets = unwrapAnthropic<UsageBucket>(usageRes);
      const apiKeys = unwrapAnthropic<AnthropicApiKey>(keysRes);
      const nextNameMap = buildNameMap(apiKeys);

      let mtd = sumCost(mtdBuckets);
      let today = sumCostForToday(mtdBuckets);
      let daily = dailyCostSeries(monthlyBuckets);
      let models = groupCostByModel(monthlyBuckets);
      let isEstimated = false;

      // Fallback: if cost endpoint returned empty but usage has data,
      // derive cost from tokens using the pricing table.
      const costEmpty =
        mtd === 0 && today === 0 && daily.length === 0 && usageBuckets.length > 0;
      if (costEmpty) {
        const estimates = estimateCostFromUsage(usageBuckets);
        mtd = estimates.mtdTotal;
        today = estimates.todayTotal;
        daily = estimates.daily;
        models = estimates.byModel;
        isEstimated = true;
        nextWarnings.push(
          'Cost endpoint empty — showing estimated cost from usage × pricing table',
        );
      }

      setMtdSpend(mtd);
      setTodaySpend(today);
      setDailyCosts(daily);
      setByModel(models);
      setAgents(summarizeAgents(usageBuckets));
      setNameMap(nextNameMap);

      const gatewayList = unwrapCloudflareList<GatewayListItem>(gatewaysRes);
      setGatewayConfigured(gatewayList.length > 0);
      if (gatewayList.length > 0) {
        const accounts = unwrapCloudflareList<{ id: string }>(accountsRes);
        const accountId = accounts[0]?.id ?? null;
        if (accountId) {
          const [metricsRes] = await batch([
            {
              type: 'graphql',
              query: AI_GATEWAY_REQUESTS_QUERY,
              variables: {
                accountTag: accountId,
                since: daysAgoIso(1),
                until: stableNow,
              },
            },
          ]);
          if (metricsRes.ok && metricsRes.data) {
            const data = metricsRes.data as {
              data?: {
                viewer?: {
                  accounts?: Array<{
                    aiGatewayRequestsAdaptiveGroups: GatewayGroup[];
                  }>;
                };
              };
              errors?: Array<{ message: string }>;
            };
            if (data.errors && data.errors.length > 0) {
              nextWarnings.push(
                `ai gateway graphql: ${data.errors.map((e) => e.message).join('; ')}`,
              );
            }
            const groups =
              data.data?.viewer?.accounts?.[0]
                ?.aiGatewayRequestsAdaptiveGroups ?? [];
            setGateways(aggregateGateways(groups));
          } else if (!metricsRes.ok) {
            nextWarnings.push(
              `ai gateway metrics: ${metricsRes.error ?? 'failed'}`,
            );
          }
        }
      } else {
        setGateways([]);
      }

      setWarnings(nextWarnings);
      setEstimated(isEstimated);
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

  const projectedMonth = projectMonthly(mtdSpend);
  const modelEntries = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  const topModel = modelEntries[0];

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-title">
            AI Spend {estimated && <span className="pill">estimated</span>}
          </div>
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

      {loading && agents.length === 0 ? (
        <>
          <SkeletonGrid count={4} />
          <div className="section-header">Daily cost · 30d</div>
          <SkeletonStack count={1} height={180} />
          <div className="section-header">By Model</div>
          <SkeletonStack count={2} />
          <div className="section-header">By Agent</div>
          <SkeletonStack count={4} />
        </>
      ) : (
        <>
      <div className="grid cols-2">
        <MetricCard label="Month to Date" value={formatUSD(mtdSpend)} />
        <MetricCard label="Today" value={formatUSD(todaySpend)} />
        <MetricCard
          label="Projected Month"
          value={formatUSD(projectedMonth)}
          delta="extrapolated"
        />
        <MetricCard
          label="Top Model"
          value={topModel ? formatUSD(topModel[1]) : '—'}
          delta={topModel ? topModel[0] : undefined}
        />
      </div>

      <div className="section-header">Daily cost · 30d</div>
      <div className="stack">
        <div className="card">
          {dailyCosts.length > 0 ? (
            <LineChart
              labels={dailyCosts.map((d) => d.date.slice(5))}
              values={dailyCosts.map((d) => d.amount)}
              label="USD"
              color="#f97316"
            />
          ) : (
            <div className="empty">No data</div>
          )}
        </div>
      </div>

      <div className="section-header">By Model</div>
      <div className="stack">
        {modelEntries.length === 0 && <div className="empty">No data</div>}
        {modelEntries.map(([model, amount]) => (
          <div key={model} className="card">
            <div className="card-label">
              <span>{model}</span>
              <span className="mono" style={{ color: 'var(--text-muted)' }}>
                {mtdSpend > 0
                  ? `${((amount / sumOf(modelEntries)) * 100).toFixed(0)}%`
                  : ''}
              </span>
            </div>
            <div className="card-value">{formatUSD(amount)}</div>
          </div>
        ))}
      </div>

      <div className="section-header tone-cf">AI Gateways · 24h</div>
      <div className="stack">
        {!gatewayConfigured && (
          <div className="card">
            <div className="card-label">No AI Gateway configured</div>
            <div
              className="card-delta"
              style={{ marginTop: 6, color: 'var(--text-secondary)' }}
            >
              Route Anthropic traffic through AI Gateway to get per-project
              cost attribution, cache hit rate, and error tracking. Create
              one in the Cloudflare dashboard → AI → AI Gateway.
            </div>
          </div>
        )}
        {gatewayConfigured && gateways.length === 0 && (
          <div className="empty">No gateway traffic in last 24h</div>
        )}
        {gateways.map((g) => (
          <div key={g.gateway} className="card">
            <div className="card-label">
              <span>{g.gateway}</span>
            </div>
            <div className="card-value">{formatCompact(g.requests)}</div>
            <div className="card-delta" style={{ marginTop: 6 }}>
              requests · 24h
            </div>
          </div>
        ))}
      </div>

      <div className="section-header">By Agent · 30d (estimated)</div>
      <div className="stack">
        {agents.length === 0 && <div className="empty">No usage data</div>}
        {agents.map((agent) => {
          const totalAgentCost = agents.reduce(
            (a, g) => a + g.estimatedCost,
            0,
          );
          const share =
            totalAgentCost > 0
              ? ((agent.estimatedCost / totalAgentCost) * 100).toFixed(0)
              : '0';
          return (
            <div key={agent.apiKeyId ?? 'console'} className="card">
              <div className="card-label">
                <span>{getAgentName(agent.apiKeyId, nameMap)}</span>
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  {share}% · cache {formatPercent(agent.cacheHitRatio, 0)}
                </span>
              </div>
              <div className="card-value">{formatUSD(agent.estimatedCost)}</div>
              <div className="card-delta">
                {formatCompact(agent.inputTokens + agent.outputTokens)} tokens ·
                in {formatCompact(agent.inputTokens)} · out{' '}
                {formatCompact(agent.outputTokens)}
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

function groupCostByModel(buckets: CostBucket[]): Record<string, number> {
  const byModel: Record<string, number> = {};
  for (const bucket of buckets) {
    for (const item of bucket.results ?? []) {
      const key = item.model ?? 'unknown';
      byModel[key] =
        (byModel[key] ?? 0) + parseFloat(item.amount) / 100;
    }
  }
  return byModel;
}

function summarizeAgents(buckets: UsageBucket[]): AgentSummary[] {
  const byKey = new Map<
    string,
    {
      apiKeyId: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReads: number;
      estimatedCost: number;
    }
  >();

  for (const bucket of buckets) {
    for (const item of bucket.results ?? []) {
      const keyId = item.api_key_id ?? 'console';
      const current =
        byKey.get(keyId) ??
        {
          apiKeyId: item.api_key_id,
          inputTokens: 0,
          outputTokens: 0,
          cacheReads: 0,
          estimatedCost: 0,
        };

      const uncachedInput = item.uncached_input_tokens ?? 0;
      const cacheRead = item.cache_read_input_tokens ?? 0;
      const cache5m = item.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      const cache1h = item.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const output = item.output_tokens ?? 0;

      current.inputTokens += uncachedInput + cacheRead + cache5m + cache1h;
      current.outputTokens += output;
      current.cacheReads += cacheRead;

      // Derive USD cost per-agent from pricing table — same math as the
      // MTD estimator but accumulated by API key.
      const pricing = resolvePricing(item.model);
      if (pricing) {
        current.estimatedCost +=
          (uncachedInput / 1_000_000) * pricing.input +
          (cacheRead / 1_000_000) * pricing.cacheRead +
          (cache5m / 1_000_000) * pricing.cacheWrite5m +
          (cache1h / 1_000_000) * pricing.cacheWrite1h +
          (output / 1_000_000) * pricing.output;
      }

      byKey.set(keyId, current);
    }
  }

  return Array.from(byKey.values())
    .map((a) => {
      const totalInput = a.inputTokens;
      const ratio = totalInput > 0 ? a.cacheReads / totalInput : 0;
      return { ...a, cacheHitRatio: ratio };
    })
    .sort((a, b) => b.estimatedCost - a.estimatedCost);
}

function projectMonthly(mtdSpend: number): number {
  const now = new Date();
  const daysElapsed = now.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  if (daysElapsed === 0) return 0;
  return (mtdSpend / daysElapsed) * daysInMonth;
}

function sumOf(entries: Array<[string, number]>): number {
  return entries.reduce((acc, [, v]) => acc + v, 0);
}

// Derives estimated USD cost from token usage using ANTHROPIC_PRICING.
// Used only when the cost endpoint returns empty but usage has data.
function estimateCostFromUsage(buckets: UsageBucket[]): {
  mtdTotal: number;
  todayTotal: number;
  daily: Array<{ date: string; amount: number }>;
  byModel: Record<string, number>;
} {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const startOfMonthStr = startOfMonth.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const dailyMap = new Map<string, number>();
  const byModel: Record<string, number> = {};
  let mtdTotal = 0;
  let todayTotal = 0;

  for (const bucket of buckets) {
    const day = bucket.starting_at ? bucket.starting_at.slice(0, 10) : null;
    if (!day) continue;

    let dayCost = 0;

    for (const item of bucket.results ?? []) {
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

      dayCost += cost;
      byModel[item.model] = (byModel[item.model] ?? 0) + cost;
    }

    dailyMap.set(day, (dailyMap.get(day) ?? 0) + dayCost);

    if (day >= startOfMonthStr) mtdTotal += dayCost;
    if (day === todayStr) todayTotal += dayCost;
  }

  const daily = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amount]) => ({ date, amount }));

  return { mtdTotal, todayTotal, daily, byModel };
}

// Matches a returned model string to the pricing table, handling the
// fact that the API returns dated model IDs like
// "claude-3-5-sonnet-20241022" that we map to "claude-sonnet-4-6".
function unwrapCloudflareList<T>(result: BatchResult): T[] {
  if (!result.ok || !result.data) return [];
  const data = result.data as { result?: T[] };
  return data.result ?? [];
}

function aggregateGateways(groups: GatewayGroup[]): GatewaySummary[] {
  const byGateway = new Map<string, GatewaySummary>();
  for (const g of groups) {
    const name = g.dimensions.gateway ?? 'unknown';
    const requests = g.count ?? g.sum?.requests ?? 0;
    const cached = g.sum?.cachedRequests ?? 0;
    const errors = g.sum?.errors ?? 0;
    const current =
      byGateway.get(name) ??
      { gateway: name, requests: 0, cached: 0, errors: 0, cacheRatio: 0 };
    current.requests += requests;
    current.cached += cached;
    current.errors += errors;
    byGateway.set(name, current);
  }
  for (const summary of byGateway.values()) {
    summary.cacheRatio =
      summary.requests > 0 ? summary.cached / summary.requests : 0;
  }
  return Array.from(byGateway.values()).sort(
    (a, b) => b.requests - a.requests,
  );
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
