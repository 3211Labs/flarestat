import type { BatchRequest, Env, Query } from './types';
import { validateAccessJWT } from './auth';
import { runQuery, runBatch } from './routes/batch';

// Same-origin traffic from the dashboard's own domain never triggers
// CORS. This allowlist covers local dev + any extra origins declared
// via the `EXTRA_CORS_ORIGINS` env var (comma-separated) in
// wrangler.toml.
const BUILTIN_ALLOWED_ORIGINS = new Set([
  'http://localhost:4321',
  'http://localhost:8788',
]);

function buildAllowedOrigins(env: Env): Set<string> {
  const extra = (env.EXTRA_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...BUILTIN_ALLOWED_ORIGINS, ...extra]);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const isAllowed = buildAllowedOrigins(env).has(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Credentials': isAllowed ? 'true' : 'false',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Cf-Access-Jwt-Assertion, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(
  request: Request,
  env: Env,
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(request, env),
      ...(init.headers ?? {}),
    },
  });
}

// Structured log helper so Workers Logs can filter/group cleanly.
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Anything that isn't /api/* is a static asset request. The ASSETS
    // binding handles the Astro build, including SPA fallback to
    // index.html for deep links. Cloudflare Access still gates these
    // at the edge — by the time we're in the Worker, auth is already
    // validated.
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (!isApi) {
      return env.ASSETS.fetch(request);
    }

    // Strip the /api prefix so the route handlers work unchanged.
    const apiPath = pathname === '/api' ? '/' : pathname.slice(4);

    // Health check — no auth required. Covers both /api/health and a
    // bare /api hit.
    if (apiPath === '/health' || apiPath === '/') {
      return json(request, env, { ok: true, environment: env.ENVIRONMENT });
    }

    const identity = await validateAccessJWT(request, env);
    if (!identity) {
      log('auth.denied', { path: apiPath });
      return json(request, env, { error: 'unauthorized' }, { status: 401 });
    }

    if (request.method !== 'POST') {
      return json(request, env, { error: 'method_not_allowed' }, { status: 405 });
    }

    try {
      if (apiPath === '/query') {
        const query = (await request.json()) as Query;
        log('api.query', { type: query.type, sub: identity.sub });
        const data = await runQuery(query, env);
        return json(request, env, { ok: true, data });
      }

      if (apiPath === '/batch') {
        const body = (await request.json()) as BatchRequest;
        if (!Array.isArray(body.queries)) {
          return json(request, env, { error: 'queries_must_be_array' }, { status: 400 });
        }
        log('api.batch', { count: body.queries.length, sub: identity.sub });
        const results = await runBatch(body.queries, env);
        return json(request, env, { ok: true, results });
      }

      return json(request, env, { error: 'not_found' }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('api.error', { path: apiPath, message });
      return json(request, env, { error: message }, { status: 500 });
    }
  },
};
