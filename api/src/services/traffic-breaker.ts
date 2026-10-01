// api/src/services/traffic-breaker.ts
/**
 * Traffic Map circuit breaker (#1157): during an incident, temporarily refuse (503) or rate-limit
 * (429) one entity (`<lane>/<entity>`) or one caller (`k<keyId>` / `u<USERID>`), answering with
 * code TRAFFIC_BREAKER_OPEN. Every breaker expires on its own.
 *
 * Redis-backed so every replica honours it: breakers live in one hash (BREAKERS_KEY); each process
 * re-reads it every SYNC_MS (and at once after a change it made). The request path reads only
 * the in-process copy — with no breaker set it is a size check and nothing else. A limit counts
 * per minute in Redis (one INCR, only for requests a breaker matches). Redis down = breakers off
 * (fail open — a broken cache must never refuse traffic).
 *
 * Never broken: /api/auth, /api/traffic-map, /api/health, /api/version, /api/ready.
 */
import { classifyRequest, entityKey } from './traffic-entities.js'
import { matchExtensionRoute } from './traffic-map.js'

export const BREAKERS_KEY = 'nvr:tm:breakers'
export const BREAKER_CODE = 'TRAFFIC_BREAKER_OPEN'
const SYNC_MS = 3000
export const MAX_MINUTES = 24 * 60

export type BreakerKind = 'entity' | 'caller'
export type BreakerMode = 'refuse' | 'limit'
export interface Breaker {
  kind: BreakerKind
  /** `<lane>/<entity>` or a caller key. */
  target: string
  mode: BreakerMode
  /** Requests per minute allowed (limit mode), across every replica. */
  limit: number | null
  /** Epoch ms. */
  until: number
  reason: string
  by: string | null
  by_name: string | null
  /** Epoch ms. */
  at: number
}

export interface BreakerRedis {
  hgetall(key: string): Promise<Record<string, string>>
  hset(key: string, field: string, value: string): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, s: number): Promise<unknown>
}

let redis: BreakerRedis | null = null
let active = new Map<string, Breaker>()
let syncTimer: NodeJS.Timeout | null = null
let lastSync = 0

export function fieldOf(kind: BreakerKind, target: string): string {
  return `${kind}:${target}`
}

const EXEMPT = /^\/api\/(auth|traffic-map|health|version|ready)(\/|\?|$)/

/** Paths a breaker never touches. */
export function breakerExempt(url: string): boolean {
  return EXEMPT.test(url) || !url.startsWith('/api/')
}

function parse(raw: Record<string, string>, now: number): Map<string, Breaker> {
  const out = new Map<string, Breaker>()
  for (const [field, v] of Object.entries(raw ?? {})) {
    try {
      const b = JSON.parse(v) as Breaker
      if (
        b &&
        typeof b.until === 'number' &&
        b.until > now &&
        (b.kind === 'entity' || b.kind === 'caller')
      )
        out.set(field, b)
    } catch {
      /* a corrupt entry is ignored */
    }
  }
  return out
}

async function sync(): Promise<void> {
  if (!redis) return
  lastSync = Date.now()
  try {
    const raw = await redis.hgetall(BREAKERS_KEY)
    const now = Date.now()
    const next = parse(raw, now)
    // Expired entries leave the hash (any replica may do it; HDEL of a gone field is a no-op).
    const expired = Object.keys(raw ?? {}).filter((f) => !next.has(f))
    if (expired.length) await redis.hdel(BREAKERS_KEY, ...expired).catch(() => {})
    active = next
  } catch {
    active = new Map() // fail open
  }
}

/** Start syncing from Redis (idempotent). Called once at boot (plugins/rate-limit.ts). */
export function startBreakerSync(r: BreakerRedis | null | undefined): void {
  if (process.env.CLOUD_META_DB_URL || !r || syncTimer) return
  redis = r
  void sync()
  syncTimer = setInterval(() => void sync(), SYNC_MS)
  syncTimer.unref?.()
}
export function stopBreakerSync(): void {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = null
  redis = null
  active = new Map()
}
/** Test hook: set the in-process copy directly. */
export function setActiveBreakersForTest(list: Breaker[], r: BreakerRedis | null = null): void {
  active = new Map(list.map((b) => [fieldOf(b.kind, b.target), b]))
  redis = r
}

export function activeBreakers(): Breaker[] {
  const now = Date.now()
  return [...active.values()].filter((b) => b.until > now).sort((a, b) => a.until - b.until)
}

export interface BreakerVerdict {
  status: 429 | 503
  body: {
    error: string
    code: typeof BREAKER_CODE
    breaker: { kind: BreakerKind; target: string; mode: BreakerMode; until: string }
  }
  retryAfter: number
}

/** The breaker matching a request, if any (no I/O; the hot path). */
export function matchBreaker(kind: BreakerKind, target: string, now = Date.now()): Breaker | null {
  if (active.size === 0) return null
  const b = active.get(fieldOf(kind, target))
  return b && b.until > now ? b : null
}

