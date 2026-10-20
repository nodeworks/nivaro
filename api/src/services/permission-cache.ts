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
 * while both versions are unchanged, and never past the hard TTL
 * (PERMISSION_CACHE_TTL_MS, default 30 s, at most 60 s). The versions are
 * Redis counters read once per request (one MGET, reused for at most 1 s on
 * the same user object); when Redis is not ready or slow, the cache is
 * skipped and the answer is built as before — denial and allow alike, there
 * is no separate path for either.
 *
 * What moves the versions:
 *  - every statement through this process's knex pools that writes an access
 *    table (roles, policies, user scopes, scope dimensions, relations, fields,
 *    collections, tree permissions) or alters one — at the driver seam, before
 *    and after the statement, plus trailing moves 1 s / 5 s / 15 s after a
 *    write made inside a transaction (the commit has no driver event);
 *  - explicit calls after API key, masquerade and transactional role writes;
 *  - the configuration epoch (db/config-epoch.ts) clears this cache through
 *    the cache registry when another process — a script, a process on
 *    another Redis — wrote configuration.
 * A raw-SQL writer outside the app (SSMS, a stored procedure) moves none of
 * them: the hard TTL is the backstop.
 *
 * Off: every call goes straight to the uncached code (same statements, same
 * order). The write side still moves the Redis counter, so a fleet where only
 * some replicas have the cache on stays correct.
 *
 * Cloud mode: always off (tenant pools have no driver seam).
 */
import { getTenantId } from '../db/tenant-context.js'
import type { User } from '../types.js'

export interface PermissionCacheRedis {
  status?: string
  mget(...keys: string[]): Promise<Array<string | null>>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
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

export function setPermissionCacheRedis(r: PermissionCacheRedis | null): void {
  redis = CLOUD ? null : r
}

export function permissionCacheEnabled(): boolean {
  return enabled
}

/** Tests and the equivalence harness switch the cache at run time. */
export function setPermissionCacheEnabled(on: boolean): void {
  enabled = on && !CLOUD
  resetLocal(undefined, false)
}

// ── state ────────────────────────────────────────────────────────────────────

type Entry = { at: number; v: unknown }
const entries = new Map<string, Entry>()
let generation = 0
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
  g: string
  u: string
}

/** Caches the entries are built from (user scope rows, dimensions, driver reads) register a
 *  bust here; it runs when a version move from another process is seen, so a refill never
 *  reads a copy older than the move. Only while the cache is on. */
export function onPermissionCacheReset(fn: (userId?: string) => void): void {
  resetListeners.add(fn)
}

function resetLocal(userId: string | undefined, listeners: boolean): void {
  entries.clear()
  generation++
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

/** The cache registry's bust (cache console, configuration epoch). */
export function clearPermissionCache(): void {
  resetLocal(undefined, false)
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
function globalKey(tenant: string): string {
  return tenant ? `${KEY}:t:${tenant}:g` : `${KEY}:g`
}
function userKey(tenant: string, uid: string): string {
  return tenant ? `${KEY}:t:${tenant}:u:${uid}` : `${KEY}:u:${uid}`
}

function observe(tenant: string, uid: string, v: Versions): void {
  const g = seenGlobal.get(tenant)
  seenGlobal.set(tenant, v.g)
  if (g !== undefined && g !== v.g) {
    resetLocal(undefined, true)
    return
  }
  const uk = `${tenant}\u0000${uid}`
  const u = seenUser.get(uk)
  if (seenUser.size > 50_000) seenUser.clear()
  seenUser.set(uk, v.u)
  if (u !== undefined && u !== v.u) resetLocal(uid, true)
}

async function readVersions(
  r: PermissionCacheRedis,
  tenant: string,
  uid: string
): Promise<Versions | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const res = await Promise.race([
      r.mget(globalKey(tenant), userKey(tenant, uid)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), VERSION_TIMEOUT_MS)
        timer.unref?.()
      })
    ])
    if (!Array.isArray(res)) {
      counters.version_errors++
      return null
    }
    const v = { g: String(res[0] ?? '0'), u: String(res[1] ?? '0') }
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
    v.g,
    v.u
  ].join('\u0000')
}

