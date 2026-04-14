import type { Env, ObservabilityQuery } from '../types';
import { withCache } from '../cache';

const TELEMETRY_QUERY_URL = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`;

// Recent error events change within minutes, but we still cache briefly
// so screen refreshes don't hammer the endpoint.
const DEFAULT_TTL = 60;

const MAX_LIMIT = 100;

// Query bodies are built server-side by `kind` so clients can't send
// arbitrary filters/groupBys. Add new kinds here (not on the client).
function buildQueryBody(query: ObservabilityQuery): Record<string, unknown> {
  const limit = Math.min(query.limit ?? 20, MAX_LIMIT);
  const timeframe = { from: query.fromMs, to: query.toMs };

  switch (query.kind) {
    case 'errors':
      // Minimum viable discovery query — events view, no dataset filter,
      // no metadata filter. The response statistics tell us whether
      // any rows were scanned at all.
      return {
        queryId: 'dashboard-errors-v1',
        timeframe,
        view: 'events',
        limit,
        parameters: {
          datasets: ['cloudflare-workers'],
          // Try to narrow to non-ok outcomes server-side so we don't
          // have to scan up to `limit` normal events client-side. If the
          // filter syntax is wrong CF ignores it and returns everything;
          // the dashboard parser then filters again client-side.
          // Match real errors: worker exceptions OR error-level logs.
          // Use an OR group so cron-logs with no outcome, info logs, etc
          // don't flood the list.
          filters: [
            {
              kind: 'group',
              filterCombination: 'or',
              filters: [
                {
                  key: '$workers.outcome',
                  type: 'string',
                  operation: 'eq',
                  value: 'exception',
                },
                {
                  key: '$metadata.level',
                  type: 'string',
                  operation: 'eq',
                  value: 'error',
                },
              ],
            },
          ],
        },
      };
    default: {
      const _exhaustive: never = query.kind;
      throw new Error(`Unknown observability kind: ${String(_exhaustive)}`);
    }
  }
}

export async function runObservability(
  query: ObservabilityQuery,
  env: Env,
): Promise<unknown> {
  const url = TELEMETRY_QUERY_URL(env.CF_ACCOUNT_ID);
  const body = buildQueryBody(query);
  const ttl = query.cacheTtl ?? DEFAULT_TTL;
  const cacheKey = `observability:${query.kind}:${query.fromMs}:${query.toMs}:${query.limit ?? 20}`;

  const { data } = await withCache('observability', cacheKey, ttl, async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Observability query failed: ${response.status} ${await response.text()}`,
      );
    }
    return await response.json();
  });

  return data;
}
