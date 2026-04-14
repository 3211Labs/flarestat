// Minimal pulsing placeholders. Uses a keyframe defined in global.css
// (added alongside this component) rather than a JS animation so React
// doesn't have to re-render for the pulse.

interface SkeletonCardProps {
  height?: number;
}

export function SkeletonCard({ height = 68 }: SkeletonCardProps) {
  return (
    <div
      className="card skeleton"
      aria-busy="true"
      aria-live="polite"
      style={{ height: `${height}px` }}
    />
  );
}

export function SkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid cols-2">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonStack({
  count = 3,
  height = 68,
}: {
  count?: number;
  height?: number;
}) {
  return (
    <div className="stack">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} height={height} />
      ))}
    </div>
  );
}
