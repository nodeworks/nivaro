import { replayRecorderMode, tapReplayEvents } from './replay-capture'
import { instrumentConsole, instrumentRequests } from './replay-context'
import {
  buildReplayMaskingOptions,
  DEFAULT_REPLAY_MASKING,
  type ReplayMaskingRules
} from './replay-masking'

/**
 * Auto-record on a signal (#1371) — the browser half, shared by the admin's
 * recorder and @nivaro/react's.
 *
 * The server sends `replay:record` { signal, minutes, token } to a person whose
 * clicks raged or went dead, or who is on a page a failing monitor or an
 * opened breaker covers (only when replay_auto_signals is on). This starts a
 * time-boxed recording labelled `auto:<signal>`:
 *
 *  - full recording already on → nothing new; a `signal` marker is dropped on
 *    the live recording's scrubber.
 *  - error-clip buffer running → rrweb records one stream per page, so the
 *    auto recording taps the buffer's events (after a fresh full snapshot).
 *  - nothing running → its own rrweb record() for the window.
 *
 * Privacy matches the recorders: every input masked, `.nvr-no-record`
 * blocked. One auto recording at a time per tab; the server's token is
 * single-use and minted for this person, so a page cannot start one itself.
 */

export const AUTO_SIGNALS = ['rage-click', 'dead-click', 'monitor', 'breaker'] as const

export interface AutoRecordRequest {
  signal: (typeof AUTO_SIGNALS)[number]
  minutes: number
  token: string
}

/** The socket payload, validated; null for anything else. */
export function parseAutoRecord(raw: unknown): AutoRecordRequest | null {
  const p = raw as { signal?: unknown; minutes?: unknown; token?: unknown } | null
  if (!p || typeof p.token !== 'string' || !/^[0-9a-f]{36}$/.test(p.token)) return null
  if (!(AUTO_SIGNALS as readonly unknown[]).includes(p.signal)) return null
  const m = Number(p.minutes)
  const minutes = Number.isFinite(m) ? Math.min(Math.max(m, 0.5), 5) : 3
  return { signal: p.signal as AutoRecordRequest['signal'], minutes, token: p.token }
}

type RrwebRecord = ((opts: Record<string, unknown>) => (() => void) | undefined) & {
  addCustomEvent?: (tag: string, payload: unknown) => void
  takeFullSnapshot?: (isCheckout?: boolean) => void
}

export interface AutoRecordDeps {
  loadRecord(): Promise<RrwebRecord | null>
  /** POST /session-recordings/start { auto_token, origin } → the recording id. */
  start(token: string): Promise<string>
  /** POST /:id/events; 'closed' stops the run (recording capped or ended). */
  append(id: string, seq: number, events: unknown[]): Promise<'ok' | 'closed'>
  end(id: string): Promise<void>
  /** The instance's masking rules (#1361); the strict defaults when absent. */
  masking?: () => ReplayMaskingRules
  flushMs?: number
}

let running: { stop: () => Promise<void> } | null = null

/** Test seam / unmount: stop a running auto recording. */
export async function stopAutoRecording(): Promise<void> {
  const r = running
  running = null
  await r?.stop()
}

export function autoRecordingActive(): boolean {
  return running != null
}

export async function runAutoRecording(
  req: AutoRecordRequest,
  deps: AutoRecordDeps
): Promise<'marked' | 'started' | 'busy' | 'failed'> {
  if (running) return 'busy'
  const mode = replayRecorderMode()
  const record = await deps.loadRecord().catch(() => null)
  if (!record) return 'failed'
  if (mode === 'full') {
    try {
      record.addCustomEvent?.('signal', { signal: req.signal })
    } catch {
      /* best-effort */
    }
    return 'marked'
  }
  // Hold the slot while the start request is in flight.
  running = { stop: async () => {} }
  let id: string
  try {
    id = await deps.start(req.token)
  } catch {
    running = null
    return 'failed'
  }
  let buffer: unknown[] = []
  let seq = 0
  let closed = false
  let inFlight: Promise<void> | null = null
  const flush = (): Promise<void> => {
    if (inFlight) return inFlight.then(flush)
    if (closed || buffer.length === 0) return Promise.resolve()
    const events = buffer
    buffer = []
    inFlight = deps
      .append(id, seq++, events)
      .then((r) => {
        if (r === 'closed') closed = true
      })
      .catch(() => {})
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
  const push = (e: unknown) => {
    if (!closed) buffer.push(e)
  }

  let stopStream: (() => void) | null = null
  let undoConsole: (() => void) | null = null
  let undoRequests: (() => void) | null = null
  try {
    if (mode === 'clip') {
      stopStream = tapReplayEvents(push)
      // A replayable stream starts with a full snapshot; the clip buffer's
      // record() emits it through the tap.
      record.takeFullSnapshot?.()
    } else {
      stopStream =
        record({
          emit: push,
          // Same masking as the recorders (#1361), never looser.
          ...buildReplayMaskingOptions(deps.masking ?? (() => DEFAULT_REPLAY_MASKING)),
          checkoutEveryNms: 60_000
        }) ?? null
      const add = (tag: string, payload: unknown) => record.addCustomEvent?.(tag, payload)
      undoConsole = instrumentConsole(add)
      undoRequests = instrumentRequests(add)
    }
    record.addCustomEvent?.('signal', { signal: req.signal })
  } catch {
    stopStream?.()
    running = null
    await deps.end(id).catch(() => {})
    return 'failed'
  }

  const timer = setInterval(() => void flush(), deps.flushMs ?? 10_000)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    clearTimeout(deadline)
    undoConsole?.()
    undoRequests?.()
    try {
      stopStream?.()
    } catch {
      /* already stopped */
    }
    await flush().catch(() => {})
    await deps.end(id).catch(() => {})
    if (running === handle) running = null
  }
  const deadline = setTimeout(() => void stop(), req.minutes * 60_000)
  const handle = { stop }
  running = handle
  return 'started'
}
