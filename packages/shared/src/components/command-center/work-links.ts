import { encodeListLink, LIST_LINK_PARAM } from '../../lib/list-link'

/**
 * CC-5 — where a Command Center number leads. A state opens the collection list filtered to that
 * pipeline state through the list's own shareable-view parameter (`lv`, lib/list-link.ts): the
 * header column filter `__state__` (kind 'state', state keys — the browser sends it as
 * `$state _in`), plus `__aging__` (hours in the current state, 'min:') for stuck groups. The
 * reader's own access applies as on any list.
 */
export function stateListUrl(
  collection: string,
  opts: { state?: string | null; minAgeHours?: number | null } = {}
): string {
  const cf: Record<string, Record<string, unknown>> = {}
  if (opts.state) cf.__state__ = { kind: 'state', value: [opts.state] }
  if (opts.minAgeHours && opts.minAgeHours > 0)
    cf.__aging__ = { kind: 'aging', value: `${Math.round(opts.minAgeHours)}:` }
  const base = `/collections/${encodeURIComponent(collection)}`
  if (Object.keys(cf).length === 0) return base
  return `${base}?${LIST_LINK_PARAM}=${encodeListLink(`cbv:${collection}`, { cf })}`
}

/** "3d" / "5h" / "12m" from seconds — compact ages for the flow rows. */
export function ageShort(seconds: number | null | undefined): string {
  if (seconds == null) return '–'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** "3 days" in words for screen readers and tooltips. */
export function ageWords(seconds: number | null | undefined): string {
  if (seconds == null) return 'no records'
  const m = Math.floor(seconds / 60)
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (m < 60) return plural(m, 'minute')
  const h = Math.floor(m / 60)
  if (h < 48) return plural(h, 'hour')
  return plural(Math.floor(h / 24), 'day')
}

/** Time since an ISO instant, compact. */
export function sinceShort(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return ageShort(Math.max(0, (Date.now() - t) / 1000))
}
