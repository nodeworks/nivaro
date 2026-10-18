// api/src/services/traffic-actions/temp-cache.ts
/**
 * Temporary cache on a hot read route (#2273). From a collection's node an admin switches on a
 * short server-side cache for N minutes (at most 15): identical reads by the SAME caller within a
 * few seconds are answered from memory. It switches itself off.
 *
 * Correctness / security rules (each has a test):
 *  - Only GET routes on CACHEABLE_ROUTES (list, one record, aggregate, distinct) of an ordinary
 *    collection (lane `items`, never a system table): their answer depends only on who asks, what
 *    they ask and the collection's data.
 *  - The key is store (tenant) + the caller's whole identity (auth method, user, role, admin flag,
 *    API key, run-as-key, masquerading admin, workspace) + route + path params + the normalised
 *    query. An entry is NEVER shared between callers; an anonymous request is never cached.
 *  - Writes bust it: any write to the collection, or to a collection related to it (one hop, both
 *    directions, junctions included), invalidates its entries on this process at once (the write
 *    path is synchronous) and on every other replica when the record event reaches it. A query
 *    that traverses relations (a `.` or `$` anywhere in its parameters, a nested filter, `deep`)
 *    is invalidated by ANY write. The epoch is captured BEFORE the read runs, so a write during
 *    the read discards the answer.
 *  - Access changes bust EVERY entry: a configuration write (policies, roles, User Scopes, tree
 *    permissions… — the driver seam's config epoch, here and on other processes), an owner-seat
 *    write (owner signal), a record event on a system table, a cache-console bust.
 *  - Only a 200 JSON string/Buffer is kept, and only when the one cookie it sets is the rolling
 *    session's (never kept: a hit passes through the session's own onSend, which sets it again);
 *    `Cache-Control: no-cache` from the caller always bypasses. Entries live ≤ entry seconds
 *    (default 30, max 300), ≤ 256 KB each, ≤ 32 MB per process; when the rule ends its entries go.
 *    At most MAX_LIVE caches are on at once.
 * Not seen by the bust: raw SQL writes outside the items service (procedures, rollup recalcs) —
 * those can be stale for at most the entry seconds. The admin is told so before switching it on.
 *
 * The rule is a timed rule (Redis; every replica honours it). Entries are per process memory.
 * Hit and miss counts go to Redis (one HINCRBY per cacheable request, only while a rule is on) so
 * the live hit rate covers every replica. With no rule on, the request path is a size check.
 */
import { createHash, randomUUID } from 'node:crypto'
import { SESSION_COOKIE } from '../../auth/session.js'
import { logActivity } from '../activity.js'
import { currentStoreId, DEFAULT_STORE, tenantStoreId } from '../traffic-taps.js'
import {
  activeRules,
  clearRule,
  onRuleEnded,
  onRulesChanged,
  setRule,
  type TimedRule,
  timedRulesAvailable
} from './timed-rules.js'

export const CACHE_MAX_MIN = 15
export const CACHE_DEFAULT_MIN = 10
export const ENTRY_S_DEFAULT = 30
export const ENTRY_S_MAX = 300
export const ENTRY_MAX_BYTES = 256 * 1024
export const TOTAL_MAX_BYTES = 32 * 1024 * 1024
export const CACHE_HEADER = 'x-nivaro-temp-cache'
export const STATS_PREFIX = 'nvr:tm:cache:stats:'
/** Temporary caches on at once (every collection). */
export const MAX_LIVE = 10
/** A bust for an access change is repeated this long after it, for the write to have landed. */
const TRAILING_BUST_MS = 3000

/** Read routes whose answer depends only on (caller, path params, query, collection data). */
export const CACHEABLE_ROUTES = new Set([
  '/api/items/:collection',
  '/api/items/:collection/:id',
  '/api/items/:collection/aggregate',
  '/api/items/:collection/distinct'
])

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** Never cached: system tables (credential stripping, directory columns) and route-only tables. */
const NEVER = /^(nivaro_|directus_|chat_messages$|chat_last_read$)/i
const SYSTEM_TABLE = /^(nivaro_|directus_)/i

