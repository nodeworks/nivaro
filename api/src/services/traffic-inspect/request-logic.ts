// api/src/services/traffic-inspect/request-logic.ts
/**
 * Traffic Map drill-down, group "request" — the pure parts: id shapes, keep-next arm specs and
 * matching, the arm book (trace-next arms + capture buffers, transport-free so it can be tested),
 * statement-shape ids and the compare diff. No db, no Redis, no Fastify.
 */
import { createHash } from 'node:crypto'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SHA1_RE = /^[0-9a-f]{40}$/

/** A request id (= trace id): a uuid. */
export function isRequestId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id)
}

/** A statement-shape id: lower-case sha1 hex. */
export function isStatementSha(id: unknown): id is string {
  return typeof id === 'string' && SHA1_RE.test(id)
}

/** `rid1,rid2` → both ids (two different uuids), else null. */
export function parseCompareId(id: unknown): [string, string] | null {
  if (typeof id !== 'string') return null
  const parts = id.split(',')
  if (parts.length !== 2) return null
  const [a, b] = parts.map((p) => p.trim())
  if (!isRequestId(a) || !isRequestId(b)) return null
  if (a.toLowerCase() === b.toLowerCase()) return null
  return [a, b]
}

/** The statement shape a trace recorded, whitespace collapsed (its identity). */
export function normaliseStatement(sql: string): string {
  return String(sql ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** sha1 hex of the normalised statement shape — the `statement` inspect id. */
export function statementSha(sql: string): string {
  return createHash('sha1').update(normaliseStatement(sql)).digest('hex')
}

/** Tables a statement reads or writes (FROM / JOIN / UPDATE / INTO), lower-cased, deduped. */
export function statementTables(sql: string): string[] {
  const out = new Set<string>()
  const re = /\b(?:from|join|update|into)\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][A-Za-z0-9_]{0,127})\]?/gi
  let m: RegExpExecArray | null = re.exec(sql)
  while (m) {
    const t = m[1].toLowerCase()
    if (t !== 'select' && t !== 'openjson') out.add(t)
    m = re.exec(sql)
  }
  return [...out]
}

// ─── Keep-next arm specs ─────────────────────────────────────────────────────

export const TRACE_NEXT_MAX_COUNT = 20
export const CAPTURE_MAX_COUNT = 50
export const ARM_MAX_TTL_SEC = 900
export const ARM_DEFAULT_TTL_SEC = 300
/** Largest captured body kept per request (bytes of the masked JSON text). */
export const CAPTURE_BODY_CAP = 64 * 1024

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
/** `k12` | `u<uuid>` | `anon` | `cron` | `cron:<job>` */
const CALLER_RE =
  /^(?:k\d{1,10}|u[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|anon)$/i
/** `lane/entity` */
const ENTITY_RE = /^[a-z]{2,20}\/[A-Za-z0-9_.:-]{1,120}$/

export interface ArmSpec {
  /** Route template as the map shows it: `GET /api/items/workflows/:id`. */
  route: string | null
  /** Caller key: `k12`, `u<UUID>`, `anon`. */
  caller: string | null
  /** `lane/entity`. */
  entity: string | null
}

export type ArmKind = 'trace' | 'capture'

/** A route template: `METHOD /path…` (GraphQL templates carry `· operation`). */
export function normaliseRoute(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/\s+/g, ' ')
  if (!s || s.length > 260) return null
  const sp = s.indexOf(' ')
  if (sp <= 0) return null
  const method = s.slice(0, sp).toUpperCase()
  const rest = s.slice(sp + 1)
  if (!METHODS.has(method) || !rest.startsWith('/')) return null
  for (const ch of rest) if (ch.charCodeAt(0) < 32) return null
  return `${method} ${rest}`
}

export function normaliseCaller(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!CALLER_RE.test(s)) return null
  if (s[0] === 'u' || s[0] === 'U') return `u${s.slice(1).toUpperCase()}`
  if (s[0] === 'K') return `k${s.slice(1)}`
  return s.toLowerCase() === 'anon' ? 'anon' : s
}

