import { useQuery } from '@tanstack/react-query'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { post } from '../lib/commands'
import {
  compactStat,
  fmtStat,
  matchRows,
  type QueryStatFormat,
  statCoverage,
  statValue,
  sumField
} from '../lib/query-stats'
import { colorPair } from './QueryTable'

// Stat boxes above a query table (budget-overview-style strip). Each stat is
// either a client-side SUM of a field over the table's own rows (so it always
// agrees with the visible data), or an independent custom query (value = sum
// of value_field over its rows). Optional hover breakdown: `details` sums
// extra fields off the same rows; a query stat lists its rows label→value.

export interface QueryWidgetStat {
  label: string
  /** Sum this field over the main query's rows. */
  field?: string
  format?: QueryStatFormat
  /** Hover breakdown: each entry summed over the same rows. */
  details?: Array<{ label: string; field: string }>
  /** Independent source: own custom query. Value = sum of value_field over its
   *  rows; when label_field set, rows also list in the hover breakdown.
   *  param_from copies values from the main widget's effective params
   *  {statQueryParam: widgetParam}. */
  query?: {
    slug: string
    params?: Record<string, unknown>
    param_from?: Record<string, string>
    value_field: string
    label_field?: string
  }
  /** Card tint (any CSS color, e.g. '#f9fbd1'). */
  bg?: string
  /** Only sum rows matching these field values (equality AND) — e.g. scope a
   *  stat to one tree section of the table. */
  row_match?: Record<string, unknown>
  /** Delta stat: value = sum(field) − sum(field_subtract); positive values
   *  render with a leading '+'. */
  field_subtract?: string
  /** `{{field}}` arithmetic over the summed fields — a weighted ratio of totals
   *  such as `{{spent}} / {{budget}} * 100`. */
  formula?: string
  /** Shown when the value is null ('—' by default), e.g. 'never imported'. */
  empty_label?: string
  /** Stat-card accent: colored top border + value (accent_dark in dark
   *  mode; accent_negative when a delta goes negative). Each may be a role name
   *  — accent | positive | negative | info … — see QueryTable COLOR_ROLES. */
  accent?: string
  accent_dark?: string
  accent_negative?: string
  /** What one table row is ('projects'). When set and only some rows carry a
   *  figure for this tile, a quiet "3 of 912 projects" line says how much of
   *  the table the number covers; when NO row does, the tile shows its
   *  empty_label instead of a summed zero. */
  coverage?: string
}

/** Colour roles that are neutral ink, not a hue: they colour the value but
 *  draw no accent stripe (a black stripe is the loudest mark in the strip). */
const NEUTRAL_ACCENTS = new Set(['ink', 'muted'])

/** Smallest tile width before the strip moves to more rows. */
const MIN_TILE = 150
const GAP = 8

/** Measure whether `full` fits in the value box and report it upward: the
 *  strip shortens EVERY money tile when any one of them would clip, so the
 *  tiles never mix $637.1M with $3,250,100.50. */
function useFits(full: string, onFit: (fits: boolean) => void) {
  const box = useRef<HTMLParagraphElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useLayoutEffect(() => {
    const b = box.current
    const p = probe.current
    if (!b || !p) {
      onFit(true)
      return
    }
    const check = () => onFit(p.offsetWidth <= b.clientWidth)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(b)
    return () => ro.disconnect()
  }, [full])
  return { box, probe }
}

