import { tierColor, tierProgress } from '../../lib/pricing';
import { formatUSD } from '../../lib/format';

interface Props {
  label: string;
  used: number;
  included: number;
  formatValue: (n: number) => string;
  overageUsd?: number;
}

export default function UsageBar({
  label,
  used,
  included,
  formatValue,
  overageUsd = 0,
}: Props) {
  const progress = tierProgress(used, included);
  const color = tierColor(progress);
  const pct = (progress * 100).toFixed(0);
  const overUnits = Math.max(0, used - included);

  return (
    <div className="card">
      <div className="card-label">
        <span>{label}</span>
        <span className="mono" style={{ color: 'var(--text-muted)' }}>
          {pct}%
        </span>
      </div>
      <div className="usage-bar" role="progressbar" aria-valuenow={progress * 100}>
        <div
          className={`usage-bar-fill ${color}`}
          style={{ width: `${Math.min(100, progress * 100)}%` }}
        />
      </div>
      <div className="card-delta" style={{ marginTop: 8 }}>
        {formatValue(used)} / {formatValue(included)} included
      </div>
      {overageUsd > 0 && (
        <div
          className="card-delta"
          style={{ marginTop: 4, color: 'var(--accent-red)' }}
        >
          +{formatValue(overUnits)} over · {formatUSD(overageUsd)} overage
        </div>
      )}
    </div>
  );
}
