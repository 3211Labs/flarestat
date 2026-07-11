# flarestat — Roadmap

## Code review 2026-07-11 — outstanding findings

Four fixes from the review were applied (rolling-24h window helper `stableHoursAgoIso`;
Billing "MTD" now month-filtered; worker-name demo leak via `maskWorkerName`;
leak-check CI made case-insensitive). Remaining findings, to triage:

### Demo-mode leaks (feature exists for safe screenshots on this public repo)
- **AI Gateway names** — `AiSpendScreen.tsx:359` renders `g.gateway` (GraphQL dimension); the `gateway` key hits no branch in `demo.ts` `maskString`, so user-chosen slugs (e.g. `acme-prod`) leak under `?demo=1`. Fix: add a `gateway` key branch in `maskString`.
- **CF billing charge descriptions** — `BillingScreen.tsx:169→754` renders `c.description`, free-text that embeds real domains ("Registration renewal for <domain>"); `isDomain` fails on spaces so it passes through. Fix: mask domain-like substrings within `description`.
- **Renamed app titles** — `apps.ts:181` applies a `localStorage` `displayName` as `app.name`, rendered at `AppsScreen.tsx:859`; never passes through `maskIfDemo`. Fix: mask display names at render.
- **Self-worker card mismatch** — `HomeScreen.tsx:356/402` compares masked `w.script` (GraphQL) against unmasked `CONFIG.selfScriptName`; in demo the Self card shows zeros and the dashboard's own worker duplicates into the list under a masked name. Fix: compare against `maskWorkerName(SELF_SCRIPT_NAME)` in demo.

### Time / labeling
- **AppsScreen "24h" Anthropic spend** — `AppsScreen.tsx:370` filters daily buckets by `now-24h`; daily buckets mean only today's partial bucket survives (undercount). Relabel to "Today" or sum across the correct day boundary.
- **AiSpendScreen 24h query** — `AiSpendScreen.tsx:179` still uses `daysAgoIso(1)`; confirm intended window and switch to `stableHoursAgoIso(24)` if it feeds a "24h" label.
- **Billing-cycle boundaries for day 29-31** — `format.ts:96-116` uses `Date.UTC(y, m, day)`, which rolls over in short months; drifts "Bills on…" / days-remaining by 1-2 days for `CF_BILLING_DAY` >= 29.

### Correctness / robustness
- **Pages workers create phantom apps** — `apps.ts:143` doesn't filter `pages-worker--*` although AppsScreen metrics/edit-list do; yields a 0-metric tile that can't be unlinked.
- **Local `formatCompact` in AppsScreen** (`:2065`) only divides by 1e3 → "5000.0k" for 5M; shadows the correct `format.ts` formatter.
- **WorkersScreen range-switch race** (`:157-187`) — `loadMetricsOnly` and `load` share state with no request-id/AbortController guard; fast tab clicks can show data for the wrong range.
- **HomeScreen accounts warning missing** (`:151`) — `accountsRes` failure isn't surfaced in the warnings banner; a failed `/accounts` yields "No worker metrics available" with no explanation.
- **TrafficScreen totals lack `?? 0`** (`:119`) — a null `sum` field makes the total NaN (mostly masked downstream).

### Not bugs (verified during review)
- Anthropic `centsToDollars` ÷100 is correct (cost_report `amount` is cents-as-decimal-string per API docs).
- `pricing.ts` opus-4-6/sonnet-4-6/haiku-4-5 rates match the current catalog.
- "By Model / Top Model" is fine — cost_report populates `model` when grouping by `description` (which `costDaily` does); only genuine non-token costs land in "unknown".
