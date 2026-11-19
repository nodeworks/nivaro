import type { Knex } from 'knex'
import { parseReportDate } from './activity-report.js'
import { withRoutineReads } from './activity-sentence.js'

/**
 * One filter shape for the audit log (#10/#11): GET /api/activity's params, the natural-language
 * search's output, a saved view's stored `filters` and a scheduled send all speak it, and all of
 * them reach the table through `applyActivityFilters` — the model never writes SQL.
 */
export interface ActivityFilters {
  user?: string | null
  actions?: string[]
  exclude_actions?: string[]
  collections?: string[]
  item?: string | null
  /** Absolute window (ISO or YYYY-MM-DD). A bare `to` date means the end of that day. */
  from?: string | null
  to?: string | null
  /** Relative window, resolved when the filters run (beats from/to). */
  range?: ActivityRange | null
  /** Plain text: entry comment, item id, action, collection or the person's name/email. */
  q?: string | null
  /** Several people (the Table view's person chip); combined with `user` when both are set. */
  users?: string[]
  /** Who really did it (activity-sentence actorOf): person, view_as, api_key, mcp, import… */
  actor_kinds?: ActorKind[]
  /** How it came in: the app, an API key, a token, an assistant, background work… */
  sources?: ActivitySource[]
  /** An edit whose revision changed one of these fields. */
  fields?: string[]
  /** Only entries that may offer Undo (an edit with a snapshot, or a delete; never a system table). */
  undoable?: boolean
  /** Record changes only — the Overview's "Records changed today" (create / update / delete /
   *  moves / restore / revert on a record of a non-system collection). */
  records_only?: boolean
}

/** The actor kinds activity-sentence's actorOf names; the SQL twin is `actorKindSql`. */
export const ACTOR_KINDS = [
  'person',
  'view_as',
  'api_key',
  'mcp',
  'import',
  'flow',
  'cron',
  'system'
] as const
export type ActorKind = (typeof ACTOR_KINDS)[number]

/** How an entry came in; `activitySourceOf` (JS) and `activitySourceSql` (SQL) are twins. */
export const ACTIVITY_SOURCES = [
  'app',
  'api_key',
  'token',
  'mcp',
  'background',
  'integration',
  'other'
] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]

/** Record-changing actions (the Overview's "Records changed today" counts these). */
export const RECORD_ACTIONS = [
  'create',
  'update',
  'delete',
  'transition',
  'pipeline-transition',
  'pipeline-start',
  'restore',
  'revert'
] as const

export const ACTIVITY_RANGES = [
  'today',
  'yesterday',
  'last_24_hours',
  'last_7_days',
  'this_week',
  'last_week',
  'last_30_days',
  'this_month',
  'last_month',
  'last_90_days'
] as const
export type ActivityRange = (typeof ACTIVITY_RANGES)[number]

export const ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,49}$/
export const COLLECTION_RE = /^[A-Za-z0-9_]{1,64}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const FIELD_RE = /^[A-Za-z0-9_]{1,64}$/
const MAX_LIST = 50
const Q_MAX = 200
/** Text search with no window reads only this far back (a LIKE over 12M rows otherwise). */
export const TEXT_SEARCH_DEFAULT_DAYS = 90
const DAY_MS = 86_400_000

function list(v: unknown): string[] {
  if (v == null || v === '') return []
  const raw = Array.isArray(v) ? v : [v]
  const out: string[] = []
  for (const x of raw) {
    if (typeof x !== 'string' && typeof x !== 'number') continue
    for (const part of String(x).split(',')) {
      const s = part.trim()
      if (s) out.push(s)
    }
  }
  return [...new Set(out)].slice(0, MAX_LIST)
}

function flag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

/**
 * Validate any filter-shaped input (query string, stored JSON, model output). Parts that do not
 * pass are dropped and named in `errors`; callers on a request answer 400 on errors, stored or
 * model input just loses the bad part.
 */
