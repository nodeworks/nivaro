import { randomBytes } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Auto-record on a signal (#1371). When something says "this is going wrong
 * for someone right now" — they rage-clicked, a burst of their clicks did
 * nothing, an ops monitor flipped to failing, or an operator opened a circuit
 * breaker — the server asks the affected people's browsers over the socket
 * (`replay:record`) to record the next three minutes, labelled
 * `auto:<signal>`, even while session recording is off.
 *
 * Off unless nivaro_settings.replay_auto_signals is on. A browser cannot
 * start one itself: every `replay:record` carries a single-use token minted
 * here for that person and that signal (two-minute life), and POST
 * /session-recordings/start honours an auto start only with it. Capped per
 * hour for the whole instance (Redis, shared by every API process; in memory
 * without Redis) and one auto recording per person per ten minutes.
 */

export const AUTO_SIGNALS = ['rage-click', 'dead-click', 'monitor', 'breaker'] as const
export type AutoSignal = (typeof AUTO_SIGNALS)[number]
export const AUTO_MINUTES = 3
export const AUTO_MAX_PER_HOUR = 12
const PERSON_COOLDOWN_S = 600
const TOKEN_TTL_S = 120
/** Never fan one signal out to a crowd: the first few people on the route. */
const MAX_TARGETS = 10

export function isAutoSignal(v: unknown): v is AutoSignal {
  return typeof v === 'string' && (AUTO_SIGNALS as readonly string[]).includes(v)
}

/** The ioredis subset used here. */
export interface AutoStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  del(key: string): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

/** In-process stand-in for a deployment without Redis (and for tests). */
export function memoryStore(now: () => number = Date.now): AutoStore {
  const m = new Map<string, { v: string; until: number }>()
  const live = (k: string) => {
    const e = m.get(k)
    if (e && e.until <= now()) m.delete(k)
    return m.get(k)
  }
  return {
    async get(k) {
      return live(k)?.v ?? null
    },
    async set(k, v, ...args) {
      const ex = args.indexOf('EX')
      const ttl = ex >= 0 ? Number(args[ex + 1]) : 86_400
      if (args.includes('NX') && live(k)) return null
      m.set(k, { v, until: now() + ttl * 1000 })
      return 'OK'
    },
    async del(k) {
      m.delete(k)
      return 1
    },
    async incr(k) {
      const n = Number(live(k)?.v ?? 0) + 1
      m.set(k, { v: String(n), until: live(k)?.until ?? now() + 86_400_000 })
      return n
    },
    async expire(k, s) {
      const e = live(k)
      if (e) e.until = now() + s * 1000
      return 1
    }
  }
}

let fallback: AutoStore | null = null
function storeOf(redis: AutoStore | null | undefined): AutoStore {
  if (redis) return redis
  fallback ??= memoryStore()
  return fallback
}

/** Test seam. */
export function resetAutoSignalsForTest(): void {
  fallback = null
  cachedOn = null
}

let cachedOn: { on: boolean; at: number } | null = null
export async function autoSignalsOn(now = Date.now()): Promise<boolean> {
  if (cachedOn && now - cachedOn.at < 30_000) return cachedOn.on
  let on = false
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first()) as
      | Record<string, unknown>
      | undefined
    on = !!row?.replay_auto_signals
  } catch {
    on = false
  }
  cachedOn = { on, at: now }
  return on
}

const hourKey = (now: number) => `replay:auto:hour:${new Date(now).toISOString().slice(0, 13)}`

/** One slot of the hourly instance cap; false once the hour is spent. */
export async function takeHourSlot(store: AutoStore, now = Date.now()): Promise<boolean> {
  const key = hourKey(now)
  const n = await store.incr(key)
  if (n === 1) await store.expire(key, 3600)
  return n <= AUTO_MAX_PER_HOUR
}

/** One auto recording per person per ten minutes. */
export async function claimPerson(store: AutoStore, userId: string): Promise<boolean> {
  const ok = await store.set(
    `replay:auto:cool:${userId.toUpperCase()}`,
    '1',
    'EX',
    PERSON_COOLDOWN_S,
    'NX'
  )
  return ok === 'OK'
}

export async function mintAutoToken(
  store: AutoStore,
  userId: string,
  signal: AutoSignal
): Promise<string> {
  const token = randomBytes(18).toString('hex')
  await store.set(
    `replay:auto:tok:${token}`,
    JSON.stringify({ user: userId.toUpperCase(), signal }),
    'EX',
    TOKEN_TTL_S
  )
  return token
}

