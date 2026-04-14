interface Props {
  values: number[];
  color?: string;
  height?: number;
  width?: number;
}

export default function Sparkline({
  values,
  color = 'var(--accent-cyan)',
  height = 28,
  width = 120,
}: Props) {
  if (!values || values.length === 0) {
    return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ stroke: color }}
    >
      <polyline points={points} />
    </svg>
  );
}