/**
 * Answer one permission question for one principal: from the cache when an
 * entry exists under the current versions and inside the TTL, else from
 * `compute` (stored when nothing moved while it ran). `clone` keeps callers
 * from mutating what is stored.
 */
export async function cachedAccess<T>(
  user: User,
  op: string,
  question: string,
  compute: () => Promise<T>,
  clone: (v: T) => T
): Promise<T> {
  if (!enabled) return compute()
  const pending = versionsFor(user)
  const versions = pending ? await pending : null
  if (!versions) {
    counters.bypassed++
    return compute()
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
  const value = await compute()
  if (gen === generation && enabled) {
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
  counters.bumps++
  if (enabled) resetLocal(undefined, true)
  const r = redis
  if (!r) return
  void r.incr(globalKey(tenantKey())).catch(() => {
    counters.version_errors++
  })
}

/** Move one person's access version (API key, View-as, scope assignment changes). */
export function bumpUserAccessVersion(userId: string | number | null | undefined): void {
  if (userId == null || userId === '') {
    bumpAccessVersion()
    return
  }
  counters.user_bumps++
  const uid = String(userId).toLowerCase()
  if (enabled) resetLocal(uid, true)
  const r = redis
  if (!r) return
  const key = userKey(tenantKey(), uid)
  void r
    .incr(key)
    .then(() => r.expire(key, USER_VERSION_TTL_S))
    .catch(() => {
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
const TOP = String.raw`(?:top\s*\(\s*\d+\s*\)\s*)?`
const WRITE_RE = new RegExp(
  String.raw`\b(?:insert\s+(?:into\s+)?[\w.#@]|update\s+${TOP}[\w.#@]+\s+set\b|delete\s+${TOP}(?:from\s+)?[\w.#@]|merge\s+${TOP}(?:into\s+)?[\w.#@]|truncate\s+table\b)`,
  'i'
)
const DDL_RE = /^\s*(?:alter|create|drop|truncate)\b|\bsp_rename\b/i

/** Exported for tests: can this statement change what the permission layer answers?
 *  A write naming an access table, or DDL on one (scratch tables and other schema work
 *  change no policy, scope or relation row). */
export function isAccessWrite(sql: string): boolean {
  if (!sql) return false
  const flat = sql.replace(/[[\]"`]/g, '')
  if (!ACCESS_RE.test(flat)) return false
  return DDL_RE.test(flat) || WRITE_RE.test(flat)
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

type QueryEvent = { sql?: unknown; __knexTxId?: unknown }
type EmitterLike = { on: (ev: string, fn: (...a: unknown[]) => void) => unknown }
const attached = new WeakSet<object>()

/** Hear access writes on one knex client (`knex.client`). Safe to call twice. */
export function attachPermissionCacheSeam(client: EmitterLike | null | undefined): void {
  if (CLOUD || !client || typeof client.on !== 'function' || attached.has(client)) return
  attached.add(client)
  const seen = (q: unknown, after: boolean) => {
    const ev = q as QueryEvent | null
    const sql = typeof ev?.sql === 'string' ? ev.sql : ''
    if (!sql || !isAccessWrite(sql)) return
    bumpAccessVersion()
    // A statement inside a transaction lands at commit, which has no event.
    if (!after && ev?.__knexTxId) scheduleTrailing()
  }
  client.on('query', (q: unknown) => seen(q, false))
  client.on('query-response', (_res: unknown, q: unknown) => seen(q, true))
  client.on('query-error', (_err: unknown, q: unknown) => seen(q, true))
}

/** Exported for tests: forget everything (versions seen, entries, trailing timers). */
export function resetPermissionCacheForTests(): void {
  for (const t of trailing) clearTimeout(t)
  trailing = []
  seenGlobal.clear()
  seenUser.clear()
  resetLocal(undefined, false)
  for (const k of Object.keys(counters) as Array<keyof typeof counters>) counters[k] = 0
}
