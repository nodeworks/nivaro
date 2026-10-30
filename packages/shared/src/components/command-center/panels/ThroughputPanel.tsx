import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from 'react'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { FAINT, FOCUS, MUTED, PANEL, PANEL_HEAD, TITLE, useAppIsDark } from '../theme'
import type { ThroughputSeries } from '../types'

type SeriesKey = 'today' | 'yesterday' | 'avg7'

/** Categorical slots 1–3 of the reference palette (validated all-pairs, light + dark). */
const SERIES: Record<SeriesKey, { label: string; light: string; dark: string }> = {
  today: { label: 'Today', light: '#2a78d6', dark: '#3987e5' },
  yesterday: { label: 'Yesterday', light: '#eb6834', dark: '#d95926' },
  avg7: { label: '7-day average', light: '#1baf7a', dark: '#199e70' }
}
const ORDER: SeriesKey[] = ['today', 'yesterday', 'avg7']

const W = 340
const H = 132
const L = 28
const R = 268
const T = 10
const B = 104

/** "9 AM", "12 PM". */
export function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24
  return `${hh % 12 === 0 ? 12 : hh % 12} ${hh < 12 ? 'AM' : 'PM'}`
}

/** A round axis top a little above `max`. Pure. */
export function niceMax(max: number): number {
  if (max <= 4) return 4
  const p = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p
  return 10 * p
}

/** Hour of day (fractional) of an instant in `tz` — places markers on the chart. Pure. */
export function hourOfDay(iso: string, tz: string | undefined): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric'
    }).formatToParts(d)
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return h + m / 60
  } catch {
    return d.getHours() + d.getMinutes() / 60
  }
}

/** One plain-language sentence for screen readers and the panel header. Pure. */
export function throughputSummary(s: ThroughputSeries): string {
  const done = s.hours.filter((h) => h.today != null)
  const today = s.today_total ?? done.reduce((n, h) => n + (h.today ?? 0), 0)
  const last = done[done.length - 1]
  const parts = [
    `${today.toLocaleString()} transitions today${last ? ` by ${hourLabel(last.hour)}` : ''}`
  ]
  if (s.yesterday_same_time != null) {
    const d = today - s.yesterday_same_time
    parts.push(
      d === 0
        ? 'the same as yesterday by this time'
        : `${Math.abs(d).toLocaleString()} ${d > 0 ? 'more' : 'fewer'} than yesterday by this time`
    )
  }
  const busiest = [...done].sort((a, b) => (b.today ?? 0) - (a.today ?? 0))[0]
  if (busiest && (busiest.today ?? 0) > 0)
    parts.push(`busiest hour ${hourLabel(busiest.hour)} (${busiest.today})`)
  return `${parts.join(', ')}.`
}

const MARK_GLYPH: Record<ThroughputSeries['markers'][number]['kind'], string> = {
  deploy: 'D',
  config: 'C',
  incident: '!'
}
const MARK_WORD: Record<ThroughputSeries['markers'][number]['kind'], string> = {
  deploy: 'Deploy',
  config: 'Configuration change',
  incident: 'Incident'
}

/**
 * Throughput (CC-8): pipeline transitions per hour of the viewer's day — today against
 * yesterday and the 7-day average — with deploy and configuration markers (administrators).
 * Hover or arrow keys move a crosshair; a table holds the same numbers for screen readers.
 */