export function normaliseEntity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return ENTITY_RE.test(s) ? s : null
}

function intIn(raw: unknown, min: number, max: number, dflt: number): number | null {
  if (raw == null || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}

/**
 * A POST body as an arm: `{ route, caller?, entity?, count, ttlSec }`. Trace-next needs a route;
 * capture needs at least one of route / caller / entity. Returns the error sentence otherwise.
 */
export function parseArmBody(
  body: unknown,
  kind: ArmKind
): { spec: ArmSpec; count: number; ttlSec: number } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const has = (k: string) => b[k] != null && b[k] !== ''
  const route = has('route') ? normaliseRoute(b.route) : null
  if (has('route') && !route)
    return { error: 'route must look like "GET /api/items/workflows/:id"' }
  const caller = has('caller') ? normaliseCaller(b.caller) : null
  if (has('caller') && !caller)
    return { error: 'caller must be a caller key like k12, u<user id> or anon' }
  const entity = kind === 'capture' && has('entity') ? normaliseEntity(b.entity) : null
  if (kind === 'capture' && has('entity') && !entity)
    return { error: 'entity must look like items/workflows' }
  if (kind === 'trace' && !route) return { error: 'Say which route to trace (route is required)' }
  if (!route && !caller && !entity)
    return { error: 'Say what to capture: a route, a caller or an entity' }
  const max = kind === 'trace' ? TRACE_NEXT_MAX_COUNT : CAPTURE_MAX_COUNT
  const count = intIn(b.count, 1, max, kind === 'trace' ? 1 : 10)
  if (count == null) return { error: `count must be a whole number from 1 to ${max}` }
  const ttlSec = intIn(b.ttlSec, 10, ARM_MAX_TTL_SEC, ARM_DEFAULT_TTL_SEC)
  if (ttlSec == null)
    return { error: `ttlSec must be a whole number from 10 to ${ARM_MAX_TTL_SEC}` }
  return { spec: { route, caller, entity }, count, ttlSec }
}

/** What a finished request is, in the arm's terms. */
export interface RequestFacts {
  route: string
  caller: string
  entity: string | null
}

/**
 * Does a request match an arm? Every criterion the arm sets must match; an arm with none
 * matches nothing. A route without a GraphQL operation (`POST /api/graphql`) matches every
 * operation of it.
 */
export function armMatches(spec: ArmSpec, facts: RequestFacts): boolean {
  if (!spec.route && !spec.caller && !spec.entity) return false
  if (spec.route) {
    const r = spec.route
    const ok = facts.route === r || (!r.includes(' · ') && facts.route.startsWith(`${r} · `))
    if (!ok) return false
  }
  if (spec.caller && spec.caller !== facts.caller) return false
  if (spec.entity && spec.entity !== facts.entity) return false
  return true
}

// ─── The arm book ────────────────────────────────────────────────────────────

export interface KeptEntry {
  rid: string
  /** Epoch ms the request finished. */
  at: number
  ms: number
  route: string
  method: string
  path: string
  status: number
  /** The API process that kept it (its trace lives there). */
  node: string
  /** Capture only: the masked request body (≤ CAPTURE_BODY_CAP, `…` when cut); null = none. */
  body?: string | null
  /** Capture only: why no body ("GET carries no body", "multipart upload not captured"). */
  body_note?: string | null
  query?: string | null
}

export interface Arm {
  id: string
  kind: ArmKind
  spec: ArmSpec
  total: number
  remaining: number
  createdAt: number
  expiresAt: number
  by: string | null
  node: string
  entries: KeptEntry[]
}

export interface ArmView {
  id: string
  kind: ArmKind
  spec: ArmSpec
  total: number
  remaining: number
  created_at: number
  expires_at: number
  /** Stopped matching (count reached); data stays until expiry. */
  done: boolean
  entries: KeptEntry[]
}

/** Cap on arms one process holds at a time (oldest dropped first). */
export const MAX_ARMS = 50

