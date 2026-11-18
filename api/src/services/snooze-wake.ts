import { currentTenantKey } from './tenant-rooms.js'
import { announceNotificationsRead } from './user-sync.js'

/**
 * A time snooze ends with no write at all (realtime gaps 2026-11-17, "no event when
 * snoozed_until passes"): the notification is back in the inbox and the unread count, but an
 * open bell, inbox or My Work kept the old answer until its next poll.
 *
 * Light by design — no cron, no table scan: when someone snoozes until a time, this process
 * arms ONE timer per (tenant, person, minute) that fires `read:changed` to that person's own
 * sockets just after that minute ends; their tabs re-read through the normal routes. Snoozes
 * further out than MAX_WAKE_MS, and timers lost to a restart, fall back to the clients' own
 * poll (they never depended on this). Ids and kinds only, never values.
 */

export const MAX_WAKE_MS = 24 * 60 * 60_000
/** How many wakes one process holds at most (a runaway bulk snooze cannot grow it). */
export const MAX_WAKES = 5000
/** Fire a moment after the snooze ends, so a read made then already sees it awake. */
export const WAKE_SLACK_MS = 1500

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** The wake key and delay for a snooze, or null when this process should not arm one.
 *  Pure — exported for tests. Wakes in the same minute share one key. */
export function planSnoozeWake(
  tenant: string,
  userId: string | null | undefined,
  until: Date | string | null | undefined,
  now = Date.now()
): { key: string; delayMs: number } | null {
  if (!userId || until == null) return null
  const at = until instanceof Date ? until.getTime() : Date.parse(String(until))
  if (!Number.isFinite(at)) return null
  // Every snooze ending inside one minute shares a wake at that minute's END, so the one that
  // ends last in it is already awake when the tabs re-read.
  const minute = Math.ceil(at / 60_000)
  const delayMs = minute * 60_000 - now + WAKE_SLACK_MS
  if (at <= now || delayMs > MAX_WAKE_MS) return null
  return { key: `${tenant}\u0001${String(userId).toUpperCase()}\u0001${minute}`, delayMs }
}

/** Arm the wake for a snooze that ends at `until`. Never throws. */
export function scheduleSnoozeWake(
  userId: string | null | undefined,
  until: Date | string | null | undefined
): void {
  try {
    const plan = planSnoozeWake(currentTenantKey(), userId, until)
    if (!plan || timers.has(plan.key) || timers.size >= MAX_WAKES) return
    const t = setTimeout(() => {
      timers.delete(plan.key)
      announceNotificationsRead(userId)
    }, plan.delayMs)
    t.unref?.()
    timers.set(plan.key, t)
  } catch {
    /* best-effort */
  }
}

/** Tests / shutdown: drop every armed wake. */
export function clearSnoozeWakes(): number {
  const n = timers.size
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  return n
}
