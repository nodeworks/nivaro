import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * Per-request phase timing.
 *
 * `nivaro_api_logs` already answers "how slow is this route" (p50/p95 on the
 * API Analytics page). It cannot answer "why was THIS request slow", which is
 * the question that actually gets asked — a list read is a chain of permission
 * lookups, metadata fetches, the query itself, computed-field passes and hooks,
 * and knowing the total tells you nothing about which one to go fix.
 *
 * Two deliberate constraints keep this cheap enough to leave on permanently:
 *
 *   1. A request that finishes under SLOW_MS is DISCARDED. Fast requests pay
 *      only for a handful of performance.now() calls and one array of small
 *      objects that is dropped on response. Nothing is written anywhere.
 *   2. The buffer is in-process and bounded. No table, no migration, no Redis
 *      round trip on the response path — tracing must never itself become a
 *      cost worth tracing. The consequence is that traces are per-replica (you
 *      see the instance you asked), the same shape presence and journeys
 *      already have.
 *
 * Nothing in here may throw into a request. A trace that fails to record is a
 * lost diagnostic; a trace that breaks a response is an outage.
 */

export interface TraceSpan {
  /** Stable identity within the trace, assigned once at record time. */
  seq: number
  phase: string
  ms: number
  /** Offset from request start, so the UI can lay spans out as a waterfall. */
  at: number
  detail?: string
  /** Round trips the phase made (#506) — at ~37ms each, the count IS the latency. */
  queries?: number
  /** The one statement shape this phase ran over and over (#507): an N+1. */
  repeat?: { sql: string; n: number; ms: number }
  /** `select *` against tables holding an nvarchar(max) column (#483). */
  wide?: Array<{ table: string; n: number }>
}

/** One statement the request ran, kept for the slow-SQL list and plan capture (#509). */
export interface TraceStatement {
  sql: string
  bindings: unknown[]
  ms: number
  n: number
}

export interface TraceRecord {
  id: string
  method: string
  route: string
  url: string
  status: number
  user: string | null
  total_ms: number
  spans: TraceSpan[]
  ts: string
  /** Round trips the whole request made (#506). */
  queries: number
  /** Time spent waiting on the database, summed over statements. */
  sql_ms: number
  /** Heaviest statement shapes by total time, with call counts. */
  top_sql: TraceStatement[]
  /** `select *` reads of nvarchar(max)-bearing tables, per table (#483). */
  wide: Array<{ table: string; n: number }>
}

interface RanStatement {
  sql: string
  bindings: unknown[]
  ms: number
  /** Offset from request start. */
  at: number
  wideTable: string | null
}

interface TraceContext {
  start: number
  spans: TraceSpan[]
  urlHint?: string
  /** Per-request id — the AI call log groups a tool loop's calls under it. */
  id: string
  userId?: string
  /** The request itself (read lazily): how it authenticated is only known
   *  after `authenticate` runs, well after the trace begins (#609). */
  request?: TraceCallerSource
  /** Every statement this request ran, in completion order (capped). */
  statements: RanStatement[]
  /** Statements started but not yet answered, by knex query uid. */
  inflight: Map<string, { sql: string; bindings: unknown[]; start: number }>
  queries: number
  /** Measurement every request keeps (Traffic Map taps read it at onResponse). */
  m: Measure
}

/**
 * Per-request figures kept for EVERY traced request (not only slow ones), read once by the
 * Traffic Map at onResponse (#1108 / #1151 / #1146 / #1145 / #1135). Plain numbers updated in
 * place — nothing here allocates per statement or per span.
 */
