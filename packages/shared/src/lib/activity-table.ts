/**
 * The Activity log's Table view, the pure part: the filter shape (the API's ActivityFilters —
 * api/src/services/activity-filters.ts — plus the Table's own), its query params, the URL state
 * a host keeps in its address bar, and the words for actor kinds and sources.
 */

export type ActorKind =
  | 'person'
  | 'view_as'
  | 'api_key'
  | 'mcp'
  | 'import'
  | 'flow'
  | 'cron'
  | 'system'
export type ActivitySource =
  | 'app'
  | 'api_key'
  | 'token'
  | 'mcp'
  | 'background'
  | 'integration'
  | 'other'

/** Mirrors api/src/services/activity-filters.ts ActivityFilters. */
export interface ActivityTableFilters {
  user?: string | null
  users?: string[]
  actions?: string[]
  exclude_actions?: string[]
  collections?: string[]
  item?: string | null
  from?: string | null
  to?: string | null
  range?: string | null
  q?: string | null
  actor_kinds?: ActorKind[]
  sources?: ActivitySource[]
  fields?: string[]
  undoable?: boolean
  records_only?: boolean
  /** One bulk change / import / flow run / assistant request (migration 516's burst key). */
  group_key?: string | null
}

export const ACTOR_KIND_WORDS: Record<ActorKind, string> = {
  person: 'Person',
  view_as: 'View-as',
  api_key: 'API key',
  mcp: 'AI assistant',
  import: 'Import',
  flow: 'Flow',
  cron: 'Scheduled job',
  system: 'System'
}

export const SOURCE_WORDS: Record<ActivitySource, string> = {
  app: 'The app',
  api_key: 'API key',
  token: 'Token',
  mcp: 'AI assistant',
  background: 'Background work',
  integration: 'Integration',
  other: 'No request'
}

export const RANGE_WORDS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_24_hours: 'Last 24 hours',
  last_7_days: 'Last 7 days',
  this_week: 'This week',
  last_week: 'Last week',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  last_90_days: 'Last 90 days'
}

export const TABLE_SORT_KEYS = ['when', 'action', 'collection', 'item', 'user'] as const
export type TableSortKey = (typeof TABLE_SORT_KEYS)[number]

export const TABLE_PAGE_SIZES = [25, 50, 100, 200] as const

/** Optional columns (When, Who, Action and Record always show). */
export const OPTIONAL_COLUMNS = ['collection', 'fields', 'source', 'request'] as const
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number]
export const COLUMN_WORDS: Record<OptionalColumn, string> = {
  collection: 'Collection',
  fields: 'Fields changed',
  source: 'Source',
  request: 'Request'
}

export interface ActivityTableState {
  filters: ActivityTableFilters
  /** `when` / `-when` / `collection` … */
  sort: string
  page: number
  pageSize: number
  fold: boolean
  /** The entry open in the detail drawer. */
  entry: number | null
}

export const DEFAULT_TABLE_STATE: ActivityTableState = {
  filters: {},
  sort: '-when',
  page: 1,
  pageSize: 50,
  fold: true,
  entry: null
}

const LIST_KEYS: Array<[keyof ActivityTableFilters, string]> = [
  ['users', 'users'],
  ['actions', 'action'],
  ['exclude_actions', 'exclude_actions'],
  ['collections', 'collection'],
  ['actor_kinds', 'actor_kind'],
  ['sources', 'source'],
  ['fields', 'field']
]
const TEXT_KEYS: Array<[keyof ActivityTableFilters, string]> = [
  ['user', 'user'],
  ['item', 'item'],
  ['range', 'range'],
  ['from', 'from'],
  ['to', 'to'],
  ['q', 'q'],
  ['group_key', 'group_key']
]

/** Drop empty keys so two equal filter sets compare equal. */
export function cleanTableFilters(f: ActivityTableFilters): ActivityTableFilters {
  const out: ActivityTableFilters = {}
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) continue
    ;(out as Record<string, unknown>)[k] = Array.isArray(v) ? [...new Set(v)] : v
  }
  return out
}

/**
 * A preset (locked) filter set merged under the person's own: lists are unioned only where the
 * preset has none (a preset collection list is the bound, the person narrows inside it by
 * picking within it), single values and switches from the preset win.
 */
export function mergeLocked(
  own: ActivityTableFilters,
  locked: ActivityTableFilters | undefined
): ActivityTableFilters {
  if (!locked) return cleanTableFilters(own)
  const out: ActivityTableFilters = { ...own }
  for (const [k, v] of Object.entries(cleanTableFilters(locked))) {
    const key = k as keyof ActivityTableFilters
    const mine = own[key]
    if (Array.isArray(v)) {
      const picked = Array.isArray(mine) ? mine.filter((x) => (v as string[]).includes(x)) : []
      ;(out as Record<string, unknown>)[key] = picked.length ? picked : v
    } else (out as Record<string, unknown>)[key] = v
  }
  // A preset window replaces the person's own (never two windows).
  if (locked.range || locked.from || locked.to) {
    out.range = locked.range ?? null
    out.from = locked.from ?? null
    out.to = locked.to ?? null
  }
  return cleanTableFilters(out)
}

