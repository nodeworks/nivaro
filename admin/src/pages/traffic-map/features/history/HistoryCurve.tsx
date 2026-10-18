/**
 * The long-history chart: the request curve (area, errors on top), an optional second line on
 * its own scale (people online / active, #2249), change markers as thin rules (#2183), job bars
 * in a lane under the curve (#2165), and a playhead. Shapes are one stretched SVG; every label is
 * HTML so it never distorts. A transparent range input over the chart picks a step (click, drag,
 * arrow keys).
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface CurveMarker {
  /** Step index (fractional) and, for a window, where it ends. */
  i: number
  i2?: number
  kind: string
  label: string
}
export interface CurveBar {
  id: string
  from: number
  to: number
  label: string
  tone: 'warn' | 'muted' | 'accent'
}

const W = 1000
const MARKER_VAR: Record<string, string> = {
  deploy: 'var(--tm-accent)',
  boot: 'var(--tm-muted)',
  config: 'var(--tm-update)',
  snapshot: 'var(--tm-muted)',
  maintenance: 'var(--tm-update)',
  incident: 'var(--tm-error)'
}
const BAR_CLASS: Record<CurveBar['tone'], string> = {
  warn: 'bg-[var(--tm-update)] text-[var(--tm-on-update)]',
  muted: 'bg-[var(--tm-card-2)] text-[var(--tm-fg-2)] border border-[var(--tm-line)]',
  accent: 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)] border border-[var(--tm-accent)]'
}

function path(values: Array<number | null>, max: number, h: number, close: boolean): string {
  const n = values.length
  if (!n || max <= 0) return ''
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => h - (Math.max(0, v) / max) * (h - 2)
  let d = ''
  let open = false
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (v == null) {
      open = false
      continue
    }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    open = true
  }
  if (close && d) d += `L${W},${h}L0,${h}Z`
  return d
}