interface Measure {
  /** Wall time with at least one statement in flight (concurrent statements count once). */
  sqlWall: number
  /** When the current in-flight stretch began (valid while a statement is in flight). */
  sqlWallStart: number
  /** Wall time per category (auth, metadata, hooks), SQL inside included. */
  cat: [number, number, number]
  catOpen: [number, number, number]
  catStart: [number, number, number]
  catSql: [number, number, number]
  /** Database wall time that ran inside a category (the SQL bar shows the rest). */
  catSqlIn: number
  /** Row filter + User Scope enforcement, wall time (SQL inside counts). */
  accessMs: number
  accessOpen: number
  accessStart: number
  /** preSerialization → onSend; 0 when the handler sent a string. */
  serStart: number
  serMs: number
  /** The largest identical-statement run any span saw (the N+1 shape) and its SQL. */
  repeatN: number
  repeatSql: string | null
  /** [direct, rollup, queue, integrity, revision, activity] writes; null until the first. */
  derived: number[] | null
  /** The first readItems of the request: its collection + compiled filter / sort inputs. */
  shape: ReadShapeRef | null
  /** #1173: wall time spent in each extension's hooks (extension id → ms); null until one ran. */
  ext: Map<string, number> | null
  /** The longest single statement (#1169 near-timeout lens) and its text. */
  maxStmtMs: number
  maxStmtSql: string | null
  /** Statements the driver gave up on (tedious request timeout, ETIMEOUT). */
  stmtTimeouts: number
}

/** What the first `readItems` of a request was asked for (references, never copied). */
export interface ReadShapeRef {
  collection: string
  filter: unknown
  sort: readonly string[]
  conditions: unknown
}

export type DerivedWriteKind = 'direct' | 'rollup' | 'queue' | 'integrity' | 'revision' | 'activity'
export const DERIVED_KINDS: readonly DerivedWriteKind[] = [
  'direct',
  'rollup',
  'queue',
  'integrity',
  'revision',
  'activity'
]

function newMeasure(): Measure {
  return {
    sqlWall: 0,
    sqlWallStart: 0,
    cat: [0, 0, 0],
    catOpen: [0, 0, 0],
    catStart: [0, 0, 0],
    catSql: [0, 0, 0],
    catSqlIn: 0,
    accessMs: 0,
    accessOpen: 0,
    accessStart: 0,
    serStart: 0,
    serMs: 0,
    repeatN: 0,
    repeatSql: null,
    derived: null,
    shape: null,
    ext: null,
    maxStmtMs: 0,
    maxStmtSql: null,
    stmtTimeouts: 0
  }
}

/** Database wall time so far, the stretch still in flight included. */
function sqlWallNow(ctx: TraceContext, now: number): number {
  return ctx.m.sqlWall + (ctx.inflight.size > 0 ? now - ctx.m.sqlWallStart : 0)
}

/** auth = 0, metadata = 1, hooks = 2, anything else -1. */
export function spanCategory(phase: string): number {
  if (phase === 'auth') return 0
  if (phase.startsWith('permissions') || phase.startsWith('metadata')) return 1
  if (phase.startsWith('hook') || phase.startsWith('rules:')) return 2
  return -1
}

/** What activity attribution reads off the live request (#609 / #617). */
export interface TraceCallerSource {
  authMethod?: string
  apiKeyId?: number | null
}

const als = new AsyncLocalStorage<TraceContext>()

/** Requests faster than this are never recorded. */
const SLOW_MS = Number(process.env.TRACE_SLOW_MS ?? 1000)
/** Ring buffer size. ~200 traces of ~15 spans is a few hundred KB. */
const CAPACITY = Number(process.env.TRACE_BUFFER ?? 200)

const buffer: TraceRecord[] = []

/** request object → its trace context, so onResponse readers never depend on the ALS chain. */
const byRequest = new WeakMap<object, TraceContext>()

export function beginTrace(urlHint?: string, request?: TraceCallerSource): void {
  // enterWith (rather than als.run) is what lets a Fastify onRequest hook scope
  // the context for the whole request without wrapping the handler chain.
  const ctx: TraceContext = {
    start: performance.now(),
    spans: [],
    urlHint,
    id: randomUUID(),
    request,
    statements: [],
    inflight: new Map(),
    queries: 0,
    m: newMeasure()
  }
  if (request && typeof request === 'object') byRequest.set(request, ctx)
  als.enterWith(ctx)
}

