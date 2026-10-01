import { type SparkMarker, useSparkMarkers } from './registry/sparkMarkers'

const MARKER_COLOR: Record<SparkMarker['kind'], string> = {
  deploy: 'var(--tm-accent-ink)',
  boot: 'var(--tm-fg-2)',
  config: 'var(--tm-update)',
  snapshot: 'var(--tm-muted)',
  maintenance: 'var(--tm-update)'
}

/**
 * Area + line spark in a 100x24 viewBox, stretched to its box. Colour defaults to the accent.
 * With a `range` (epoch ms the series covers), change markers (#1093: restarts, deploys, config
 * writes, maintenance) are drawn over it — each with a hover label.
 */
export function Sparkline({
  data,
  color = 'var(--tm-accent)',
  className,
  range
}: {
  data: number[]
  color?: string
  className?: string
  range?: { from: number; to: number }
}) {
  const markers = useSparkMarkers(range)
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
  const svg = (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio='none'
      className={markers.length ? 'absolute inset-0 h-full w-full' : className}
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
  if (!markers.length || !range) return svg
  const span = range.to - range.from
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - range.from) / span) * 100))
  return (
    <div className={`relative ${className ?? ''}`} data-tm-spark-markers={markers.length}>
      {svg}
      {markers.map((m) => {
        const left = pos(m.at)
        const width = m.until ? Math.max(0.8, pos(m.until) - left) : 0
        const time = new Date(m.at).toTimeString().slice(0, 5)
        return (
          <span
            key={`${m.kind}:${m.at}`}
            role='img'
            aria-label={`${time} ${m.label}`}
            title={`${time} · ${m.label}`}
            data-tm-marker={m.kind}
            className='absolute inset-y-0 -ml-[3px] block w-[7px] cursor-default'
            style={{ left: `${left}%`, width: width ? `calc(${width}% + 6px)` : undefined }}
          >
            <span
              className='absolute inset-y-0 left-[3px] block'
              style={
                width
                  ? {
                      right: '3px',
                      background: MARKER_COLOR[m.kind],
                      opacity: 0.16
                    }
                  : { width: 1, background: MARKER_COLOR[m.kind], opacity: 0.7 }
              }
            />
          </span>
        )
      })}
    </div>
  )
}
