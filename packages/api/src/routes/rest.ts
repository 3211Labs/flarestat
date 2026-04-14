import type { Env, RestQuery } from '../types';
import { withCache } from '../cache';

const CF_REST_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TTL = 300;

// Allowlist of REST paths the dashboard is permitted to call. Anything
// not matched here is rejected before the CF API token is used.
// Patterns use `{account}` as a placeholder for the account ID.
// The match is prefix-based so sub-resources like ?page=2 still work.
const ALLOWED_PATHS: readonly string[] = [
  '/accounts',
  '/accounts/{account}/workers/scripts',
  '/accounts/{account}/d1/database',
  '/accounts/{account}/r2/buckets',
  '/accounts/{account}/storage/kv/namespaces',
  '/accounts/{account}/pages/projects',
  '/accounts/{account}/ai-gateway/gateways',
  '/zones',
  '/user/billing/history',
  '/user/subscriptions',
] as const;

function isPathAllowed(path: string): boolean {
  for (const pattern of ALLOWED_PATHS) {
    if (path === pattern) return true;
    if (path.startsWith(`${pattern}/`)) return true;
    if (path.startsWith(`${pattern}?`)) return true;
  }
  return false;
}

export async function runRest(query: RestQuery, env: Env): Promise<unknown> {
  const method = query.method ?? 'GET';
  if (method !== 'GET') {
    throw new Error(`REST method not allowed: ${method}`);
  }

  const rawPath = query.path.startsWith('/') ? query.path : `/${query.path}`;

  // Validate against the allowlist BEFORE placeholder expansion so the
  // client can't smuggle through arbitrary paths via the {account} slot.
  if (!isPathAllowed(rawPath)) {
    throw new Error(`REST path not allowed: ${rawPath}`);
  }

  const expandedPath = rawPath.replace('{account}', env.CF_ACCOUNT_ID);
  const url = `${CF_REST_BASE}${expandedPath}`;

  const ttl = query.cacheTtl ?? DEFAULT_TTL;
  const cacheKey = `${method}:${url}`;

  const { data } = await withCache('rest', cacheKey, ttl, async () => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(
        `REST request failed: ${response.status} ${await response.text()}`,
      );
    }
    return await response.json();
  });

  return data;
}