/**
 * Leave the current async context with NO trace. `beginTrace` uses enterWith, so the store can
 * outlive its request on a keep-alive socket; an untraced request clears it so nothing (the
 * Traffic Map's request id on a public-page event, AI call attribution) reads a stale trace.
 */
export function clearTrace(): void {
  if (als.getStore()) als.enterWith(undefined as unknown as TraceContext)
}

/** How the current request authenticated, for a write that has no request
 *  object in hand (GraphQL resolvers, deferred effects inside the request).
 *  Null outside a request — a cron's writes are nobody's inbound call. */
export function currentTraceCaller(): { auth: string | null; apiKeyId: number | null } | null {
  const req = als.getStore()?.request
  if (!req) return null
  return {
    auth: req.authMethod ?? null,
    apiKeyId:
      req.apiKeyId != null && Number.isFinite(Number(req.apiKeyId)) ? Number(req.apiKeyId) : null
  }
}

/** #1154 — the current request's workspace (the Traffic Map tags write events with it). */
export function currentTraceWorkspace(): string | null {
  const ws = (als.getStore()?.request as { workspaceId?: unknown } | undefined)?.workspaceId
  return typeof ws === 'string' && ws ? ws : null
}

/** Run `fn` inside its own trace context — a background job that must
 *  still attribute its AI calls to a request id and a person. */
export function runInTrace<T>(
  urlHint: string,
  userId: string | null,
  fn: () => Promise<T>
): Promise<T> {
  return als.run(
    {
      start: performance.now(),
      spans: [],
      urlHint,
      id: randomUUID(),
      userId: userId ?? undefined,
      statements: [],
      inflight: new Map(),
      queries: 0,
      m: newMeasure()
    },
    fn
  )
}

/** Stamp the resolved user onto the current request's trace (authenticate calls it). */
export function setTraceUser(userId: string): void {
  const ctx = als.getStore()
  if (ctx) ctx.userId = userId
}

/**
 * What the AI call log attributes a call to: the request id, route and user, if any. `request`
 * is false inside `runInTrace` (a background job's own id — no request, no API log row behind it).
 */
export function currentTraceMeta(): {
  id: string
  urlHint: string | null
  userId: string | null
  request?: boolean
} | null {
  const ctx = als.getStore()
  if (!ctx) return null
  return {
    id: ctx.id,
    urlHint: ctx.urlHint ?? null,
    userId: ctx.userId ?? null,
    request: ctx.request != null
  }
}

/** #304 — the current request's URL, for pool-leak attribution. */
export function currentRequestHint(): string | null {
  return als.getStore()?.urlHint ?? null
}

/**
 * Time an async phase. Outside a traced request this is a straight pass-through
 * with no allocation, so instrumented code stays safe to call from crons,
 * workers and tests.
 */
export async function span<T>(phase: string, fn: () => Promise<T>, detail?: string): Promise<T> {
  const ctx = als.getStore()
  if (!ctx) return fn()
  const start = performance.now()
  const q0 = ctx.queries
  const s0 = ctx.statements.length
  const m = ctx.m
  const cat = spanCategory(phase)
  if (cat >= 0 && m.catOpen[cat]++ === 0) {
    m.catStart[cat] = start
    m.catSql[cat] = sqlWallNow(ctx, start)
  }
  try {
    return await fn()
  } finally {
    if (cat >= 0 && --m.catOpen[cat] === 0) {
      // Union wall time of the category's (possibly overlapping) spans; the database time spent
      // inside them is remembered so the SQL bar shows only the SQL outside every category.
      const now = performance.now()
      m.cat[cat] += now - m.catStart[cat]
      m.catSqlIn += Math.max(0, sqlWallNow(ctx, now) - m.catSql[cat])
    }
    // Recorded in `finally` so a phase that throws still shows its cost — the
    // slow thing and the failing thing are often the same thing.
    const rec: TraceSpan = {
      seq: 0,
      phase,
      ms: performance.now() - start,
      at: start - ctx.start,
      detail
    }
    const queries = ctx.queries - q0
    if (queries > 0) {
      rec.queries = queries
      // Statements answered while this phase ran. Concurrent phases share the
      // window, which over-attributes by design — the count still names the
      // shape that repeated, which is what an N+1 hunt needs.
      const ran = ctx.statements.slice(s0)
      const repeat = repeatedShape(ran)
      if (repeat) {
        rec.repeat = repeat
        if (repeat.n > m.repeatN) {
          m.repeatN = repeat.n
          m.repeatSql = repeat.sql
        }
      }
      const wide = wideByTable(ran)
      if (wide.length) rec.wide = wide
    }
    ctx.spans.push(rec)
  }
}

