export function Sparkline({ points, up = true, w = 96, h = 40 }: { points: number[]; up?: boolean; w?: number; h?: number }) {
  if (points.length < 2) return <svg width={w} height={h} />;
  const min = Math.min(...points), max = Math.max(...points), r = max - min || 1;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${h - 2 - ((p - min) / r) * (h - 4)}`).join(' ');
  const stroke = up ? '#4ADE80' : '#FF6B5E';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <path d={d} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
