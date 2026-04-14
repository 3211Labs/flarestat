import { maskIfDemo } from './demo';

export type Query =
  | {
      type: 'graphql';
      query: string;
      variables?: Record<string, unknown>;
      cacheTtl?: number;
    }
  | {
      type: 'rest';
      path: string;
      method?: 'GET';
      cacheTtl?: number;
    }
  | {
      type: 'anthropic';
      endpoint: 'usage' | 'cost' | 'keys';
      params: Record<string, string | string[]>;
      cacheTtl?: number;
    }
  | {
      type: 'observability';
      kind: 'errors';
      fromMs: number;
      toMs: number;
      limit?: number;
      cacheTtl?: number;
    };

export interface BatchResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

// Default to a same-origin path so Access cookies work without cross-origin
// login dances. PUBLIC_API_BASE can override for local dev.
const API_BASE =
  (import.meta as unknown as { env?: { PUBLIC_API_BASE?: string } }).env
    ?.PUBLIC_API_BASE ?? '/api';

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`API ${path} failed: ${response.status}`);
  }
  const result = (await response.json()) as { ok: boolean; data?: T; error?: string };
  if (!result.ok) {
    throw new Error(result.error ?? 'Unknown API error');
  }
  return maskIfDemo(result.data as T);
}

export async function query<T = unknown>(q: Query): Promise<T> {
  return request<T>('/query', q);
}

export async function batch<T = unknown>(
  queries: Query[],
): Promise<BatchResult<T>[]> {
  const response = await fetch(`${API_BASE}/batch`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries }),
  });
  if (!response.ok) {
    throw new Error(`API /batch failed: ${response.status}`);
  }
  const result = (await response.json()) as {
    ok: boolean;
    results: BatchResult<T>[];
  };
  return result.results.map((r) =>
    r.ok && r.data !== undefined ? { ...r, data: maskIfDemo(r.data) } : r,
  );
}

// Convenience wrappers used across screens.
export const CloudflareQueries = {
  listZones: (): Query => ({
    type: 'rest',
    path: '/zones',
    cacheTtl: 300,
  }),
  listWorkers: (): Query => ({
    type: 'rest',
    path: '/accounts/{account}/workers/scripts',
    cacheTtl: 300,
  }),
  listD1: (): Query => ({
    type: 'rest',
    path: '/accounts/{account}/d1/database',
    cacheTtl: 300,
  }),
  listR2: (): Query => ({
    type: 'rest',
    path: '/accounts/{account}/r2/buckets',
    cacheTtl: 300,
  }),
  listKV: (): Query => ({
    type: 'rest',
    path: '/accounts/{account}/storage/kv/namespaces',
    cacheTtl: 300,
  }),
  listPages: (): Query => ({
    type: 'rest',
    path: '/accounts/{account}/pages/projects',
    cacheTtl: 300,
  }),
  billingHistory: (): Query => ({
    type: 'rest',
    path: '/user/billing/history',
    cacheTtl: 300,
  }),
  workerDeployments: (scriptName: string): Query => ({
    type: 'rest',
    path: `/accounts/{account}/workers/scripts/${scriptName}/deployments`,
    cacheTtl: 300,
  }),
  workerSettings: (scriptName: string): Query => ({
    type: 'rest',
    path: `/accounts/{account}/workers/scripts/${scriptName}/settings`,
    cacheTtl: 600,
  }),
  listAiGateways: (): Query => ({
    type: 'rest',
    path: '/accounts/{account}/ai-gateway/gateways',
    cacheTtl: 600,
  }),
  recentErrors: (hoursBack = 24, limit = 20): Query => {
    const now = Date.now();
    return {
      type: 'observability',
      kind: 'errors',
      fromMs: now - hoursBack * 60 * 60 * 1000,
      toMs: now,
      limit,
    };
  },
};

// Leave cacheTtl off these so the Worker's default applies (30 min for
// Anthropic — aligned with the Admin API's 1/min rate-limit guidance).
export const AnthropicQueries = {
  costDaily: (startingAt: string, endingAt: string): Query => ({
    type: 'anthropic',
    endpoint: 'cost',
    params: {
      starting_at: startingAt,
      ending_at: endingAt,
      'group_by[]': ['description', 'workspace_id'],
      bucket_width: '1d',
    },
  }),
  usageDailyByModel: (startingAt: string, endingAt: string): Query => ({
    type: 'anthropic',
    endpoint: 'usage',
    params: {
      starting_at: startingAt,
      ending_at: endingAt,
      'group_by[]': ['model'],
      bucket_width: '1d',
    },
  }),
  usageDailyByKey: (startingAt: string, endingAt: string): Query => ({
    type: 'anthropic',
    endpoint: 'usage',
    params: {
      starting_at: startingAt,
      ending_at: endingAt,
      'group_by[]': ['api_key_id', 'model'],
      bucket_width: '1d',
    },
  }),
  apiKeys: (): Query => ({
    type: 'anthropic',
    endpoint: 'keys',
    params: {},
    cacheTtl: 3600,
  }),
};