/** Below this many identical statements a phase is a loop, not an N+1. */
const REPEAT_MIN = 5

function repeatedShape(ran: RanStatement[]): TraceSpan['repeat'] | undefined {
  const groups = new Map<string, { n: number; ms: number }>()
  for (const r of ran) {
    const g = groups.get(r.sql) ?? { n: 0, ms: 0 }
    g.n++
    g.ms += r.ms
    groups.set(r.sql, g)
  }
  let best: { sql: string; n: number; ms: number } | null = null
  for (const [sql, g] of groups)
    if (g.n >= REPEAT_MIN && (!best || g.n > best.n)) best = { sql, ...g }
  return best ? { sql: best.sql, n: best.n, ms: Math.round(best.ms) } : undefined
}

function wideByTable(ran: RanStatement[]): Array<{ table: string; n: number }> {
  const counts = new Map<string, number>()
  for (const r of ran) if (r.wideTable) counts.set(r.wideTable, (counts.get(r.wideTable) ?? 0) + 1)
  return [...counts].map(([table, n]) => ({ table, n })).sort((a, b) => b.n - a.n)
}

// ─── Query accounting (#506 / #507 / #483) ───────────────────────────────────
//
// knex emits `query` when a statement is sent and `query-response` /
// `query-error` when it answers, both carrying the query's uid. Inside a traced
// request every statement is counted and timed; outside one the listeners
// return immediately. Kept per request, never global — a global counter would
// attribute one request's queries to another under concurrency.

/** How many statements a request keeps in full. Past this only the count grows. */
const STATEMENT_CAP = 400
/** Statement text kept per entry — enough to read the shape, not a 20KB body. */
const SQL_CAP = 600

/** Tables carrying an nvarchar(max) column; `select *` on these is the #483 class. */
let wideTables: Set<string> = new Set()
export function setWideTables(tables: Iterable<string>): void {
  wideTables = new Set([...tables].map((t) => t.toLowerCase()))
}

const SELECT_STAR = /^\s*select\s+(?:top\s*\(?[@\w]+\)?\s+)?\*\s+from\s+\[?([A-Za-z0-9_]+)\]?/i

function wideTableOf(sql: string): string | null {
  const m = SELECT_STAR.exec(sql)
  if (!m) return null
  const t = m[1].toLowerCase()
  return wideTables.has(t) ? t : null
}

interface KnexQueryEvent {
  __knexQueryUid?: string
  sql?: string
  bindings?: unknown[]
}

/**
 * Attach to a knex instance once. Safe to call for several instances (the
 * read replica, a tenant db) — each statement is attributed to whichever
 * request's context it ran under.
 */