/**
 * Trace-next arms and capture buffers. One per process; peers' arms and kept entries arrive
 * through `arm` / `applyRemote`. Expired arms (and their buffered bodies) are dropped on the next
 * touch — nothing outlives its ttl.
 */
export class KeepNextBook {
  private arms = new Map<string, Arm>()
  constructor(private now: () => number = () => Date.now()) {}

  /** Drop expired arms. */
  sweep(): void {
    const t = this.now()
    for (const [id, a] of this.arms) if (a.expiresAt <= t) this.arms.delete(id)
  }

  /** Arms still able to match (not expired, count left). */
  active(): number {
    const t = this.now()
    let n = 0
    for (const a of this.arms.values()) if (a.expiresAt > t && a.remaining > 0) n++
    return n
  }

  /** Add (or replace) an arm. Entries are kept only when they fit the arm. */
  arm(a: Omit<Arm, 'entries'> & { entries?: KeptEntry[] }): void {
    this.sweep()
    const cap = Math.min(a.total, a.kind === 'capture' ? CAPTURE_MAX_COUNT : TRACE_NEXT_MAX_COUNT)
    const arm: Arm = {
      ...a,
      remaining: Math.max(0, Math.min(a.remaining, cap)),
      total: cap,
      entries: (a.entries ?? []).slice(0, cap)
    }
    this.arms.delete(arm.id)
    this.arms.set(arm.id, arm)
    while (this.arms.size > MAX_ARMS) {
      const first = this.arms.keys().next().value
      if (first === undefined) break
      this.arms.delete(first)
    }
  }

  /** Stop matching now; what it caught stays until the arm expires. */
  stop(id: string): boolean {
    const a = this.arms.get(id)
    if (!a) return false
    a.remaining = 0
    return true
  }

  /**
   * The arms a finished request satisfies, each with one unit consumed. The caller records the
   * entry with `record`.
   */
  match(facts: RequestFacts): Arm[] {
    if (this.arms.size === 0) return []
    const t = this.now()
    const hit: Arm[] = []
    for (const a of this.arms.values()) {
      if (a.expiresAt <= t || a.remaining <= 0) continue
      if (!armMatches(a.spec, facts)) continue
      a.remaining--
      hit.push(a)
    }
    return hit
  }

  /** Store an entry on an arm (dedupe by rid, bounded by the arm's count, body capped). */
  record(armId: string, entry: KeptEntry): boolean {
    const a = this.arms.get(armId)
    if (!a || a.expiresAt <= this.now()) return false
    if (a.entries.some((e) => e.rid === entry.rid)) return false
    if (a.entries.length >= a.total) return false
    a.entries.push(a.kind === 'capture' ? capEntry(entry) : stripBody(entry))
    return true
  }

  /** A peer kept `entry` for `armId`: store it and count it against what is left here. */
  applyRemote(armId: string, entry: KeptEntry): void {
    const a = this.arms.get(armId)
    if (!a) return
    if (this.record(armId, entry)) a.remaining = Math.max(0, a.total - a.entries.length)
  }

  view(id: string): ArmView | null {
    this.sweep()
    const a = this.arms.get(id)
    if (!a) return null
    return {
      id: a.id,
      kind: a.kind,
      spec: a.spec,
      total: a.total,
      remaining: a.remaining,
      created_at: a.createdAt,
      expires_at: a.expiresAt,
      done: a.remaining <= 0,
      entries: [...a.entries].sort((x, y) => y.at - x.at)
    }
  }

  /** The newest captured entry for a request (any capture), with its arm id. */
  captured(rid: string): { armId: string; entry: KeptEntry } | null {
    this.sweep()
    const want = rid.toLowerCase()
    for (const a of this.arms.values()) {
      if (a.kind !== 'capture') continue
      const e = a.entries.find((x) => x.rid.toLowerCase() === want)
      if (e) return { armId: a.id, entry: e }
    }
    return null
  }