export function ThroughputPanel() {
  const cc = useCc()
  const dark = useAppIsDark() || cc.tv
  const { data, isLoading } = useCcQuery<ThroughputSeries>('/throughput', undefined, {
    refetchInterval: cc.at ? false : 60_000,
    placeholderData: (prev) => prev
  })
  const [cursor, setCursor] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const geo = useMemo(() => {
    if (!data) return null
    const max = niceMax(
      Math.max(1, ...data.hours.flatMap((h) => [h.today ?? 0, h.yesterday, h.avg7]))
    )
    const x = (h: number) => L + (h / 23) * (R - L)
    const y = (v: number) => B - (v / max) * (B - T)
    const path = (k: SeriesKey) => {
      let d = ''
      for (const h of data.hours) {
        const v = h[k]
        if (v == null) continue
        d += `${d ? 'L' : 'M'}${x(h.hour).toFixed(1)},${y(v).toFixed(1)}`
      }
      return d
    }
    // Direct labels at each line's last point, nudged apart so they never overlap.
    const ends = ORDER.map((k) => {
      const pts = data.hours.filter((h) => h[k] != null)
      const lastPt = pts[pts.length - 1]
      return lastPt ? { k, x: x(lastPt.hour), y: y(lastPt[k] as number) } : { k, x: x(0), y: y(0) }
    }).sort((a, b) => a.y - b.y)
    for (let i = 1; i < ends.length; i++)
      if (ends[i].y - ends[i - 1].y < 11) ends[i].y = ends[i - 1].y + 11
    return { max, x, y, path, ends }
  }, [data])

  if (isLoading && !data)
    return (
      <section className={PANEL} data-cc-panel='throughput' aria-label='Throughput today'>
        <div className={PANEL_HEAD}>
          <h2 className={TITLE}>Throughput today</h2>
        </div>
        <p className={`px-3 py-3 text-[12px] ${FAINT}`}>Loading…</p>
      </section>
    )
  if (!data || !geo) return null

  const color = (k: SeriesKey) => (dark ? SERIES[k].dark : SERIES[k].light)
  const summary = throughputSummary(data)
  const markers = data.markers
    .map((m) => ({ ...m, h: hourOfDay(m.at, data.time_zone) }))
    .filter((m): m is typeof m & { h: number } => m.h != null)

  const pick = (ev: PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    const vx = ((ev.clientX - box.left) / box.width) * W
    setCursor(Math.max(0, Math.min(23, Math.round(((vx - L) / (R - L)) * 23))))
  }
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault()
      setCursor((c) => {
        const cur = c ?? new Date().getHours()
        return Math.max(0, Math.min(23, cur + (ev.key === 'ArrowRight' ? 1 : -1)))
      })
    } else if (ev.key === 'Escape') setCursor(null)
  }
  const hov = cursor != null ? data.hours[cursor] : null

  return (
    <section
      className={`${PANEL} relative`}
      data-cc-panel='throughput'
      aria-label='Throughput today'
    >
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Throughput today</h2>
        <span className={`text-[11px] ${FAINT}`}>transitions per hour</span>
      </div>
      <div className='px-3 pt-2'>
        <p className='text-[12px] text-[var(--cc-text)]'>{summary}</p>
        {cc.region && data.region_applies === false && (
          <p className={`text-[11px] ${FAINT}`}>
            Some pipelines can't be placed in regions — counted everywhere.
          </p>
        )}
        <ul className='mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]' aria-label='Legend'>
          {ORDER.map((k) => (
            <li key={k} className={`flex items-center gap-1.5 ${MUTED}`}>
              <span
                aria-hidden='true'
                className='inline-block h-0.5 w-3.5 shrink-0 rounded-full'
                style={{ background: color(k) }}
              />
              {SERIES[k].label}
            </li>
          ))}
        </ul>
      </div>
      <div className='relative px-1 pb-5'>
        {/* The chart is a slider over the hours: arrow keys move the crosshair. */}
        <div
          role='slider'
          tabIndex={0}
          aria-label='Hour of the day'
          aria-valuemin={0}
          aria-valuemax={23}
          aria-valuenow={cursor ?? 0}
          aria-valuetext={
            hov
              ? `${hourLabel(hov.hour)}: today ${hov.today ?? 'not yet'}, yesterday ${hov.yesterday}, 7-day average ${hov.avg7}`
              : `${summary} Use the arrow keys to read each hour.`
          }
          className={`rounded ${FOCUS}`}
          onKeyDown={onKey}
          onBlur={() => setCursor(null)}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className='block w-full touch-none'
            aria-hidden='true'
            onPointerMove={pick}
            onPointerLeave={() => setCursor(null)}
          >
            {[0, geo.max / 2, geo.max].map((v) => (
              <g key={v}>
                <line
                  x1={L}
                  x2={R}
                  y1={geo.y(v)}
                  y2={geo.y(v)}
                  stroke='var(--cc-border)'
                  strokeWidth='1'
                />
                <text
                  x={L - 4}
                  y={geo.y(v) + 3}
                  textAnchor='end'
                  fontSize='9'
                  fill='var(--cc-faint)'
                  className='tabular-nums'
                >
                  {Math.round(v)}
                </text>
              </g>
            ))}
            {[0, 6, 12, 18, 23].map((h) => (
              <text
                key={h}
                x={geo.x(h)}
                y={B + 12}
                textAnchor={h === 0 ? 'start' : h === 23 ? 'end' : 'middle'}
                fontSize='9'
                fill='var(--cc-faint)'
              >
                {hourLabel(h)}
              </text>
            ))}
            {[...ORDER].reverse().map((k) => (
              <path
                key={k}
                d={geo.path(k)}
                fill='none'
                stroke={color(k)}
                strokeWidth='2'
                strokeLinejoin='round'
                strokeLinecap='round'
              />
            ))}
            {geo.ends.map((e) => (
              <text
                key={e.k}
                x={Math.min(e.x + 5, R + 4)}
                y={e.y + 3}
                fontSize='9'
                fill='var(--cc-muted)'
              >
                {SERIES[e.k].label}
              </text>
            ))}
            {hov && (
              <g pointerEvents='none'>
                <line
                  x1={geo.x(hov.hour)}
                  x2={geo.x(hov.hour)}
                  y1={T}
                  y2={B}
                  stroke='var(--cc-muted)'
                  strokeWidth='1'
                />
                {ORDER.map((k) =>
                  hov[k] == null ? null : (
                    <circle
                      key={k}
                      cx={geo.x(hov.hour)}
                      cy={geo.y(hov[k] as number)}
                      r='4'
                      fill={color(k)}
                      stroke='var(--cc-panel)'
                      strokeWidth='2'
                    />
                  )
                )}
              </g>
            )}
          </svg>
        </div>
        {/* Markers: labelled ticks along the time axis, each a button with its own tooltip. */}
        {markers.map((m) => (
          <button
            key={`${m.kind}-${m.at}-${m.label}`}
            type='button'
            className={`absolute flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-sm border border-[var(--cc-border)] bg-[var(--cc-raised)] text-[9px] font-semibold text-[var(--cc-text)] hover:bg-[var(--cc-chip-hover)] ${FOCUS}`}
            style={{
              left: `calc(4px + (100% - 8px) * ${(geo.x(m.h) / W).toFixed(4)})`,
              bottom: '0px'
            }}
            data-tip={`${MARK_WORD[m.kind]} · ${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — ${m.label}`}
            aria-label={`${MARK_WORD[m.kind]} at ${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${m.label}`}
            onClick={() => (m.href ? cc.navigate(m.href) : undefined)}
          >
            {MARK_GLYPH[m.kind]}
          </button>
        ))}
        {hov && (
          <div
            className='pointer-events-none absolute top-1 rounded-md border border-[var(--cc-border)] bg-[var(--cc-panel)] px-2 py-1 text-[11px] shadow-sm'
            style={
              geo.x(hov.hour) > W / 2
                ? { right: `${((1 - geo.x(hov.hour) / W) * 100 + 3).toFixed(1)}%` }
                : { left: `${((geo.x(hov.hour) / W) * 100 + 3).toFixed(1)}%` }
            }
            aria-live='polite'
          >
            <p className='font-medium text-[var(--cc-strong)]'>
              {hourLabel(hov.hour)}–{hourLabel(hov.hour + 1)}
            </p>
            {ORDER.map((k) => (
              <p key={k} className='flex items-center gap-1.5 tabular-nums text-[var(--cc-text)]'>
                <span
                  className='inline-block h-0.5 w-2.5 rounded'
                  style={{ background: color(k) }}
                  aria-hidden
                />
                {SERIES[k].label}: {hov[k] == null ? '—' : hov[k]}
              </p>
            ))}
          </div>
        )}
      </div>
      <table className='sr-only'>
        <caption>Transitions per hour</caption>
        <thead>
          <tr>
            <th scope='col'>Hour</th>
            {ORDER.map((k) => (
              <th key={k} scope='col'>
                {SERIES[k].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.hours.map((h) => (
            <tr key={h.hour}>
              <th scope='row'>{hourLabel(h.hour)}</th>
              <td>{h.today ?? 'not yet'}</td>
              <td>{h.yesterday}</td>
              <td>{h.avg7}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