export function attachQueryTracing(client: {
  on: (ev: string, fn: (...a: unknown[]) => void) => unknown
}): void {
  client.on('query', (q: unknown) => {
    const ctx = als.getStore()
    if (!ctx) return
    const ev = q as KnexQueryEvent
    ctx.queries++
    if (!ev.__knexQueryUid || typeof ev.sql !== 'string') return
    const start = performance.now()
    if (ctx.inflight.size === 0) ctx.m.sqlWallStart = start
    ctx.inflight.set(ev.__knexQueryUid, {
      sql: ev.sql,
      bindings: Array.isArray(ev.bindings) ? ev.bindings : [],
      start
    })
  })
  const settle = (q: unknown) => {
    const ctx = als.getStore()
    if (!ctx) return
    const ev = q as KnexQueryEvent
    const uid = ev.__knexQueryUid
    if (!uid) return
    const started = ctx.inflight.get(uid)
    if (!started) return
    ctx.inflight.delete(uid)
    const now = performance.now()
    const ms = now - started.start
    if (ctx.inflight.size === 0) ctx.m.sqlWall += now - ctx.m.sqlWallStart
    if (ms > ctx.m.maxStmtMs) {
      ctx.m.maxStmtMs = ms
      ctx.m.maxStmtSql = started.sql.length > SQL_CAP ? started.sql.slice(0, SQL_CAP) : started.sql
    }
    if (ctx.statements.length >= STATEMENT_CAP) return
    const sql = started.sql.length > SQL_CAP ? `${started.sql.slice(0, SQL_CAP)}…` : started.sql
    ctx.statements.push({
      sql,
      bindings: started.bindings.slice(0, 40),
      ms,
      at: started.start - ctx.start,
      wideTable: wideTableOf(started.sql)
    })
  }
  client.on('query-response', (_res: unknown, q: unknown) => settle(q))
  client.on('query-error', (err: unknown, q: unknown) => {
    if (isStatementTimeout(err)) {
      const ctx = als.getStore()
      if (ctx) ctx.m.stmtTimeouts++
    }
    settle(q)
  })
}

/** A driver-side statement timeout (tedious `requestTimeout`): ETIMEOUT / "Timeout: Request
 *  failed to complete in 15000ms". Knex wraps the driver error; the code or text survives. */
export function isStatementTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; errors?: unknown }
  if (e.code === 'ETIMEOUT') return true
  const text = String(e.message ?? '')
  if (/Timeout: Request failed to complete/i.test(text)) return true
  if (Array.isArray(e.errors)) return e.errors.some((x) => isStatementTimeout(x))
  return false
}

/** Statement shapes by total time, with call counts. */
function topStatements(ran: RanStatement[], limit: number): TraceStatement[] {
  const groups = new Map<string, TraceStatement>()
  for (const r of ran) {
    const g = groups.get(r.sql)
    if (g) {
      g.n++
      g.ms += r.ms
      if (r.ms > g.ms / g.n && g.bindings.length === 0) g.bindings = r.bindings
    } else groups.set(r.sql, { sql: r.sql, bindings: r.bindings, ms: r.ms, n: 1 })
  }
  return [...groups.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map((g) => ({ ...g, ms: Math.round(g.ms * 10) / 10 }))
}

/** Record a phase that was measured elsewhere (e.g. an existing timing). */
export function markSpan(phase: string, ms: number, detail?: string): void {
  const ctx = als.getStore()
  if (!ctx) return
  ctx.spans.push({ seq: 0, phase, ms, at: performance.now() - ctx.start - ms, detail })
}

/** True when the current request is being traced — lets callers skip building detail strings. */
export function isTracing(): boolean {
  return als.getStore() !== undefined
}

// ─── Per-request measurement (Traffic Map, #1108 / #1151 / #1146 / #1145 / #1135) ─────────
// Every function below is a no-op outside a traced request and allocates nothing on the way in.

/** A write the request caused: its own (`direct`) or one derived from it (rollup, queue cache,
 *  integrity check, revision, activity row). */
export function noteDerivedWrite(kind: DerivedWriteKind, n = 1): void {
  const ctx = als.getStore()
  if (!ctx || n <= 0) return
  const i = DERIVED_KINDS.indexOf(kind)
  if (i < 0) return
  if (!ctx.m.derived) ctx.m.derived = [0, 0, 0, 0, 0, 0]
  ctx.m.derived[i] += n
}

/** The first list read of the request (its filter / sort / conditions, kept by reference). */
export function noteReadShape(
  collection: string,
  filter: unknown,
  sort: readonly string[],
  conditions: unknown
): void {
  const ctx = als.getStore()
  if (!ctx || ctx.m.shape) return
  ctx.m.shape = { collection, filter, sort, conditions }
}

function accessEnter(m: Measure): void {
  if (m.accessOpen++ === 0) m.accessStart = performance.now()
}
function accessLeave(m: Measure): void {
  if (--m.accessOpen === 0) m.accessMs += performance.now() - m.accessStart
}

/** Time row-filter / User Scope enforcement (nested calls count once). */
export async function timeAccess<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = als.getStore()
  if (!ctx) return fn()
  accessEnter(ctx.m)
  try {
    return await fn()
  } finally {
    accessLeave(ctx.m)
  }
}
export function timeAccessSync<T>(fn: () => T): T {
  const ctx = als.getStore()
  if (!ctx) return fn()
  accessEnter(ctx.m)
  try {
    return fn()
  } finally {
    accessLeave(ctx.m)
  }
}