  /** Test hook. */
  clear(): void {
    this.arms.clear()
  }
}

function stripBody(e: KeptEntry): KeptEntry {
  const { body: _b, body_note: _n, ...rest } = e
  return rest
}

function capEntry(e: KeptEntry): KeptEntry {
  if (typeof e.body !== 'string' || e.body.length <= CAPTURE_BODY_CAP) return e
  return { ...e, body: `${e.body.slice(0, CAPTURE_BODY_CAP)}…` }
}

// ─── Records named by a path ─────────────────────────────────────────────────

const REC_ID = /^(\d{1,18}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const COLLECTION = /^[A-Za-z0-9_]{1,128}$/

/** `collection:id` when the path names one record (`/api/items/<collection>/<id>`). */
export function recordRefFromPath(path: string | null | undefined): string | null {
  if (!path) return null
  const p = path.split('?')[0]
  const m = /^\/api\/items\/([^/]+)\/([^/]+)$/.exec(p)
  if (!m) return null
  const [, collection, id] = m
  if (!COLLECTION.test(collection) || !REC_ID.test(id)) return null
  return `${collection}:${id}`
}

/**
 * A route template as a SQL filter on the request log: `GET /api/items/x/:id` → method GET, path
 * LIKE `/api/items/x/%` (LIKE wildcards in literal parts escaped, `:id` as `%`). GraphQL
 * templates filter on the operation instead.
 */
export function routeLogFilter(template: string): {
  method: string
  pathLike: string | null
  pathExact: string | null
  operation: string | null
} | null {
  const t = normaliseRoute(template)
  if (!t) return null
  const sp = t.indexOf(' ')
  const method = t.slice(0, sp)
  let rest = t.slice(sp + 1)
  let operation: string | null = null
  const dot = rest.indexOf(' · ')
  if (dot >= 0) {
    operation = rest.slice(dot + 3).trim() || null
    rest = rest.slice(0, dot)
  }
  if (!rest.includes(':id')) return { method, pathLike: null, pathExact: rest, operation }
  const like = rest
    .split(':id')
    .map((part) => part.replace(/[%_[]/g, (c) => `[${c}]`))
    .join('%')
  return { method, pathLike: like, pathExact: null, operation }
}

// ─── Compare ─────────────────────────────────────────────────────────────────

export interface CompareSpan {
  phase: string
  ms: number
}
export interface CompareStatement {
  sql: string
  ms: number
  n: number
}
export interface CompareSide {
  status: number | null
  latency_ms: number | null
  query: string | null
  trace: { total_ms: number; spans: CompareSpan[]; top_sql: CompareStatement[] } | null
}

export interface CompareDiff {
  status: { a: number | null; b: number | null; same: boolean }
  ms: { a: number | null; b: number | null; delta: number | null; pct: number | null }
  phases: Array<{ phase: string; a: number | null; b: number | null; delta: number | null }>
  sql: {
    added: Array<{ sha: string; sql: string; ms: number; n: number }>
    removed: Array<{ sha: string; sql: string; ms: number; n: number }>
    slower: Array<{
      sha: string
      sql: string
      a_ms: number
      b_ms: number
      a_n: number
      b_n: number
    }>
    faster: Array<{
      sha: string
      sql: string
      a_ms: number
      b_ms: number
      a_n: number
      b_n: number
    }>
    /** Both sides carry a trace — the SQL comparison means something. */
    comparable: boolean
  }
  params: Array<{
    name: string
    a: string | null
    b: string | null
    change: 'added' | 'removed' | 'changed' | 'same'
  }>
}

/** `a=1&b=2` → ordered pairs (names decoded; repeated names joined with `, `). */
export function parseQueryParams(q: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!q) return out
  const s = q.startsWith('?') ? q.slice(1) : q
  for (const part of s.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawName = eq < 0 ? part : part.slice(0, eq)
    const rawVal = eq < 0 ? '' : part.slice(eq + 1)
    const dec = (v: string) => {
      try {
        return decodeURIComponent(v.replace(/\+/g, ' '))
      } catch {
        return v
      }
    }
    const name = dec(rawName)
    const val = dec(rawVal)
    out.set(name, out.has(name) ? `${out.get(name)}, ${val}` : val)
  }
  return out
}

function phaseTotals(spans: CompareSpan[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of spans) m.set(s.phase, (m.get(s.phase) ?? 0) + (Number(s.ms) || 0))
  return m
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** Slower = the later side spends ≥ 25% and ≥ 5 ms more on the statement shape. */
function isSlower(a: number, b: number): boolean {
  return b - a >= 5 && b >= a * 1.25
}

/** A request compared with another: status, time, phases, SQL shapes, query params. */
export function diffCompare(a: CompareSide, b: CompareSide): CompareDiff {
  const ams = a.trace?.total_ms ?? a.latency_ms
  const bms = b.trace?.total_ms ?? b.latency_ms
  const delta = ams != null && bms != null ? bms - ams : null
  const pct = delta != null && ams ? Math.round((delta / ams) * 100) : null

  const pa = phaseTotals(a.trace?.spans ?? [])
  const pb = phaseTotals(b.trace?.spans ?? [])
  const names = [...new Set([...pa.keys(), ...pb.keys()])]
  const phases = names
    .map((phase) => {
      const x = pa.has(phase) ? round1(pa.get(phase) as number) : null
      const y = pb.has(phase) ? round1(pb.get(phase) as number) : null
      return { phase, a: x, b: y, delta: x != null && y != null ? round1(y - x) : null }
    })
    .sort((p, q) => Math.max(q.a ?? 0, q.b ?? 0) - Math.max(p.a ?? 0, p.b ?? 0))

  const sa = new Map((a.trace?.top_sql ?? []).map((s) => [statementSha(s.sql), s]))
  const sb = new Map((b.trace?.top_sql ?? []).map((s) => [statementSha(s.sql), s]))
  const comparable = !!a.trace && !!b.trace
  const added: CompareDiff['sql']['added'] = []
  const removed: CompareDiff['sql']['removed'] = []
  const slower: CompareDiff['sql']['slower'] = []
  const faster: CompareDiff['sql']['faster'] = []
  if (comparable) {
    for (const [sha, s] of sb)
      if (!sa.has(sha)) added.push({ sha, sql: s.sql, ms: round1(s.ms), n: s.n })
    for (const [sha, s] of sa)
      if (!sb.has(sha)) removed.push({ sha, sql: s.sql, ms: round1(s.ms), n: s.n })
    for (const [sha, x] of sa) {
      const y = sb.get(sha)
      if (!y) continue
      const row = { sha, sql: x.sql, a_ms: round1(x.ms), b_ms: round1(y.ms), a_n: x.n, b_n: y.n }
      if (isSlower(x.ms, y.ms)) slower.push(row)
      else if (isSlower(y.ms, x.ms)) faster.push(row)
    }
    added.sort((p, q) => q.ms - p.ms)
    removed.sort((p, q) => q.ms - p.ms)
    slower.sort((p, q) => q.b_ms - q.a_ms - (p.b_ms - p.a_ms))
    faster.sort((p, q) => q.a_ms - q.b_ms - (p.a_ms - p.b_ms))
  }

  const qa = parseQueryParams(a.query)
  const qb = parseQueryParams(b.query)
  const params = [...new Set([...qa.keys(), ...qb.keys()])].map((name) => {
    const x = qa.has(name) ? (qa.get(name) as string) : null
    const y = qb.has(name) ? (qb.get(name) as string) : null
    const change: CompareDiff['params'][number]['change'] =
      x == null ? 'added' : y == null ? 'removed' : x === y ? 'same' : 'changed'
    return { name, a: x, b: y, change }
  })

  return {
    status: { a: a.status, b: b.status, same: a.status === b.status },
    ms: { a: ams, b: bms, delta, pct },
    phases,
    sql: { added, removed, slower, faster, comparable },
    params
  }
}