export function normalizeActivityFilters(raw: unknown): {
  filters: ActivityFilters
  errors: string[]
} {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: string[] = []
  const f: ActivityFilters = {}

  const user = text(src.user, 64)
  if (user) {
    if (UUID_RE.test(user)) f.user = user
    else errors.push('`user` must be a user id')
  }
  const pick = (keys: string[], re: RegExp, label: string) => {
    const vals = keys.flatMap((k) => list(src[k]))
    const ok = vals.filter((v) => re.test(v))
    if (ok.length < vals.length) errors.push(`\`${label}\` has an invalid value`)
    return [...new Set(ok)]
  }
  const actions = pick(['action', 'action[]', 'actions'], ACTION_RE, 'action')
  if (actions.length) f.actions = actions
  const excluded = pick(['exclude_actions', 'exclude_action'], ACTION_RE, 'exclude_actions')
  if (excluded.length) f.exclude_actions = excluded
  const collections = pick(
    ['collection', 'collection[]', 'collections'],
    COLLECTION_RE,
    'collection'
  )
  if (collections.length) f.collections = collections

  const users = pick(['users', 'users[]'], UUID_RE, 'users')
  if (users.length) f.users = users
  const kinds = pick(['actor_kind', 'actor_kinds', 'actor_kind[]'], ACTION_RE, 'actor_kind')
  const okKinds = kinds.filter((k) => (ACTOR_KINDS as readonly string[]).includes(k))
  if (okKinds.length < kinds.length) errors.push('`actor_kind` is not a known kind')
  if (okKinds.length) f.actor_kinds = okKinds as ActorKind[]
  const sources = pick(['source', 'sources', 'source[]'], ACTION_RE, 'source')
  const okSources = sources.filter((k) => (ACTIVITY_SOURCES as readonly string[]).includes(k))
  if (okSources.length < sources.length) errors.push('`source` is not a known source')
  if (okSources.length) f.sources = okSources as ActivitySource[]
  const fields = pick(['field', 'fields', 'field[]'], FIELD_RE, 'field')
  if (fields.length) f.fields = fields
  if (flag(src.undoable)) f.undoable = true
  if (flag(src.records_only)) f.records_only = true

  const item = text(src.item, 255)
  if (item) f.item = item
  const q = text(src.q, Q_MAX)
  if (q) f.q = q

  const range = text(src.range, 32)
  if (range) {
    if ((ACTIVITY_RANGES as readonly string[]).includes(range)) f.range = range as ActivityRange
    else errors.push('`range` is not a known range')
  }
  for (const edge of ['from', 'to'] as const) {
    const v = text(src[edge], 40)
    if (!v) continue
    const d = parseReportDate(v, edge === 'from' ? 'start' : 'end')
    if (d === 'invalid' || d == null) errors.push(`\`${edge}\` is not a valid date`)
    else f[edge] = v
  }
  return { filters: f, errors }
}

export function hasActivityFilter(f: ActivityFilters): boolean {
  return !!(
    f.user ||
    f.actions?.length ||
    f.exclude_actions?.length ||
    f.collections?.length ||
    f.item ||
    f.from ||
    f.to ||
    f.range ||
    f.q ||
    f.users?.length ||
    f.actor_kinds?.length ||
    f.sources?.length ||
    f.fields?.length ||
    f.undoable ||
    f.records_only
  )
}

const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

/** A relative range as a UTC window (weeks start Monday). `to` null = up to now. */
export function resolveRange(
  range: ActivityRange,
  now = new Date()
): { from: Date; to: Date | null } {
  const today = startOfUtcDay(now)
  const dow = (today.getUTCDay() + 6) % 7 // Monday = 0
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  switch (range) {
    case 'today':
      return { from: today, to: null }
    case 'yesterday':
      return { from: new Date(today.getTime() - DAY_MS), to: new Date(today.getTime() - 1) }
    case 'last_24_hours':
      return { from: new Date(now.getTime() - DAY_MS), to: null }
    case 'last_7_days':
      return { from: new Date(now.getTime() - 7 * DAY_MS), to: null }
    case 'this_week':
      return { from: new Date(today.getTime() - dow * DAY_MS), to: null }
    case 'last_week': {
      const thisWeek = new Date(today.getTime() - dow * DAY_MS)
      return {
        from: new Date(thisWeek.getTime() - 7 * DAY_MS),
        to: new Date(thisWeek.getTime() - 1)
      }
    }
    case 'last_30_days':
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: null }
    case 'this_month':
      return { from: monthStart, to: null }
    case 'last_month': {
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      return { from: prev, to: new Date(monthStart.getTime() - 1) }
    }
    case 'last_90_days':
      return { from: new Date(now.getTime() - 90 * DAY_MS), to: null }
  }
}

