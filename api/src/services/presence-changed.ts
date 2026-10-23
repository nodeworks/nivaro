/**
 * `presence:changed` coalescing (post-mortem 2026-10-23).
 *
 * The socket server told every browser of the tenant on EVERY presence write — each connect
 * (reconnects and extra tabs included), disconnect and idle flip — and every browser re-read
 * the online list on each one. With ~45 people that was a refetch storm that pegged the event
 * loop. Now, per tenant:
 *   - the first change goes out at once (leading edge), so one person arriving shows instantly;
 *   - further changes inside the window are gathered and go out as ONE event when it closes,
 *     carrying every changed id; while changes keep coming the window keeps rolling, so a
 *     tenant hears at most one event per window.
 *
 * Payload: `{ user_id: <first id>, user_ids: [...ids] }` — `user_id` stays so clients that
 * read only it keep working. Past MAX_IDS the list is cut and `many: true` says "treat it as
 * everyone". Ids only, never presence values (realtime payload rule).
 *
 * State is keyed by tenant ('' self-hosted) and lives per process; each replica coalesces its
 * own writes.
 */

export const PRESENCE_CHANGED_WINDOW_MS = 2000
export const PRESENCE_CHANGED_MAX_IDS = 200

export interface PresenceChangedPayload {
  user_id: string
  user_ids: string[]
  many?: true
}

export interface PresenceChangedCoalescer {
  /** A person's presence changed in `tenant`. */
  note(tenant: string, userId: string): void
  /** Drop every open window (shutdown, tests). Pending ids are not sent. */
  dispose(): void
  stats(): { emitted: number; noted: number; open_windows: number }
}

export function payloadFor(ids: string[]): PresenceChangedPayload {
  const many = ids.length > PRESENCE_CHANGED_MAX_IDS
  const list = many ? ids.slice(0, PRESENCE_CHANGED_MAX_IDS) : ids
  return { user_id: list[0], user_ids: list, ...(many ? { many: true as const } : {}) }
}

export function createPresenceChangedCoalescer(
  emit: (tenant: string, payload: PresenceChangedPayload) => void,
  windowMs = PRESENCE_CHANGED_WINDOW_MS
): PresenceChangedCoalescer {
  // tenant → ids changed since the window opened (upper-cased key → id as written).
  const windows = new Map<
    string,
    { pending: Map<string, string>; timer: ReturnType<typeof setTimeout> }
  >()
  const counts = { emitted: 0, noted: 0 }

  const send = (tenant: string, ids: string[]) => {
    counts.emitted++
    try {
      emit(tenant, payloadFor(ids))
    } catch {
      /* best-effort */
    }
  }

  const open = (tenant: string) => {
    const timer = setTimeout(() => close(tenant), windowMs)
    ;(timer as { unref?: () => void }).unref?.()
    windows.set(tenant, { pending: new Map(), timer })
  }

  const close = (tenant: string) => {
    const w = windows.get(tenant)
    windows.delete(tenant)
    if (!w || w.pending.size === 0) return
    send(tenant, [...w.pending.values()])
    // Changes are still arriving: keep the window rolling so the next batch waits too.
    open(tenant)
  }

  return {
    note(tenant, userId) {
      if (!userId) return
      counts.noted++
      const w = windows.get(tenant)
      if (w) {
        w.pending.set(String(userId).toUpperCase(), String(userId))
        return
      }
      send(tenant, [String(userId)])
      open(tenant)
    },
    dispose() {
      for (const w of windows.values()) clearTimeout(w.timer)
      windows.clear()
    },
    stats: () => ({ ...counts, open_windows: windows.size })
  }
}
