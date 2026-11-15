import { useSyncExternalStore } from 'react'
import { serverNow } from './server-clock'

/**
 * Live deadline countdowns (realtime round 2): "due in 1 h 59 m" on a record and in lists,
 * turning amber and red at the SLA rule's own lines — counted here, from the instants the
 * server already sent (`warning_at` / `due_at`, api services/sla-deadline.ts), with no read
 * per tick. ONE shared ticker for the whole page (every countdown re-renders on the same
 * beat), paused while the tab is hidden and caught up the moment it is shown again.
 * Times come from `serverNow()`, so a drifting machine clock does not run them early or late.
 */

export const DEADLINE_TICK_MS = 30_000

const listeners = new Set<() => void>()
let now = serverNow()
let timer: ReturnType<typeof setInterval> | null = null

function beat(): void {
  now = serverNow()
  for (const l of listeners) l()
}

function onVisibility(): void {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'visible') {
    beat()
    if (!timer) timer = setInterval(beat, DEADLINE_TICK_MS)
  } else if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    // The first countdown on screen: start from the current time, not a stale beat.
    now = serverNow()
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (!hidden) timer = setInterval(beat, DEADLINE_TICK_MS)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      if (timer) clearInterval(timer)
      timer = null
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

const snapshot = () => now

/** The shared page clock for countdowns (epoch ms, server time); moves every DEADLINE_TICK_MS. */
export function useDeadlineNow(enabled = true): number {
  const t = useSyncExternalStore(enabled ? subscribe : noopSubscribe, snapshot, snapshot)
  return enabled ? t : serverNow()
}

function noopSubscribe(): () => void {
  return () => {}
}

// ── Pure math (tested) ──────────────────────────────────────────────────────

export interface DeadlineLines {
  /** When the clock turns amber (ISO or epoch ms); null/absent = no warning line. */
  warning_at?: string | number | null
  /** When the clock turns red. */
  due_at?: string | number | null
}

export type LiveDeadlineStatus = 'on_track' | 'warning' | 'breached'

function ms(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null
  const t = typeof v === 'number' ? v : new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/** Where the clock stands at `at`; null when there is no due instant to judge by. */
export function liveDeadlineStatus(d: DeadlineLines, at: number): LiveDeadlineStatus | null {
  const due = ms(d.due_at)
  if (due == null) return null
  if (at >= due) return 'breached'
  const warn = ms(d.warning_at)
  if (warn != null && at >= warn) return 'warning'
  return 'on_track'
}

/** "3 d 4 h", "1 h 59 m", "45 m", "under a minute" — a span in whole minutes, never seconds. */
export function countdownText(spanMs: number): string {
  const totalMin = Math.floor(Math.abs(spanMs) / 60_000)
  if (totalMin < 1) return 'under a minute'
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} m` : `${hours} h`
  return `${mins} m`
}

/** "due in 1 h 59 m" / "overdue by 2 h 5 m"; null without a due instant. */
export function dueInText(d: DeadlineLines, at: number): string | null {
  const due = ms(d.due_at)
  if (due == null) return null
  return at >= due ? `overdue by ${countdownText(at - due)}` : `due in ${countdownText(due - at)}`
}

/** Hours left to the due instant (negative once past), for readers that speak hours. */
export function hoursLeft(d: DeadlineLines, at: number): number | null {
  const due = ms(d.due_at)
  return due == null ? null : (due - at) / 3_600_000
}

/**
 * The next instant the colour changes after `at` (the warning line, then the due line); null
 * when it will not change again. A page that wants one exact refetch at the flip reads this.
 */
export function nextDeadlineFlip(d: DeadlineLines, at: number): number | null {
  for (const t of [ms(d.warning_at), ms(d.due_at)]) if (t != null && t > at) return t
  return null
}

/**
 * An SLA reading kept current between reads: the server's `status` / `remaining_hours`, moved
 * on by the shared clock when the reading carries its instants. A reading without them (an
 * older server, a due-date based row) is returned as it came.
 */
export function liveSlaReading<
  T extends {
    status: 'ok' | 'warning' | 'breached' | null
    remaining_hours: number | null
    warning_at?: string | null
    due_at?: string | null
  }
>(s: T, at: number): T {
  const live = liveDeadlineStatus(s, at)
  if (!live) return s
  return {
    ...s,
    status: live === 'on_track' ? 'ok' : live,
    remaining_hours: hoursLeft(s, at)
  }
}
