import type { Env, GraphQLQuery } from '../types';
import { withCache } from '../cache';

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
// 5min default matches REST — the CF analytics data is at most minutes
// fresh anyway, so shorter TTLs just burn rate limit budget.
const DEFAULT_TTL = 300;
// Upper bound on an inbound GraphQL query string. Our dashboard's
// largest query is ~3KB; 16KB leaves generous headroom while capping
// the blast radius of an authed-but-buggy client. Cloudflare's own
// GraphQL endpoint caps at 100KB, so we're strictly below that too.
const MAX_QUERY_BYTES = 16_384;

export async function runGraphQL(query: GraphQLQuery, env: Env): Promise<unknown> {
  if (typeof query.query !== 'string' || query.query.length === 0) {
    throw new Error('GraphQL query is required');
  }
  if (query.query.length > MAX_QUERY_BYTES) {
    throw new Error(
      `GraphQL query too large: ${query.query.length} bytes (max ${MAX_QUERY_BYTES})`,
    );
  }
  const body = JSON.stringify({
    query: query.query,
    variables: query.variables ?? {},
  });

  const ttl = query.cacheTtl ?? DEFAULT_TTL;
  const { data } = await withCache('graphql', body, ttl, async () => {
    const response = await fetch(CF_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `GraphQL request failed: ${response.status} ${await response.text()}`,
      );
    }
    return await response.json();
  });

  return data;
}
