import { useEffect, useMemo, useState } from 'react'

/**
 * Change chips for figures that update live (realtime program 2026-11-14, idea 20).
 *
 * A count that quietly moves from 14 to 17 tells the person nothing about whether it moved
 * while they looked away. The chip says how far it moved: "+3 since this morning", or, when
 * nothing moved today, "−2 since yesterday". The baseline is the first value this browser saw
 * today (and the last value it saw on the day before). It lives in localStorage, per person and
 * per figure, so no new read, route or table is involved — a figure is only ever read once, the
 * way it already was.
 *
 * Only whole-number figures get a chip (a money total or a percentage has no honest "+3"). No
 * colour judgement: whether up is good depends on the figure, so the chip is neutral.
 */

export interface DeltaBaseline {
  /** Local calendar day this baseline belongs to (YYYY-MM-DD). */
  day: string
  /** The first value seen on `day`. */
  first: number
  /** Local hour (0–23) the first value was seen. */
  firstHour: number
  /** The latest value seen on `day`. */
  last: number
  /** The last value seen on the day before `day`; null when that day was not seen. */
  prevLast: number | null
}

export interface DeltaChip {
  delta: number
  /** `+3` / `−2`, with a real minus sign. */
  sign: string
  since: 'this morning' | 'earlier today' | 'yesterday'
  /** The whole phrase: "+3 since this morning". */
  text: string
}

/** A whole-number tile value ("1,204", "-3", "7") as a number; anything else is not a count. */
export function parseCount(value: string | null | undefined): number | null {
  if (value == null) return null
  const t = String(value).trim().replace(/−/g, '-')
  if (!/^-?\d{1,3}(,\d{3})*$|^-?\d+$/.test(t)) return null
  const n = Number(t.replace(/,/g, ''))
  return Number.isSafeInteger(n) ? n : null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function yesterdayKey(now: Date): string {
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return dayKey(y)
}

/** Fold one seen value into the baseline (pure). */
export function advanceBaseline(
  prev: DeltaBaseline | null,
  value: number,
  now: Date = new Date()
): DeltaBaseline {
  const today = dayKey(now)
  if (!prev)
    return { day: today, first: value, firstHour: now.getHours(), last: value, prevLast: null }
  if (prev.day === today) return prev.last === value ? prev : { ...prev, last: value }
  return {
    day: today,
    first: value,
    firstHour: now.getHours(),
    last: value,
    // Only the day right before counts as "yesterday"; an older visit is no baseline.
    prevLast: prev.day === yesterdayKey(now) ? prev.last : null
  }
}

/** The chip a baseline justifies right now, or null (nothing moved). */
export function deltaChip(b: DeltaBaseline | null): DeltaChip | null {
  if (!b) return null
  let delta = b.last - b.first
  let since: DeltaChip['since'] = b.firstHour < 12 ? 'this morning' : 'earlier today'
  if (delta === 0) {
    if (b.prevLast == null || b.prevLast === b.last) return null
    delta = b.last - b.prevLast
    since = 'yesterday'
  }
  const sign = `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString('en-US')}`
  return { delta, sign, since, text: `${sign} since ${since}` }
}

// ── Storage (best effort: private windows and blocked storage just mean no chip) ───────

const KEY_PREFIX = 'nvr:chip:'

export function readBaseline(storeKey: string): DeltaBaseline | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + storeKey)
    if (!raw) return null
    const b = JSON.parse(raw) as Partial<DeltaBaseline>
    if (
      typeof b.day !== 'string' ||
      !Number.isFinite(b.first) ||
      !Number.isFinite(b.last) ||
      !Number.isFinite(b.firstHour)
    )
      return null
    return {
      day: b.day,
      first: Number(b.first),
      firstHour: Number(b.firstHour),
      last: Number(b.last),
      prevLast: b.prevLast == null || !Number.isFinite(b.prevLast) ? null : Number(b.prevLast)
    }
  } catch {
    return null
  }
}

function writeBaseline(storeKey: string, b: DeltaBaseline): void {
  try {
    localStorage.setItem(KEY_PREFIX + storeKey, JSON.stringify(b))
  } catch {
    // no storage: the chip simply does not carry over a reload
  }
}

/**
 * The change chip for one figure. `storeKey` names the person and the figure
 * (`<user id>:<figure key>`); `value` is what the figure shows now — pass null while it is
 * loading or failed (a placeholder is never a baseline). Returns null for non-count values and
 * while nothing has moved.
 */
export function useChangeChip(
  storeKey: string,
  value: string | null | undefined,
  enabled = true
): DeltaChip | null {
  const n = enabled ? parseCount(value) : null
  const [baseline, setBaseline] = useState<DeltaBaseline | null>(() =>
    enabled ? readBaseline(storeKey) : null
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: storeKey change re-reads below
  useEffect(() => {
    setBaseline(enabled ? readBaseline(storeKey) : null)
  }, [storeKey, enabled])
  useEffect(() => {
    if (n == null) return
    setBaseline((prev) => {
      const next = advanceBaseline(prev ?? readBaseline(storeKey), n)
      if (next !== prev) writeBaseline(storeKey, next)
      return next
    })
  }, [n, storeKey])
  return useMemo(() => (n == null ? null : deltaChip(advanceBaseline(baseline, n))), [n, baseline])
}
