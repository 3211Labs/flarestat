// App-grouping logic. Auto-detects apps from Worker name prefixes,
// then matches Anthropic API keys + AI Gateways by the same prefix.
// User overrides (rename, include/exclude resources) layer on top via
// localStorage so the dashboard stays usable across iPhone + desktop
// without a backend mapping store.

const STORAGE_KEY = 'flarestat:apps-overrides:v1';

export interface AppOverrides {
  // Display-name override for an auto-detected app id.
  displayName?: string;
  // Workers to forcibly include / exclude vs the prefix match.
  includeWorkers?: string[];
  excludeWorkers?: string[];
  includeKeys?: string[];
  excludeKeys?: string[];
  includeGateways?: string[];
  excludeGateways?: string[];
}

export interface OverridesMap {
  [appId: string]: AppOverrides;
}

export interface DetectedApp {
  id: string;
  name: string;
  workers: string[];
  anthropicKeyIds: string[];
  gatewayIds: string[];
}

// Strip common worker suffixes ("-api", "-worker", etc.) and trailing
// env tags ("-prod", "-staging") so `the-edge-api` and `the-edge` group
// under the same app id.
const STRIP_SUFFIXES = [
  '-api',
  '-worker',
  '-app',
  '-frontend',
  '-backend',
  '-cron',
  '-prod',
  '-production',
  '-staging',
  '-dev',
  '-development',
];

export function deriveAppId(scriptName: string): string {
  let id = scriptName.toLowerCase();
  // Repeatedly strip suffixes so `foo-api-prod` → `foo`.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of STRIP_SUFFIXES) {
      if (id.endsWith(suffix) && id.length > suffix.length) {
        id = id.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return id || scriptName.toLowerCase();
}

export function loadOverrides(): OverridesMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OverridesMap) : {};
  } catch {
    return {};
  }
}

export function saveOverrides(overrides: OverridesMap): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function setAppOverride(
  appId: string,
  patch: Partial<AppOverrides>,
): OverridesMap {
  const all = loadOverrides();
  all[appId] = { ...(all[appId] ?? {}), ...patch };
  saveOverrides(all);
  return all;
}

// Toggle membership of a resource for an app. Maintains
// include/exclude lists so user choices survive future auto-detect
// runs (otherwise an excluded item would silently re-appear when its
// name still matches).
export function toggleResourceMembership(
  appId: string,
  resourceType: 'workers' | 'keys' | 'gateways',
  resourceId: string,
  shouldBeMember: boolean,
  autoMatched: boolean,
): OverridesMap {
  const all = loadOverrides();
  const ov = (all[appId] = { ...(all[appId] ?? {}) });
  const inc = `include${cap(resourceType)}` as keyof AppOverrides;
  const exc = `exclude${cap(resourceType)}` as keyof AppOverrides;
  const include = new Set((ov[inc] as string[] | undefined) ?? []);
  const exclude = new Set((ov[exc] as string[] | undefined) ?? []);

  if (shouldBeMember) {
    exclude.delete(resourceId);
    if (!autoMatched) include.add(resourceId);
  } else {
    include.delete(resourceId);
    if (autoMatched) exclude.add(resourceId);
  }

  const incArr = include.size > 0 ? Array.from(include) : undefined;
  const excArr = exclude.size > 0 ? Array.from(exclude) : undefined;
  (ov as Record<string, unknown>)[inc] = incArr;
  (ov as Record<string, unknown>)[exc] = excArr;
  saveOverrides(all);
  return all;
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

interface DetectInputs {
  workerScripts: string[];
  anthropicKeys: Array<{ id: string; name?: string | null }>;
  gateways: Array<{ id: string; name?: string | null }>;
  overrides?: OverridesMap;
}

// Build the app list from raw inventory + user overrides.
export function detectApps(inputs: DetectInputs): DetectedApp[] {
  const overrides = inputs.overrides ?? loadOverrides();
  const byApp = new Map<string, DetectedApp>();

  // 1. Group workers by derived id.
  for (const script of inputs.workerScripts) {
    const id = deriveAppId(script);
    const current = byApp.get(id) ?? blankApp(id);
    if (!current.workers.includes(script)) current.workers.push(script);
    byApp.set(id, current);
  }

  // 2. Apply worker-level include/exclude overrides.
  for (const [appId, ov] of Object.entries(overrides)) {
    const app = byApp.get(appId) ?? blankApp(appId);
    for (const w of ov.includeWorkers ?? []) {
      if (!app.workers.includes(w)) app.workers.push(w);
    }
    if (ov.excludeWorkers?.length) {
      app.workers = app.workers.filter(
        (w) => !ov.excludeWorkers!.includes(w),
      );
    }
    byApp.set(appId, app);
  }

  // 3. Match Anthropic keys + Gateways to apps by name prefix, then
  //    apply key/gateway overrides.
  for (const app of byApp.values()) {
    const keyMatches = inputs.anthropicKeys
      .filter((k) => matchesAppId(app.id, k.name))
      .map((k) => k.id);
    const gatewayMatches = inputs.gateways
      .filter((g) => matchesAppId(app.id, g.name))
      .map((g) => g.id);
    app.anthropicKeyIds = uniq([
      ...keyMatches,
      ...(overrides[app.id]?.includeKeys ?? []),
    ]).filter((k) => !overrides[app.id]?.excludeKeys?.includes(k));
    app.gatewayIds = uniq([
      ...gatewayMatches,
      ...(overrides[app.id]?.includeGateways ?? []),
    ]).filter((g) => !overrides[app.id]?.excludeGateways?.includes(g));
    const nameOverride = overrides[app.id]?.displayName;
    if (nameOverride) app.name = nameOverride;
  }

  return Array.from(byApp.values())
    .filter((a) => a.workers.length > 0 || a.anthropicKeyIds.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function blankApp(id: string): DetectedApp {
  return {
    id,
    name: prettify(id),
    workers: [],
    anthropicKeyIds: [],
    gatewayIds: [],
  };
}

function prettify(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function matchesAppId(appId: string, name?: string | null): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return normalized.includes(appId);
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