/** `items/<collection>` a temporary cache may be switched on for; null when it may not. */
export function cacheableCollection(target: string): string | null {
  const m = target.match(/^items\/([A-Za-z_][A-Za-z0-9_]{0,127})$/)
  if (!m) return null
  return NEVER.test(m[1]) ? null : m[1]
}

export interface CacheIdentitySource {
  authMethod?: string
  user?: {
    id?: string | null
    role?: string | null
    api_key_scope_restrictions?: unknown
    api_key_sandbox?: boolean
  } | null
  isAdmin?: boolean
  apiKeyId?: number | null
  apiKeyScopes?: unknown
  apiKeySimulatedId?: number | null
  masqueradeAdminId?: string | null
  workspaceId?: string | null
}

/** Everything about the caller an answer may depend on; null = never cache (no signed-in caller). */
export function identityKey(r: CacheIdentitySource): string | null {
  const uid = r.user?.id
  if (!uid) return null
  // An API key's scopes are read fresh on every request: an edit to them changes the key at once.
  const keyScope =
    r.apiKeyScopes != null || r.user?.api_key_scope_restrictions != null || r.user?.api_key_sandbox
      ? createHash('sha1')
          .update(
            JSON.stringify([
              r.apiKeyScopes ?? null,
              r.user?.api_key_scope_restrictions ?? null,
              !!r.user?.api_key_sandbox
            ])
          )
          .digest('hex')
      : ''
  return [
    `a=${r.authMethod ?? ''}`,
    `u=${String(uid).toUpperCase()}`,
    `r=${r.user?.role ?? ''}`,
    `x=${r.isAdmin ? 1 : 0}`,
    `k=${r.apiKeyId ?? ''}`,
    `s=${r.apiKeySimulatedId ?? ''}`,
    `m=${r.masqueradeAdminId ?? ''}`,
    `w=${r.workspaceId ?? ''}`,
    `p=${keyScope}`
  ].join('|')
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortDeep((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/** The query (or params) with keys sorted at every depth — `?a=1&b=2` and `?b=2&a=1` agree. */
export function normalizeQuery(q: unknown): string {
  return JSON.stringify(sortDeep(q ?? {}))
}

const LOGICAL = new Set(['_and', '_or', '_not'])
const QUANTIFIERS = new Set(['_some', '_none'])

/** A filter that reaches through a relation: a field whose condition names another field
 *  (`{"tags":{"name":{"_eq":"x"}}}`) or a quantifier (`_some` / `_none`). */
function filterIsRelational(node: unknown, depth = 0): boolean {
  if (depth > 32 || !node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((n) => filterIsRelational(n, depth + 1))
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (LOGICAL.has(k)) {
      if (filterIsRelational(v, depth + 1)) return true
      continue
    }
    if (k.startsWith('_') || !v || typeof v !== 'object' || Array.isArray(v)) continue
    for (const ck of Object.keys(v as Record<string, unknown>))
      if (QUANTIFIERS.has(ck) || !ck.startsWith('_')) return true
  }
  return false
}

/** A query that reads through relations depends on other collections' data. */
export function isRelational(normalizedQuery: string): boolean {
  if (normalizedQuery.includes('.') || normalizedQuery.includes('$')) return true
  let q: Record<string, unknown>
  try {
    q = JSON.parse(normalizedQuery) as Record<string, unknown>
  } catch {
    return true // unreadable: assume the widest dependency
  }
  if (!q || typeof q !== 'object') return false
  if (q.deep != null || q.alias != null) return true
  let filter = q.filter
  if (typeof filter === 'string') {
    try {
      filter = JSON.parse(filter)
    } catch {
      return false // the route refuses it
    }
  }
  return filterIsRelational(filter)
}

export function cacheKey(parts: {
  store: string
  identity: string
  route: string
  params: string
  query: string
}): string {
  return createHash('sha256')
    .update([parts.store, parts.identity, parts.route, parts.params, parts.query].join('\u0000'))
    .digest('hex')
}

// ── state (per process; keyed by store inside) ───────────────────────────────
interface Entry {
  body: string | Buffer
  contentType: string
  expires: number
  ruleId: string
  /** Epochs the answer was read under (captured before the read). */
  deps: Array<[string, number]>
  bytes: number
}
const entries = new Map<string, Entry>()
let totalBytes = 0
/** `<store>|<collection>` → epoch; `<store>|*` → any-write epoch; ALL → access epoch (every
 *  entry depends on it). */
const epochs = new Map<string, number>()
const local = new Map<string, { hit: number; miss: number; bypass: number; stored: number }>()
const ALL = '#all'
let trailing: NodeJS.Timeout | null = null

function epochOf(k: string): number {
  return epochs.get(k) ?? 0
}

function drop(key: string): void {
  const e = entries.get(key)
  if (!e) return
  entries.delete(key)
  totalBytes -= e.bytes
}

function localStats(ruleId: string) {
  let s = local.get(ruleId)
  if (!s) {
    s = { hit: 0, miss: 0, bypass: 0, stored: 0 }
    local.set(ruleId, s)
  }
  return s
}

interface StatsRedis {
  hincrby(key: string, field: string, n: number): Promise<unknown>
  expire(key: string, s: number): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
}
let statsRedis: StatsRedis | null = null
export function setTempCacheRedis(r: StatsRedis | null | undefined): void {
  statsRedis = r ?? null
}

function count(rule: TimedRule, field: 'hit' | 'miss' | 'bypass' | 'stored'): void {
  localStats(rule.id)[field]++
  if (!statsRedis) return
  const key = `${STATS_PREFIX}${rule.id}`
  statsRedis.hincrby(key, field, 1).catch(() => {})
  if (field === 'miss') {
    const ttl = Math.max(60, Math.ceil((rule.until - Date.now()) / 1000) + 3600)
    statsRedis.expire(key, ttl).catch(() => {})
  }
}

/**
 * A write to `collection` (this process, synchronously, or a record event relayed from another
 * replica). `tenant` = the event's tenant ('' self-hosted).
 */
export function noteCollectionChanged(collection: string, tenant?: string): void {
  if (activeRules('cache').length === 0 && entries.size === 0) return
  // A system table (a role, a scope, an owner seat, a share…) may change who sees what.
  if (SYSTEM_TABLE.test(collection)) {
    bumpAll()
    return
  }
  const store = tenant ? tenantStoreId(tenant) : tenant === '' ? DEFAULT_STORE : currentStoreId()
  const s = store || DEFAULT_STORE
  epochs.set(`${s}|${collection}`, epochOf(`${s}|${collection}`) + 1)
  epochs.set(`${s}|*`, epochOf(`${s}|*`) + 1)
  if (epochs.size > 5000) {
    // Forgetting epochs would make old entries match again: they go with them, and the access
    // epoch (kept, then moved) discards every read still in flight.
    const all = epochOf(ALL)
    epochs.clear()
    entries.clear()
    totalBytes = 0
    epochs.set(ALL, all + 1)
  }
}

function bumpAll(): void {
  epochs.set(ALL, epochOf(ALL) + 1)
}

/**
 * Who may see what may have changed (a policy, role, User Scope, tree permission or owner seat —
 * writes that never reach the record events): every entry goes, now and again once the write has
 * landed (a read that raced it is not kept either).
 */
export function bustAllTempCache(): void {
  if (activeRules('cache').length === 0 && entries.size === 0) return
  bumpAll()
  if (trailing) return
  trailing = setTimeout(() => {
    trailing = null
    bumpAll()
  }, TRAILING_BUST_MS)
  trailing.unref?.()
}

/** True while any temporary cache is on (other replicas relay record events only then). */
export function tempCacheActive(): boolean {
  return activeRules('cache').length > 0
}

// Entries of rules that ended go with them.
onRulesChanged(() => {
  const live = new Set(activeRules('cache').map((r) => r.id))
  for (const [k, e] of entries) if (!live.has(e.ruleId)) drop(k)
})

const PENDING = Symbol.for('nvr.tm.tempCache')
interface Pending {
  key: string
  rule: TimedRule
  deps: Array<[string, number]>
}

interface ReqLike extends CacheIdentitySource {
  method: string
  headers: Record<string, unknown>
  params?: unknown
  query?: unknown
  routeOptions?: { url?: string }
}
interface ReplyLike {
  code(n: number): ReplyLike
  header(k: string, v: string): ReplyLike
  getHeader(k: string): unknown
  send(body: unknown): unknown
  statusCode: number
}

/** The cache rule a request falls under (no I/O); null when none. */
export function ruleFor(req: ReqLike, rules = activeRules('cache')): TimedRule | null {
  if (rules.length === 0 || req.method !== 'GET') return null
  const route = req.routeOptions?.url
  if (!route || !CACHEABLE_ROUTES.has(route)) return null
  const collection = (req.params as { collection?: unknown } | undefined)?.collection
  if (typeof collection !== 'string' || !COLLECTION_RE.test(collection)) return null
  const target = `items/${collection}`
  return rules.find((r) => r.target === target) ?? null
}

/** The epochs an answer to this request depends on (the collection, its relations, or any). */
export function depsFor(store: string, rule: TimedRule, query: string): Array<[string, number]> {
  const all: [string, number] = [ALL, epochOf(ALL)]
  if (isRelational(query)) return [all, [`${store}|*`, epochOf(`${store}|*`)]]
  const cols = [
    rule.target.slice('items/'.length),
    ...((rule.opts?.related as string[] | undefined) ?? []).filter((c) => COLLECTION_RE.test(c))
  ]
  return [
    all,
    ...[...new Set(cols)].map((c): [string, number] => [`${store}|${c}`, epochOf(`${store}|${c}`)])
  ]
}

function noCache(headers: Record<string, unknown>): boolean {
  const cc = String(headers['cache-control'] ?? '').toLowerCase()
  const pragma = String(headers.pragma ?? '').toLowerCase()
  return cc.includes('no-cache') || cc.includes('no-store') || pragma.includes('no-cache')
}

/**
 * preHandler on the items routes, AFTER authenticate + workspace + every guard. Answers a hit
 * (returns true) or notes what the response must be stored under.
 */
export function tempCacheLookup(req: ReqLike, reply: ReplyLike, now = Date.now()): boolean {
  try {
    return lookupEntry(req, reply, now)
  } catch {
    return false // a cache fault never changes the answer: the route runs
  }
}

function lookupEntry(req: ReqLike, reply: ReplyLike, now: number): boolean {
  const rule = ruleFor(req)
  if (!rule) return false
  if (noCache(req.headers)) {
    count(rule, 'bypass')
    return false
  }
  const identity = identityKey(req)
  if (!identity) return false
  const store = currentStoreId() || DEFAULT_STORE
  const query = normalizeQuery(req.query)
  const key = cacheKey({
    store,
    identity,
    route: req.routeOptions?.url ?? '',
    params: normalizeQuery(req.params),
    query
  })
  const e = entries.get(key)
  if (e && e.ruleId === rule.id && e.expires > now && e.deps.every(([k, v]) => epochOf(k) === v)) {
    count(rule, 'hit')
    reply.header(CACHE_HEADER, 'hit').header('content-type', e.contentType).code(200).send(e.body)
    return true
  }
  if (e) drop(key)
  count(rule, 'miss')
  reply.header(CACHE_HEADER, 'miss')
  ;(req as unknown as Record<symbol, Pending>)[PENDING] = {
    key,
    rule,
    deps: depsFor(store, rule, query)
  }
  return false
}

/**
 * A Set-Cookie that only renews the session (`rolling: true` re-sends it on every response) says
 * nothing the identity in the key does not; any other cookie makes the answer unkeepable.
 */
export function onlySessionCookie(header: unknown): boolean {
  if (header == null || header === '') return true
  const list = Array.isArray(header) ? header : [header]
  return list.every((c) => String(c).trimStart().startsWith(`${SESSION_COOKIE}=`))
}

/** onSend on the items routes: keep a fresh 200 JSON answer under the key noted at lookup. */
export function tempCacheStore(req: object, reply: ReplyLike, payload: unknown, now = Date.now()) {
  try {
    keepEntry(req, reply, payload, now)
  } catch {
    /* not kept */
  }
}

function keepEntry(req: object, reply: ReplyLike, payload: unknown, now: number): void {
  const p = (req as Record<symbol, Pending | undefined>)[PENDING]
  if (!p) return
  ;(req as Record<symbol, Pending | undefined>)[PENDING] = undefined
  if (reply.statusCode !== 200) return
  // The cookie itself is never kept: only the body and its content type are.
  if (!onlySessionCookie(reply.getHeader('set-cookie'))) return
  const ct = String(reply.getHeader('content-type') ?? '')
  if (!ct.toLowerCase().includes('application/json')) return
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return
  const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length
  if (bytes > ENTRY_MAX_BYTES) return
  // The rule may have ended (or been replaced) while the read ran.
  const live = activeRules('cache', now).find((r) => r.id === p.rule.id)
  if (!live) return
  // A write during the read: the answer may predate it — do not keep it.
  if (!p.deps.every(([k, v]) => epochOf(k) === v)) return
  const entryS = Math.min(ENTRY_S_MAX, Math.max(1, Number(live.opts?.entry_s) || ENTRY_S_DEFAULT))
  drop(p.key)
  while (totalBytes + bytes > TOTAL_MAX_BYTES && entries.size > 0) {
    const oldest = entries.keys().next().value as string
    drop(oldest)
  }
  entries.set(p.key, {
    body: payload,
    contentType: ct,
    expires: Math.min(live.until, now + entryS * 1000),
    ruleId: live.id,
    deps: p.deps,
    bytes
  })
  totalBytes += bytes
  count(live, 'stored')
}

/**
 * The two hooks on the items routes (registered there, after every guard). Callback hooks: no
 * promise per request while no cache is on; a hit answers without calling done().
 */
export function registerTempCacheHooks(app: {
  addHook(name: 'preHandler', fn: (req: unknown, reply: unknown, done: () => void) => void): unknown
  addHook(
    name: 'onSend',
    fn: (
      req: unknown,
      reply: unknown,
      payload: unknown,
      done: (err: null, p: unknown) => void
    ) => void
  ): unknown
}): void {
  app.addHook('preHandler', (req, reply, done) => {
    if (!tempCacheLookup(req as ReqLike, reply as ReplyLike)) done()
  })
  app.addHook('onSend', (req, reply, payload, done) => {
    tempCacheStore(req as object, reply as ReplyLike, payload)
    done(null, payload)
  })
}

// ── admin side ───────────────────────────────────────────────────────────────
export class TempCacheError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 400
  ) {
    super(message)
  }
}

/**
 * Collections one hop from `collection` (either side of a relation, junction legs included), plus
 * the far side of each M2M / M2A through its junction (the junction's other leg).
 */
export function relatedCollections(
  collection: string,
  relations: Array<{
    many_collection: string
    one_collection: string | null
    one_allowed_collections?: string[] | null
    junction_field?: string | null
  }>
): string[] {
  const out = new Set<string>()
  const junctions = new Set<string>()
  for (const r of relations) {
    const sides = [r.many_collection, r.one_collection, ...(r.one_allowed_collections ?? [])]
    if (!sides.includes(collection)) continue
    for (const c of sides) if (c && c !== collection) out.add(c)
    if (r.junction_field && r.one_collection === collection && r.many_collection !== collection)
      junctions.add(r.many_collection)
  }
  for (const r of relations) {
    if (!junctions.has(r.many_collection)) continue
    for (const c of [r.one_collection, ...(r.one_allowed_collections ?? [])])
      if (c && c !== collection) out.add(c)
  }
  return [...out].slice(0, 200)
}

export async function startTempCache(opts: {
  target: string
  minutes?: number
  entrySeconds?: number
  user: {
    id?: string
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  }
  req?: Parameters<typeof logActivity>[0]['req']
  /** Injected for tests; defaults to the relation metadata. */
  loadRelations?: (collection: string) => Promise<Parameters<typeof relatedCollections>[1]>
}): Promise<TimedRule> {
  const collection = cacheableCollection(opts.target)
  if (!collection)
    throw new TempCacheError(
      'A temporary cache can only be switched on for an ordinary collection’s read routes',
      'CACHE_TARGET'
    )
  const minutes = Math.round(Number(opts.minutes ?? CACHE_DEFAULT_MIN))
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > CACHE_MAX_MIN)
    throw new TempCacheError(`minutes must be 1–${CACHE_MAX_MIN}`, 'CACHE_MINUTES')
  const entryS = Math.round(Number(opts.entrySeconds ?? ENTRY_S_DEFAULT))
  if (!Number.isFinite(entryS) || entryS < 1 || entryS > ENTRY_S_MAX)
    throw new TempCacheError(`entry seconds must be 1–${ENTRY_S_MAX}`, 'CACHE_ENTRY_S')
  if (!timedRulesAvailable())
    throw new TempCacheError(
      'A temporary cache needs Redis, which is not connected',
      'CACHE_UNAVAILABLE',
      503
    )
  const on = activeRules('cache')
  if (on.some((r) => r.target === opts.target))
    throw new TempCacheError('A temporary cache is already on for this collection', 'CACHE_ON', 409)
  if (on.length >= MAX_LIVE)
    throw new TempCacheError(
      `${MAX_LIVE} temporary caches are already on — switch one off first`,
      'CACHE_LIMIT',
      409
    )
  const load =
    opts.loadRelations ?? (async (c: string) => (await import('../collections.js')).getRelations(c))
  const related = relatedCollections(collection, await load(collection))
  const now = Date.now()
  const u = opts.user
  const rule: TimedRule = {
    kind: 'cache',
    id: randomUUID(),
    target: opts.target,
    until: now + minutes * 60_000,
    at: now,
    by: u.id ?? null,
    by_name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || null,
    opts: { entry_s: entryS, related }
  }
  await setRule(rule)
  await logActivity({
    action: 'traffic-map-temp-cache-on',
    user: u.id ?? null,
    collection: 'nivaro_api_logs',
    comment: `Temporary cache on ${collection} reads for ${minutes} min (answers kept ${entryS} s per caller)`,
    req: opts.req
  })
  return rule
}

