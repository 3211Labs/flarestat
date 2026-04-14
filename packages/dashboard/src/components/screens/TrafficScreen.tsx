import { useEffect, useState } from 'react';
import { batch, CloudflareQueries, query, type Query } from '../../lib/api';
import {
  formatBytes,
  formatCompact,
  formatRelativeTime,
  isoNow,
  daysAgoIso,
} from '../../lib/format';
import MetricCard from '../cards/MetricCard';
import LineChart from '../charts/LineChart';
import { SkeletonGrid, SkeletonStack } from '../cards/Skeleton';

type Range = '1' | '7' | '30';

interface Zone {
  id: string;
  name: string;
}

interface HttpRequestsGroup {
  dimensions: { date: string };
  sum: {
    requests: number;
    bytes: number;
    cachedRequests: number;
    cachedBytes: number;
    threats: number;
    pageViews: number;
  };
  uniq: { uniques: number };
}

const ZONE_TRAFFIC_QUERY = `
  query ZoneTraffic($zoneTag: string!, $since: string!, $until: string!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1dGroups(
          limit: 30
          filter: { date_geq: $since, date_leq: $until }
          orderBy: [date_ASC]
        ) {
          dimensions { date }
          sum { requests bytes cachedRequests cachedBytes threats pageViews }
          uniq { uniques }
        }
      }
    }
  }
`;

export default function TrafficScreen() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('7');
  const [groups, setGroups] = useState<HttpRequestsGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>(isoNow());

  async function loadZones() {
    try {
      const results = await batch([CloudflareQueries.listZones()]);
      const res = results[0];
      if (!res.ok || !res.data) throw new Error(res.error ?? 'no zones');
      const data = res.data as { result?: Zone[] };
      const zoneList = data.result ?? [];
      setZones(zoneList);
      if (zoneList.length > 0 && !selectedZone) {
        setSelectedZone(zoneList[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadTraffic() {
    if (!selectedZone) return;
    setLoading(true);
    setError(null);
    try {
      const since = daysAgoIso(parseInt(range, 10)).slice(0, 10);
      const until = new Date().toISOString().slice(0, 10);
      const q: Query = {
        type: 'graphql',
        query: ZONE_TRAFFIC_QUERY,
        variables: { zoneTag: selectedZone, since, until },
      };
      const data = await query<{
        data?: {
          viewer?: {
            zones?: Array<{ httpRequests1dGroups: HttpRequestsGroup[] }>;
          };
        };
      }>(q);
      const grouped = data.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
      setGroups(grouped);
      setRefreshedAt(isoNow());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshAll() {
    await loadZones();
    if (selectedZone) await loadTraffic();
  }

  useEffect(() => {
    loadZones();
  }, []);

  useEffect(() => {
    if (selectedZone) loadTraffic();
  }, [selectedZone, range]);

  const totals = groups.reduce(
    (acc, g) => {
      acc.requests += g.sum.requests;
      acc.cached += g.sum.cachedRequests;
      acc.bytes += g.sum.bytes;
      acc.threats += g.sum.threats;
      acc.uniques += g.uniq.uniques;
      return acc;
    },
    { requests: 0, cached: 0, bytes: 0, threats: 0, uniques: 0 },
  );

  const cacheRatio = totals.requests > 0 ? totals.cached / totals.requests : 0;
  const labels = groups.map((g) => g.dimensions.date.slice(5));
  const values = groups.map((g) => g.sum.requests);

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-title">Traffic</div>
          <div className="page-meta">
            {loading
              ? 'Loading…'
              : error
              ? `Error: ${error}`
              : `Updated ${formatRelativeTime(refreshedAt)}`}
          </div>
        </div>
        <button className="pill" onClick={refreshAll}>
          Refresh
        </button>
      </header>

      <div className="tabs">
        {zones.map((zone) => (
          <button
            key={zone.id}
            className="tab"
            aria-pressed={selectedZone === zone.id}
            onClick={() => setSelectedZone(zone.id)}
          >
            {zone.name}
          </button>
        ))}
      </div>

      <div className="tabs">
        {(['1', '7', '30'] as Range[]).map((r) => (
          <button
            key={r}
            className="tab"
            aria-pressed={range === r}
            onClick={() => setRange(r)}
          >
            {r === '1' ? '24h' : `${r}d`}
          </button>
        ))}
      </div>

      {loading && groups.length === 0 ? (
        <>
          <SkeletonGrid count={4} />
          <div className="section-header">Requests over time</div>
          <SkeletonStack count={1} height={200} />
        </>
      ) : (
        <>
          <div className="grid cols-2">
            <MetricCard label="Requests" value={formatCompact(totals.requests)} />
            <MetricCard label="Bandwidth" value={formatBytes(totals.bytes)} />
            <MetricCard
              label="Cache Hit"
              value={`${(cacheRatio * 100).toFixed(1)}%`}
              status={cacheRatio > 0.5 ? 'healthy' : 'warning'}
            />
            <MetricCard
              label="Threats"
              value={formatCompact(totals.threats)}
              status={totals.threats > 0 ? 'warning' : 'healthy'}
            />
          </div>

          <div className="section-header">Requests over time</div>
          <div className="stack">
            <div className="card">
              {labels.length > 0 ? (
                <LineChart labels={labels} values={values} label="Requests" />
              ) : (
                <div className="empty">No data</div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