export function HistoryCurve({
  values,
  errors,
  line,
  line2,
  markers = [],
  bars = [],
  playhead,
  onPick,
  ticks,
  height = 96,
  label,
  peak,
  legend
}: {
  values: number[]
  errors?: number[]
  line?: Array<number | null>
  line2?: number[]
  markers?: CurveMarker[]
  bars?: CurveBar[]
  playhead?: number | null
  onPick?: (i: number) => void
  ticks: Array<{ i: number; label: string }>
  height?: number
  label: string
  /** A level drawn as a dashed rule (the day's peak line). */
  peak?: number | null
  legend?: ReactNode
}) {
  const n = values.length
  const max = Math.max(1, ...values, peak ?? 0)
  const lineMax = Math.max(1, ...(line ?? []).map((v) => v ?? 0), ...(line2 ?? []))
  const pct = (i: number) => (n <= 1 ? 50 : (Math.max(0, Math.min(n - 1, i)) / (n - 1)) * 100)
  const lanes: CurveBar[][] = []
  for (const b of bars) {
    const lane = lanes.find((l) => l.every((o) => b.from >= o.to + 0.5 || b.to + 0.5 <= o.from))
    if (lane) lane.push(b)
    else lanes.push([b])
  }
  return (
    <div className='min-w-0'>
      <div
        className='relative w-full rounded-md has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-nvr-cyan'
        style={{ height }}
        data-tm-history-curve=''
      >
        <svg
          viewBox={`0 0 ${W} ${height}`}
          preserveAspectRatio='none'
          className='absolute inset-0 h-full w-full overflow-visible'
          aria-hidden='true'
        >
          <path d={path(values, max, height, true)} fill='var(--tm-accent-soft)' stroke='none' />
          <path
            d={path(values, max, height, false)}
            fill='none'
            stroke='var(--tm-accent)'
            strokeWidth={1.5}
            vectorEffect='non-scaling-stroke'
          />
          {errors?.some((v) => v > 0) && (
            <path
              d={path(errors, max, height, true)}
              fill='var(--tm-error-soft)'
              stroke='var(--tm-error)'
              strokeWidth={1}
              vectorEffect='non-scaling-stroke'
            />
          )}
          {line && (
            <path
              d={path(line, lineMax, height, false)}
              fill='none'
              stroke='var(--tm-fg-2)'
              strokeWidth={1.5}
              strokeDasharray='4 3'
              vectorEffect='non-scaling-stroke'
            />
          )}
          {line2 && (
            <path
              d={path(line2, lineMax, height, false)}
              fill='none'
              stroke='var(--tm-read)'
              strokeWidth={1.25}
              vectorEffect='non-scaling-stroke'
            />
          )}
          {peak != null && peak > 0 && (
            <line
              x1={0}
              x2={W}
              y1={height - (peak / max) * (height - 2)}
              y2={height - (peak / max) * (height - 2)}
              stroke='var(--tm-update)'
              strokeDasharray='6 4'
              strokeWidth={1}
              vectorEffect='non-scaling-stroke'
            />
          )}
          {markers.map((m, k) =>
            m.i2 != null && m.i2 > m.i ? (
              <rect
                // biome-ignore lint/suspicious/noArrayIndexKey: markers are a fixed list per read
                key={k}
                x={(pct(m.i) / 100) * W}
                width={Math.max(1, ((pct(m.i2) - pct(m.i)) / 100) * W)}
                y={0}
                height={height}
                fill={MARKER_VAR[m.kind] ?? 'var(--tm-muted)'}
                opacity={0.12}
              />
            ) : (
              <line
                // biome-ignore lint/suspicious/noArrayIndexKey: markers are a fixed list per read
                key={k}
                x1={(pct(m.i) / 100) * W}
                x2={(pct(m.i) / 100) * W}
                y1={0}
                y2={height}
                stroke={MARKER_VAR[m.kind] ?? 'var(--tm-muted)'}
                strokeWidth={1.5}
                vectorEffect='non-scaling-stroke'
              />
            )
          )}
        </svg>
        {onPick && n > 1 && (
          <input
            type='range'
            min={0}
            max={n - 1}
            step={1}
            value={Math.max(0, Math.min(n - 1, playhead ?? n - 1))}
            onChange={(e) => onPick(Number(e.target.value))}
            aria-label={label}
            className='absolute inset-0 h-full w-full cursor-crosshair appearance-none bg-transparent opacity-0'
            data-tm-history-scrub=''
          />
        )}
        {/* Marker hit areas with instant tooltips. */}
        {markers.map((m, k) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: markers are a fixed list per read
            key={`h${k}`}
            className='absolute top-0 z-10 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-[var(--tm-card)]'
            style={{ left: `${pct(m.i)}%`, background: MARKER_VAR[m.kind] ?? 'var(--tm-muted)' }}
            data-tip={m.label}
            data-tm-history-marker={m.kind}
          />
        ))}
        {playhead != null && n > 0 && (
          <span
            className='pointer-events-none absolute inset-y-0 w-px bg-[var(--tm-fg)]'
            style={{ left: `${pct(playhead)}%` }}
            aria-hidden='true'
            data-tm-history-playhead={playhead}
          />
        )}
      </div>
      {lanes.length > 0 && (
        <div className='mt-1 grid gap-0.5' data-tm-history-bars=''>
          {lanes.slice(0, 6).map((lane, li) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lanes are packed per render
            <div key={li} className='relative h-[16px]'>
              {lane.map((b) => (
                <span
                  key={b.id}
                  className={cn(
                    'absolute top-0 h-full min-w-[4px] truncate rounded-[3px] px-1 font-mono text-[10px] leading-[16px]',
                    BAR_CLASS[b.tone]
                  )}
                  style={{
                    left: `${pct(b.from)}%`,
                    width: `${Math.max(0.4, pct(b.to) - pct(b.from))}%`
                  }}
                  data-tip={b.label}
                  data-tm-history-bar={b.id}
                >
                  {b.id}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      <div
        className='relative mt-1 h-[14px] text-[10.5px] tabular-nums text-[var(--tm-muted)]'
        aria-hidden='true'
      >
        {ticks.map((t) => (
          <span
            key={t.i}
            className='absolute -translate-x-1/2 whitespace-nowrap'
            style={{ left: `${pct(t.i)}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
      {legend && (
        <div className='mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--tm-muted)]'>
          {legend}
        </div>
      )}
    </div>
  )
}

/** A legend swatch. */
export function Swatch({
  color,
  dashed,
  children
}: {
  color: string
  dashed?: boolean
  children: ReactNode
}) {
  return (
    <span className='inline-flex items-center gap-1.5'>
      <span
        className='inline-block h-0 w-3.5 border-t-2'
        style={{ borderColor: color, borderStyle: dashed ? 'dashed' : 'solid' }}
        aria-hidden='true'
      />
      {children}
    </span>
  )
}