/**
 * The signal a token was minted for — once, and only for the person it was
 * minted for. Anything else (unknown, expired, used, someone else's) is null.
 */
export async function consumeAutoToken(
  store: AutoStore | null | undefined,
  token: unknown,
  userId: string
): Promise<AutoSignal | null> {
  if (typeof token !== 'string' || !/^[0-9a-f]{36}$/.test(token)) return null
  const s = storeOf(store)
  const key = `replay:auto:tok:${token}`
  const raw = await s.get(key)
  if (!raw) return null
  await s.del(key)
  try {
    const v = JSON.parse(raw) as { user?: string; signal?: string }
    if (String(v.user) !== userId.toUpperCase() || !isAutoSignal(v.signal)) return null
    return v.signal
  } catch {
    return null
  }
}

/** API path or breaker entity → the admin / portal pages that show it. */
export function pagePrefixesFor(target: string): string[] {
  const t = String(target ?? '')
  const m =
    /^\/api\/items\/([A-Za-z0-9_]+)/.exec(t) ??
    /^(?:items|collection|collections)\/([A-Za-z0-9_]+)/.exec(t)
  if (!m) return []
  const c = m[1]
  if (/^(nivaro_|directus_)/i.test(c)) return []
  return [`/collections/${c}`, `/records/${c}`]
}

export interface SignalDeps {
  store?: AutoStore | null
  emit?: (userId: string, payload: { signal: AutoSignal; minutes: number; token: string }) => void
  usersOnPrefixes?: (prefixes: string[]) => string[] | Promise<string[]>
  now?: number
}

/**
 * Ask the affected people's browsers to record the next three minutes.
 * Targets: `userIds` (the person who raged) plus whoever is on a page under
 * `pathPrefixes` right now (this API process's sockets). Returns how many
 * were asked, and why it stopped short.
 */
export async function fireReplaySignal(
  signal: AutoSignal,
  target: { userIds?: string[]; pathPrefixes?: string[] },
  deps: SignalDeps = {}
): Promise<{ sent: number; reason?: 'off' | 'cap' | 'nobody' }> {
  try {
    if (!(await autoSignalsOn(deps.now))) return { sent: 0, reason: 'off' }
    const store = storeOf(deps.store ?? (await redisStore()))
    const emit = deps.emit ?? (await socketEmit())
    let onPages: string[] = []
    if (target.pathPrefixes?.length) {
      const reader = deps.usersOnPrefixes ?? (await socketReader())
      onPages = reader ? await reader(target.pathPrefixes) : []
    }
    // Ids as stored (the socket's user room is `user:<id>`), deduped case-blind.
    const byKey = new Map<string, string>()
    for (const u of [...(target.userIds ?? []), ...onPages]) {
      if (u && !byKey.has(String(u).toUpperCase())) byKey.set(String(u).toUpperCase(), String(u))
    }
    const people = [...byKey.values()].slice(0, MAX_TARGETS)
    if (people.length === 0 || !emit) return { sent: 0, reason: 'nobody' }
    let sent = 0
    for (const userId of people) {
      if (!(await claimPerson(store, userId))) continue
      if (!(await takeHourSlot(store, deps.now))) return { sent, reason: 'cap' }
      const token = await mintAutoToken(store, userId, signal)
      emit(userId, { signal, minutes: AUTO_MINUTES, token })
      sent++
    }
    return { sent }
  } catch {
    return { sent: 0 }
  }
}

async function redisStore(): Promise<AutoStore | null> {
  try {
    const { getApp } = await import('./io-holder.js')
    return ((getApp() as { redis?: AutoStore } | null)?.redis ?? null) as AutoStore | null
  } catch {
    return null
  }
}

async function socketEmit(): Promise<SignalDeps['emit'] | null> {
  try {
    const { getIo } = await import('./io-holder.js')
    const io = getIo()
    if (!io) return null
    return (userId, payload) => {
      // The user room holds every tab; the recorder answers in each open one.
      io.to(`user:${userId}`).emit('replay:record', payload)
    }
  } catch {
    return null
  }
}

async function socketReader(): Promise<((prefixes: string[]) => Promise<string[]>) | null> {
  try {
    // Post-mortem 3.3 — the realtime processes' sockets when this one serves none.
    const { usersOnPathPrefixAnywhere } = await import('./socket-cluster-presence.js')
    return (prefixes) => usersOnPathPrefixAnywhere(prefixes)
  } catch {
    return null
  }
}

/** Store used by POST /session-recordings/start to check a token. */
export async function autoTokenStore(): Promise<AutoStore | null> {
  return redisStore()
}
