/**
 * Pure pieces of the admin global search (Cmd+K palette + /search page): the
 * answer shapes of GET /global-search and its siblings (every field added by the
 * 2026-10-28 search program is optional — an older API simply leaves it out),
 * recents in localStorage, keyboard helpers, chips for the parsed query, extra
 * result kinds, command requests and CSV. No React here, so it is unit-tested.
 */

// ─── Answer shapes ───────────────────────────────────────────────────────────

export interface SearchRecord {
  collection: string
  display_name?: string | null
  id: string | number
  label: string
  snippet: string
  /** Field key that matched, its label and the matching value (≤80 chars). */
  matched_field?: string
  matched_label?: string
  matched_value?: string
  /** An exact id / number hit. */
  exact?: boolean
  score?: number
  mine?: boolean
  updated_at?: string
}

export interface ExtraHit {
  kind: string
  id: string
  label: string
  snippet?: string
  href: string
  admin_href?: string
  collection?: string
  item?: string
}

export type ExtraKind = 'comments' | 'files' | 'videos' | 'docs' | 'chat' | 'config'
export type SearchExtra = Partial<Record<ExtraKind, ExtraHit[]>>

export interface QueryFilter {
  field: string
  label: string
  op: 'eq' | 'contains' | 'gte' | 'lte'
  value: string
}

export interface ParsedQuery {
  text: string
  scope: string | null
  filters: QueryFilter[]
}

export interface SearchCommand {
  id: string
  label: string
  kind: 'transition' | 'hold' | 'create' | 'assign'
  collection?: string
  item?: string
  confirm: string
  payload: unknown
}

export interface SavedSearch {
  id: string
  name: string
  q: string
  scope: string | null
  created_at?: string
}

export interface RecordPreview {
  collection: string
  id: string | number
  label: string
  state?: { label: string; color?: string | null } | null
  owners?: Array<{ id: string; name: string }>
  fields: Array<{ label: string; value: string | null }>
  updated_at?: string | null
  updated_by?: string | null
}

// ─── Recents (localStorage) ──────────────────────────────────────────────────

export interface RecentRecord {
  collection: string
  id: string
  label: string
  /** The collection's display name when it was opened. */
  kind?: string
}

export const RECENT_RECORDS_KEY = 'nvr_palette_recent_records'
export const RECENT_SEARCHES_KEY = 'nvr_palette_recent_searches'
export const MAX_RECENT_RECORDS = 8
export const MAX_RECENT_SEARCHES = 5

function readList<T>(key: string, max: number, ok: (v: unknown) => v is T): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(raw) ? raw.filter(ok).slice(0, max) : []
  } catch {
    return []
  }
}

function writeList(key: string, list: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}

const isRecentRecord = (v: unknown): v is RecentRecord =>
  !!v &&
  typeof (v as RecentRecord).collection === 'string' &&
  (typeof (v as RecentRecord).id === 'string' || typeof (v as RecentRecord).id === 'number')

export function readRecentRecords(): RecentRecord[] {
  return readList(RECENT_RECORDS_KEY, MAX_RECENT_RECORDS, isRecentRecord).map((r) => ({
    ...r,
    id: String(r.id),
    label: r.label || String(r.id)
  }))
}

export function pushRecentRecord(r: RecentRecord): RecentRecord[] {
  const entry = { ...r, id: String(r.id) }
  const list = [
    entry,
    ...readRecentRecords().filter((x) => !(x.collection === entry.collection && x.id === entry.id))
  ].slice(0, MAX_RECENT_RECORDS)
  writeList(RECENT_RECORDS_KEY, list)
  return list
}

export function readRecentSearches(): string[] {
  return readList(
    RECENT_SEARCHES_KEY,
    MAX_RECENT_SEARCHES,
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  )
}

/** Newest first, one copy per wording (case-insensitive), searches of 2+ characters. */
export function pushRecentSearch(q: string): string[] {
  const t = q.trim()
  if (t.length < 2) return readRecentSearches()
  const list = [
    t,
    ...readRecentSearches().filter((x) => x.trim().toLowerCase() !== t.toLowerCase())
  ].slice(0, MAX_RECENT_SEARCHES)
  writeList(RECENT_SEARCHES_KEY, list)
  return list
}

export function forgetRecentSearch(q: string): string[] {
  const list = readRecentSearches().filter((x) => x !== q)
  writeList(RECENT_SEARCHES_KEY, list)
  return list
}

