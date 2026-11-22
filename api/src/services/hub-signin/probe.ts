import type { HubSigninConfig } from './config.js'

/**
 * Nivaro Hub phase 7 (plan Decision 5): is the Hub up for this app right now?
 *
 * `GET <HUB_URL>/api/hub/oidc/ping?client_id=` with a 1.5 s budget; only a 200 JSON `{ ok: true }`
 * counts as up (a captive portal's 200 HTML, a 5xx, `{ ok: false }` for an inactive client or an
 * app in `direct` mode are all down). Remembered in-process: up 15 s, down 30 s. A Hub round trip
 * that failed for availability (discovery, token exchange unreachable, Hub server_error) calls
 * noteHubSigninFailed(): down for 60 s whatever the probe says. Concurrent askers share one probe.
 */

export const PROBE_TIMEOUT_MS = 1_500
const UP_MS = 15_000
const DOWN_MS = 30_000
const FAILED_MS = 60_000
const MAX_BODY = 4_096

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

let memo: { key: string; up: boolean; until: number } | null = null
let failedUntil = 0
const inflight = new Map<string, Promise<boolean>>()

function keyOf(cfg: HubSigninConfig): string {
  return `${cfg.hubUrl}|${cfg.clientId}`
}

async function probeOnce(cfg: HubSigninConfig, fetchImpl: FetchImpl): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `${cfg.hubUrl}/api/hub/oidc/ping?client_id=${encodeURIComponent(cfg.clientId)}`,
      {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      }
    )
    if (res.status !== 200) return false
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) return false
    const text = await res.text()
    if (text.length > MAX_BODY) return false
    const body = JSON.parse(text) as { ok?: unknown } | null
    return body?.ok === true
  } catch {
    return false
  }
}

export async function hubSigninUp(
  cfg: HubSigninConfig,
  deps: { fetchImpl?: FetchImpl; now?: () => number } = {}
): Promise<boolean> {
  const now = deps.now ?? Date.now
  if (now() < failedUntil) return false
  const key = keyOf(cfg)
  if (memo && memo.key === key && now() < memo.until) return memo.up
  const running = inflight.get(key)
  if (running) return running
  const p = probeOnce(cfg, deps.fetchImpl ?? ((u, i) => fetch(u, i)))
    .then((up) => {
      memo = { key, up, until: now() + (up ? UP_MS : DOWN_MS) }
      return up
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** A Hub round trip failed for availability: treat the Hub as down for 60 s. */
export function noteHubSigninFailed(now: number = Date.now()): void {
  failedUntil = now + FAILED_MS
  memo = null
}

export function _resetHubProbeForTests(): void {
  memo = null
  failedUntil = 0
  inflight.clear()
}
