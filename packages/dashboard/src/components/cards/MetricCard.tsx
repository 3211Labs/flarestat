import Sparkline from '../charts/Sparkline';

interface Props {
  label: string;
  value: string;
  delta?: string;
  trend?: 'up' | 'down' | 'flat';
  sparkline?: number[];
  status?: 'healthy' | 'warning' | 'error' | 'idle';
  tone?: 'cf' | 'anthropic';
}

export default function MetricCard({
  label,
  value,
  delta,
  trend = 'flat',
  sparkline,
  status,
  tone,
}: Props) {
  return (
    <div className={`card${tone ? ` tone-${tone}` : ''}`}>
      <div className="card-label">
        <span>{label}</span>
        {status && <span className={`status-dot ${status}`} aria-hidden />}
      </div>
      <div className="card-value">{value}</div>
      {sparkline && sparkline.length > 0 && <Sparkline values={sparkline} />}
      {delta && (
        <div className={`card-delta ${trend === 'up' ? 'up' : trend === 'down' ? 'down' : ''}`}>
          {delta}
        </div>
      )}
    </div>
  );
}