/** `/collections/:c/:id` → the record it opens (never `/new`). */
export function recordFromPath(path: string): { collection: string; id: string } | null {
  const m = /^\/collections\/([^/?#]+)\/([^/?#]+)$/.exec(path)
  if (!m || m[2] === 'new') return null
  return { collection: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) }
}

export const recordPath = (collection: string, id: string | number) =>
  `/collections/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`

/** ↑ in an empty box recalls the last search; each further ↑ the one before it. */
export function nextRecall(recent: string[], current: string): string | null {
  if (recent.length === 0) return null
  if (!current.trim()) return recent[0]
  const i = recent.indexOf(current)
  if (i < 0 || i + 1 >= recent.length) return null
  return recent[i + 1]
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

/** Alt/Option + 1…9 → that tab (0-based). Read from `code`: on a Mac, Option+digit
 *  types a symbol into `key`. */
export function altDigit(e: {
  altKey: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  code: string
}) {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
  return m ? Number(m[1]) - 1 : null
}

/** Cmd+Enter (Mac) / Ctrl+Enter: open the highlighted result in a new browser tab. */
export const isNewTabEnter = (e: { key: string; metaKey: boolean; ctrlKey: boolean }) =>
  e.key === 'Enter' && (e.metaKey || e.ctrlKey)

// ─── Why it matched ─────────────────────────────────────────────────────────

/** One short line saying why a record is in the results, or null when the API
 *  did not say. */
export function whyMatched(r: SearchRecord): string | null {
  if (r.exact) return 'Exact ID match'
  const label = r.matched_label || (r.matched_field ? humanize(r.matched_field) : '')
  if (!label) return null
  const value = (r.matched_value ?? '').trim()
  return value ? `${label}: ${value}` : `Matched ${label}`
}

function humanize(key: string) {
  const s = key.replace(/_/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

// ─── Extra result kinds (comments, files, …) ─────────────────────────────────

export const EXTRA_KINDS: Array<{ kind: ExtraKind; label: string }> = [
  { kind: 'comments', label: 'Comments' },
  { kind: 'files', label: 'Files' },
  { kind: 'videos', label: 'Videos' },
  { kind: 'docs', label: 'Docs' },
  { kind: 'chat', label: 'Chat' },
  { kind: 'config', label: 'Settings & config' }
]

export const extraTabKey = (kind: ExtraKind) => `extra:${kind}`
export const isExtraTab = (tab: string | null): tab is `extra:${ExtraKind}` =>
  !!tab && tab.startsWith('extra:')

/** Tabs for the extra kinds that came back with hits, in a fixed order. */
export function extraTabs(
  extra: SearchExtra | null | undefined
): Array<{ key: string; kind: ExtraKind; label: string; count: string; hits: ExtraHit[] }> {
  if (!extra) return []
  return EXTRA_KINDS.flatMap(({ kind, label }) => {
    const hits = Array.isArray(extra[kind]) ? (extra[kind] as ExtraHit[]) : []
    return hits.length
      ? [{ key: extraTabKey(kind), kind, label, count: String(hits.length), hits }]
      : []
  })
}

/** Where an extra hit opens in the admin: `admin_href`, else the shared `href`
 *  with efp-new's `/records/:c/:id` mapped onto `/collections/:c/:id`. */
export function extraHref(h: ExtraHit): string {
  if (h.admin_href) return h.admin_href
  const m = /^\/records\/([^/?#]+)\/([^/?#]+)(.*)$/.exec(h.href)
  if (m) return `/collections/${m[1]}/${m[2]}${m[3]}`
  return h.href
}

// ─── People ──────────────────────────────────────────────────────────────────

/** role · zones · title (#17); falls back to the email when none came back. */
export function personMeta(p: {
  role_name?: string | null
  zones?: string[] | null
  title?: string | null
  email?: string | null
}): string {
  const zones = Array.isArray(p.zones) ? p.zones.filter(Boolean) : []
  const zoneText =
    zones.length > 2 ? `${zones.slice(0, 2).join(', ')} +${zones.length - 2}` : zones.join(', ')
  const parts = [p.role_name, zoneText, p.title].filter((x): x is string => !!x && !!x.trim())
  if (parts.length) return parts.join(' · ')
  return p.email ?? ''
}

// ─── Parsed query chips ──────────────────────────────────────────────────────

export interface QueryChip {
  key: string
  kind: 'scope' | 'filter'
  label: string
  /** The query text without this chip's token, or null when it can't be found. */
  without: string | null
}

const OP_TEXT: Record<QueryFilter['op'], string> = {
  eq: '=',
  contains: '∋',
  gte: '≥',
  lte: '≤'
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** `field:value` / `field:"two words"` tokens for any of `names` removed from `text`. */
function removeToken(text: string, names: string[]): string | null {
  for (const name of names.filter(Boolean)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(^|\\s)${esc}:(?:"[^"]*"|\\S*)`, 'i')
    if (re.test(text))
      return text
        .replace(re, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim()
  }
  return null
}

/** Remove a leading scope prefix (`wf:`, `po:`, `@`) from `text`. */
function removeScope(text: string): string | null {
  const t = text.trimStart()
  const m = /^(@|[a-z][\w-]*:)\s*/i.exec(t)
  if (!m) return null
  // `field:value` is a filter, not a scope — a scope prefix stands alone or before text.
  return t.slice(m[0].length).trim()
}

/** Chips for the parsed query under the box (#2/#3): scope first, then each filter. */
export function queryChips(
  raw: string,
  parsed: ParsedQuery | null | undefined,
  scopeLabel: (scope: string) => string
): QueryChip[] {
  if (!parsed) return []
  const out: QueryChip[] = []
  if (parsed.scope) {
    out.push({
      key: `scope:${parsed.scope}`,
      kind: 'scope',
      label: scopeLabel(parsed.scope),
      without: removeScope(raw)
    })
  }
  for (const f of parsed.filters ?? []) {
    out.push({
      key: `filter:${f.field}:${f.op}:${f.value}`,
      kind: 'filter',
      label: `${f.label || f.field} ${OP_TEXT[f.op] ?? '='} ${f.value}`,
      without: removeToken(raw, [f.field, slug(f.label ?? '')])
    })
  }
  return out
}

// ─── Commands (#19) ──────────────────────────────────────────────────────────

export type CommandRequest =
  | { kind: 'navigate'; path: string }
  | { kind: 'post'; url: string; body: Record<string, unknown> }

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown) =>
  typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null

/** The normal route a search command runs through — the same ones the record page
 *  uses, so access, guards and reasons are judged there. Null = can't be run here. */
export function commandRequest(cmd: SearchCommand, note?: string): CommandRequest | null {
  const p = obj(cmd.payload)
  const c = cmd.collection ?? str(p.collection)
  const item = cmd.item ?? str(p.item) ?? str(p.id)
  const comment = note?.trim() || null
  if (cmd.kind === 'create') {
    return c ? { kind: 'navigate', path: `/collections/${encodeURIComponent(c)}/new` } : null
  }
  if (!c || !item) return null
  const base = `/pipelines/instance/${encodeURIComponent(c)}/${encodeURIComponent(item)}`
  if (cmd.kind === 'transition') {
    const transitionId = str(p.transition_id) ?? str(p.transitionId)
    if (!transitionId) return null
    return {
      kind: 'post',
      url: `${base}/transition`,
      body: { transition_id: transitionId, ...(comment ? { comment } : {}) }
    }
  }
  if (cmd.kind === 'assign') {
    const user = str(p.user) ?? str(p.user_id)
    if (!user) return null
    const state = str(p.state) ?? str(p.state_id)
    return { kind: 'post', url: `${base}/owners`, body: { user, ...(state ? { state } : {}) } }
  }
  if (cmd.kind === 'hold') {
    const key = str(p.key) ?? str(p.action)
    if (!key) return null
    const body = { collection: c, ids: [item], reason: comment ?? str(p.reason) }
    return p.source === 'code'
      ? { kind: 'post', url: `/bulk-actions/${encodeURIComponent(key)}/execute`, body }
      : { kind: 'post', url: '/bulk-actions/run', body: { ...body, key } }
  }
  return null
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')
}

export function recordsCsv(rows: SearchRecord[]): string {
  return toCsv(
    ['Collection', 'ID', 'Label', 'Matched field', 'Matched value', 'Snippet', 'Updated'],
    rows.map((r) => [
      r.display_name || r.collection,
      r.id,
      r.label,
      r.matched_label ?? r.matched_field ?? (r.exact ? 'ID' : ''),
      r.matched_value ?? '',
      r.snippet && r.snippet !== r.label ? r.snippet : '',
      r.updated_at ?? ''
    ])
  )
}

// ─── Sort ────────────────────────────────────────────────────────────────────

export type SearchSort = 'relevance' | 'newest'

/** Newest first on the loaded rows (rows without a date keep their order, last). */
export function sortRecords(rows: SearchRecord[], sort: SearchSort): SearchRecord[] {
  if (sort !== 'newest') return rows
  const t = (r: SearchRecord) => (r.updated_at ? Date.parse(r.updated_at) : Number.NaN)
  return rows
    .map((r, i) => ({ r, i, t: t(r) }))
    .sort((a, b) => {
      const an = Number.isNaN(a.t)
      const bn = Number.isNaN(b.t)
      if (an !== bn) return an ? 1 : -1
      if (!an && a.t !== b.t) return b.t - a.t
      return a.i - b.i
    })
    .map((x) => x.r)
}