/** GET /api/activity(/table) params for a filter set (lists comma-joined). */
export function tableFilterParams(f: ActivityTableFilters): Record<string, string> {
  const out: Record<string, string> = {}
  const c = cleanTableFilters(f)
  for (const [k, p] of LIST_KEYS) {
    const v = c[k] as string[] | undefined
    if (v?.length) out[p] = v.join(',')
  }
  for (const [k, p] of TEXT_KEYS) {
    const v = c[k] as string | undefined
    if (!v) continue
    if (c.range && (k === 'from' || k === 'to')) continue
    out[p] = v
  }
  if (c.undoable) out.undoable = '1'
  if (c.records_only) out.records_only = '1'
  return out
}

const PREFIX = 't_'

/** The table's state as URL params (filters under their API names; the rest prefixed). */
export function tableStateToParams(s: ActivityTableState): Record<string, string> {
  const out = tableFilterParams(s.filters)
  if (s.sort && s.sort !== DEFAULT_TABLE_STATE.sort) out[`${PREFIX}sort`] = s.sort
  if (s.page > 1) out[`${PREFIX}page`] = String(s.page)
  if (s.pageSize !== DEFAULT_TABLE_STATE.pageSize) out[`${PREFIX}size`] = String(s.pageSize)
  if (!s.fold) out[`${PREFIX}fold`] = '0'
  if (s.entry != null) out.entry = String(s.entry)
  return out
}

/** Every URL param the table owns (a host clears these before writing new state). */
export const TABLE_PARAM_KEYS = [
  ...LIST_KEYS.map(([, p]) => p),
  ...TEXT_KEYS.map(([, p]) => p),
  'undoable',
  'records_only',
  `${PREFIX}sort`,
  `${PREFIX}page`,
  `${PREFIX}size`,
  `${PREFIX}fold`,
  'entry'
]

const SORT_RE = /^-?(when|action|collection|item|user)$/

/** URL params → state (anything unreadable falls back to the default). */
export function tableStateFromParams(p: URLSearchParams): ActivityTableState {
  const list = (k: string) =>
    p
      .getAll(k)
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean)
  const filters: ActivityTableFilters = {}
  for (const [k, key] of LIST_KEYS) {
    const v = list(key)
    if (v.length) (filters as Record<string, unknown>)[k] = v
  }
  for (const [k, key] of TEXT_KEYS) {
    const v = p.get(key)?.trim()
    if (v) (filters as Record<string, unknown>)[k] = v
  }
  if (p.get('undoable') === '1') filters.undoable = true
  if (p.get('records_only') === '1') filters.records_only = true
  const sort = p.get(`${PREFIX}sort`) ?? ''
  const page = Math.floor(Number(p.get(`${PREFIX}page`)))
  const size = Math.floor(Number(p.get(`${PREFIX}size`)))
  const entry = Math.floor(Number(p.get('entry')))
  return {
    filters: cleanTableFilters(filters),
    sort: SORT_RE.test(sort) ? sort : DEFAULT_TABLE_STATE.sort,
    page: Number.isFinite(page) && page > 1 ? page : 1,
    pageSize: (TABLE_PAGE_SIZES as readonly number[]).includes(size)
      ? size
      : DEFAULT_TABLE_STATE.pageSize,
    fold: p.get(`${PREFIX}fold`) !== '0',
    entry: Number.isFinite(entry) && entry > 0 ? entry : null
  }
}

/** The next sort when a header is pressed: newest-first columns start descending. */
export function nextTableSort(current: string, key: TableSortKey): string {
  const desc = current.startsWith('-')
  const field = desc ? current.slice(1) : current
  if (field !== key) return key === 'when' ? '-when' : key
  return desc ? key : `-${key}`
}

export function sortOf(sort: string): { key: string; dir: 'asc' | 'desc' } {
  return sort.startsWith('-') ? { key: sort.slice(1), dir: 'desc' } : { key: sort, dir: 'asc' }
}

/** "1–50 of 1,234", "51–63", "1–50 of more than 50". */
export function pageRangeText(opts: {
  page: number
  pageSize: number
  shown: number
  total: number | null
  hasMore: boolean
}): string {
  if (opts.shown === 0) return 'No entries'
  const from = (opts.page - 1) * opts.pageSize + 1
  const to = from + opts.shown - 1
  const fmt = (n: number) => n.toLocaleString()
  if (opts.total != null && opts.total >= to) return `${fmt(from)}–${fmt(to)} of ${fmt(opts.total)}`
  return opts.hasMore ? `${fmt(from)}–${fmt(to)} of more` : `${fmt(from)}–${fmt(to)}`
}

/** A value in a field change as plain words — never JSON (objects become "key: value" lines). */
export function plainValueLines(v: unknown, depth = 0): string[] {
  if (v == null || v === '') return ['empty']
  if (typeof v === 'boolean') return [v ? 'Yes' : 'No']
  if (typeof v !== 'object') return [String(v)]
  if (Array.isArray(v)) {
    if (v.length === 0) return ['none']
    if (depth > 1) return [`${v.length} items`]
    return v.slice(0, 20).flatMap((x) => plainValueLines(x, depth + 1).map((l) => `• ${l}`))
  }
  if (depth > 1) return ['a group of values']
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return ['empty']
  return entries.slice(0, 20).map(([k, x]) => {
    const inner = plainValueLines(x, depth + 1)
    return `${k}: ${inner.length === 1 ? inner[0] : `${inner.length} values`}`
  })
}