/** The window the filters read, or null for no time bound. Text search is always bounded. */
export function activityWindow(
  f: ActivityFilters,
  now = new Date()
): { from: Date | null; to: Date | null; defaulted: boolean } {
  if (f.range) return { ...resolveRange(f.range, now), defaulted: false }
  const from = f.from ? parseReportDate(f.from, 'start') : null
  const to = f.to ? parseReportDate(f.to, 'end') : null
  const fromD = from instanceof Date ? from : null
  const toD = to instanceof Date ? to : null
  if (f.q && !fromD) {
    const anchor = toD ?? now
    return {
      from: new Date(anchor.getTime() - TEXT_SEARCH_DEFAULT_DAYS * DAY_MS),
      to: toD,
      defaulted: true
    }
  }
  return { from: fromD, to: toD, defaulted: false }
}

/** A LIKE prefix pattern (`nivaro_%`) whose own underscore matches only itself. */
export function likePrefix(prefix: string, mssql: boolean): string {
  const escaped = mssql ? prefix.replace(/[%_[]/g, '[$&]') : prefix.replace(/[%_\\]/g, '\\$&')
  return `${escaped}%`
}

/** A LIKE pattern that finds `"field":` as a key of a revision delta's JSON. */
export function deltaKeyPattern(field: string, mssql: boolean): string {
  const escaped = mssql ? field.replace(/[%_[]/g, '[$&]') : field.replace(/[%_\\]/g, '\\$&')
  return `%"${escaped}":%`
}

/**
 * Other dialects: `"field":` only where a top-level key can start — first in the object
 * (`{"field":`) or right after a comma (`,"field":`). Inside a JSON string every `"` is escaped
 * (`\"field\":`), so a value holding the key's text never matches. (A key of a NESTED object
 * after a comma still could; SQL Server checks the top-level keys exactly.) Deltas are written
 * by JSON.stringify: no spaces.
 */
export function deltaKeyPatternsAnchored(field: string): string[] {
  const escaped = field.replace(/[%_\\]/g, '\\$&')
  return [`{"${escaped}":%`, `%,"${escaped}":%`]
}

/** JS twin of the field-changed match: is `field` a top-level key of this delta? */
export function deltaHasKey(delta: unknown, field: string): boolean {
  let d: unknown = delta
  if (typeof delta === 'string') {
    try {
      d = JSON.parse(delta)
    } catch {
      return false
    }
  }
  return !!d && typeof d === 'object' && !Array.isArray(d) && Object.hasOwn(d, field)
}

/** A column of the activity alias, quoted for the dialect (`user` is a reserved word). */
function col(alias: string, name: string, mssql: boolean): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias) || !/^[a-z_][a-z0-9_]*$/i.test(name))
    throw new Error('bad column')
  return mssql ? `[${alias}].[${name}]` : `"${alias}"."${name}"`
}

/**
 * SQL twin of activity-sentence's `actorOf`: the entry's actor kind as one CASE expression over
 * the stored columns that exist here (`cols`). Only fixed column names and literals — nothing a
 * caller wrote — so it is safe to splice into whereRaw / select.
 */