/** preSerialization (object payloads only). */
export function markSerializeStart(req: object): void {
  const ctx = byRequest.get(req)
  if (ctx) ctx.m.serStart = performance.now()
}
/** onSend: closes the serialization window opened above. */
export function markSerializeEnd(req: object): void {
  const ctx = byRequest.get(req)
  if (ctx && ctx.m.serStart > 0) {
    ctx.m.serMs += performance.now() - ctx.m.serStart
    ctx.m.serStart = 0
  }
}

/** What one finished request measured — read by the Traffic Map at onResponse. */
export interface RequestMeasure {
  queries: number
  /** Wall time waiting on the database (concurrent statements count once). */
  sqlMs: number
  /** The part of sqlMs outside auth / metadata / hooks (the latency split's SQL bar). */
  sqlOutsideMs: number
  authMs: number
  metadataMs: number
  hooksMs: number
  serializationMs: number
  accessMs: number
  repeatN: number
  repeatSql: string | null
  /** [direct, rollup, queue, integrity, revision, activity]; null when it wrote nothing. */
  derived: readonly number[] | null
  shape: ReadShapeRef | null
  /** #1173: wall time per extension (its hooks); null when no extension hook ran. */
  extensionMs: ReadonlyMap<string, number> | null
  /** The longest single statement and its text (#1169). */
  maxStatementMs: number
  maxStatementSql: string | null
  /** Statements the driver gave up on (tedious request timeout). */
  statementTimeouts: number
}

/**
 * #1173 — an extension's hook ran `ms` inside the current traced request (the Traffic Map
 * splits an entity's load between core and each extension). Outside a request: nothing.
 */
export function noteExtensionMs(extensionId: string, ms: number): void {
  const ctx = als.getStore()
  if (!ctx || !extensionId || !Number.isFinite(ms) || ms <= 0) return
  const m = ctx.m
  if (!m.ext) m.ext = new Map()
  m.ext.set(extensionId, (m.ext.get(extensionId) ?? 0) + ms)
}

/** The measurement of the request `req` (null when it was not traced, e.g. not under /api). */
export function requestMeasure(req: unknown): RequestMeasure | null {
  if (!req || typeof req !== 'object') return null
  const ctx = byRequest.get(req)
  if (!ctx) return null
  const m = ctx.m
  const sql = sqlWallNow(ctx, performance.now())
  return {
    queries: ctx.queries,
    sqlMs: sql,
    sqlOutsideMs: Math.max(0, sql - m.catSqlIn),
    authMs: m.cat[0],
    metadataMs: m.cat[1],
    hooksMs: m.cat[2],
    serializationMs: m.serMs,
    accessMs: m.accessMs,
    repeatN: m.repeatN,
    repeatSql: m.repeatSql,
    derived: m.derived,
    shape: m.shape,
    extensionMs: m.ext,
    maxStatementMs: m.maxStmtMs,
    maxStatementSql: m.maxStmtSql,
    statementTimeouts: m.stmtTimeouts
  }
}

/** Distinct statement texts the request `req` ran (≤ `limit`, each ≤ SQL_CAP) — the deadlock
 *  marker (#1171) indexes them so a deadlock graph's statements can name their entities. */
