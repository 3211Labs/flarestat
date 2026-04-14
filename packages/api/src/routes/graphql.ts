import type { Env, GraphQLQuery } from '../types';
import { withCache } from '../cache';

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
// 5min default matches REST — the CF analytics data is at most minutes
// fresh anyway, so shorter TTLs just burn rate limit budget.
const DEFAULT_TTL = 300;

export async function runGraphQL(query: GraphQLQuery, env: Env): Promise<unknown> {
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
