import { getDisplayTimezone } from '../../lib/utils'

/**
 * Pages visited — what the card and the Day view do with a person's stored
 * routes. The API names each place as the viewer may read it (journey-labels.ts
 * `label`); this folds a session's steps into rows a person can read, and says
 * the route's own words (never ids, never query strings) when the API did not.
 */

export type JourneyLabelKind = 'record' | 'new-record' | 'list' | 'queue' | 'person' | 'page'

export interface JourneyLabel {
  title: string
  section: string | null
  detail: string | null
  kind: JourneyLabelKind
  key: string
  record?: { collection: string; id: string }
  queue_id?: string
  person_id?: string
}

export interface JourneyStepIn {
  path: string
  entered_at: string
  duration_seconds: number | null
  app?: string
  label?: JourneyLabel
}

export interface JourneyRow {
  label: JourneyLabel
  /** Where the first folded step pointed (a link target for admin pages). */
  path: string
  app: string
  start: string
  /** Total time across the folded visits; null = the page is still open / unknown. */
  seconds: number | null
  visits: number
  details: string[]
  /** The last visit has no end yet (the person may still be there). */
  open: boolean
}

export interface JourneySessionView {
  rows: JourneyRow[]
  /** Steps left out because the page was open for under a second. */
  skipped: number
  /** Every step, as recorded. */
  views: number
  start: string
  end: string
  seconds: number
}

// ─── Words ───────────────────────────────────────────────────────────────────

const ACRONYMS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  csv: 'CSV',
  erp: 'ERP',
  id: 'ID',
  mcp: 'MCP',
  pdf: 'PDF',
  sla: 'SLA',
  sql: 'SQL',
  sso: 'SSO',
  ui: 'UI'
}

/** "invoice-approvals" → "Invoice approvals". */
export function words(raw: string): string {
  const out = raw
    .split(/[\s_.:-]+/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase())
    .join(' ')
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : ''
}

/** A segment that names a record rather than a page (twin of api presence-stuck isIdLikeSegment). */
export function isIdLike(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[A-Za-z0-9_-]{20,}$/.test(seg) ||
    (/\d/.test(seg) && /^[A-Z0-9-]+$/.test(seg))
  )
}