export async function stopTempCache(id: string): Promise<boolean> {
  return !!(await clearRule('cache', id))
}

let wired = false
export function wireTempCache(): void {
  if (wired) return
  wired = true
  onRuleEnded('cache', async (rule, reason) => {
    const s = await tempCacheStats(rule)
    await logActivity({
      action: 'traffic-map-temp-cache-off',
      user: reason === 'stopped' ? rule.by : null,
      collection: 'nivaro_api_logs',
      comment: `Temporary cache on ${rule.target.slice('items/'.length)} ${reason === 'stopped' ? 'switched off early' : 'ended'}: ${s.hit} hits, ${s.miss} misses`,
      origin: reason === 'stopped' ? 'person' : 'machine'
    })
  })
}

export interface TempCacheStats {
  hit: number
  miss: number
  bypass: number
  stored: number
  /** hit / (hit + miss); null before any cacheable read. */
  rate: number | null
  /** Across every replica (Redis) or this process only. */
  scope: 'cluster' | 'process'
}

export async function tempCacheStats(rule: TimedRule): Promise<TempCacheStats> {
  let s = { ...localStats(rule.id) }
  let scope: TempCacheStats['scope'] = 'process'
  if (statsRedis) {
    try {
      const raw = await statsRedis.hgetall(`${STATS_PREFIX}${rule.id}`)
      if (raw && Object.keys(raw).length) {
        s = {
          hit: Number(raw.hit) || 0,
          miss: Number(raw.miss) || 0,
          bypass: Number(raw.bypass) || 0,
          stored: Number(raw.stored) || 0
        }
      }
      scope = 'cluster'
    } catch {
      /* this process's own counts */
    }
  }
  const seen = s.hit + s.miss
  return { ...s, rate: seen ? s.hit / seen : null, scope }
}

export async function tempCaches() {
  const rules = activeRules('cache')
  const out = []
  for (const r of rules) {
    let held = 0
    for (const e of entries.values()) if (e.ruleId === r.id) held++
    out.push({
      id: r.id,
      target: r.target,
      collection: r.target.slice('items/'.length),
      until: r.until,
      at: r.at,
      by_name: r.by_name,
      entry_s: Number(r.opts?.entry_s) || ENTRY_S_DEFAULT,
      related: ((r.opts?.related as string[] | undefined) ?? []).length,
      entries_here: held,
      stats: await tempCacheStats(r)
    })
  }
  return out
}

/** Test hook. */
export function resetTempCache(): void {
  if (trailing) clearTimeout(trailing)
  trailing = null
  entries.clear()
  totalBytes = 0
  epochs.clear()
  local.clear()
  statsRedis = null
}
export function tempCacheSize(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: totalBytes }
}
