/**
 * Chat health (#989) — what the Ops console needs to say whether chat is
 * working: how many sends, how many failed, how long a send takes from the
 * request arriving to the socket emit, and how late messages reach the
 * browsers that received them (reported back by a sample of clients).
 *
 * In-process ring buffers, per replica — the same posture as the trace ring.
 */

interface Sample {
  at: number
  ms: number
}

const WINDOW_MS = 60 * 60_000
const MAX = 2000

const sends: Sample[] = []
const failures: Array<{ at: number; error: string }> = []
const deliveries: Sample[] = []

function trim<T extends { at: number }>(arr: T[]): void {
  const cutoff = Date.now() - WINDOW_MS
  while (arr.length && (arr[0].at < cutoff || arr.length > MAX)) arr.shift()
}

export function recordChatSend(ms: number): void {
  sends.push({ at: Date.now(), ms })
  trim(sends)
}

export function recordChatSendFailure(error: string): void {
  failures.push({ at: Date.now(), error: error.slice(0, 200) })
  trim(failures)
}

/** A client saw a message `ms` after it was stored. Clamped: clocks drift. */
export function recordChatDelivery(ms: number): void {
  if (!Number.isFinite(ms)) return
  deliveries.push({ at: Date.now(), ms: Math.max(0, Math.min(ms, 10 * 60_000)) })
  trim(deliveries)
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}

export interface ChatHealth {
  window_minutes: number
  sockets: number
  sends: number
  failed_sends: number
  send_ms: { p50: number | null; p95: number | null }
  delivery_ms: { p50: number | null; p95: number | null; samples: number }
  recent_failures: Array<{ at: string; error: string }>
}

export function chatHealth(sockets: number): ChatHealth {
  trim(sends)
  trim(failures)
  trim(deliveries)
  return {
    window_minutes: WINDOW_MS / 60_000,
    sockets,
    sends: sends.length,
    failed_sends: failures.length,
    send_ms: {
      p50: pct(
        sends.map((s) => s.ms),
        0.5
      ),
      p95: pct(
        sends.map((s) => s.ms),
        0.95
      )
    },
    delivery_ms: {
      p50: pct(
        deliveries.map((s) => s.ms),
        0.5
      ),
      p95: pct(
        deliveries.map((s) => s.ms),
        0.95
      ),
      samples: deliveries.length
    },
    recent_failures: failures
      .slice(-10)
      .reverse()
      .map((f) => ({ at: new Date(f.at).toISOString(), error: f.error }))
  }
}