export function requestStatements(req: unknown, limit = 40): string[] {
  if (!req || typeof req !== 'object') return []
  const ctx = byRequest.get(req)
  if (!ctx) return []
  const out = new Set<string>()
  for (const s of ctx.statements) {
    out.add(s.sql)
    if (out.size >= limit) break
  }
  return [...out]
}

// ─── Follow-this-user (#309) ─────────────────────────────────────────────────
const followBudget = new Map<string, { remaining: number; until: number }>()

export function followUser(userId: string, requests = 50): void {
  followBudget.set(userId.toUpperCase(), { remaining: requests, until: Date.now() + 3600_000 })
}

export function followedUsers(): Array<{ user: string; remaining: number }> {
  const now = Date.now()
  return [...followBudget.entries()]
    .filter(([, v]) => v.remaining > 0 && v.until > now)
    .map(([user, v]) => ({ user, remaining: v.remaining }))
}

function consumeFollow(userId: string): boolean {
  const f = followBudget.get(userId.toUpperCase())
  if (!f || f.remaining <= 0 || f.until < Date.now()) return false
  f.remaining--
  return true
}

export function finishTrace(meta: {
  method: string
  route: string
  url: string
  status: number
  user: string | null
}): void {
  const ctx = als.getStore()
  if (!ctx) return
  const total = performance.now() - ctx.start
  // #309 — follow-this-user: a flagged user's requests are kept regardless of
  // speed (their next N, whatever they touch), so a "it's slow for Beth"
  // report can be traced without waiting for a threshold breach.
  const followed = meta.user && consumeFollow(meta.user)
  if (total < SLOW_MS && !followed) return

  // Spans nest (a phase can contain sub-phases), so they are kept in start
  // order and the UI indents by overlap rather than being handed a tree the
  // instrumentation would have to agree on.
  const spans = [...ctx.spans].sort((a, b) => a.at - b.at)

  buffer.push({
    // The request id (plugins/request-trace.ts stamps it on req.requestId, the API log row and
    // the x-nivaro-request-id header), so getTrace(requestId) finds this request's trace.
    id: ctx.id,
    method: meta.method,
    route: meta.route,
    url: meta.url,
    status: meta.status,
    user: meta.user,
    total_ms: Math.round(total),
    spans: spans.map((s, i) => ({
      ...s,
      seq: i,
      ms: Math.round(s.ms * 10) / 10,
      at: Math.round(s.at)
    })),
    ts: new Date().toISOString(),
    queries: ctx.queries,
    sql_ms: Math.round(ctx.statements.reduce((n, r) => n + r.ms, 0)),
    top_sql: topStatements(ctx.statements, Math.max(1, Number(process.env.TRACE_TOP_SQL) || 8)),
    wide: wideByTable(ctx.statements)
  })
  while (buffer.length > CAPACITY) buffer.shift()
}

export function listTraces(limit = 50): TraceRecord[] {
  return buffer.slice(-limit).reverse()
}

export function getTrace(id: string): TraceRecord | null {
  return buffer.find((t) => t.id === id) ?? null
}

export function clearTraces(): void {
  buffer.length = 0
}

export function traceConfig() {
  return { slow_ms: SLOW_MS, capacity: CAPACITY, buffered: buffer.length }
}

/**
 * "Unaccounted" is the honest part of the waterfall: total minus the top-level
 * spans, i.e. time inside the request that nothing has instrumented yet. It is
 * the pointer to where the NEXT span belongs, so it is computed rather than
 * quietly omitted.
 */
export function unaccountedMs(trace: TraceRecord): number {
  // Only count spans no other span contains, or nested work is double-counted.
  const top: TraceSpan[] = []
  for (const s of trace.spans) {
    const contained = top.some((t) => s.at >= t.at && s.at + s.ms <= t.at + t.ms + 0.5)
    if (!contained) top.push(s)
  }
  const covered = top.reduce((sum, s) => sum + s.ms, 0)
  return Math.max(0, Math.round(trace.total_ms - covered))
}
