export default function Sparkline({
  values,
  maxY,
  width = 300,
  height = 32,
}: {
  values: number[];
  maxY: number;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return <div className="text-xs text-zinc-600">not enough data</div>;
  }
  const max = maxY > 0 ? maxY : 1;
  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - Math.max(0, Math.min(1, v / max)) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M${points.join(" L")}`;

  return (
    <svg width={width} height={height} className="block" viewBox={`0 0 ${width} ${height}`}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.25} className="text-emerald-400" />
    </svg>
  );
}