export function actorKindSql(alias: string, cols: ReadonlySet<string>, mssql: boolean): string {
  const c = (n: string) => col(alias, n, mssql)
  const when: string[] = []
  if (cols.has('actor'))
    for (const k of ACTOR_KINDS) when.push(`WHEN ${c('actor')} LIKE '{"kind":"${k}"%' THEN '${k}'`)
  const mcp: string[] = []
  if (cols.has('mcp_conn')) mcp.push(`${c('mcp_conn')} IS NOT NULL`)
  if (cols.has('via_app')) mcp.push(`${c('via_app')} IS NOT NULL`)
  if (mcp.length) when.push(`WHEN ${mcp.join(' OR ')} THEN 'mcp'`)
  if (cols.has('auth_method')) {
    when.push(`WHEN ${c('auth_method')} = 'masquerade' THEN 'view_as'`)
    if (cols.has('api_key_id'))
      when.push(
        `WHEN ${c('auth_method')} IN ('api_key', 'key_sim') AND ${c('api_key_id')} IS NOT NULL THEN 'api_key'`
      )
  }
  if (cols.has('chain_parent')) {
    when.push(`WHEN ${c('chain_parent')} LIKE 'cron:%' THEN 'cron'`)
    when.push(`WHEN ${c('chain_parent')} LIKE 'import${mssql ? '[_]' : '\\_'}run:%' THEN 'import'`)
    when.push(`WHEN ${c('chain_parent')} LIKE 'flow${mssql ? '[_]' : '\\_'}run:%' THEN 'flow'`)
  }
  when.push(`WHEN ${c('comment')} LIKE 'import:%' THEN 'import'`)
  if (cols.has('origin')) when.push(`WHEN ${c('origin')} = 'import' THEN 'import'`)
  when.push(`WHEN ${c('user')} IS NOT NULL THEN 'person'`)
  return `CASE ${when.join(' ')} ELSE 'system' END`
}

/** SQL twin of `activitySourceOf`: how the entry came in, one CASE expression. */
export function activitySourceSql(
  alias: string,
  cols: ReadonlySet<string>,
  mssql: boolean
): string {
  const c = (n: string) => col(alias, n, mssql)
  const when: string[] = []
  const mcp: string[] = []
  if (cols.has('mcp_conn')) mcp.push(`${c('mcp_conn')} IS NOT NULL`)
  if (cols.has('via_app')) mcp.push(`${c('via_app')} IS NOT NULL`)
  if (cols.has('actor')) mcp.push(`${c('actor')} LIKE '{"kind":"mcp"%'`)
  if (mcp.length) when.push(`WHEN ${mcp.join(' OR ')} THEN 'mcp'`)
  const bg: string[] = []
  if (cols.has('actor'))
    for (const k of ['import', 'flow', 'cron']) bg.push(`${c('actor')} LIKE '{"kind":"${k}"%'`)
  if (cols.has('chain_parent')) {
    bg.push(`${c('chain_parent')} LIKE 'cron:%'`)
    bg.push(`${c('chain_parent')} LIKE 'import${mssql ? '[_]' : '\\_'}run:%'`)
    bg.push(`${c('chain_parent')} LIKE 'flow${mssql ? '[_]' : '\\_'}run:%'`)
  }
  bg.push(`${c('comment')} LIKE 'import:%'`)
  if (cols.has('origin')) bg.push(`${c('origin')} = 'import'`)
  when.push(`WHEN ${bg.join(' OR ')} THEN 'background'`)
  if (cols.has('auth_method')) {
    when.push(`WHEN ${c('auth_method')} IN ('api_key', 'key_sim') THEN 'api_key'`)
    when.push(`WHEN ${c('auth_method')} = 'token' THEN 'token'`)
    when.push(`WHEN ${c('auth_method')} IN ('session', 'masquerade') THEN 'app'`)
  }
  if (cols.has('origin')) when.push(`WHEN ${c('origin')} = 'integration' THEN 'integration'`)
  return `CASE ${when.join(' ')} ELSE 'other' END`
}

