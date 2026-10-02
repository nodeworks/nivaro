// api/src/services/traffic-inspect/nav-logic.ts
/**
 * Traffic Map drill-down, group "nav" — the pure parts: what a search box entry is, how the
 * Related rail's groups are assembled, a page load's waterfall shape and a p75. No I/O.
 */

export interface RefWire {
  kind: string
  id: string
  label?: string
  /** Epoch ms the ref is about. */
  at?: number
}

// ── Search (#1208) ──

export const SEARCH_MAX_LEN = 200
export const SEARCH_MAX_RESULTS = 20

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@/]{1,64}@[^\s@/]{1,190}\.[^\s@/]{2,24}$/
const RECORD_RE = /^([a-z][a-z0-9_]{0,62})\/([A-Za-z0-9_.:-]{1,80})$/
const ROUTE_RE = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/[^\s?#]{0,299})(?:[?#].*)?$/i
const FRIENDLY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,59}$/
/** API key, masquerade and key-simulation tokens, or a pasted Authorization header. */
const CREDENTIAL_PREFIX_RE = /^(?:nvk|nvm|nvq)_|^bearer\s/i
/** A long opaque run (static tokens are 64 hex, share links 48 hex): looks like a secret. */
const OPAQUE_RE = /^[A-Za-z0-9_+/=-]{32,}$/

export const SEARCH_REFUSED_CREDENTIAL =
  'That looks like a credential. Search never looks up API keys or tokens — search by the key name, its owner or a request instead.'

export type SearchClass =
  | { type: 'empty' }
  | { type: 'refused'; reason: string }
  | { type: 'uuid'; id: string }
  | { type: 'int'; n: number }
  | { type: 'email'; email: string }
  | { type: 'record'; collection: string; id: string }
  | { type: 'route'; method: string | null; path: string }
  | { type: 'friendly'; value: string }
  | { type: 'text' }

/** What a search box entry names. Credentials are refused before anything else looks at them. */
export function classifySearch(raw: unknown): SearchClass {
  const q = typeof raw === 'string' ? raw.trim() : ''
  if (!q) return { type: 'empty' }
  if (q.length > SEARCH_MAX_LEN)
    return { type: 'refused', reason: `Search takes up to ${SEARCH_MAX_LEN} characters.` }
  if (CREDENTIAL_PREFIX_RE.test(q)) return { type: 'refused', reason: SEARCH_REFUSED_CREDENTIAL }
  if (UUID_RE.test(q)) return { type: 'uuid', id: q.toLowerCase() }
  if (OPAQUE_RE.test(q)) return { type: 'refused', reason: SEARCH_REFUSED_CREDENTIAL }
  if (/^\d{1,15}$/.test(q)) {
    const n = Number(q)
    return Number.isSafeInteger(n) && n > 0 ? { type: 'int', n } : { type: 'text' }
  }
  if (EMAIL_RE.test(q)) return { type: 'email', email: q.toLowerCase() }
  const route = ROUTE_RE.exec(q)
  if (route)
    return { type: 'route', method: route[1] ? route[1].toUpperCase() : null, path: route[2] }
  const rec = RECORD_RE.exec(q)
  if (rec) return { type: 'record', collection: rec[1], id: rec[2] }
  if (FRIENDLY_RE.test(q) && /\d/.test(q) && /[A-Za-z]/.test(q))
    return { type: 'friendly', value: q }
  return { type: 'text' }
}

export interface SearchResult {
  ref: RefWire
  label: string
  hint: string
}

