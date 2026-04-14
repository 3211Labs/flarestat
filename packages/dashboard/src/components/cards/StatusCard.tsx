import Sparkline from '../charts/Sparkline';

interface Props {
  name: string;
  invocations: number;
  errors: number;
  sparkline?: number[];
}

function statusFor(errors: number, invocations: number) {
  if (invocations === 0) return 'idle' as const;
  const errorRate = errors / invocations;
  if (errorRate > 0.01) return 'error' as const;
  if (errorRate > 0.001) return 'warning' as const;
  return 'healthy' as const;
}

export default function StatusCard({
  name,
  invocations,
  errors,
  sparkline,
}: Props) {
  const status = statusFor(errors, invocations);

  return (
    <div className="card">
      <div className="card-label">
        <span>{name}</span>
        <span className={`status-dot ${status}`} aria-hidden />
      </div>
      <div className="card-value">
        {invocations > 1000 ? `${(invocations / 1000).toFixed(1)}k` : invocations}
      </div>
      {sparkline && <Sparkline values={sparkline} />}
      <div
        className={`card-delta ${errors > 0 ? 'down' : ''}`}
        style={{ marginTop: 6 }}
      >
        {errors} errors · 24h
      </div>
    </div>
  );
}
