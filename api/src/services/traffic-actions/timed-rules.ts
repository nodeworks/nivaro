// api/src/services/traffic-actions/timed-rules.ts
/**
 * Traffic Map timed actions (#2215 debug windows, #2273 temporary caches): rules an admin switches
 * on from a node that switch themselves off again.
 *
 * Same shape as the circuit breakers (traffic-breaker.ts): every rule lives in ONE Redis hash
 * (ACTIONS_KEY, field `<kind>:<id>`), each process re-reads it every SYNC_MS (and at once after a
 * change it made), and the request path reads only the in-process copy — with no rule set it is a
 * size check. Redis down = no rules (fail open: a broken cache never changes how requests run).
 *
 * Ending: a rule ends when an admin stops it or when `until` passes. Exactly one process writes the
 * "ended" activity row for it: whichever first wins `SET <END_PREFIX><id> NX` (the process that
 * stops it, else the first to notice the expiry on a sync — or on its own timer at `until`).
 *
 * Self-hosted only: the Traffic Map's action routes answer 404 in cloud mode, and nothing here
 * starts there.
 */

export const ACTIONS_KEY = 'nvr:tm:actions'
export const END_PREFIX = 'nvr:tm:actions:end:'
const SYNC_MS = 3000

export type TimedRuleKind = 'debug' | 'cache'

export interface TimedRule {
  kind: TimedRuleKind
  id: string
  /** What the rule applies to: `<lane>/<entity>` or a caller key. */
  target: string
  /** Epoch ms the rule ends. */
  until: number
  /** Epoch ms it was switched on. */
  at: number
  by: string | null
  by_name: string | null
  /** Kind-specific settings (cache: entry seconds). */
  opts?: Record<string, unknown>
}

export interface TimedRulesRedis {
  hgetall(key: string): Promise<Record<string, string>>
  hset(key: string, field: string, value: string): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
}

export type EndReason = 'stopped' | 'expired'
type EndListener = (rule: TimedRule, reason: EndReason) => void | Promise<void>
type ChangeListener = () => void

let redis: TimedRulesRedis | null = null
let active = new Map<string, TimedRule>()
let syncTimer: NodeJS.Timeout | null = null
const endTimers = new Map<string, NodeJS.Timeout>()
const endListeners = new Map<TimedRuleKind, EndListener>()
const changeListeners = new Set<ChangeListener>()

export function fieldOf(kind: TimedRuleKind, id: string): string {
  return `${kind}:${id}`
}

/** Live rules from the raw hash (pure; exported for tests). */
export function parseRules(raw: Record<string, string> | null | undefined, now: number) {
  const live = new Map<string, TimedRule>()
  const expired: TimedRule[] = []
  const corrupt: string[] = []
  for (const [field, v] of Object.entries(raw ?? {})) {
    let r: TimedRule | null = null
    try {
      r = JSON.parse(v) as TimedRule
    } catch {
      r = null
    }
    if (
      !r ||
      (r.kind !== 'debug' && r.kind !== 'cache') ||
      typeof r.until !== 'number' ||
      typeof r.id !== 'string' ||
      typeof r.target !== 'string'
    ) {
      corrupt.push(field)
      continue
    }
    if (r.until > now) live.set(field, r)
    else expired.push(r)
  }
  return { live, expired, corrupt }
}

/** Claim the right to write a rule's "ended" row; true for exactly one caller cluster-wide. */
async function claimEnd(id: string): Promise<boolean> {
  if (!redis) return true
  try {
    const r = await redis.set(`${END_PREFIX}${id}`, '1', 'EX', 86_400, 'NX')
    return r === 'OK' || r === true
  } catch {
    return false
  }
}

async function fireEnd(rule: TimedRule, reason: EndReason): Promise<void> {
  const fn = endListeners.get(rule.kind)
  if (!fn) return
  try {
    await fn(rule, reason)
  } catch {
    /* an end row that failed to write never affects the rules */
  }
}

function armEndTimer(field: string, rule: TimedRule): void {
  if (endTimers.has(field)) return
  const t = setTimeout(
    () => {
      endTimers.delete(field)
      void sync()
    },
    Math.max(0, rule.until - Date.now()) + 50
  )
  t.unref?.()
  endTimers.set(field, t)
}

