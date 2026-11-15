import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveCollection } from './live'

/**
 * "Data changed since run · Refresh" (realtime program 2026-11-14, item 16).
 *
 * A custom query's answer is cached, so a figure on a page can sit there while the records it
 * reads move. The server already says WHICH tables a query reads (`freshness_sources`, declared
 * on the query or inferred from its SQL + the procedures it EXECs) and when the answer was
 * computed (`cached_at` / `executed_at`). This file adds the live half: while the figure is on
 * screen the page watches those tables; the first write after the run raises a quiet chip, and
 * Refresh (or, opt-in, an automatic refresh) re-runs the query past the cache.
 *
 * Unknown tables = no chip: a query with no `freshness_sources` (uncached, or nothing could be
 * inferred) is never watched. Writes made by raw SQL that announce nothing (a stored procedure
 * that never calls the announcer) cannot raise it either — the chip says "changed", never
 * "unchanged".
 */

/** What of a response the chip needs (a custom-query envelope, or a widget render's `cache`). */
export interface RunEnvelope {
  cached_at?: string | null
  executed_at?: string | null
  freshness_sources?: Array<{ table: string }> | null
}

/** The tables worth watching: distinct, in order; none when the response names none. */
export function watchedTables(envelope: RunEnvelope | null | undefined): string[] {
  const out: string[] = []
  for (const s of envelope?.freshness_sources ?? []) {
    const t = typeof s?.table === 'string' ? s.table.trim() : ''
    if (t && !out.includes(t)) out.push(t)
  }
  return out.slice(0, 12)
}

/** One value per run of the query: changes when the figure is recomputed. */
export function runStamp(envelope: RunEnvelope | null | undefined): string | null {
  return envelope?.cached_at ?? envelope?.executed_at ?? null
}

/** Does a batch of live events count as "the data changed"? Not a comment/lock/state-only notice. */
export function countsAsDataChange(batch: { aspectsOnly: boolean; events: unknown[] }): boolean {
  return !batch.aspectsOnly && batch.events.length > 0
}

/**
 * Watches `tables`; returns when the first write landed after the current run (`runKey`).
 * Changes with the run: a refresh (new `runKey`) clears it. Own writes count too — the figure
 * the person is looking at is just as old whoever changed the data.
 */
export function useDataChanged(
  tables: string[],
  runKey: string | null | undefined,
  enabled = true
): number | null {
  const [changedAt, setChangedAt] = useState<number | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runKey is the trigger
  useEffect(() => {
    setChangedAt(null)
  }, [runKey])
  const key = tables.join(',')
  useLiveCollection(
    key ? tables : null,
    (batch) => {
      if (countsAsDataChange(batch)) setChangedAt((prev) => prev ?? Date.now())
    },
    { debounceMs: 1000, includeOwn: true, enabled: enabled && key !== '' }
  )
  return changedAt
}

// ── Opt-in auto-refresh ───────────────────────────────────────────────────

const PREF_PREFIX = 'nvr:auto-refresh:'

/** The viewer's saved choice for a report / widget (this browser only). */
export function readAutoRefresh(scope: string): boolean {
  try {
    return localStorage.getItem(PREF_PREFIX + scope) === '1'
  } catch {
    return false
  }
}

export function writeAutoRefresh(scope: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_PREFIX + scope, '1')
    else localStorage.removeItem(PREF_PREFIX + scope)
  } catch {
    /* private window / blocked storage: the choice lasts until reload */
  }
}

export function useAutoRefreshPref(scope: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readAutoRefresh(scope))
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope is the trigger
  useEffect(() => {
    setOn(readAutoRefresh(scope))
  }, [scope])
  const set = useCallback(
    (v: boolean) => {
      writeAutoRefresh(scope, v)
      setOn(v)
    },
    [scope]
  )
  return [on, set]
}

/** Least time between two automatic refreshes of one figure. */
export const AUTO_REFRESH_MIN_GAP_MS = 15_000
/** Most automatic refreshes this browser tab starts in a minute, across every figure on it. */
export const AUTO_REFRESH_TAB_PER_MINUTE = 6

const tabStarts: number[] = []

/**
 * May this tab start another automatic refresh now? Records it when it says yes. The server
 * keeps its own limits (the read gate queues heavy reads; pushed widgets stop at
 * WIDGET_LIVE_MAX_PER_MIN) — this keeps one open page from adding to them without end.
 * Exported for tests (`starts` lets a test pass its own list).
 */
export function takeAutoRefreshSlot(
  now = Date.now(),
  starts: number[] = tabStarts,
  max = AUTO_REFRESH_TAB_PER_MINUTE
): boolean {
  while (starts.length > 0 && now - starts[0] >= 60_000) starts.shift()
  if (starts.length >= max) return false
  starts.push(now)
  return true
}

/**
 * When `enabled` and the data changed, call `refresh` — once per change, no sooner than
 * `minGapMs` after this figure's last automatic refresh, never while the tab is hidden (it
 * runs on return), and within the tab's per-minute budget (a refused slot retries in 10 s).
 */
export function useAutoRefreshOnChange(opts: {
  changedAt: number | null
  enabled: boolean
  refresh: () => void
  minGapMs?: number
}): void {
  const { changedAt, enabled } = opts
  const refreshRef = useRef(opts.refresh)
  refreshRef.current = opts.refresh
  const last = useRef(0)
  const handled = useRef<number | null>(null)
  const minGap = opts.minGapMs ?? AUTO_REFRESH_MIN_GAP_MS

  useEffect(() => {
    if (!enabled || changedAt == null || handled.current === changedAt) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const attempt = () => {
      timer = null
      if (document.hidden) return // the visibilitychange listener runs it
      if (!takeAutoRefreshSlot()) {
        timer = setTimeout(attempt, 10_000)
        return
      }
      handled.current = changedAt
      last.current = Date.now()
      refreshRef.current()
    }
    const onVisible = () => {
      if (!document.hidden && !timer && handled.current !== changedAt) {
        timer = setTimeout(attempt, 0)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    timer = setTimeout(attempt, Math.max(0, last.current + minGap - Date.now()))
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      if (timer) clearTimeout(timer)
    }
  }, [enabled, changedAt, minGap])
}

/**
 * Everything a stamp needs: whether the data changed since this run, and the viewer's opt-in
 * auto-refresh (the choice is kept per `scope`, e.g. `report:12` or `widget:7`).
 */
export function useLiveStamp(opts: {
  envelope: RunEnvelope | null | undefined
  scope: string
  refresh: () => void
  /** Another switch decides auto-refresh (a report-wide one): pass it instead of the saved choice. */
  autoOverride?: boolean
}) {
  const { envelope, scope, refresh, autoOverride } = opts
  const tables = useMemo(() => watchedTables(envelope), [envelope])
  const changedAt = useDataChanged(tables, runStamp(envelope), tables.length > 0)
  const [saved, setSaved] = useAutoRefreshPref(scope)
  const auto = autoOverride ?? saved
  useAutoRefreshOnChange({ changedAt, enabled: auto && tables.length > 0, refresh })
  return {
    /** Tables are known and one changed since the run (and auto-refresh is not already on it). */
    changed: changedAt != null && !auto,
    /** null when no table is known — nothing to offer. */
    autoRefresh:
      tables.length > 0 && autoOverride === undefined ? { on: saved, onChange: setSaved } : null
  }
}
