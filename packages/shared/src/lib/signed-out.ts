/**
 * Signed-out gate: one per tab, shared by every client that asks "who am I".
 *
 * A tab whose session ended (signed out elsewhere, expired, a phone left open overnight) kept
 * asking the API who it was — `GET /auth/ws-token` on every socket (re)connect and focus,
 * `/auth/me` and `/users/me` from every mounted reader, `/rum` beacons — and every answer was
 * the same 401 (staging 2026-10-23: 2,116 ws-token 401s in an hour, a fifth of all requests).
 *
 * After the first 401 the tab knows it is signed out: identity calls are answered here with a
 * local 401 instead of a request, except one probe per backoff window (1 s doubling to a 5 min
 * cap, ±25% jitter) so a sign-in this tab never hears about is still found. A sign-in resumes
 * everything at once: an identity call that succeeds, a new bearer token (`noteCredentialChanged`),
 * or another tab of this origin that signed in (BroadcastChannel `nvr-auth`).
 *
 * View-as and run-as-key refusals (`MASQUERADE_*`, `KEY_SIM_*`) are not a signed-out person: the
 * host drops that header and carries on, so they never close the gate.
 *
 * No work on import (the BroadcastChannel opens on first use): nothing here needs `sideEffects`.
 */

export const SIGNED_OUT_MIN_MS = 1_000
export const SIGNED_OUT_MAX_MS = 5 * 60_000

/** 401 codes that say the session itself is gone, whichever route answered them. */
const SESSION_GONE_CODES = new Set([
  'NOT_SIGNED_IN',
  'SESSION_EXPIRED',
  'TOKEN_INVALID',
  'ACCOUNT_NOT_ACTIVE'
])
/** 401 codes about a View-as / run-as-key header, not the person's own session. */
const NOT_THE_SESSION = /^(MASQUERADE_|KEY_SIM_)/

/** The "who am I" reads the gate answers locally while signed out (GET, no query). */
const IDENTITY_PATHS = new Set(['/auth/me', '/users/me', '/auth/ws-token'])

let signedOut = false
let failures = 0
let nextProbeAt = 0
const listeners = new Set<() => void>()
let channel: BroadcastChannel | null | undefined
/** This page already told other tabs it is signed in (once per page is enough). */
let announced = false

/** The wait before the next probe after `n` refusals in a row: 1 s doubling, capped, jittered. */
export function signedOutBackoff(n: number, random: () => number = Math.random): number {
  const base = Math.min(SIGNED_OUT_MIN_MS * 2 ** Math.max(0, n - 1), SIGNED_OUT_MAX_MS)
  return Math.min(SIGNED_OUT_MAX_MS, Math.round(base * (0.75 + random() * 0.5)))
}

function errStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null
  const s = typeof e?.status === 'number' ? e.status : e?.response?.status
  return typeof s === 'number' ? s : undefined
}

/** The refusal's machine code: SDK errors carry the body as `response`, axios as `response.data`. */
function errCode(err: unknown): string | undefined {
  const r = (err as { response?: { code?: unknown; data?: { code?: unknown } } } | null)?.response
  const c = r?.code ?? r?.data?.code
  return typeof c === 'string' ? c : undefined
}

/**
 * Does this error say the tab is signed out? `identity` = it came from a "who am I" call, where
 * any 401 (bar View-as) counts; elsewhere only the session-gone codes do (a public form's wrong
 * password is a 401 too).
 */
export function isSignedOutError(err: unknown, identity = false): boolean {
  if (errStatus(err) !== 401) return false
  const code = errCode(err)
  if (code && NOT_THE_SESSION.test(code)) return false
  return identity || (code != null && SESSION_GONE_CODES.has(code))
}

/** True once a 401 said this tab is signed out, until a sign-in is heard. */
export function isSignedOut(): boolean {
  return signedOut
}

/**
 * A 401 from the API: close the gate and push the next probe further out. `escalate: false`
 * (a refusal from an ordinary read) only closes an open gate — it never lengthens the wait.
 */
export function noteUnauthorized(escalate = true): void {
  if (signedOut && !escalate) return
  failures += 1
  signedOut = true
  nextProbeAt = Date.now() + signedOutBackoff(failures)
}

function reopen(): boolean {
  const was = signedOut
  signedOut = false
  failures = 0
  nextProbeAt = 0
  if (was) {
    for (const cb of [...listeners]) {
      try {
        cb()
      } catch {
        /* one listener must not stop the rest */
      }
    }
  }
  return was
}

function bus(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  channel = null
  try {
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel('nvr-auth')
      channel.onmessage = (ev: MessageEvent) => {
        if ((ev.data as { t?: string } | null)?.t === 'signed-in') reopen()
      }
    }
  } catch {
    channel = null
  }
  return channel
}

/**
 * An identity call succeeded: this tab is signed in. Other tabs hear it when this tab was
 * signed out until now, or the first time this page learns it (a fresh page after sign-in).
 */
export function noteSignedIn(): void {
  const ch = bus()
  if (!reopen() && announced) return
  announced = true
  try {
    ch?.postMessage({ t: 'signed-in' })
  } catch {
    /* closed channel */
  }
}

/** The host swapped credentials (a new bearer token): whatever was refused may work now. */
export function noteCredentialChanged(): void {
  reopen()
}

/** Called once each time the tab goes from signed out to signed in. Returns the unsubscribe. */
export function onSignedIn(cb: () => void): () => void {
  bus()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * May an identity call go to the API now? Always while signed in; while signed out only once
 * per backoff window — the caller that gets `true` is that window's probe.
 */
export function claimIdentityCall(): boolean {
  if (!signedOut) return true
  const now = Date.now()
  if (now < nextProbeAt) return false
  nextProbeAt = now + signedOutBackoff(failures)
  return true
}

/** What a blocked identity call rejects with: the shape of the server's own 401. */
export function signedOutError(): Error & { status: number; response: Record<string, unknown> } {
  return Object.assign(new Error('Not signed in'), {
    status: 401,
    response: { error: 'Not signed in', code: 'NOT_SIGNED_IN' },
    signedOutGate: true
  })
}

/** Is this command a "who am I" read the gate guards? */
export function isIdentityRead(
  method: string | undefined,
  path: string | undefined,
  params?: unknown
) {
  if ((method ?? 'GET').toUpperCase() !== 'GET' || !path) return false
  if (params && typeof params === 'object' && Object.keys(params).length > 0) return false
  return IDENTITY_PATHS.has(path)
}

/**
 * Run one identity call through the gate: `blocked()` answers without a request while the tab
 * is signed out (outside its probe window); a success opens the gate, a signed-out 401 closes it.
 */
export async function guardIdentityCall<T>(
  call: () => Promise<T>,
  blocked: () => T | Promise<T>
): Promise<T> {
  if (!claimIdentityCall()) return blocked()
  try {
    const out = await call()
    noteSignedIn()
    return out
  } catch (err) {
    if (isSignedOutError(err, true)) noteUnauthorized()
    throw err
  }
}

/** Tests only: forget everything. */
export function __resetSignedOutGate(): void {
  signedOut = false
  failures = 0
  nextProbeAt = 0
  announced = false
  listeners.clear()
  try {
    channel?.close()
  } catch {
    /* noop */
  }
  channel = undefined
}
