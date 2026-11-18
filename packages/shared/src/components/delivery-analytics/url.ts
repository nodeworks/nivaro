import { useCallback, useState } from 'react'
import type { DaCell, DaCond, DaSource } from './types'

/**
 * Everything the page shows lives in the URL, so a drilled view is a link and
 * Back steps out of it:
 *
 *   window=24h|7d|30d|90d|custom  from=YYYY-MM-DD  to=YYYY-MM-DD
 *   category=  channel=  collection=  sender=  acted=4|24|72   by=<breakdown>
 *   d=n|m|x    the open drill's source        dw=<dim>:<v1>,<v2>  (repeatable)
 *   dp=1       the drill counts the previous period
 *   dl=        the drill's title              ds=time-asc|ttr     sort
 *   dby=<dim>  the drill is split by one more dimension
 *   leaf=n:<id> | m:<id>   one notification / email
 */

export const PAGE_KEYS = [
  'window',
  'from',
  'to',
  'category',
  'channel',
  'collection',
  'sender',
  'acted',
  'by'
] as const
export const DRILL_KEYS = ['d', 'dw', 'dp', 'dl', 'ds', 'dby', 'leaf'] as const

export type SetParams = (mutate: (p: URLSearchParams) => void, opts?: { replace?: boolean }) => void

/** Host-owned URL state when the host passes it; the view's own state otherwise. */
export function useParamState(
  search: URLSearchParams | undefined,
  onChange: ((next: URLSearchParams, opts: { replace?: boolean }) => void) | undefined
): [URLSearchParams, SetParams] {
  const [own, setOwn] = useState(() => new URLSearchParams())
  const params = search ?? own
  const set = useCallback<SetParams>(
    (mutate, opts = {}) => {
      const next = new URLSearchParams(params)
      mutate(next)
      if (onChange) onChange(next, opts)
      else setOwn(next)
    },
    [params, onChange]
  )
  return [params, set]
}

export const encodeCond = ([dim, values]: DaCond): string =>
  `${dim}:${values.map(encodeURIComponent).join(',')}`

export function decodeCond(raw: string): DaCond | null {
  const i = raw.indexOf(':')
  if (i <= 0) return null
  try {
    return [
      raw.slice(0, i),
      raw
        .slice(i + 1)
        .split(',')
        .map(decodeURIComponent)
    ]
  } catch {
    return null
  }
}

export interface DrillState {
  source: DaSource
  where: DaCond[]
  prev: boolean
  label: string | null
  sort: 'time' | 'time-asc' | 'ttr'
  splitBy: string | null
  leaf: { source: 'n' | 'm'; id: number } | null
}

export function readDrill(p: URLSearchParams): DrillState | null {
  const leafRaw = p.get('leaf')
  const leafMatch = leafRaw?.match(/^([nm]):(\d+)$/)
  const leaf = leafMatch ? { source: leafMatch[1] as 'n' | 'm', id: Number(leafMatch[2]) } : null
  const d = p.get('d')
  if (d !== 'n' && d !== 'm' && d !== 'x') {
    if (!leaf) return null
    return {
      source: leaf.source,
      where: [],
      prev: false,
      label: null,
      sort: 'time',
      splitBy: null,
      leaf
    }
  }
  const ds = p.get('ds')
  return {
    source: d,
    where: p
      .getAll('dw')
      .map(decodeCond)
      .filter((c): c is DaCond => !!c),
    prev: p.get('dp') === '1',
    label: p.get('dl'),
    sort: ds === 'ttr' || ds === 'time-asc' ? ds : 'time',
    splitBy: p.get('dby'),
    leaf
  }
}

export function clearDrill(p: URLSearchParams): void {
  for (const k of DRILL_KEYS) p.delete(k)
}

export function writeDrill(p: URLSearchParams, cell: DaCell, label: string): void {
  clearDrill(p)
  p.set('d', cell.s)
  for (const c of cell.w) p.append('dw', encodeCond(c))
  if (cell.win === 'prev') p.set('dp', '1')
  p.set('dl', label)
}

/** The query a drill's rows / split request carries (absolute window from the summary). */
export function drillQuery(
  page: URLSearchParams,
  drill: Pick<DrillState, 'source' | 'where' | 'prev'>,
  win: {
    from: string
    to: string
    prev_from: string
    prev_to: string
    asof: string
    acted_hours: number
  }
): URLSearchParams {
  const q = new URLSearchParams()
  q.set('source', drill.source)
  q.set('from', drill.prev ? win.prev_from : win.from)
  q.set('to', drill.prev ? win.prev_to : win.to)
  q.set('asof', win.asof)
  q.set('acted_hours', String(win.acted_hours))
  for (const k of ['category', 'channel', 'collection', 'sender'] as const) {
    const v = page.get(k)
    if (v) q.set(k, v)
  }
  for (const c of drill.where) q.append('w', encodeCond(c))
  return q
}

// ── Formatting ─────────────────────────────────────────────────────────────

export const fmtInt = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? '–' : n.toLocaleString('en-US')

export const pct = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–'

export function mins(m: number | null | undefined): string {
  if (m == null || Number.isNaN(m)) return '–'
  if (m < 1) return `${Math.max(1, Math.round(m * 60))}s`
  if (m < 60) return `${Math.round(m)}m`
  if (m < 1440) return `${(m / 60).toFixed(1)}h`
  return `${(m / 1440).toFixed(1)}d`
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function fmtRange(fromIso: string, toIso: string): string {
  const f = new Date(fromIso)
  const t = new Date(toIso)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  const sameDay = t.getTime() - f.getTime() <= 2 * 86_400_000
  if (sameDay)
    return `${f.toLocaleString(undefined, { ...opts, hour: 'numeric', minute: '2-digit' })} – ${t.toLocaleString(undefined, { ...opts, hour: 'numeric', minute: '2-digit' })}`
  return `${f.toLocaleDateString(undefined, opts)} – ${t.toLocaleDateString(undefined, opts)}`
}

/** A bucket key (YYYY-MM-DD or YYYY-MM-DDTHH, UTC) as a short local label. */
export function bucketLabel(key: string, bucket: 'day' | 'hour'): string {
  if (bucket === 'hour') {
    const d = new Date(`${key}:00:00.000Z`)
    return d.toLocaleTimeString(undefined, { hour: 'numeric' })
  }
  const d = new Date(`${key}T00:00:00.000Z`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export const titleize = (s: string): string =>
  s === '(none)' ? 'None' : s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
