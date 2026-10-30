import { useEffect, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from '../lib/commands'
import {
  SLOW_REASON_AFTER_MS,
  SLOW_REASON_MAX_POLLS,
  SLOW_REASON_POLL_MS,
  type SlowReasonContext,
  slowReasonText,
  type WaitAnswer
} from '../lib/slow-reason'

export interface SlowReadRequest {
  method: 'GET' | 'POST'
  /** API path (with or without /api); a query string is ignored. */
  url: string
}

export interface UseSlowReasonOptions extends SlowReasonContext {
  /** True while the page's own read is still loading. */
  pending: boolean
  /** The read the page is making; null = ask nothing (the notice still says it is slow). */
  request: SlowReadRequest | null
  /** How long before the read counts as slow (default 3 s). */
  afterMs?: number
  enabled?: boolean
}

export interface SlowReason {
  /** Loading for at least `afterMs`. */
  slow: boolean
  /** How long it has been loading, ms (0 while not slow). */
  elapsedMs: number
  /** The plain sentence, or null when the server knows nothing useful. */
  text: string | null
  answer: WaitAnswer | null
}

/**
 * #3231 — after ~3 s of loading, ask the server what this read is waiting on and keep asking
 * every few seconds while it still loads (hidden tabs skip a beat). Nothing is asked for a read
 * that finishes in time, so a fast page makes no extra call.
 */
export function useSlowReason(opts: UseSlowReasonOptions): SlowReason {
  const client = useOptionalNivaroClient()
  const afterMs = opts.afterMs ?? SLOW_REASON_AFTER_MS
  const enabled = opts.enabled !== false
  const sig = opts.request ? `${opts.request.method} ${opts.request.url.split('?')[0]}` : ''
  const [elapsedMs, setElapsed] = useState(0)
  const [answer, setAnswer] = useState<WaitAnswer | null>(null)
  const reqRef = useRef(opts.request)
  reqRef.current = opts.request

  // biome-ignore lint/correctness/useExhaustiveDependencies: restart on the read's identity
  useEffect(() => {
    setElapsed(0)
    setAnswer(null)
    if (!opts.pending || !enabled) return
    const t0 = Date.now()
    let polls = 0
    let asking = false
    let gone = false
    let lastAsk = 0
    const tick = () => {
      const ms = Date.now() - t0
      setElapsed(ms >= afterMs ? ms : 0)
      const req = reqRef.current
      if (ms < afterMs || !client || !req || asking || polls >= SLOW_REASON_MAX_POLLS) return
      if (typeof document !== 'undefined' && document.hidden) return
      if (lastAsk && Date.now() - lastAsk < SLOW_REASON_POLL_MS) return
      asking = true
      lastAsk = Date.now()
      polls++
      client
        .request<{ data: WaitAnswer }>(
          get('/background-runs/waiting', { method: req.method, url: req.url.split('?')[0] })
        )
        .then((r) => {
          if (!gone) setAnswer(r.data ?? null)
        })
        .catch(() => {
          // An older server (404) or a refusal: stop asking, the notice stays generic.
          polls = SLOW_REASON_MAX_POLLS
        })
        .finally(() => {
          asking = false
        })
    }
    const timer = setInterval(tick, 1000)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [opts.pending, enabled, sig, afterMs, client])

  const slow = opts.pending && enabled && elapsedMs >= afterMs
  return {
    slow,
    elapsedMs: slow ? elapsedMs : 0,
    text: slow
      ? slowReasonText(answer, { noun: opts.noun, label: opts.label, knownRows: opts.knownRows })
      : null,
    answer: slow ? answer : null
  }
}
