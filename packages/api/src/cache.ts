// Synthetic origin for cache keys — never served, just hashed with the
// request URL so caches.default can deduplicate identical upstream
// requests across invocations.
const DEFAULT_CACHE_HOST = 'https://flarestat-cache.internal';

async function hashKey(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildCacheKey(namespace: string, digest: string): Request {
  return new Request(`${DEFAULT_CACHE_HOST}/${namespace}/${digest}`, {
    method: 'GET',
  });
}

export async function getCached<T>(
  namespace: string,
  keyInput: string,
): Promise<T | null> {
  const digest = await hashKey(keyInput);
  const cache = caches.default;
  const hit = await cache.match(buildCacheKey(namespace, digest));
  if (!hit) return null;
  try {
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

export async function setCached(
  namespace: string,
  keyInput: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const digest = await hashKey(keyInput);
  const response = new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${ttlSeconds}`,
    },
  });
  await caches.default.put(buildCacheKey(namespace, digest), response);
}

export async function withCache<T>(
  namespace: string,
  keyInput: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<{ data: T; cached: boolean }> {
  if (ttlSeconds <= 0) {
    return { data: await fetcher(), cached: false };
  }
  const hit = await getCached<T>(namespace, keyInput);
  if (hit !== null) return { data: hit, cached: true };
  const data = await fetcher();
  await setCached(namespace, keyInput, data, ttlSeconds);
  return { data, cached: false };
}
