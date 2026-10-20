/**
 * Compiled permission cache per person (#2442). OFF unless PERMISSION_CACHE=on.
 *
 * What it holds: the DERIVED answers the permission layer rebuilds on every
 * call — the role decision behind can() (role row + matching policy), the
 * allowed field list, the parsed row-filter conditions, the admin flag and a
 * person's compiled User Scope enforcement (restrict filters + hop routes) —
 * one entry per (principal, question). Never a record, never a user row: who
 * the caller is (user row, status, role id, API key row, OAuth grant,
 * masquerade token) is still read fresh on every request by authenticate,
 * and that identity is part of every key.
 *
 * The key: tenant · sign-in kind (session / token / api key + id / run-as-key
 * / masquerade + issuing admin / oauth + client) · user id · role id · the
 * API key's scope and row-restriction lists · sandbox flag · the cluster-wide
 * access version · the person's own access version — then the question
 * (operation, action, collection).
 *
 * Staleness: a wrong entry is wrong ACCESS, so an entry is reachable only
 * while the versions are unchanged, and never past the hard TTL
 * (PERMISSION_CACHE_TTL_MS, default 30 s, at most 60 s). The versions are
 * Redis counters plus an incarnation nonce (a Redis that lost its keys can
 * never climb back onto an old number), read once per request (one MGET,
 * reused for at most 1 s on the same user object); when Redis is not ready or
 * slow, or the nonce is missing, the cache is skipped and the answer is built
 * as before — denial and allow alike, there is no separate path for either.
 * An answer built from a fallback (a failed read papered over) is never kept.
 *
 * What moves the versions:
 *  - every statement through this process's knex pools (and runLongSql's raw
 *    batches) that is not a plain read and names an access table (roles,
 *    policies, user scopes, scope dimensions, relations, fields, collections,
 *    tree permissions), any table/view DDL, dynamic SQL, and a stored
 *    procedure whose body may touch them (unknown = may) — before and after
 *    the statement;
 *  - a transaction that wrote one, when it settles (the commit has no driver
 *    event), plus trailing moves 1 s / 5 s / 15 s;
 *  - explicit calls after API key, View-as and transactional role writes;
 *  - the configuration epoch (db/config-epoch.ts) clears this cache and the
 *    caches it is built from when another process — a script, a process with
 *    the cache off, a process on another Redis — wrote configuration.
 * A writer outside the app (SSMS, a job on the database server, a linked server, a
 * trigger on a business table that writes an access table, sp_MSforeachtable-style
 * generated SQL) moves none of them: the hard TTL is the backstop.
 *
 * Whenever the versions move, the caches the entries are built from (user
 * scope rows, dimensions, scope routes, role admin flags, driver-seam config
 * reads) are dropped too, and a fill whose read straddled the move is not
 * kept — so a refill never reads a copy from before the move.
 *
 * Off: every call goes straight to the uncached code (same statements, same
 * order) and nothing on the write side runs. Turn it on for every replica of
 * an environment together; a replica with it off is still seen through the
 * configuration epoch (within CACHE_EPOCH_POLL_MS + its trailing move).
 *
 * Cloud mode: always off (tenant pools have no driver seam).
 */
import { getTenantId } from '../db/tenant-context.js'
import type { User } from '../types.js'

