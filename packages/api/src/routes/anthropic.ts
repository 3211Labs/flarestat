import type { AnthropicQuery, Env } from '../types';
import { withCache } from '../cache';

const ANTHROPIC_USAGE_URL =
  'https://api.anthropic.com/v1/organizations/usage_report/messages';
const ANTHROPIC_COST_URL =
  'https://api.anthropic.com/v1/organizations/cost_report';
const ANTHROPIC_KEYS_URL =
  'https://api.anthropic.com/v1/organizations/api_keys';

// Daily cost data doesn't change meaningfully within 30 minutes, and
// Anthropic's Admin API is aggressively rate-limited (1/min sustained),
// so we cache long and share keys across screens via stableNowIso().
const DEFAULT_TTL = 1800;

interface AnthropicPage {
  data: unknown[];
  has_more: boolean;
  next_page: string | null;
}

// Allowlist of query params accepted by the Anthropic Admin API endpoints
// the dashboard uses. Anything else is stripped before forwarding — this
// prevents clients from probing arbitrary filters or leaking capabilities
// that the UI isn't meant to expose. `page` is managed server-side by the
// pagination loop so we never honour a client-supplied value.
const ALLOWED_ANTHROPIC_PARAMS: ReadonlySet<string> = new Set([
  'starting_at',
  'ending_at',
  'bucket_width',
  'limit',
  'group_by[]',
  'group_by',
  'workspace_ids[]',
  'models[]',
  'api_key_ids[]',
  'service_tiers[]',
  'context_windows[]',
]);

function buildSearchParams(
  params: Record<string, string | string[]>,
): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED_ANTHROPIC_PARAMS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.append(key, value);
    }
  }
  return search;
}

function baseUrlFor(endpoint: AnthropicQuery['endpoint']): string {
  switch (endpoint) {
    case 'usage':
      return ANTHROPIC_USAGE_URL;
    case 'cost':
      return ANTHROPIC_COST_URL;
    case 'keys':
      return ANTHROPIC_KEYS_URL;
  }
}

export async function runAnthropic(
  query: AnthropicQuery,
  env: Env,
): Promise<unknown> {
  const baseUrl = baseUrlFor(query.endpoint);

  const params = buildSearchParams(query.params);
  const cacheKey = `${query.endpoint}:${params.toString()}`;
  const ttl = query.cacheTtl ?? DEFAULT_TTL;

  const { data } = await withCache('anthropic', cacheKey, ttl, async () => {
    const aggregated: unknown[] = [];
    let page: string | null = null;

    while (true) {
      const pageParams = new URLSearchParams(params);
      if (page) pageParams.set('page', page);

      const response = await fetchWithRetry(
        `${baseUrl}?${pageParams.toString()}`,
        env,
      );

      if (!response.ok) {
        throw new Error(
          `Anthropic ${query.endpoint} failed: ${response.status} ${await response.text()}`,
        );
      }

      const result = (await response.json()) as AnthropicPage;
      if (Array.isArray(result.data)) {
        aggregated.push(...result.data);
      }

      if (!result.has_more || !result.next_page) break;
      page = result.next_page;
    }

    return { data: aggregated, endpoint: query.endpoint };
  });

  return data;
}

// Retries once on 429 with a short backoff. The Admin API's rate limit
// is 1/min sustained, so a single 3s retry usually lets a burst clear.
async function fetchWithRetry(url: string, env: Env): Promise<Response> {
  const headers = {
    'anthropic-version': '2023-06-01',
    'x-api-key': env.ANTHROPIC_ADMIN_KEY,
    'User-Agent':
      'flarestat/1.0.0 (https://github.com/flarestat/flarestat)',
  };

  let response = await fetch(url, { headers });
  if (response.status !== 429) return response;

  // Respect Retry-After header if present, otherwise wait 3s.
  const retryAfter = response.headers.get('retry-after');
  const waitMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, 10000) : 3000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  return fetch(url, { headers });
}