function StatBox({
  stat,
  rows,
  effectiveParams,
  loading,
  compact,
  onFit
}: {
  stat: QueryWidgetStat
  rows: Array<Record<string, unknown>>
  effectiveParams: Record<string, unknown>
  loading: boolean
  compact: boolean
  onFit: (fits: boolean) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const q = stat.query
  const queryParams = q
    ? {
        ...(q.params ?? {}),
        ...Object.fromEntries(
          Object.entries(q.param_from ?? {}).map(([sp, wp]) => [sp, effectiveParams[wp]])
        )
      }
    : null
  const { data: qRows, isLoading: qLoading } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['query-stat', q?.slug, JSON.stringify(queryParams)],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          post(`/custom-queries/${q!.slug}/execute`, { params: queryParams })
        )
        .then((r) => r.data ?? []),
    enabled: !!q,
    staleTime: 60_000
  })

  const matchedRows = matchRows(rows, stat.row_match)
  const busy = q ? qLoading : loading
  const coverage = stat.coverage && !busy ? statCoverage(stat, rows) : null
  // With coverage on, a tile no row reports for has no figure — not $0.
  const noneReporting = !!coverage && coverage.reporting === 0
  const value = busy || noneReporting ? null : statValue(stat, rows, qRows ?? null)
  const empty = !busy && (value === null || value === undefined || value === '')
  // Date / text tiles are context (when, which), not a measure: they sit
  // quieter than the money beside them and never take an accent.
  const meta = stat.format === 'date' || stat.format === 'text'

  const detailItems: Array<{ label: string; value: number }> = q
    ? q.label_field
      ? (qRows ?? []).map((r) => ({
          label: String(r[q.label_field as string] ?? '—'),
          value: Number(r[q.value_field]) || 0
        }))
      : []
    : (stat.details ?? []).map((d) => ({ label: d.label, value: sumField(matchedRows, d.field) }))

  // A delta tile flips to accent_negative below zero; any other tile does
  // too when it OPTS IN with accent_negative (Remaining Budget overspent).
  const isNegativeDelta =
    typeof value === 'number' && value < 0 && (stat.field_subtract || stat.accent_negative)
  const accentName = isNegativeDelta ? (stat.accent_negative ?? 'negative') : stat.accent
  const accentPair =
    meta || empty || !accentName
      ? null
      : isNegativeDelta
        ? colorPair(accentName)
        : colorPair(accentName, stat.accent_dark)
  const stripe = accentPair && !NEUTRAL_ACCENTS.has(String(accentName).trim().toLowerCase())

  const sign = typeof value === 'number' && stat.field_subtract && value > 0 ? '+' : ''
  const fullText = `${sign}${fmtStat(value, stat.format, stat.empty_label)}`
  const canShorten =
    typeof value === 'number' &&
    (stat.format === undefined || stat.format === 'currency' || stat.format === 'number')
  // Non-money tiles measure nothing ('' always fits), so they never hold the strip compact.
  const { box, probe } = useFits(canShorten ? fullText : '', onFit)
  const shown =
    compact && canShorten ? `${sign}${compactStat(value as number, stat.format)}` : fullText

  const partial = coverage && coverage.reporting > 0 && coverage.reporting < coverage.total

  const hasDetails = detailItems.length > 0
  return (
    // Hover is a mouse convenience; the label button below is the keyboard path.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div
      className='relative min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
      style={
        accentPair
          ? ({ '--qsa': accentPair[0], '--qsad': accentPair[1] } as unknown as React.CSSProperties)
          : undefined
      }
      onMouseEnter={hasDetails ? () => setOpen(true) : undefined}
      onMouseLeave={hasDetails ? () => setOpen(false) : undefined}
      data-stat-tile={stat.label}
    >
      {stripe && (
        <span
          aria-hidden='true'
          className='absolute -inset-x-px -top-px h-[2px] rounded-t-lg bg-[color:var(--qsa)] dark:bg-[color:var(--qsad)]'
        />
      )}
      {/* The configured tint renders as a small accent dot, not a card wash —
          six pastel-washed cards in a row read as noise, six neutral cards
          with color-keyed dots read as a system. */}
      <p className='flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
        {stat.bg && (
          <span
            aria-hidden='true'
            className='h-2 w-2 shrink-0 rounded-full border border-black/10'
            style={{ backgroundColor: stat.bg, filter: 'saturate(2.2)' }}
          />
        )}
        {hasDetails ? (
          // The breakdown is a disclosure: a real button so keyboard users reach it.
          <button
            type='button'
            className='min-w-0 truncate rounded-sm text-left underline decoration-slate-300 decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:decoration-slate-600'
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onClick={() => setOpen((v) => !v)}
            title={stat.label}
          >
            {stat.label}
          </button>
        ) : (
          <span className='truncate' title={stat.label}>
            {stat.label}
          </span>
        )}
      </p>
      {busy ? (
        <div className='mt-1 h-5 w-24 animate-pulse rounded bg-slate-200/60 dark:bg-[hsl(var(--nvr-skeleton))]' />
      ) : (
        <p
          ref={box}
          className={`relative mt-0.5 truncate leading-[22px] tabular-nums ${
            empty
              ? 'text-[13px] font-normal text-slate-500 dark:text-slate-400'
              : meta
                ? 'text-[13px] font-medium text-slate-600 dark:text-slate-300'
                : accentPair
                  ? 'text-[15px] font-semibold text-[color:var(--qsa)] dark:text-[color:var(--qsad)]'
                  : 'text-[15px] font-semibold text-slate-800 dark:text-slate-100'
          }`}
          title={shown !== fullText ? fullText : undefined}
          data-stat-value
        >
          {shown}
          {/* Off-screen copy of the exact figure — measures whether it fits. */}
          <span
            ref={probe}
            aria-hidden='true'
            className='pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap'
          >
            {fullText}
          </span>
        </p>
      )}
      {partial && (
        <p
          className='truncate text-[11px] tabular-nums text-slate-500 dark:text-slate-400'
          data-stat-coverage
        >
          {coverage.reporting.toLocaleString('en-US')} of {coverage.total.toLocaleString('en-US')}{' '}
          {stat.coverage}
        </p>
      )}
      {open && hasDetails && (
        <div
          id={detailsId}
          className='absolute left-0 top-full z-40 mt-1 min-w-[220px] rounded-md border border-slate-200 bg-white p-2 shadow-lg dark:border-border dark:bg-popover'
        >
          {detailItems.map((d) => (
            <div key={d.label} className='flex justify-between gap-4 py-0.5 text-[12px]'>
              <span className='text-slate-500 dark:text-slate-400'>{d.label}</span>
              <span className='tabular-nums text-slate-700 dark:text-slate-200'>
                {fmtStat(d.value, stat.format)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function QueryStatStrip({
  stats,
  rows,
  effectiveParams,
  loading
}: {
  stats: QueryWidgetStat[]
  rows: Array<Record<string, unknown>>
  effectiveParams: Record<string, unknown>
  loading: boolean
}) {
  // Balanced rows: as many columns as fit at MIN_TILE, then spread the tiles
  // evenly over the rows they need (8 tiles → 8, or 4 + 4 — never 6 + 2 with
  // two stretched orphans).
  const ref = useRef<HTMLDivElement>(null)
  const n = stats.length
  const [cols, setCols] = useState(n)
  const [clipping, setClipping] = useState<Record<string, boolean>>({})
  const compact = Object.values(clipping).some(Boolean)
  // One stable reporter per tile: a tile that clipped stays on record until it
  // reports it fits again (it keeps measuring the exact text while shortened).
  const reporters = useRef(new Map<string, (fits: boolean) => void>())
  const reporterFor = (label: string) => {
    let r = reporters.current.get(label)
    if (!r) {
      r = (fits: boolean) =>
        setClipping((prev) => (prev[label] === !fits ? prev : { ...prev, [label]: !fits }))
      reporters.current.set(label, r)
    }
    return r
  }
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !n) return
    const measure = () => {
      const perRow = Math.max(1, Math.floor((el.clientWidth + GAP) / (MIN_TILE + GAP)))
      const rowsNeeded = Math.ceil(n / perRow)
      setCols(Math.ceil(n / rowsNeeded))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [n])
  if (!n) return null
  return (
    <div
      ref={ref}
      className='grid gap-2 pb-3'
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {stats.map((s) => (
        <StatBox
          key={s.label}
          stat={s}
          rows={rows}
          effectiveParams={effectiveParams}
          loading={loading}
          compact={compact}
          onFit={reporterFor(s.label)}
        />
      ))}
    </div>
  )
}