export interface PermissionCacheRedis {
  status?: string
  mget(...keys: string[]): Promise<Array<string | null>>
  // biome-ignore lint/suspicious/noExplicitAny: ioredis overloads (NX / EX ttl)
  set(...args: any[]): Promise<unknown>
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

const CLOUD = !!process.env.CLOUD_META_DB_URL
let enabled = process.env.PERMISSION_CACHE === 'on' && !CLOUD
/** Hard backstop: no entry is served after this, whatever the versions say. */
export const PERMISSION_CACHE_TTL_MS = bounded(
  process.env.PERMISSION_CACHE_TTL_MS,
  30_000,
  1_000,
  60_000
)
const MAX_ENTRIES = bounded(process.env.PERMISSION_CACHE_MAX, 20_000, 100, 200_000)
/** How long a version read may take before the request goes uncached. */
const VERSION_TIMEOUT_MS = bounded(process.env.PERMISSION_CACHE_REDIS_TIMEOUT_MS, 50, 5, 1_000)
/** How long one user object reuses the versions it read (one request, in practice). */
const VERSION_REUSE_MS = 1_000
const USER_VERSION_TTL_S = 86_400
const TRAILING_MS = [1_000, 5_000, 15_000]
const KEY = 'nvr:permver'

let redis: PermissionCacheRedis | null = null
/** This process's own incarnation tag for a nonce it creates. */
const NONCE_SEED = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export function setPermissionCacheRedis(r: PermissionCacheRedis | null): void {
  redis = CLOUD ? null : r
}

export function permissionCacheEnabled(): boolean {
  return enabled
}

/** Tests and the equivalence harness switch the cache at run time. A process that booted
 *  with it off has no seam or commit hook attached, so its own writes move nothing. */
export function setPermissionCacheEnabled(on: boolean): void {
  enabled = on && !CLOUD
  resetLocal(undefined, false)
}

// ── state ────────────────────────────────────────────────────────────────────

type Entry = { at: number; v: unknown }
const entries = new Map<string, Entry>()
let generation = 0
/** Per person: a reset for one person drops only that person's in-flight fills. */
const userGeneration = new Map<string, number>()
let tokenSeq = 0
/** A value no other write — here or on any process, before or after a Redis loss — ever
 *  produces, so a version can never come back to one an entry was stored under. */
function freshToken(): string {
  return `${NONCE_SEED}-${(++tokenSeq).toString(36)}`
}
const seenGlobal = new Map<string, string>()
const seenUser = new Map<string, string>()
const kinds = new WeakMap<object, string>()
const versionMemo = new WeakMap<
  object,
  { at: number; tenant: string; uid: string; p: Promise<Versions | null> }
>()
const resetListeners = new Set<(userId?: string) => void>()
const counters = {
  hits: 0,
  misses: 0,
  stores: 0,
  dropped: 0,
  bypassed: 0,
  bumps: 0,
  user_bumps: 0,
  resets: 0,
  version_errors: 0
}

interface Versions {
  /** Changes whenever the counters were lost (Redis flushed, restarted, failed over). */
  n: string
  g: string
  u: string
}

/** Caches the entries are built from (user scope rows, dimensions, driver reads) register a
 *  bust here; it runs when a version move from another process is seen, so a refill never
 *  reads a copy older than the move. Only while the cache is on. */
export function onPermissionCacheReset(fn: (userId?: string) => void): void {
  resetListeners.add(fn)
}

function resetLocal(userId: string | undefined, listeners: boolean, scan = true): void {
  if (userId === undefined) {
    entries.clear()
    // A fill that started before this point is not stored.
    generation++
  } else {
    if (scan) {
      for (const key of entries.keys()) {
        if (key.split('\u0000', 3)[2]?.toLowerCase() === userId) entries.delete(key)
      }
    }
    if (userGeneration.size >= 50_000) userGeneration.clear()
    userGeneration.set(userId, (userGeneration.get(userId) ?? 0) + 1)
  }
  counters.resets++
  if (!listeners) return
  for (const fn of resetListeners) {
    try {
      fn(userId)
    } catch {
      /* one listener never stops the rest */
    }
  }
}

/** The cache registry's bust (cache console, configuration epoch: another process, a
 *  script or a process on another Redis wrote configuration). The caches the entries are
 *  built from are dropped too, so a refill cannot read a copy from before the write. */
export function clearPermissionCache(): void {
  // The epoch also moves on CREATE / ALTER PROCEDURE elsewhere: bodies are read again.
  forgetProcedureVerdicts()
  resetLocal(undefined, enabled)
}

export function permissionCacheStats(): Record<string, number | boolean> {
  return {
    enabled,
    ttl_ms: PERMISSION_CACHE_TTL_MS,
    max_entries: MAX_ENTRIES,
    entries: entries.size,
    ...counters
  }
}

/** authenticate names how the request signed in; the kind is part of every key. */
export function notePrincipalKind(user: object, kind: string): void {
  kinds.set(user, kind)
}

// ── versions ─────────────────────────────────────────────────────────────────

function tenantKey(): string {
  return getTenantId() ?? ''
}
// One hash slot per tenant ({…}), so the MGET also works on a Redis Cluster.
function slot(tenant: string): string {
  return `{${tenant || 'self'}}`
}
function globalKey(tenant: string): string {
  return `${KEY}:${slot(tenant)}:g`
}
function userKey(tenant: string, uid: string): string {
  return `${KEY}:${slot(tenant)}:u:${uid}`
}
function nonceKey(tenant: string): string {
  return `${KEY}:${slot(tenant)}:n`
}

/** A version this process had not seen yet — moved elsewhere, or seen for the first time
 *  (the subcaches may predate it either way) — drops what was built from the old one. */
function observe(tenant: string, uid: string, v: Versions): void {
  const g = seenGlobal.get(tenant)
  const now = `${v.n}\u0000${v.g}`
  if (g !== now) {
    seenGlobal.set(tenant, now)
    resetLocal(undefined, true)
  }
  const uk = `${tenant}\u0000${uid}`
  const u = seenUser.get(uk)
  if (u === v.u) return
  if (seenUser.size >= 50_000) {
    const oldest = seenUser.keys().next().value
    if (oldest !== undefined) seenUser.delete(oldest)
  }
  seenUser.delete(uk)
  seenUser.set(uk, v.u)
  // First sight: no entry can carry an older version of this person (nothing to scan for).
  if (g === now) resetLocal(uid, true, u !== undefined)
}

/** Missing-nonce resets, at most one per tenant per second (a Redis that refuses writes
 *  would otherwise clear every cache on every request). */
const lastNonceReset = new Map<string, number>()

async function readVersions(
  r: PermissionCacheRedis,
  tenant: string,
  uid: string
): Promise<Versions | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const res = await Promise.race([
      r.mget(nonceKey(tenant), globalKey(tenant), userKey(tenant, uid)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), VERSION_TIMEOUT_MS)
        timer.unref?.()
      })
    ])
    if (!Array.isArray(res)) {
      counters.version_errors++
      return null
    }
    if (res[0] == null) {
      // No nonce: the counters were lost (or never made). Start a new incarnation, drop
      // everything built under the old one, and answer this request uncached.
      void r.set(nonceKey(tenant), freshToken(), 'NX').catch(() => {})
      seenGlobal.delete(tenant)
      const at = Date.now()
      if (at - (lastNonceReset.get(tenant) ?? 0) >= 1_000) {
        lastNonceReset.set(tenant, at)
        resetLocal(undefined, true)
      } else {
        entries.clear()
        generation++
      }
      return null
    }
    if (res[1] == null || res[2] == null) {
      // A version key that is missing (never written, expired or evicted) gets a fresh
      // token: a placeholder like '0' could come back after another loss and revive what
      // was stored under it. This request answers uncached.
      if (res[1] == null) void r.set(globalKey(tenant), freshToken(), 'NX').catch(() => {})
      if (res[2] == null)
        void r
          .set(userKey(tenant, uid), freshToken(), 'EX', USER_VERSION_TTL_S, 'NX')
          .catch(() => {})
      return null
    }
    const v = { n: String(res[0]), g: String(res[1]), u: String(res[2]) }
    observe(tenant, uid, v)
    return v
  } catch {
    counters.version_errors++
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function versionsFor(user: User): Promise<Versions | null> | null {
  const r = redis
  if (!r || (r.status !== undefined && r.status !== 'ready')) return null
  const tenant = tenantKey()
  const uid = String(user.id ?? '').toLowerCase()
  const now = Date.now()
  const memo = versionMemo.get(user)
  if (memo && memo.tenant === tenant && memo.uid === uid && now - memo.at < VERSION_REUSE_MS)
    return memo.p
  const p = readVersions(r, tenant, uid)
  versionMemo.set(user, { at: now, tenant, uid, p })
  return p
}

function principalKey(user: User, v: Versions): string {
  return [
    tenantKey(),
    kinds.get(user) ?? '-',
    String(user.id ?? ''),
    String(user.role ?? ''),
    user.api_key_scopes ? JSON.stringify(user.api_key_scopes) : '',
    user.api_key_scope_restrictions ? JSON.stringify(user.api_key_scope_restrictions) : '',
    user.api_key_sandbox ? '1' : '',
    v.n,
    v.g,
    v.u
  ].join('\u0000')
}

/** Handed to a compute: `degraded()` says the answer was built from a fallback (a read
 *  that failed and was papered over) and must not be kept. */
export interface AccessCompute {
  degraded(): void
}
const NO_STORE: AccessCompute = { degraded() {} }

/**
 * Answer one permission question for one principal: from the cache when an
 * entry exists under the current versions and inside the TTL, else from
 * `compute` (stored when nothing moved while it ran and it was not degraded).
 * `clone` keeps callers from mutating what is stored.
 */
export async function cachedAccess<T>(
  user: User,
  op: string,
  question: string,
  compute: (ctx: AccessCompute) => Promise<T>,
  clone: (v: T) => T
): Promise<T> {
  if (!enabled) return compute(NO_STORE)
  const pending = versionsFor(user)
  const versions = pending ? await pending : null
  if (!versions) {
    counters.bypassed++
    return compute(NO_STORE)
  }
  const key = `${principalKey(user, versions)}\u0001${op}\u0001${question}`
  const now = Date.now()
  const hit = entries.get(key)
  if (hit) {
    entries.delete(key)
    if (now - hit.at < PERMISSION_CACHE_TTL_MS) {
      entries.set(key, hit)
      counters.hits++
      return clone(hit.v as T)
    }
  }
  counters.misses++
  const gen = generation
  const uid = String(user.id ?? '').toLowerCase()
  const ugen = userGeneration.get(uid) ?? 0
  let degraded = false
  const value = await compute({
    degraded() {
      degraded = true
    }
  })
  if (gen === generation && ugen === (userGeneration.get(uid) ?? 0) && enabled && !degraded) {
    if (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
    entries.set(key, { at: now, v: clone(value) })
    counters.stores++
  } else {
    counters.dropped++
  }
  return value
}

// ── write side ───────────────────────────────────────────────────────────────

/** Move the cluster-wide access version (and clear this process's entries). */
export function bumpAccessVersion(): void {
  if (!enabled) return
  counters.bumps++
  resetLocal(undefined, true)
  const r = redis
  if (!r) return
  void r.set(globalKey(tenantKey()), freshToken()).catch(() => {
    counters.version_errors++
  })
}

/** Move one person's access version (API key, View-as, scope assignment changes). */
export function bumpUserAccessVersion(userId: string | number | null | undefined): void {
  if (!enabled) return
  if (userId == null || userId === '') {
    bumpAccessVersion()
    return
  }
  counters.user_bumps++
  const uid = String(userId).toLowerCase()
  resetLocal(uid, true)
  const r = redis
  if (!r) return
  const key = userKey(tenantKey(), uid)
  void r.set(key, freshToken(), 'EX', USER_VERSION_TTL_S).catch(() => {
    counters.version_errors++
  })
}

const ACCESS_TABLES = [
  'nivaro_roles',
  'nivaro_policies',
  'nivaro_user_scopes',
  'nivaro_scope_dimensions',
  'nivaro_relations',
  'nivaro_fields',
  'nivaro_collections',
  'nivaro_tree_permissions'
]
const ACCESS_RE = new RegExp(`\\b(?:${ACCESS_TABLES.join('|')})\\b`, 'i')
/** Anything in a statement that is not a plain read. */
const MUTATING_RE =
  /\b(?:insert|update|delete|merge|truncate|drop|alter|create|exec|execute|into|grant|revoke)\b/i
/** Table / view DDL changes the scope routes (they read which tables exist); scratch tables
 *  (#x, ##x) do not. So does SELECT … INTO a real table. */
const TABLE_DDL_RE =
  /\b(?:create|alter|drop)\s+(?:or\s+alter\s+)?(?:table|view)\s+(?!(?:if\s+(?:not\s+)?exists\s+)?\[?#)|\bsp_rename\b|\bselect\b[^;]*?\binto\s+(?!\[?#)[\w.[\]"]+\s+from\b/i
const PROC_DDL_RE = /\b(?:create|alter|drop)\s+(?:or\s+alter\s+)?proc(?:edure)?\b/i
/** `exec name`, `exec @rc = name`, `execute name`; `exec (@sql)` / `exec ('…')` is dynamic. */
const EXEC_RE = /\bexec(?:ute)?(?:\s*(\()|\s+(?:@\w+\s*=\s*)?([\w.[\]"#@]+))/gi

/** Comments and string literals removed, so neither can make or hide a write. */
function strip(sql: string): string {
  // One pass, left to right: whichever starts first wins, so a quote inside a comment, a
  // comment marker inside a string and either inside a [bracketed] or "quoted" name are
  // all read as what they are. Names are kept; strings become '' and comments a space.
  return sql.replace(
    /\[[^\]]*\]?|"[^"]*"?|N?'(?:[^']|'')*'?|\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*/gi,
    (m) => {
      if (m.startsWith('[') || m.startsWith('"')) return m
      return m.startsWith('/*') || m.startsWith('--') ? ' ' : "''"
    }
  )
}

/** The SQL texts handed to sp_executesql / sp_sqlexec as literals, unescaped. */
function dynamicLiterals(sql: string): string[] {
  const out: string[] = []
  for (const m of sql.matchAll(/\bsp_(?:executesql|sqlexec)\s+N?'((?:[^']|'')*)'/gi))
    out.push(m[1].replace(/''/g, "'"))
  return out
}

/** System procedures that never write data (everything else named sp_… is looked up). */
const READ_ONLY_SYSTEM_PROCS = new Set([
  'sp_getapplock',
  'sp_releaseapplock',
  'sp_set_session_context',
  'sp_spaceused',
  'sp_who',
  'sp_who2',
  'sp_lock',
  'sp_help',
  'sp_helptext',
  'sp_helpindex',
  'sp_columns',
  'sp_tables',
  'sp_describe_first_result_set',
  'sp_describe_undeclared_parameters',
  'sp_refreshview',
  'sp_recompile',
  'sp_prepare',
  'sp_unprepare',
  'sp_reset_connection'
])

export type StatementVerdict = { bump: boolean; procs: string[] }

/** Exported for tests: what a statement does to the access inputs. `bump` = it may change
 *  them; `procs` = stored procedures it runs (their bodies decide). */
const verdictMemo = new Map<string, StatementVerdict>()

export function classifyStatement(sql: string): StatementVerdict {
  if (!sql) return { bump: false, procs: [] }
  // The seam, the transaction's own event and the after-statement call all ask about the
  // same text: it is read once.
  const memo = verdictMemo.get(sql)
  if (memo) return memo
  const verdict = classifyText(sql, 0)
  if (sql.length <= 20_000) {
    if (verdictMemo.size >= 500) verdictMemo.clear()
    verdictMemo.set(sql, verdict)
  }
  return verdict
}

function classifyText(sql: string, depth: number): StatementVerdict {
  const none: StatementVerdict = { bump: false, procs: [] }
  if (!sql) return none
  const code = strip(sql)
  if (TABLE_DDL_RE.test(code)) return { bump: true, procs: [] }
  // Filling a scratch table (#x) is not a write to anything that feeds access.
  const mutating = MUTATING_RE.test(code.replace(/\binto\s+\[?#/gi, ' '))
  // A write (or anything not a plain read) that names an access table. The raw text is
  // tested so a name inside dynamic SQL (sp_executesql N'update nivaro_roles …') counts.
  if (mutating && ACCESS_RE.test(sql)) return { bump: true, procs: [] }
  if (!mutating) return none
  const procs: string[] = []
  for (const m of code.matchAll(EXEC_RE)) {
    const target = m[1] ?? m[2] ?? ''
    // Dynamic SQL built in a variable: what it runs cannot be read here.
    if (target === '(' || target.startsWith('@')) return { bump: true, procs: [] }
    const name = target.replace(/[[\]"]/g, '').toLowerCase()
    const leaf = name.split('.').pop() ?? name
    if (leaf === 'sp_executesql' || leaf === 'sp_sqlexec') {
      // SQL held in a variable is unknown; a literal is read like any other batch.
      const rest = code.slice((m.index ?? 0) + m[0].length)
      if (!/^\s*''/.test(rest)) return { bump: true, procs: [] }
      continue
    }
    if (READ_ONLY_SYSTEM_PROCS.has(leaf)) continue
    procs.push(name)
  }
  for (const inner of dynamicLiterals(sql)) {
    if (depth >= 3) return { bump: true, procs: [] }
    const v = classifyText(inner, depth + 1)
    if (v.bump) return v
    procs.push(...v.procs)
  }
  return { bump: false, procs }
}

/** Exported for tests: the verdict as a yes/no (a procedure counts as "may change"). */
export function isAccessWrite(sql: string): boolean {
  const v = classifyStatement(sql)
  return v.bump || v.procs.length > 0
}

// Stored procedures: a body that names an access table, runs another procedure, runs
// dynamic SQL or changes tables may change access; one that does none of those cannot.
// Not known yet = may (the version moves, and the body is looked up for next time).
let procLookup: ((name: string) => Promise<string | null>) | null = null
const procTouches = new Map<string, { at: number; touches: boolean }>()
const procPending = new Set<string>()
/** Moves on every procedure DDL this process sees: a lookup that straddled one is dropped. */
let procGeneration = 0

/** server.ts hands over a reader for procedure bodies (OBJECT_DEFINITION). */
export function setPermissionCacheProcLookup(
  fn: ((name: string) => Promise<string | null>) | null
): void {
  procLookup = fn
}

/** Exported for tests. */
export function bodyTouchesAccess(body: string | null): boolean {
  if (body == null) return true
  const code = strip(body)
  return ACCESS_RE.test(body) || /\bexec(?:ute)?\b/i.test(code) || TABLE_DDL_RE.test(code)
}

function forgetProcedureVerdicts(): void {
  procTouches.clear()
  procGeneration++
}

function lookUpProcedure(name: string, previous: boolean | undefined): void {
  const lookup = procLookup
  if (!lookup || procPending.has(name)) return
  procPending.add(name)
  const g0 = procGeneration
  const at = Date.now()
  void lookup(name)
    .then((body) => {
      if (g0 !== procGeneration) return
      if (procTouches.size >= 2_000) procTouches.clear()
      const touches = bodyTouchesAccess(body)
      procTouches.set(name, { at, touches })
      // A body that now touches access was altered somewhere this process did not see:
      // what ran under the old verdict may have changed access.
      if (previous === false && touches) bumpAccessVersion()
    })
    .catch(() => {})
    .finally(() => procPending.delete(name))
}

/** Verdicts survive ordinary resets; they are dropped on procedure DDL here, by the cache
 *  console and by a configuration-epoch move. A verdict older than an entry is still used
 *  while it is read again in the background. Unknown = may change access. */
function procMayChangeAccess(name: string): boolean {
  const known = procTouches.get(name)
  if (known) {
    if (Date.now() - known.at >= PERMISSION_CACHE_TTL_MS) lookUpProcedure(name, known.touches)
    return known.touches
  }
  lookUpProcedure(name, undefined)
  return true
}

let trailing: NodeJS.Timeout[] = []
function scheduleTrailing(): void {
  for (const t of trailing) clearTimeout(t)
  trailing = TRAILING_MS.map((ms) => {
    const t = setTimeout(() => bumpAccessVersion(), ms)
    t.unref?.()
    return t
  })
}

/** Transactions (knex txid) that wrote an access input: the version moves again when they
 *  settle (see attachPermissionCacheCommitHook). */
const wroteAccess = new Set<string>()

/**
 * One statement as the driver (or runLongSql) sends it; `after` = it has answered. Only
 * while the cache is on: with it off nothing here runs.
 */
export function notePermissionStatement(sql: string, after: boolean, txId?: unknown): boolean {
  if (!enabled || !sql) return false
  if (PROC_DDL_RE.test(sql)) forgetProcedureVerdicts()
  const verdict = classifyStatement(sql)
  const bump = verdict.bump || verdict.procs.some((p) => procMayChangeAccess(p))
  if (!bump) return false
  bumpAccessVersion()
  if (!after && txId != null && txId !== '') {
    if (wroteAccess.size > 10_000) wroteAccess.clear()
    wroteAccess.add(String(txId))
    scheduleTrailing()
  }
  return true
}

type QueryEvent = { sql?: unknown; __knexTxId?: unknown }
type EmitterLike = { on: (ev: string, fn: (...a: unknown[]) => void) => unknown }
const attached = new WeakSet<object>()

/** Hear access writes on one knex client (`knex.client`). Safe to call twice. */
export function attachPermissionCacheSeam(client: EmitterLike | null | undefined): void {
  if (CLOUD || !client || typeof client.on !== 'function' || attached.has(client)) return
  attached.add(client)
  const seen = (q: unknown, after: boolean) => {
    const ev = q as QueryEvent | null
    if (typeof ev?.sql === 'string') notePermissionStatement(ev.sql, after, ev.__knexTxId)
  }
  client.on('query', (q: unknown) => seen(q, false))
  client.on('query-response', (_res: unknown, q: unknown) => seen(q, true))
  client.on('query-error', (_err: unknown, q: unknown) => seen(q, true))
}

type TrxLike = {
  txid?: unknown
  outerTx?: { txid?: unknown } | null
  then?: unknown
  on?: (ev: string, fn: (q: unknown) => void) => unknown
}
type TransactionFn = (...a: unknown[]) => unknown
const COMMIT_HOOK = Symbol.for('nivaro.permissionCacheCommitHook')

/**
 * A commit has no driver event (tedious commits out of band), so the version moves when
 * the transaction itself settles — committed, or rolled back (a harmless move). A
 * savepoint hands its mark to the transaction around it. Patched on the dialect client's
 * prototype, which every transaction client (nested ones too) shares.
 */
export function attachPermissionCacheCommitHook(client: object | null | undefined): void {
  if (CLOUD || !client) return
  const proto = Object.getPrototypeOf(client) as Record<string | symbol, unknown> | null
  if (!proto || proto[COMMIT_HOOK] || typeof proto.transaction !== 'function') return
  proto[COMMIT_HOOK] = true
  const original = proto.transaction as TransactionFn
  proto.transaction = function patched(this: unknown, ...args: unknown[]) {
    const trx = original.apply(this, args) as TrxLike
    try {
      watchTransaction(trx)
    } catch {
      /* never in the way of a transaction */
    }
    return trx
  }
}

function watchTransaction(trx: TrxLike | null | undefined): void {
  const txid = trx?.txid
  if (!trx || txid == null || typeof trx.then !== 'function') return
  // The Transaction re-emits every statement its client runs (savepoints included); knex
  // drops __knexTxId from the connection when a savepoint ends, so this is what attributes
  // the outer transaction's later statements.
  if (typeof trx.on === 'function') {
    trx.on('query', (q: unknown) => {
      const sql = (q as QueryEvent | null)?.sql
      if (!enabled || typeof sql !== 'string') return
      const v = classifyStatement(sql)
      if (v.bump || v.procs.some((p) => procMayChangeAccess(p))) {
        if (wroteAccess.size > 10_000) wroteAccess.clear()
        wroteAccess.add(String(txid))
      }
    })
  }
  const settled = () => {
    if (!wroteAccess.delete(String(txid))) return
    const outer = trx.outerTx?.txid
    if (outer != null) wroteAccess.add(String(outer))
    else bumpAccessVersion()
  }
  ;(trx.then as (a: () => void, b: () => void) => unknown).call(trx, settled, settled)
}

/** Exported for tests: forget everything (versions seen, entries, trailing timers). */
export function resetPermissionCacheForTests(): void {
  for (const t of trailing) clearTimeout(t)
  trailing = []
  seenGlobal.clear()
  seenUser.clear()
  wroteAccess.clear()
  procTouches.clear()
  procPending.clear()
  verdictMemo.clear()
  userGeneration.clear()
  lastNonceReset.clear()
  resetLocal(undefined, false)
  for (const k of Object.keys(counters) as Array<keyof typeof counters>) counters[k] = 0
}
