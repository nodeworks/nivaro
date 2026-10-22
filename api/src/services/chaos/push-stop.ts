import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import { type ArmedFault, describeTarget } from './catalog.js'
import { runParticipants } from './drill-alerts.js'
import { type ChaosRun, getRun } from './runs.js'

/**
 * Stop a drill from your phone (#2861). When a drill starts and when it auto-aborts, the person
 * who started it and its participants get a browser push with a Stop action. The push carries a
 * signed one-time token; the service worker posts it to `POST /api/chaos/stop-all/push`, which
 * ends every fault on the instance — no sign-in needed on the phone, because the token is:
 *  - signed (HMAC over SESSION_SECRET) and bound to one run and one person,
 *  - short-lived: until the run's window ends (an abort push: five minutes),
 *  - single-use: its nonce is spent in this process and, when Redis answers, cluster-wide.
 * Signing needs no Redis, so the Stop works while Redis is down (the local clear always happens).
 * The person must still be a chaos operator when the token is spent.
 */

export const STOP_TOKEN_GRACE_MS = 30_000
export const ABORT_TOKEN_TTL_MS = 5 * 60_000

interface StopClaims {
  /** run id */
  r: string
  /** user id */
  u: string
  /** expires, ms */
  e: number
  /** nonce */
  n: string
}

function key(): string {
  return `nivaro-chaos-stop|${config.SESSION_SECRET}`
}

function sign(payload: string): string {
  return createHmac('sha256', key()).update(payload).digest('base64url')
}

export function mintStopToken(runId: string, userId: string, expiresAt: number): string {
  const claims: StopClaims = { r: runId, u: userId, e: Math.round(expiresAt), n: randomUUID() }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export class StopTokenError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string
  ) {
    super(message)
  }
}

/** Check signature and expiry (no spending). Throws StopTokenError. */
export function verifyStopToken(token: unknown, now = Date.now()): StopClaims {
  const t = typeof token === 'string' ? token.trim() : ''
  const dot = t.indexOf('.')
  if (!t || t.length > 600 || dot < 1)
    throw new StopTokenError('That stop link is not valid', 400, 'CHAOS_STOP_TOKEN')
  const payload = t.slice(0, dot)
  const given = Buffer.from(t.slice(dot + 1))
  const want = Buffer.from(sign(payload))
  if (given.length !== want.length || !timingSafeEqual(given, want))
    throw new StopTokenError('That stop link is not valid', 403, 'CHAOS_STOP_TOKEN')
  let claims: StopClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StopClaims
  } catch {
    throw new StopTokenError('That stop link is not valid', 400, 'CHAOS_STOP_TOKEN')
  }
  if (!claims?.r || !claims.u || !claims.n || !Number.isFinite(claims.e))
    throw new StopTokenError('That stop link is not valid', 400, 'CHAOS_STOP_TOKEN')
  if (now > claims.e)
    throw new StopTokenError('That stop link has expired', 410, 'CHAOS_STOP_EXPIRED')
  return claims
}

// ── Single use ────────────────────────────────────────────────────────────────

interface SpendBus {
  set(key: string, value: string, mode: 'PX', ms: number, nx: 'NX'): Promise<unknown>
}

const spent = new Map<string, number>()
let bus: SpendBus | null = null

export function setStopTokenRedis(r: SpendBus | null): void {
  bus = r
}

/** Spend a verified token's nonce. false = it was used before. */
export async function spendStopToken(claims: StopClaims, now = Date.now()): Promise<boolean> {
  for (const [n, exp] of spent) if (exp < now) spent.delete(n)
  if (spent.has(claims.n)) return false
  spent.set(claims.n, claims.e)
  if (!bus) return true
  try {
    const ok = await Promise.race([
      bus.set(
        `nvr:chaos:stoptok:${claims.n}`,
        claims.r,
        'PX',
        Math.max(1000, claims.e - now),
        'NX'
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))
    ])
    // null = another replica spent it first. A Redis that does not answer must not block a Stop.
    return ok !== null
  } catch {
    return true
  }
}

/** Verify + spend; returns who stops and for which run. Throws StopTokenError. */
export async function redeemStopToken(
  token: unknown,
  now = Date.now()
): Promise<{ run_id: string; user_id: string }> {
  const claims = verifyStopToken(token, now)
  if (!(await spendStopToken(claims, now)))
    throw new StopTokenError('That stop link was already used', 410, 'CHAOS_STOP_USED')
  return { run_id: claims.r, user_id: claims.u }
}

// ── The pushes ────────────────────────────────────────────────────────────────

type PushFn = (
  userId: string,
  payload: {
    title: string
    body: string
    url?: string | null
    tag?: string | null
    stop_token?: string | null
  }
) => Promise<number>

let pushOverride: PushFn | null = null

async function push(...args: Parameters<PushFn>): Promise<number> {
  if (pushOverride) return pushOverride(...args)
  const { sendWebPush } = await import('../web-push.js')
  return sendWebPush(...args)
}

async function pushToParticipants(
  run: ChaosRun,
  title: string,
  body: string,
  expiresAt: number
): Promise<number> {
  let sent = 0
  for (const userId of await runParticipants(run)) {
    try {
      sent += await push(userId, {
        title,
        body,
        url: `/chaos?tab=runs&run=${encodeURIComponent(run.id)}`,
        tag: `chaos-${run.id}`,
        stop_token: mintStopToken(run.id, userId, expiresAt)
      })
    } catch {
      /* never blocks a drill */
    }
  }
  return sent
}

/** A drill was armed: tell its people, with a Stop that lasts as long as the window. */
export async function pushDrillStarted(fault: ArmedFault): Promise<number> {
  if (!fault.run_id) return 0
  const run = await getRun(fault.run_id).catch(() => null)
  if (!run || run.kind === 'ci') return 0
  const secs = Math.max(1, Math.round((fault.ends_at - fault.started_at) / 1000))
  return pushToParticipants(
    run,
    `Chaos drill running: ${fault.label}`,
    `${fault.label} on ${describeTarget(fault.target)} for ${secs}s. Stop ends every fault on this instance.`,
    fault.ends_at + STOP_TOKEN_GRACE_MS
  )
}

/** A drill auto-aborted (its hypothesis broke): tell its people, Stop for five more minutes. */
export async function pushDrillAborted(fault: ArmedFault, reason: string): Promise<number> {
  if (!fault.run_id) return 0
  const run = await getRun(fault.run_id).catch(() => null)
  if (!run || run.kind === 'ci') return 0
  return pushToParticipants(
    run,
    `Chaos drill aborted: ${fault.label}`,
    `${reason.replace(/^aborted:\s*/, '').slice(0, 160)}. The fault is off; Stop ends anything else still armed.`,
    Date.now() + ABORT_TOKEN_TTL_MS
  )
}

/** Tests only. */
export function _setStopPushForTests(fn: PushFn | null): void {
  pushOverride = fn
  spent.clear()
  bus = null
}
