/** Area + line spark in a 100x24 viewBox, stretched to its box. Colour defaults to the accent. */
export function Sparkline({
  data,
  color = 'var(--tm-accent)',
  className
}: {
  data: number[]
  color?: string
  className?: string
}) {
  const w = 100
  const h = 24
  const pad = 1.5
  const clean = data.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const max = Math.max(1e-6, ...clean)
  const pts = clean.map((v, i) => [
    pad + (i * (w - 2 * pad)) / Math.max(1, clean.length - 1),
    h - pad - (v / max) * (h - 2 * pad)
  ])
  if (pts.length === 0)
    return <svg viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden='true' />
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const first = pts[0]
  const last = pts[pts.length - 1]
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio='none'
      className={className}
      aria-hidden='true'
    >
      <path
        d={`${line} L${last[0].toFixed(1)} ${h} L${first[0].toFixed(1)} ${h} Z`}
        fill={color}
        opacity='0.14'
      />
      <path
        d={line}
        fill='none'
        stroke={color}
        strokeWidth='1.5'
        strokeLinejoin='round'
        vectorEffect='non-scaling-stroke'
      />
    </svg>
  )
}
