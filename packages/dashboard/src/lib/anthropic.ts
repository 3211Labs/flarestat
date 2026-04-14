import { centsToDollars } from './format';
import type { BatchResult } from './api';

export interface CostBucket {
  starting_at?: string;
  results: Array<{
    amount: string;
    cost_type?: string;
    description?: string;
    model?: string;
    service_tier?: string;
    token_type?: string;
  }>;
}

export interface UsageBucket {
  starting_at?: string;
  results: Array<{
    api_key_id: string | null;
    model: string;
    uncached_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
    output_tokens?: number;
  }>;
}

// Pull the array of time-bucket results out of a batch response. The
// Worker wraps Anthropic responses as { data: [...buckets], endpoint }.
export function unwrapAnthropic<T>(result: BatchResult): T[] {
  if (!result.ok || !result.data) return [];
  const data = result.data as { data?: T[] };
  return data.data ?? [];
}

export function sumCost(buckets: CostBucket[]): number {
  let total = 0;
  for (const bucket of buckets) {
    for (const item of bucket.results ?? []) {
      total += centsToDollars(item.amount);
    }
  }
  return total;
}

export function sumCostForToday(buckets: CostBucket[]): number {
  const today = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const bucket of buckets) {
    if (!bucket.starting_at?.startsWith(today)) continue;
    for (const item of bucket.results ?? []) {
      total += centsToDollars(item.amount);
    }
  }
  return total;
}

export function filterBucketsFromMonth<
  T extends { starting_at?: string },
>(buckets: T[]): T[] {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const cutoff = startOfMonth.toISOString().slice(0, 10);
  return buckets.filter((b) => (b.starting_at ?? '').slice(0, 10) >= cutoff);
}

// Aggregate cost buckets by day, returning an array sorted ascending by date.
export function dailyCostSeries(
  buckets: CostBucket[],
): Array<{ date: string; amount: number }> {
  const byDay = new Map<string, number>();
  for (const bucket of buckets) {
    const day = bucket.starting_at?.slice(0, 10);
    if (!day) continue;
    let total = byDay.get(day) ?? 0;
    for (const item of bucket.results ?? []) {
      total += centsToDollars(item.amount);
    }
    byDay.set(day, total);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amount]) => ({ date, amount }));
}

// Take the last N days of a daily series — used for sparklines.
export function aggregateByDay(
  buckets: CostBucket[],
  days: number,
): number[] {
  const daily = new Map<string, number>();
  for (const bucket of buckets) {
    const day = bucket.starting_at?.slice(0, 10);
    if (!day) continue;
    let sum = daily.get(day) ?? 0;
    for (const item of bucket.results ?? []) {
      sum += centsToDollars(item.amount);
    }
    daily.set(day, sum);
  }
  const keys = Array.from(daily.keys()).sort();
  return keys.slice(-days).map((k) => daily.get(k) ?? 0);
}
