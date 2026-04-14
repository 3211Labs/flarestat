export interface Env {
  ENVIRONMENT: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  // Optional. Only needed if you want Anthropic spend tracking on the
  // AI / Billing / Apps screens.
  ANTHROPIC_ADMIN_KEY: string;
  ALLOW_DEV_BYPASS?: string;
  // Optional comma-separated list of extra origins permitted to send
  // credentialed CORS requests. Same-origin traffic from the
  // dashboard's own domain never needs to be listed here.
  EXTRA_CORS_ORIGINS?: string;
  // Static assets binding declared in wrangler.toml [assets]. Falls
  // through to here when no /api/* route matches.
  ASSETS: Fetcher;
}

export type QueryType = 'graphql' | 'rest' | 'anthropic' | 'observability';

export interface GraphQLQuery {
  type: 'graphql';
  query: string;
  variables?: Record<string, unknown>;
  cacheTtl?: number;
}

export interface RestQuery {
  type: 'rest';
  path: string;
  method?: 'GET';
  cacheTtl?: number;
}

export interface AnthropicQuery {
  type: 'anthropic';
  endpoint: 'usage' | 'cost' | 'keys';
  params: Record<string, string | string[]>;
  cacheTtl?: number;
}

// Workers Observability telemetry query. Only pre-defined `kind` values
// are accepted — the Worker builds the full telemetry query body so
// clients can't proxy arbitrary filter/groupBy payloads.
export interface ObservabilityQuery {
  type: 'observability';
  kind: 'errors';
  fromMs: number;
  toMs: number;
  limit?: number;
  cacheTtl?: number;
}

export type Query = GraphQLQuery | RestQuery | AnthropicQuery | ObservabilityQuery;

export interface BatchRequest {
  queries: Query[];
}

export interface BatchResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}
