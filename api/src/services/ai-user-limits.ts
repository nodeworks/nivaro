import { db } from '../db/index.js'
import { currentTraceMeta } from './request-trace.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Default per-person AI limits — ON unless turned off, and generous: they stop
 * a runaway script or a stuck loop from one account, not normal use. Admin
 * budgets (ai-quality.ts, #1817) stay the place for real spending policy.
 *
 *   AI_USER_CALLS_PER_MINUTE   provider calls one person may start per minute
 *                              (default 120; 0 = off). An Ask AI question uses
 *                              one call per tool round.
 *   AI_USER_DAILY_TOKENS       input + output tokens one person may use per UTC
 *                              day (default 10,000,000; 0 = off), read from the
 *                              call log (nivaro_ai_calls) every 30 s plus what
 *                              this process saw since.
 *
 * Counted per process for the minute window (N replicas allow up to N× the
 * burst); the daily figure reads the shared call log, so it holds across
 * replicas within ~30 s. Calls with no person behind them (crons, system
 * jobs) are never limited. Keys carry the tenant (cloud mode).
 */

const MINUTE_MS = 60_000
const TOKEN_SNAPSHOT_MS = 30_000

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function userCallsPerMinute(): number {
  return envLimit('AI_USER_CALLS_PER_MINUTE', 120)
}

export function userDailyTokens(): number {
  return envLimit('AI_USER_DAILY_TOKENS', 10_000_000)
}

export class AiUserLimitError extends Error {
  statusCode = 429
  code: 'AI_RATE_LIMITED' | 'AI_DAILY_TOKENS'
  retryAfterSeconds: number
  constructor(code: 'AI_RATE_LIMITED' | 'AI_DAILY_TOKENS', retryAfterSeconds: number) {
    super(
      code === 'AI_RATE_LIMITED'
        ? `You are sending AI requests faster than this instance allows. Try again in ${retryAfterSeconds} s.`
        : 'You have reached your AI usage for today. It resets at midnight UTC; an administrator can raise the limit (AI_USER_DAILY_TOKENS).'
    )
    this.name = 'AiUserLimitError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const calls = new Map<string, number[]>()
const tokens = new Map<string, { day: string; at: number; base: number; local: number }>()
const inflight = new Map<string, Promise<number>>()

const keyFor = (userId: string) => `${currentTenantKey()}|${userId.toUpperCase()}`
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

function sweep(now: number) {
  if (calls.size < 5000) return
  for (const [k, list] of calls)
    if (!list.length || now - list[list.length - 1] > MINUTE_MS) calls.delete(k)
}

/** Record one call start; throws when the person is over the minute window. */
export function noteUserCall(userId: string, now = Date.now()): void {
  const limit = userCallsPerMinute()
  if (limit <= 0) return
  const k = keyFor(userId)
  const list = (calls.get(k) ?? []).filter((t) => now - t < MINUTE_MS)
  if (list.length >= limit) {
    calls.set(k, list)
    const retry = Math.max(1, Math.ceil((MINUTE_MS - (now - list[0])) / 1000))
    throw new AiUserLimitError('AI_RATE_LIMITED', retry)
  }
  list.push(now)
  calls.set(k, list)
  sweep(now)
}

async function loggedTokensToday(userId: string, start: Date): Promise<number> {
  const row = (await db('nivaro_ai_calls')
    .where('created_at', '>=', start)
    .where({ user: userId })
    .first(db.raw('SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total'))
    .catch(() => null)) as { total?: unknown } | null
  return Number(row?.total ?? 0) || 0
}

/** Tokens the person used today (UTC): the call log's figure plus this process's since. */
export async function userTokensToday(userId: string, now = new Date()): Promise<number> {
  const k = keyFor(userId)
  const day = dayOf(now)
  const hit = tokens.get(k)
  if (hit && hit.day === day && now.getTime() - hit.at < TOKEN_SNAPSHOT_MS)
    return hit.base + hit.local
  let p = inflight.get(k)
  if (!p) {
    const start = new Date(`${day}T00:00:00.000Z`)
    p = loggedTokensToday(userId, start).finally(() => inflight.delete(k))
    inflight.set(k, p)
  }
  const base = await p
  tokens.set(k, { day, at: now.getTime(), base, local: 0 })
  if (tokens.size > 5000) {
    for (const [key, v] of tokens) if (v.day !== day) tokens.delete(key)
  }
  return base
}

/** Add a finished call's tokens to this process's running figure. */
export function noteUserTokens(userId: string, used: number, now = new Date()): void {
  if (!(used > 0)) return
  const hit = tokens.get(keyFor(userId))
  if (hit && hit.day === dayOf(now)) hit.local += used
}

/** The person behind the call being made right now, when there is one. */
export function currentAiUser(): string | null {
  const id = currentTraceMeta()?.userId
  return id ? String(id) : null
}

/**
 * Called before every provider call (getAiClient's guard): throws
 * AiUserLimitError (429) when the person behind the request is over either
 * limit. No person = no limit.
 */
export async function checkUserAiLimits(userId = currentAiUser()): Promise<void> {
  if (!userId) return
  const cap = userDailyTokens()
  if (cap > 0 && (await userTokensToday(userId)) >= cap) {
    const now = Date.now()
    const midnight = Date.parse(`${dayOf(new Date(now + 86_400_000))}T00:00:00.000Z`)
    throw new AiUserLimitError('AI_DAILY_TOKENS', Math.ceil((midnight - now) / 1000))
  }
  noteUserCall(userId)
}

/** Tokens a provider answer reports (input + output), 0 when it reports none. */
export function tokensOf(res: unknown): number {
  const u = (res as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage
  return (Number(u?.input_tokens) || 0) + (Number(u?.output_tokens) || 0)
}

// ─── per-person slots (one feature, a few at once) ───────────────────────────

const slots = new Map<string, number>()

/**
 * Take one of `max` concurrent slots for (feature, person). Returns the
 * release function, or null when every slot is taken — answer 429.
 */
export function takeUserSlot(feature: string, userId: string, max = 1): (() => void) | null {
  const k = `${feature}|${keyFor(userId)}`
  const held = slots.get(k) ?? 0
  if (held >= max) return null
  slots.set(k, held + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (slots.get(k) ?? 1) - 1
    if (n <= 0) slots.delete(k)
    else slots.set(k, n)
  }
}

const featureWindows = new Map<string, number[]>()

/** A per-person per-feature minute window (e.g. briefs: 10 a minute). True = allowed. */
export function allowUserFeatureCall(
  feature: string,
  userId: string,
  perMinute: number,
  now = Date.now()
): boolean {
  if (perMinute <= 0) return true
  const k = `${feature}|${keyFor(userId)}`
  const list = (featureWindows.get(k) ?? []).filter((t) => now - t < MINUTE_MS)
  if (list.length >= perMinute) {
    featureWindows.set(k, list)
    return false
  }
  list.push(now)
  featureWindows.set(k, list)
  if (featureWindows.size > 5000) {
    for (const [key, l] of featureWindows)
      if (!l.length || now - l[l.length - 1] > MINUTE_MS) featureWindows.delete(key)
  }
  return true
}

export function resetUserAiLimitsForTests(): void {
  calls.clear()
  tokens.clear()
  inflight.clear()
  slots.clear()
  featureWindows.clear()
}
