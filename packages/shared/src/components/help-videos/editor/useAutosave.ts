import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { helpVideoApi, helpVideoError, helpVideoKeys } from '../api'
import { useLeaveWarning } from '../recorder/useLeaveWarning'
import type { VideoEdits } from '../types'

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'invalid' | 'error'

const DEBOUNCE_MS = 1000
const RETRY_FIRST_MS = 5000
const RETRY_MAX_MS = 60_000

/** JSON with sorted keys: the server rebuilds every object, so key order
 *  alone must not count as a difference. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x
  )
}

/**
 * Saves the draft edits 1 s after the last change.
 * - One PUT at a time; a change made meanwhile is saved right after.
 * - The server normalizes what it stores. When its copy differs and the
 *   author hasn't changed anything since, `onAdopt(sent, stored)` hands it
 *   over so the editor shows what was saved (no undo step, no new save).
 * - 409 HELP_VIDEO_EDITS_CONFLICT: another tab saved first. Saving stops
 *   until the editor reloads the draft.
 * - 422: the edits are refused; the next change tries again.
 * - Anything else: retried by itself after 5 s, doubling up to 60 s.
 * - The browser asks before leaving the page while anything is unsaved.
 */
export function useAutosave(
  videoId: string,
  present: VideoEdits,
  initialHash: string,
  opts: { onAdopt?: (sent: VideoEdits, stored: VideoEdits) => void } = {}
) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [status, setStatus] = useState<AutosaveStatus>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [retryInMs, setRetryInMs] = useState<number | null>(null)
  // The video is refetching after a save: until it lands, the server's
  // `draft_matches_published` still describes the edits from before the save.
  const [refreshing, setRefreshing] = useState(0)
  // Timers and the save chain read refs, so a status change never re-runs the
  // schedule effect (which would PUT the same edits again, forever).
  const statusRef = useRef<AutosaveStatus>('idle')
  const mark = useCallback((s: AutosaveStatus) => {
    statusRef.current = s
    setStatus(s)
  }, [])
  const hash = useRef(initialHash)
  const presentRef = useRef(present)
  presentRef.current = present
  /** The edits object the server holds right now. */
  const saved = useRef(present)
  const onAdopt = useRef(opts.onAdopt)
  onAdopt.current = opts.onAdopt
  const timer = useRef<number | null>(null)
  const fails = useRef(0)
  const running = useRef<Promise<void> | null>(null)
  const again = useRef(false)
  const live = useRef(true)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const schedule = useCallback(
    (ms: number) => {
      clearTimer()
      if (!live.current) return
      timer.current = window.setTimeout(() => {
        timer.current = null
        void saveRef.current()
      }, ms)
    },
    [clearTimer]
  )

  const saveOnce = async () => {
    const edits = presentRef.current
    if (edits === saved.current || statusRef.current === 'conflict') return
    mark('saving')
    try {
      const v = await helpVideoApi(client).saveDraft(videoId, edits, hash.current)
      hash.current = v.edits_hash
      saved.current = edits
      if (
        onAdopt.current &&
        v.edits &&
        presentRef.current === edits &&
        stable(v.edits) !== stable(edits)
      ) {
        saved.current = v.edits
        // The editor shows the stored copy from its next render on; until
        // then a flush (Close, publish) must already see it as saved.
        presentRef.current = v.edits
        onAdopt.current(edits, v.edits)
      }
      fails.current = 0
      setRetryInMs(null)
      setMessage(null)
      mark('saved')
      setRefreshing((n) => n + 1)
      void qc
        .invalidateQueries({ queryKey: helpVideoKeys.one(videoId) })
        .catch(() => undefined)
        .finally(() => {
          if (live.current) setRefreshing((n) => Math.max(0, n - 1))
        })
    } catch (err) {
      const e = helpVideoError(err)
      if (e?.status === 409 && e.code === 'HELP_VIDEO_EDITS_CONFLICT') {
        clearTimer()
        setRetryInMs(null)
        setMessage('These edits changed in another tab. Reload to continue.')
        mark('conflict')
      } else if (e?.status === 422) {
        setRetryInMs(null)
        setMessage((err as Error).message || 'These edits could not be saved.')
        mark('invalid')
      } else {
        const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** fails.current)
        fails.current += 1
        setRetryInMs(delay)
        // The delay grows to a minute; a fixed number would go stale.
        setMessage("Couldn't save your latest changes. Trying again shortly.")
        mark('error')
        schedule(delay)
      }
    }
  }

  // One save at a time. A call while one runs asks for another pass, which
  // runs only if the running one succeeded (a failure has its own retry).
  const save = (): Promise<void> => {
    if (running.current) {
      again.current = true
      return running.current
    }
    const p = (async () => {
      try {
        do {
          again.current = false
          await saveOnce()
        } while (again.current && statusRef.current === 'saved')
      } finally {
        running.current = null
      }
    })()
    running.current = p
    return p
  }
  saveRef.current = save

  // Schedules a save 1 s after a change — and only on a change.
  useEffect(() => {
    if (statusRef.current === 'conflict') return
    if (present === saved.current) {
      // Back to what the server holds (an undo, or the adopted copy).
      if (!running.current) {
        clearTimer()
        if (statusRef.current === 'error' || statusRef.current === 'invalid') {
          fails.current = 0
          setRetryInMs(null)
          setMessage(null)
          mark('saved')
        }
      }
      return
    }
    // A pending retry gives way to the regular delay after a fresh change.
    schedule(DEBOUNCE_MS)
  }, [present, mark, clearTimer, schedule])

  // Leaving the editor saves what's waiting; nothing retries after that.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      clearTimer()
      if (presentRef.current !== saved.current && statusRef.current !== 'conflict')
        void saveRef.current()
    }
  }, [clearTimer])

  /** Saves whatever is waiting right now (Close, tab switches, publish).
   *  Resolves true when the server holds the latest edits. */
  const flush = useCallback(async (): Promise<boolean> => {
    clearTimer()
    await saveRef.current()
    return presentRef.current === saved.current && statusRef.current !== 'conflict'
  }, [clearTimer])

  const unsaved =
    present !== saved.current ||
    status === 'saving' ||
    status === 'error' ||
    status === 'invalid' ||
    status === 'conflict'
  useLeaveWarning(unsaved)

  return {
    status,
    message,
    hash: hash.current,
    retryInMs,
    unsaved,
    /** True from a save landing until the refetched video arrives. */
    refreshing: refreshing > 0,
    flush
  }
}