function notifyChange(): void {
  for (const fn of changeListeners) {
    try {
      fn()
    } catch {
      /* isolated */
    }
  }
}

export async function sync(): Promise<void> {
  if (!redis) return
  const before = active
  let raw: Record<string, string>
  try {
    raw = await redis.hgetall(ACTIONS_KEY)
  } catch {
    active = new Map() // fail open
    if (before.size) notifyChange()
    return
  }
  const now = Date.now()
  const { live, expired, corrupt } = parseRules(raw, now)
  const gone = [...expired.map((r) => fieldOf(r.kind, r.id)), ...corrupt]
  if (gone.length) await redis.hdel(ACTIONS_KEY, ...gone).catch(() => {})
  active = live
  for (const [field, rule] of live) armEndTimer(field, rule)
  // Rules this process knew that are now past `until` (or gone without a stop): one end row.
  const ended = new Map<string, TimedRule>()
  for (const r of expired) ended.set(r.id, r)
  for (const [field, r] of before) if (!live.has(field) && r.until <= now) ended.set(r.id, r)
  for (const r of ended.values()) {
    if (await claimEnd(r.id)) await fireEnd(r, 'expired')
  }
  const changed =
    before.size !== live.size ||
    [...live.keys()].some((k) => before.get(k)?.until !== live.get(k)?.until)
  if (changed) notifyChange()
}

/** Start syncing (idempotent). Self-hosted only. */
export function startTimedRules(r: TimedRulesRedis | null | undefined): void {
  if (process.env.CLOUD_META_DB_URL || !r || syncTimer) return
  redis = r
  void sync()
  syncTimer = setInterval(() => void sync(), SYNC_MS)
  syncTimer.unref?.()
}

export function stopTimedRules(): void {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = null
  for (const t of endTimers.values()) clearTimeout(t)
  endTimers.clear()
  redis = null
  active = new Map()
}

/** Test hook: the Redis client and in-process copy, set directly. */
export function setTimedRulesForTest(list: TimedRule[], r: TimedRulesRedis | null = null): void {
  active = new Map(list.map((x) => [fieldOf(x.kind, x.id), x]))
  redis = r
  notifyChange()
}

export function timedRulesAvailable(): boolean {
  return !!redis
}

/** `fn(rule, reason)` once per ended rule of `kind` (the cluster-wide winner of the claim). */
export function onRuleEnded(kind: TimedRuleKind, fn: EndListener): void {
  endListeners.set(kind, fn)
}

/** Called whenever this process's copy of the rules changes. Returns unsubscribe. */
export function onRulesChanged(fn: ChangeListener): () => void {
  changeListeners.add(fn)
  return () => {
    changeListeners.delete(fn)
  }
}

/** Every live rule of `kind` (no I/O). */
export function activeRules(kind: TimedRuleKind, now = Date.now()): TimedRule[] {
  if (active.size === 0) return []
  const out: TimedRule[] = []
  for (const r of active.values()) if (r.kind === kind && r.until > now) out.push(r)
  return out.sort((a, b) => a.until - b.until)
}

export function hasActiveRules(): boolean {
  return active.size > 0
}

export async function setRule(rule: TimedRule): Promise<void> {
  if (!redis) throw new Error('Redis is not available')
  await redis.hset(ACTIONS_KEY, fieldOf(rule.kind, rule.id), JSON.stringify(rule))
  await sync()
}

/** Stop a rule now; the caller's process writes its "stopped" row. False when it was not live. */
export async function clearRule(kind: TimedRuleKind, id: string): Promise<TimedRule | null> {
  if (!redis) throw new Error('Redis is not available')
  const field = fieldOf(kind, id)
  const had = active.get(field) ?? null
  await redis.hdel(ACTIONS_KEY, field)
  const t = endTimers.get(field)
  if (t) clearTimeout(t)
  endTimers.delete(field)
  active.delete(field)
  notifyChange()
  if (had && (await claimEnd(had.id))) await fireEnd(had, 'stopped')
  return had
}