/** JS twin of `activitySourceSql` over a stored row. */
export function activitySourceOf(r: {
  mcp_conn?: unknown
  via_app?: unknown
  actor?: unknown
  chain_parent?: unknown
  comment?: unknown
  origin?: unknown
  auth_method?: unknown
}): ActivitySource {
  const t = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  if (r.mcp_conn != null || r.via_app != null) return 'mcp'
  // Stored JSON text, or the resolved object a page row carries (activity-readable).
  const kind =
    typeof r.actor === 'string'
      ? (/^\{"kind":"([a-z_]+)"/.exec(r.actor)?.[1] ?? '')
      : r.actor && typeof r.actor === 'object'
        ? t((r.actor as { kind?: unknown }).kind)
        : ''
  if (kind === 'mcp') return 'mcp'
  if (kind === 'import' || kind === 'flow' || kind === 'cron') return 'background'
  if (/^(cron|import_run|flow_run):/.test(t(r.chain_parent))) return 'background'
  if (/^import:/i.test(t(r.comment)) || t(r.origin) === 'import') return 'background'
  const auth = t(r.auth_method)
  if (auth === 'api_key' || auth === 'key_sim') return 'api_key'
  if (auth === 'token') return 'token'
  if (auth === 'session' || auth === 'masquerade') return 'app'
  if (t(r.origin) === 'integration') return 'integration'
  return 'other'
}

/** A LIKE pattern for user text: wildcards in the text match themselves. */
export function likeContains(value: string, mssql: boolean): string {
  const escaped = mssql ? value.replace(/[%_[]/g, '[$&]') : value.replace(/[%_\\]/g, '\\$&')
  return `%${escaped}%`
}

/**
 * Apply the filters to a query over `nivaro_activity as <alias>`. Every value is bound; nothing
 * the caller (or the model) wrote becomes SQL.
 */
export function applyActivityFilters<T extends Knex.QueryBuilder>(
  qb: T,
  f: ActivityFilters,
  opts: {
    alias?: string
    mssql: boolean
    now?: Date
    /** The optional activity columns present (activity-readable optionalActivityColumns):
     *  the actor-kind and source filters read them. Absent = none of them. */
    columns?: ReadonlySet<string>
  }
): T {
  const a = opts.alias ?? 'a'
  const people = [...new Set([...(f.user ? [f.user] : []), ...(f.users ?? [])])]
  if (people.length === 1) qb.where(`${a}.user`, people[0])
  else if (people.length) qb.whereIn(`${a}.user`, people)
  if (f.actions?.length) qb.whereIn(`${a}.action`, f.actions)
  // Hiding `read` hides every routine read (notification, report, saved view) with it.
  if (f.exclude_actions?.length) qb.whereNotIn(`${a}.action`, withRoutineReads(f.exclude_actions))
  if (f.collections?.length === 1) qb.where(`${a}.collection`, f.collections[0])
  else if (f.collections?.length) qb.whereIn(`${a}.collection`, f.collections)
  if (f.item) qb.where(`${a}.item`, f.item)
  const cols = opts.columns ?? new Set<string>()
  if (f.actor_kinds?.length) {
    qb.whereRaw(
      `(${actorKindSql(a, cols, opts.mssql)}) in (${f.actor_kinds.map(() => '?').join(', ')})`,
      f.actor_kinds
    )
  }
  if (f.sources?.length) {
    qb.whereRaw(
      `(${activitySourceSql(a, cols, opts.mssql)}) in (${f.sources.map(() => '?').join(', ')})`,
      f.sources
    )
  }
  if (f.records_only) {
    qb.whereIn(`${a}.action`, [...RECORD_ACTIONS])
      .whereNotNull(`${a}.item`)
      .whereNotNull(`${a}.collection`)
      .whereNot(`${a}.collection`, 'like', likePrefix('nivaro_', opts.mssql))
      .whereNot(`${a}.collection`, 'like', likePrefix('directus_', opts.mssql))
  }
  if (f.fields?.length) {
    const fields = f.fields
    const mssql = opts.mssql
    qb.whereExists(function changed(this: Knex.QueryBuilder) {
      this.select('rf.id')
        .from('nivaro_revisions as rf')
        .whereRaw('?? = ??', ['rf.activity', `${a}.id`])
        .where((w) => {
          // A cheap prefilter, then the key itself: a VALUE that holds the text `"budget":`
          // must never match (deltaKeyMatch).
          for (const field of fields) {
            if (mssql) w.orWhere('rf.delta', 'like', deltaKeyPattern(field, true))
            else
              for (const pat of deltaKeyPatternsAnchored(field)) w.orWhere('rf.delta', 'like', pat)
          }
        })
      // SQL Server: the delta's own TOP-LEVEL keys (OPENJSON of this row's column, one EXISTS,
      // the names bound — never a parsed id list OR'd into the row predicate).
      if (mssql)
        this.whereRaw(
          `EXISTS (SELECT 1 FROM OPENJSON(CASE WHEN ISJSON(rf.delta) = 1 THEN rf.delta END) AS jk WHERE jk.[key] IN (${fields.map(() => '?').join(', ')}))`,
          fields
        )
    })
  }
  if (f.undoable) {
    qb.whereNotNull(`${a}.collection`)
      .whereNot(`${a}.collection`, 'like', likePrefix('nivaro_', opts.mssql))
      .whereNot(`${a}.collection`, 'like', likePrefix('directus_', opts.mssql))
      .whereNotNull(`${a}.item`)
      .where((w) => {
        w.where(`${a}.action`, 'delete').orWhere((u) => {
          u.where(`${a}.action`, 'update').whereExists(function snap(this: Knex.QueryBuilder) {
            this.select('ru.id')
              .from('nivaro_revisions as ru')
              .whereRaw('?? = ??', ['ru.activity', `${a}.id`])
              .whereNotNull('ru.delta')
          })
        })
      })
  }
  const w = activityWindow(f, opts.now)
  if (w.from) qb.where(`${a}.timestamp`, '>=', w.from)
  if (w.to) qb.where(`${a}.timestamp`, '<=', w.to)
  if (f.q) {
    const pat = likeContains(f.q, opts.mssql)
    const q = f.q
    qb.where((inner) => {
      inner
        .where(`${a}.comment`, 'like', pat)
        .orWhere(`${a}.item`, q)
        .orWhere(`${a}.action`, 'like', pat)
        .orWhere(`${a}.collection`, 'like', pat)
        .orWhereIn(`${a}.user`, function users(this: Knex.QueryBuilder) {
          this.select('id')
            .from('nivaro_users')
            .where('email', 'like', pat)
            .orWhere('first_name', 'like', pat)
            .orWhere('last_name', 'like', pat)
        })
    })
  }
  return qb
}

/**
 * The FROM of the activity list's id page and count (alias `a`). On SQL Server it reads
 * WITH (NOLOCK): a filter no index serves (`action=access-request` alone, 12M rows) runs a
 * parallel scan that held thousands of page S locks — including the newest page every write
 * appends to — for up to 15 s. Each item save logs an activity row, so the save queued behind
 * the scan and every read of that page queued behind the save (army 9 b09: a one-line quantity
 * save written at 0.3 s answered after 6.4 s, when a 15 s `action=access-request` read was
 * cancelled; measured on EFP_Development: ~5,400 page S locks held at 11 s, none WITH (NOLOCK)).
 * The log is append-only, so a dirty read can at most list an entry a moment early or count
 * a row whose write then rolls back; the rows themselves are re-read by id (pageRows).
 */
export function activityListSource(knex: Knex, mssql: boolean): Knex.QueryBuilder {
  const q = mssql
    ? knex.from(knex.raw('?? AS a WITH (NOLOCK)', ['nivaro_activity']))
    : knex('nivaro_activity as a')
  // A View-as pipeline move's attribution row (services/view-as-attribution.ts) only names the
  // administrator behind a move; the move itself is the history row. Never a list entry of its
  // own, for anyone — null-safe (an action-less row stays listed).
  return q.where((w) => w.whereNot('a.action', VIEW_AS_MOVE_ACTION).orWhereNull('a.action'))
}

/** The activity action of a View-as pipeline move's attribution row (view-as-attribution.ts). */
export const VIEW_AS_MOVE_ACTION = 'view-as-move'