/** Dedupe by kind:id (first wins) and cap. */
export function finishResults(rows: SearchResult[], max = SEARCH_MAX_RESULTS): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const r of rows) {
    const k = `${r.ref.kind}:${r.ref.id}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
    if (out.length >= max) break
  }
  return out
}

// ── Related rail (#1204) ──

export const RELATED_PER_GROUP = 10

/** Display order of the rail's groups. */
export const RELATED_ORDER = ['load', 'chain', 'record', 'caller', 'error', 'statement'] as const

export interface RelatedDraft {
  key: string
  label: string
  refs: RefWire[]
  /** How many exist in all (when known); refs past RELATED_PER_GROUP become `more`. */
  total?: number
}

export interface RelatedGroup {
  key: string
  label: string
  refs: RefWire[]
  more?: number
}

/**
 * Finish the rail: drop the level itself from every group, dedupe, cap each group at
 * RELATED_PER_GROUP (the rest counted in `more`), drop empty groups, order by RELATED_ORDER.
 */
export function finishRelated(
  drafts: RelatedDraft[],
  self: { kind: string; id: string },
  per = RELATED_PER_GROUP
): RelatedGroup[] {
  const selfKey = `${self.kind}:${self.id.toLowerCase()}`
  const out: RelatedGroup[] = []
  for (const d of drafts) {
    const seen = new Set<string>()
    let removed = 0
    const refs: RefWire[] = []
    for (const r of d.refs) {
      if (!r?.kind || !r.id) continue
      const k = `${r.kind}:${String(r.id).toLowerCase()}`
      if (k === selfKey || seen.has(k)) {
        removed++
        continue
      }
      seen.add(k)
      refs.push(r)
    }
    if (refs.length === 0) continue
    const shown = refs.slice(0, per)
    const total = Math.max(refs.length, (d.total ?? refs.length + removed) - removed)
    const more = total - shown.length
    out.push(
      more > 0
        ? { key: d.key, label: d.label, refs: shown, more }
        : {
            key: d.key,
            label: d.label,
            refs: shown
          }
    )
  }
  const rank = (k: string) => {
    const i = (RELATED_ORDER as readonly string[]).indexOf(k)
    return i < 0 ? RELATED_ORDER.length : i
  }
  return out.sort((a, b) => rank(a.key) - rank(b.key))
}

/** `METHOD /path · status` for an API log row. */
export function requestLabel(r: {
  method?: string | null
  path?: string | null
  status?: number | null
}): string {
  const what = `${(r.method ?? '').toUpperCase()} ${r.path ?? ''}`.trim() || 'request'
  return r.status != null ? `${what} · ${r.status}` : what
}

// ── Page load waterfall (#1205) ──

export interface WaterfallCall {
  rid: string | null
  route: string
  start: number
  ms: number
  status: number
}

export interface WaterfallRow extends WaterfallCall {
  /** Ms from the load's first call to this call's start. */
  offset_ms: number
}

export interface Waterfall {
  rows: WaterfallRow[]
  /** First start to last end. */
  total_ms: number
  slowest: WaterfallRow | null
  /** Routes called more than once in the load, most repeated first. */
  duplicates: Array<{ route: string; n: number }>
  errors: number
}

export function buildWaterfall(calls: WaterfallCall[]): Waterfall {
  const sorted = [...calls].sort((a, b) => a.start - b.start)
  const first = sorted.length ? sorted[0].start : 0
  let lastEnd = first
  const rows: WaterfallRow[] = sorted.map((c) => {
    lastEnd = Math.max(lastEnd, c.start + Math.max(0, c.ms))
    return { ...c, ms: Math.max(0, c.ms), offset_ms: Math.max(0, c.start - first) }
  })
  const slowest = rows.reduce<WaterfallRow | null>((w, r) => (!w || r.ms > w.ms ? r : w), null)
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.route, (counts.get(r.route) ?? 0) + 1)
  const duplicates = [...counts]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([route, n]) => ({ route, n }))
  return {
    rows,
    total_ms: Math.max(0, lastEnd - first),
    slowest,
    duplicates,
    errors: rows.filter((r) => r.status >= 400).length
  }
}

/** 75th percentile (nearest rank) of the finite values; null when there are none. */
export function p75(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  if (v.length === 0) return null
  v.sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.ceil(0.75 * v.length) - 1)]
}

/** A screen key `<app> <pattern>` split; a bare pattern has no app. */
export function splitScreenKey(screen: string): { app: string | null; path: string } {
  const i = screen.indexOf(' ')
  return i > 0
    ? { app: screen.slice(0, i), path: screen.slice(i + 1) }
    : { app: null, path: screen }
}

/** Does a load's screen match a page given as a screen key or a bare pattern? */
export function screenMatches(screen: string, page: string): boolean {
  if (!page) return false
  if (screen === page) return true
  return splitScreenKey(screen).path === page
}
