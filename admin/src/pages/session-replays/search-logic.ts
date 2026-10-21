/**
 * Replay search (#1374) — the pure half of the Search tab: what the URL holds,
 * what goes to GET /session-recordings/search, and how a hit reads.
 */

export interface ReplaySearchParams {
  collection: string
  item: string
  field: string
  selector: string
  /** #1315 — a failed-request filter: '' | '4xx' | '5xx' | 'client_error'. */
  outcome: string
  /** Route pattern the recording visited ('/collections/orders/:id'). */
  route: string
  /** Look-back days for an outcome search. */
  days: string
}

export const SEARCH_PARAM_KEYS = [
  'collection',
  'item',
  'field',
  'selector',
  'outcome',
  'route',
  'days'
] as const

export const OUTCOME_OPTIONS = [
  { value: '', label: 'Any outcome' },
  { value: '4xx', label: 'Request failed (4xx)' },
  { value: '5xx', label: 'Server error (5xx)' },
  { value: 'client_error', label: 'Error in the browser' }
]
export const OUTCOME_DAYS = [
  { value: '1', label: 'Last day' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' }
]

export interface ReplayMatch {
  kind: 'route' | 'record' | 'field' | 'selector' | 'outcome'
  key: string
  first_ms: number
  last_ms: number
}

/** One recording that matched, as the search endpoint answers it. */
export interface ReplayHit {
  id: string
  user: string | null
  user_name: string | null
  app: string | null
  origin: string | null
  started_at: string
  ended_at: string | null
  last_event_at: string | null
  event_count: number
  byte_size: number
  truncated: boolean
  /** Span of the match (epoch ms). */
  first_ms: number
  last_ms: number
  matches: ReplayMatch[]
}

export function readSearchParams(p: URLSearchParams): ReplaySearchParams {
  return {
    collection: p.get('collection')?.trim() ?? '',
    item: p.get('item')?.trim() ?? '',
    field: p.get('field')?.trim() ?? '',
    selector: p.get('selector')?.trim() ?? '',
    outcome: p.get('outcome')?.trim() ?? '',
    route: p.get('route')?.trim() ?? '',
    days: p.get('days')?.trim() ?? ''
  }
}

/** True when the URL asks for the Search tab (a ?tab=search or any search key). */
export function wantsSearchTab(p: URLSearchParams): boolean {
  if (p.get('tab') === 'search') return true
  return SEARCH_PARAM_KEYS.some((k) => k !== 'days' && !!p.get(k)?.trim())
}

/**
 * Query string for the search endpoint, or '' when there is nothing it can
 * answer (no criterion, or a record id without its collection).
 */
export function searchQueryString(q: ReplaySearchParams): string {
  if (q.item && !q.collection) return ''
  if (!q.collection && !q.field && !q.selector && !q.outcome && !q.route) return ''
  const out = new URLSearchParams()
  for (const k of SEARCH_PARAM_KEYS) {
    // The look-back only means something to an outcome search.
    if (q[k] && (k !== 'days' || q.outcome)) out.set(k, q[k])
  }
  return out.toString()
}

/** Collections that have indexed record visits, from `collection/id` keys. */
export function collectionsFromRecordKeys(keys: string[]): string[] {
  const set = new Set<string>()
  for (const k of keys) {
    const i = k.indexOf('/')
    if (i > 0) set.add(k.slice(0, i))
  }
  return [...set].sort()
}

/** "Opened orders/1042", "Typed in due_date", … */
export function matchLabel(m: ReplayMatch): string {
  switch (m.kind) {
    case 'record':
      return `Opened ${m.key}`
    case 'field':
      return `In field ${m.key}`
    case 'selector':
      return `Touched ${m.key}`
    case 'outcome':
      return m.key
    default:
      return `Visited ${m.key}`
  }
}

/** "14:02–14:09" (same day) for a match span. */
export function spanLabel(first: number, last: number): string {
  const t = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const a = t(first)
  const b = t(last)
  return a === b ? a : `${a}–${b}`
}
