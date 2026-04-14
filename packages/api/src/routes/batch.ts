import type { BatchResult, Env, Query } from '../types';
import { runGraphQL } from './graphql';
import { runRest } from './rest';
import { runAnthropic } from './anthropic';
import { runObservability } from './observability';

export async function runQuery(query: Query, env: Env): Promise<unknown> {
  switch (query.type) {
    case 'graphql':
      return runGraphQL(query, env);
    case 'rest':
      return runRest(query, env);
    case 'anthropic':
      return runAnthropic(query, env);
    case 'observability':
      return runObservability(query, env);
    default: {
      const _exhaustive: never = query;
      throw new Error(`Unknown query type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export async function runBatch(
  queries: Query[],
  env: Env,
): Promise<BatchResult[]> {
  return Promise.all(
    queries.map(async (q): Promise<BatchResult> => {
      try {
        const data = await runQuery(q, env);
        return { ok: true, status: 200, data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 500, error: message };
      }
    }),
  );
}
