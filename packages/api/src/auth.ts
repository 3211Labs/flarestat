import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { Env } from './types';

type JWKSGetter = ReturnType<typeof createRemoteJWKSet>;

let cachedJWKS: JWKSGetter | null = null;
let cachedTeamDomain: string | null = null;

function getJWKS(teamDomain: string): JWKSGetter {
  if (!cachedJWKS || cachedTeamDomain !== teamDomain) {
    cachedJWKS = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`),
    );
    cachedTeamDomain = teamDomain;
  }
  return cachedJWKS;
}

export interface AccessIdentity {
  email?: string;
  sub: string;
  raw: JWTPayload;
}

export async function validateAccessJWT(
  request: Request,
  env: Env,
): Promise<AccessIdentity | null> {
  // Dev bypass must be opted into EXPLICITLY via a dedicated var. Don't
  // key on ENVIRONMENT — a missing/misspelled var would otherwise ship
  // the Worker wide open. Fail closed by default.
  if (env.ALLOW_DEV_BYPASS === 'true') {
    console.warn(
      '!!! AUTH BYPASS ACTIVE — ALLOW_DEV_BYPASS=true. NEVER in production !!!',
    );
    return { sub: 'dev', email: 'dev@localhost', raw: {} };
  }

  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return null;
  }

  const jwt =
    request.headers.get('Cf-Access-Jwt-Assertion') ??
    extractCookie(request.headers.get('Cookie'), 'CF_Authorization');

  if (!jwt) return null;

  try {
    const { payload } = await jwtVerify(jwt, getJWKS(env.CF_ACCESS_TEAM_DOMAIN), {
      issuer: env.CF_ACCESS_TEAM_DOMAIN,
      audience: env.CF_ACCESS_AUD,
    });
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : 'unknown',
      email: typeof payload.email === 'string' ? payload.email : undefined,
      raw: payload,
    };
  } catch {
    return null;
  }
}

function extractCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const pairs = header.split(';');
  for (const pair of pairs) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
