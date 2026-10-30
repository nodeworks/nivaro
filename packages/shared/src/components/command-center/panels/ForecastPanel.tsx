import { AlertTriangle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { FAINT, MUTED, PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { ForecastToday } from '../types'

/**
 * Today's forecast (CC-33): arrivals (records entering their workflow) and completions per hour
 * today against the usual curve — the same hour on the same weekday over the last 4 weeks. Two
 * series in fixed categorical slots (blue = arrivals, orange = completions; the validated
 * reference palette, stepped per theme); today solid, usual dashed. Hover (or focus) an hour for
 * its numbers. The summary under the chart says the same in words, and "falling behind" is said
 * in words with an icon, never by colour alone. A screen-reader table carries every hour.
 */
const W = 320
const H = 120
const PAD = { l: 26, r: 6, t: 8, b: 18 }
const HOUR_LABEL = (h: number) =>
  h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`

const viewerTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function ForecastPanel() {
  const cc = useCc()
  const tz = useMemo(viewerTz, [])
  const q = useCcQuery<ForecastToday>('/forecast', { tz }, { refetchInterval: 120_000 })
  const f = q.data
  const [hover, setHover] = useState<number | null>(null)
  if (q.isError) return null
  const nowHour = cc.at ? new Date(cc.at).getHours() : new Date().getHours()

  const rows = f?.by_hour ?? []
  const max = Math.max(
    1,
    ...rows.flatMap((r) => [r.arrivals, r.completions, r.expected_arrivals, r.expected_completions])
  )
  const x = (h: number) => PAD.l + (h / 23) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b)
  const path = (vals: Array<number | null>) =>
    vals
      .map((v, h) => (v == null ? null : `${x(h).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .map((p, i) => `${i ? 'L' : 'M'}${p}`)
      .join(' ')
  const today = (k: 'arrivals' | 'completions') =>
    rows.map((r) => (r.hour <= nowHour ? r[k] : null))
  const noHistory = f != null && (f.history_days ?? 0) === 0
  const hovered = hover != null ? rows[hover] : null

  return (
    <section className={PANEL} data-cc-panel='forecast' data-cc-forecast aria-busy={q.isLoading}>
      <style>{`
        [data-cc-mode='light'] [data-cc-forecast] { --fc-a: #2a78d6; --fc-c: #eb6834; }
        [data-cc-mode='dark'] [data-cc-forecast] { --fc-a: #3987e5; --fc-c: #d95926; }
      `}</style>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Today’s forecast</h2>
        <span className={`flex items-center gap-2 text-[10.5px] ${MUTED}`}>
          <Key color='var(--fc-a)' label='Arrivals' />
          <Key color='var(--fc-c)' label='Completions' />
          <span className='flex items-center gap-1'>
            <span className='w-3.5 border-t-2 border-dashed border-[var(--cc-muted)]' aria-hidden />
            usual
          </span>
        </span>
      </div>
      <div className='p-3'>
        {f && (
          <div className='relative'>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className='block h-auto w-full'
              role='img'
              aria-label={summary(f)}
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                // One column per hour, wider than the marks: the hour under the pointer.
                const box = e.currentTarget.getBoundingClientRect()
                const px = ((e.clientX - box.left) / Math.max(1, box.width)) * W
                const h = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * 23)
                setHover(Math.min(23, Math.max(0, h)))
              }}
            >
              {/* recessive grid + axes */}
              <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke='var(--cc-border)' />
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(max)}
                y2={y(max)}
                stroke='var(--cc-border)'
                strokeDasharray='2 3'
              />
              <text
                x={PAD.l - 4}
                y={y(max) + 3}
                textAnchor='end'
                fontSize='8'
                fill='var(--cc-faint)'
              >
                {Math.round(max)}
              </text>
              <text x={PAD.l - 4} y={y(0) + 3} textAnchor='end' fontSize='8' fill='var(--cc-faint)'>
                0
              </text>
              {[0, 6, 12, 18, 23].map((h) => (
                <text
                  key={h}
                  x={x(h)}
                  y={H - 4}
                  textAnchor='middle'
                  fontSize='8'
                  fill='var(--cc-faint)'
                >
                  {HOUR_LABEL(h)}
                </text>
              ))}
              {/* now */}
              <line
                x1={x(nowHour)}
                x2={x(nowHour)}
                y1={PAD.t}
                y2={y(0)}
                stroke='var(--cc-faint)'
                strokeDasharray='1 2'
              />
              {!noHistory && (
                <>
                  <path
                    d={path(rows.map((r) => r.expected_arrivals))}
                    fill='none'
                    stroke='var(--fc-a)'
                    strokeWidth='1.5'
                    strokeDasharray='4 3'
                    opacity='0.8'
                  />
                  <path
                    d={path(rows.map((r) => r.expected_completions))}
                    fill='none'
                    stroke='var(--fc-c)'
                    strokeWidth='1.5'
                    strokeDasharray='4 3'
                    opacity='0.8'
                  />
                </>
              )}
              <path
                d={path(today('arrivals'))}
                fill='none'
                stroke='var(--fc-a)'
                strokeWidth='2'
                strokeLinejoin='round'
              />
              <path
                d={path(today('completions'))}
                fill='none'
                stroke='var(--fc-c)'
                strokeWidth='2'
                strokeLinejoin='round'
              />
              {hovered && (
                <line
                  x1={x(hovered.hour)}
                  x2={x(hovered.hour)}
                  y1={PAD.t}
                  y2={y(0)}
                  stroke='var(--cc-muted)'
                />
              )}
            </svg>
            {hovered && (
              <div
                className='pointer-events-none absolute top-0 rounded-md border border-[var(--cc-border)] bg-[var(--cc-panel)] px-2 py-1 text-[11px] text-[var(--cc-text)] shadow-sm'
                style={{
                  left: `${(x(hovered.hour) / W) * 100}%`,
                  transform: hovered.hour > 14 ? 'translateX(calc(-100% - 6px))' : 'translateX(6px)'
                }}
              >
                <div className='font-medium'>
                  {HOUR_LABEL(hovered.hour)}–{HOUR_LABEL((hovered.hour + 1) % 24)}
                </div>
                <div className='tabular-nums'>
                  Arrivals {hovered.hour <= nowHour ? hovered.arrivals : '–'}{' '}
                  <span className={FAINT}>(usual {hovered.expected_arrivals})</span>
                </div>
                <div className='tabular-nums'>
                  Completions {hovered.hour <= nowHour ? hovered.completions : '–'}{' '}
                  <span className={FAINT}>(usual {hovered.expected_completions})</span>
                </div>
              </div>
            )}
          </div>
        )}
        {f && (
          <div className='mt-2 space-y-1 text-[11.5px]'>
            {f.behind && (
              <p
                className='flex items-center gap-1 font-medium text-[var(--cc-warn-text)]'
                role='status'
              >
                <AlertTriangle className='h-3.5 w-3.5' aria-hidden />
                Falling behind: work is arriving faster than it is being finished, compared with a
                usual {weekday(cc.at)}.
              </p>
            )}
            <p className={MUTED}>{summary(f)}</p>
            {f.region_applies === false && (
              <p className={FAINT}>These records are not placed in regions — showing everywhere.</p>
            )}
          </div>
        )}
        {f && (
          <table className='sr-only'>
            <caption>Arrivals and completions by hour today, with the usual</caption>
            <thead>
              <tr>
                <th>Hour</th>
                <th>Arrivals</th>
                <th>Usual arrivals</th>
                <th>Completions</th>
                <th>Usual completions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hour}>
                  <td>{HOUR_LABEL(r.hour)}</td>
                  <td>{r.hour <= nowHour ? r.arrivals : ''}</td>
                  <td>{r.expected_arrivals}</td>
                  <td>{r.hour <= nowHour ? r.completions : ''}</td>
                  <td>{r.expected_completions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!f && q.isLoading && <p className={`text-[12px] ${FAINT}`}>Working out today…</p>}
      </div>
    </section>
  )
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className='flex items-center gap-1'>
      <span className='h-[2px] w-3 rounded' style={{ background: color }} aria-hidden />
      {label}
    </span>
  )
}

function weekday(at: number | null): string {
  return new Date(at ?? Date.now()).toLocaleDateString(undefined, { weekday: 'long' })
}

function summary(f: ForecastToday): string {
  const usual = (f.history_days ?? 0) > 0
  const a = `${f.arrivals_so_far} arrived so far${usual ? ` (usually ${Math.round(f.arrivals_expected)} by now)` : ''}`
  const c = `${f.completions_so_far} completed${usual ? ` (usually ${Math.round(f.completions_expected)})` : ''}`
  return `${a}; ${c}.${usual ? '' : ' Not enough history yet for a usual day.'}`
}