function singular(w: string): string {
  if (/ies$/i.test(w)) return w.replace(/ies$/i, 'y')
  if (/(ss|us|is)$/i.test(w)) return w
  if (/(x|ch|sh)es$/i.test(w)) return w.replace(/es$/i, '')
  return /s$/i.test(w) ? w.slice(0, -1) : w
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const valueWords = (v: string) => {
  const s = decode(v).trim()
  return s && /^[A-Za-z0-9 _-]{1,40}$/.test(s) && !isIdLike(s) ? words(s) : null
}
const tabWords = (v: string) => {
  const w = valueWords(v)
  return w ? `${w} tab` : null
}
const QUERY_WORDS: Record<string, (v: string) => string | null> = {
  addendum: () => 'Addendum open',
  tab: tabWords,
  p: tabWords,
  section: tabWords,
  view: tabWords,
  focus: valueWords,
  edit: () => 'Editing',
  watch: () => 'Watching a video',
  recording: () => 'Watching a recording',
  ticket: () => 'Ticket open',
  q: () => 'Searching',
  search: () => 'Searching',
  autofill: () => 'From a document',
  prefill: () => 'Prefilled'
}

function queryWords(search: string): string | null {
  const out: string[] = []
  for (const part of search.split('&')) {
    const [k, ...rest] = part.split('=')
    const w = QUERY_WORDS[decode(k ?? '').toLowerCase()]?.(rest.join('='))
    if (w && !out.includes(w)) out.push(w)
  }
  return out.length ? out.join(' · ') : null
}

/**
 * The route's own words, for a step the API sent no label for (an older API).
 * Same shape as the server's answer, but with no lookups: a record is "A
 * workflow record", a queue "A queue". Ids and query strings never show.
 */
export function fallbackJourneyLabel(path: string): JourneyLabel {
  const [bare, ...q] = String(path ?? '').split('?')
  const segs = bare.split('#')[0].split('/').filter(Boolean).map(decode)
  const detail = queryWords(q.join('?').split('#')[0])
  const [a, b, c] = segs
  if ((a === 'records' || a === 'collections') && b && /^[A-Za-z_]\w*$/.test(b)) {
    const plural = words(b.replace(/^(nivaro|directus)_/, ''))
    const one = singular(plural)
    if (!c) return { title: plural, section: 'List', detail, kind: 'list', key: `list:${b}` }
    if (c === 'new')
      return {
        title: `New ${one.toLowerCase()}`,
        section: plural,
        detail,
        kind: 'new-record',
        key: `new:${b}`
      }
    return {
      title: `A ${one.toLowerCase()} record`,
      section: plural,
      detail,
      kind: 'record',
      key: `record:${b}:${c.toLowerCase()}`
    }
  }
  if (a === 'queues' && b)
    return {
      title: 'A queue',
      section: 'Queue',
      detail,
      kind: 'queue',
      key: `queue:${b.toLowerCase()}`
    }
  const named = segs
    .filter((s) => !isIdLike(s))
    .map(words)
    .filter(Boolean)
  const key = `page:${segs.join('/').toLowerCase()}`
  if (!named.length) return { title: 'Home', section: null, detail, kind: 'page', key }
  return {
    title: named[named.length - 1],
    section: named.length > 1 ? named[0] : null,
    detail,
    kind: 'page',
    key
  }
}

// ─── Folding ─────────────────────────────────────────────────────────────────

const ms = (iso: string) => new Date(iso).getTime()

/**
 * One session's steps → rows. A step open for under a second (a redirect, a
 * click straight through) is left out and counted; then consecutive visits to
 * the same place fold into one row with their total time — so "record →
 * record with its addendum open → record" reads as one row, "Addendum open".
 */
export function foldJourneySession(steps: ReadonlyArray<JourneyStepIn>): JourneySessionView {
  const all = [...steps].sort((x, y) => ms(x.entered_at) - ms(y.entered_at))
  const kept = all.length > 1 ? all.filter((s) => s.duration_seconds !== 0) : all
  const list = kept.length ? kept : all.slice(-1)
  const rows: JourneyRow[] = []
  for (const s of list) {
    const label = s.label ?? fallbackJourneyLabel(s.path)
    const prev = rows[rows.length - 1]
    const detail = label.detail
    if (prev && prev.label.key === label.key) {
      prev.visits++
      prev.seconds =
        s.duration_seconds == null ? prev.seconds : (prev.seconds ?? 0) + s.duration_seconds
      prev.open = s.duration_seconds == null
      if (detail && !prev.details.includes(detail)) prev.details.push(detail)
      // A readable record label (with its link) beats a fallback one.
      if (!prev.label.record && label.record) prev.label = { ...label, detail: prev.label.detail }
      continue
    }
    rows.push({
      label,
      path: s.path,
      app: s.app ?? 'admin',
      start: s.entered_at,
      seconds: s.duration_seconds,
      visits: 1,
      details: detail ? [detail] : [],
      open: s.duration_seconds == null
    })
  }
  const first = all[0]
  const last = all[all.length - 1]
  const startMs = first ? ms(first.entered_at) : 0
  const endMs = last ? ms(last.entered_at) + (last.duration_seconds ?? 0) * 1000 : 0
  const end = Math.max(startMs, endMs)
  return {
    rows,
    skipped: all.length - list.length,
    views: all.length,
    start: first ? new Date(startMs).toISOString() : '',
    end: first ? new Date(end).toISOString() : '',
    seconds: Math.round((end - startMs) / 1000)
  }
}

// ─── Time ────────────────────────────────────────────────────────────────────

function clockParts(iso: string): { time: string; period: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(getDisplayTimezone() ? { timeZone: getDisplayTimezone() as string } : {})
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { time: `${get('hour')}:${get('minute')}`, period: get('dayPeriod') }
}

/** "8:57 AM" — no leading zero, the viewer's chosen zone. */
export function fmtClock(iso: string): string {
  const { time, period } = clockParts(iso)
  return period ? `${time} ${period}` : time
}

/** "8:57 – 9:42 AM", or "11:50 AM – 12:10 PM" across noon. */
export function fmtSpan(startIso: string, endIso: string): string {
  const a = clockParts(startIso)
  const b = clockParts(endIso)
  if (a.time === b.time && a.period === b.period) return fmtClock(startIso)
  if (a.period === b.period) return `${a.time} – ${b.time}${b.period ? ` ${b.period}` : ''}`
  return `${fmtClock(startIso)} – ${fmtClock(endIso)}`
}

/** "<1s", "59s", "1m 9s", "17m", "1h 5m". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return ''
  const s = Math.max(0, Math.round(seconds))
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}
