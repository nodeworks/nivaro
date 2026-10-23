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
 * The window is adaptive (load test 2026-10-23, 250 people ≈ 400 tabs: someone changes in
 * nearly every window). It starts at PRESENCE_CHANGED_WINDOW_MS, grows by
 * PRESENCE_CHANGED_WINDOW_GROWTH each window that closes with changes in it, up to
 * PRESENCE_CHANGED_MAX_WINDOW_MS, and shrinks by the same factor (never below the start) each
 * window that closes empty. A tenant quiet for a whole max window starts over at the start
 * size. The cap is deliberately small: the window only batches ids — spreading the refetches
 * is the client's job (packages/shared lib/presence-live.ts: at most one refresh per ~10 s per
 * tab), and the client's gap absorbs any server window shorter than it, so a change reaches
 * every tab within ≈ 12 s instead of server window + client gap stacked.
 *
 * Payload: `{ user_id: <first id>, user_ids: [...ids] }` — `user_id` stays so clients that
 * read only it keep working. Past MAX_IDS the list is cut and `many: true` says "treat it as
 * everyone". Ids only, never presence values (realtime payload rule).
 *
 * State is keyed by tenant ('' self-hosted) and lives per process; each replica coalesces its
 * own writes.
 */

export const PRESENCE_CHANGED_WINDOW_MS = 2000
export const PRESENCE_CHANGED_MAX_WINDOW_MS = 3000
export const PRESENCE_CHANGED_WINDOW_GROWTH = 1.5
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
  /** The window size `tenant` is on now (ms); the start size when it has none. */
  windowFor(tenant: string): number
}

export function payloadFor(ids: string[]): PresenceChangedPayload {
  const many = ids.length > PRESENCE_CHANGED_MAX_IDS
  const list = many ? ids.slice(0, PRESENCE_CHANGED_MAX_IDS) : ids
  return { user_id: list[0], user_ids: list, ...(many ? { many: true as const } : {}) }
}

export interface PresenceChangedWindowOptions {
  /** Start (quiet) window. */
  minMs?: number
  /** Largest window while changes keep arriving. */
  maxMs?: number
  /** A busy window multiplies the size by this; an empty one divides it. */
  growth?: number
  now?: () => number
}

export function createPresenceChangedCoalescer(
  emit: (tenant: string, payload: PresenceChangedPayload) => void,
  windowOpts: number | PresenceChangedWindowOptions = {}
): PresenceChangedCoalescer {
  // A plain number = a fixed window (the original signature).
  const o: PresenceChangedWindowOptions =
    typeof windowOpts === 'number' ? { minMs: windowOpts, maxMs: windowOpts } : windowOpts
  const minMs = Math.max(1, o.minMs ?? PRESENCE_CHANGED_WINDOW_MS)
  const maxMs = Math.max(minMs, o.maxMs ?? PRESENCE_CHANGED_MAX_WINDOW_MS)
  const growth = Math.max(1, o.growth ?? PRESENCE_CHANGED_WINDOW_GROWTH)
  const now = o.now ?? Date.now

  // tenant → ids changed since the window opened (upper-cased key → id as written).
  const windows = new Map<
    string,
    { pending: Map<string, string>; timer: ReturnType<typeof setTimeout> }
  >()
  // tenant → the size its windows are on, and when its last window closed. Kept only while
  // the size is above the start, so a quiet tenant holds nothing.
  const sizes = new Map<string, { size: number; closedAt: number }>()
  const counts = { emitted: 0, noted: 0 }

  const send = (tenant: string, ids: string[]) => {
    counts.emitted++
    try {
      emit(tenant, payloadFor(ids))
    } catch {
      /* best-effort */
    }
  }

  const sizeFor = (tenant: string): number => {
    const s = sizes.get(tenant)
    if (!s) return minMs
    // Quiet (no window open) for a whole max window: back to the start size.
    if (!windows.has(tenant) && now() - s.closedAt >= maxMs) {
      sizes.delete(tenant)
      return minMs
    }
    return s.size
  }

  const setSize = (tenant: string, size: number) => {
    const next = Math.min(maxMs, Math.max(minMs, Math.round(size)))
    if (next <= minMs) sizes.delete(tenant)
    else sizes.set(tenant, { size: next, closedAt: now() })
  }

  const open = (tenant: string) => {
    const timer = setTimeout(() => close(tenant), sizeFor(tenant))
    ;(timer as { unref?: () => void }).unref?.()
    windows.set(tenant, { pending: new Map(), timer })
  }

  const close = (tenant: string) => {
    const size = sizeFor(tenant)
    const w = windows.get(tenant)
    windows.delete(tenant)
    if (!w || w.pending.size === 0) {
      setSize(tenant, size / growth)
      return
    }
    send(tenant, [...w.pending.values()])
    // Changes are still arriving: a longer window, kept rolling so the next batch waits too.
    setSize(tenant, size * growth)
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
      sizes.clear()
    },
    stats: () => ({ ...counts, open_windows: windows.size }),
    windowFor: (tenant) => sizeFor(tenant)
  }
}