/** Decide a matched breaker: refuse → 503; limit → INCR this minute's count, 429 when over. */
export async function judgeBreaker(b: Breaker, now = Date.now()): Promise<BreakerVerdict | null> {
  const until = new Date(b.until).toISOString()
  const who = b.kind === 'entity' ? 'this endpoint' : 'this caller'
  if (b.mode === 'refuse') {
    return {
      status: 503,
      retryAfter: Math.max(1, Math.ceil((b.until - now) / 1000)),
      body: {
        error: `Requests to ${who} are paused by an administrator until ${until}.`,
        code: BREAKER_CODE,
        breaker: { kind: b.kind, target: b.target, mode: b.mode, until }
      }
    }
  }
  if (!redis || !b.limit || b.limit <= 0) return null
  const minute = Math.floor(now / 60_000)
  let n: number
  try {
    const key = `nvr:tm:brk:${fieldOf(b.kind, b.target)}:${minute}`
    n = await redis.incr(key)
    if (n === 1) await redis.expire(key, 75)
  } catch {
    return null // fail open
  }
  if (n <= b.limit) return null
  return {
    status: 429,
    retryAfter: Math.max(1, 60 - Math.floor((now / 1000) % 60)),
    body: {
      error: `Requests to ${who} are limited to ${b.limit} a minute by an administrator until ${until}.`,
      code: BREAKER_CODE,
      breaker: { kind: b.kind, target: b.target, mode: b.mode, until }
    }
  }
}

/** The entity key a request lands on (before auth / GraphQL parsing — a graphql operation breaker
 *  cannot match here, only the lane-level entity the path names). */
export function entityOfRequest(method: string, url: string): string | null {
  const path = url.split('?')[0]
  let c = classifyRequest({ method, path })
  if (c?.lane === 'other') {
    const ext = matchExtensionRoute(method, path)
    if (ext) c = classifyRequest({ method, path, extensionId: ext })
  }
  return c ? entityKey(c.lane, c.entity) : null
}

interface ReplyLike {
  code(n: number): ReplyLike
  header(k: string, v: string): ReplyLike
  send(body: unknown): unknown
}

/** onRequest hook body: entity breakers. Returns true when it answered. */
export async function entityBreakerHook(
  req: { method: string; raw: { url?: string }; url: string },
  reply: ReplyLike
): Promise<boolean> {
  if (active.size === 0) return false
  const url = req.raw.url ?? req.url
  if (breakerExempt(url)) return false
  const key = entityOfRequest(req.method, url)
  const b = key ? matchBreaker('entity', key) : null
  if (!b) return false
  const v = await judgeBreaker(b)
  if (!v) return false
  reply.header('Retry-After', String(v.retryAfter)).code(v.status).send(v.body)
  return true
}

const CALLER_CHECKED = Symbol.for('nvr.breaker.caller')

/**
 * After authenticate resolved the caller: caller breakers. Throws an http error the global
 * handler answers (status + code + `breaker`). One judgement per request (authenticate can run
 * twice, e.g. the maintenance hook then the route).
 */
export async function callerBreakerCheck(req: {
  raw: { url?: string }
  url: string
  authMethod?: string
  apiKeyId?: number | null
  user?: { id?: string } | null
}): Promise<void> {
  if (active.size === 0) return
  const r = req as unknown as Record<symbol, BreakerVerdict | null | undefined>
  let v = r[CALLER_CHECKED]
  if (v === undefined) {
    v = null
    const url = req.raw.url ?? req.url
    if (!breakerExempt(url)) {
      const key =
        req.authMethod === 'api_key' && req.apiKeyId != null
          ? `k${req.apiKeyId}`
          : req.user?.id
            ? `u${String(req.user.id).toUpperCase()}`
            : null
      const b = key ? matchBreaker('caller', key) : null
      if (b) v = await judgeBreaker(b)
    }
    r[CALLER_CHECKED] = v
  }
  if (!v) return
  const err = Object.assign(new Error(v.body.error), {
    statusCode: v.status,
    code: BREAKER_CODE,
    breaker: v.body.breaker,
    retryAfter: v.retryAfter
  })
  throw err
}

// ── admin writes ─────────────────────────────────────────────────────────────
const ENTITY_RE = /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/
const CALLER_RE = /^(k\d{1,12}|u[0-9A-F-]{36})$/

export function validTarget(kind: BreakerKind, target: string): boolean {
  return kind === 'entity' ? ENTITY_RE.test(target) : CALLER_RE.test(target)
}

export async function setBreaker(b: Breaker): Promise<void> {
  if (!redis) throw new Error('Redis is not available')
  await redis.hset(BREAKERS_KEY, fieldOf(b.kind, b.target), JSON.stringify(b))
  await sync()
}

export async function clearBreaker(kind: BreakerKind, target: string): Promise<boolean> {
  if (!redis) throw new Error('Redis is not available')
  const had = active.has(fieldOf(kind, target))
  await redis.hdel(BREAKERS_KEY, fieldOf(kind, target))
  await sync()
  return had
}

export function breakerSyncAge(): number {
  return lastSync ? Date.now() - lastSync : -1
}
export function breakersAvailable(): boolean {
  return !!redis
}
