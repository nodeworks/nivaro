import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { liveMotionAllowed, useLiveBusy } from './live-preference'

/**
 * Screens that update live without moving under the person (realtime program 2026-11-14).
 *
 * The live-query bridge (live-queries.ts) decides WHEN a screen's reads refetch. This file is
 * what a screen does with the fresh answer so the change lands quietly:
 *
 * - `useSettledRows` — a list whose rows may leave or arrive while someone works in it. Rows
 *   never reorder under the pointer or keyboard focus, a row that left stays where it was in a
 *   calm "departed" state until the person's next interaction away from it (never while the
 *   pointer is on it or something holds it, like an open confirm), and rows that arrive while
 *   the list is held are added at the end.
 * - `holdTopInserts` / `useTopInserts` — a newest-first feed (notifications): new rows slide in
 *   at the top only while the person is scrolled at the top; otherwise they wait behind a quiet
 *   "3 new" pill and the rows on screen keep their order.
 * - `useLiveFade` — the changed figure fades in (Web Animations; reduced motion: none). Only
 *   text that changed while the screen was armed by a background refresh fades; first loads,
 *   typing and the person's own clicks do not.
 * - `updatedAgoLabel` — "Updated 10 s ago" for a hover/focus-only footer.
 *
 * Nothing here reads data or talks to the server.
 */

// ── Settled rows ──────────────────────────────────────────────────────────

export interface SettledRow<T> {
  key: string
  row: T
  /** `departed`: no longer in the server's answer, still shown (calmly) where it was. */
  state: 'live' | 'departed'
}

export interface SettleOptions {
  /** The pointer or keyboard focus is in the list: keep the order, append arrivals at the end. */
  frozen: boolean
  /** Keys of departed rows that may now leave (an interaction happened since they left). */
  mayLeave?: ReadonlySet<string> | ((key: string) => boolean)
  /** Keys that never leave, whatever happened (pointer on it, its confirm is open). */
  held?: ReadonlySet<string>
  /** Keys whose departure is expected (the person's own decision): they leave at once. */
  released?: ReadonlySet<string>
}

const has = (s: ReadonlySet<string> | ((k: string) => boolean) | undefined, k: string) =>
  !s ? false : typeof s === 'function' ? s(k) : s.has(k)

/**
 * Fold a fresh server answer into what is on screen (pure; exported for tests).
 *
 * Frozen: the shown order stays; rows still present take their new data in place, rows gone
 * from the answer stay as `departed`, new rows go to the end. Not frozen: the server's order,
 * with departed rows kept next to the row they followed until they may leave.
 */
export function settleRows<T>(
  prev: readonly SettledRow<T>[],
  next: readonly T[],
  keyOf: (row: T) => string,
  opts: SettleOptions
): SettledRow<T>[] {
  const nextByKey = new Map<string, T>()
  for (const r of next) nextByKey.set(keyOf(r), r)
  const keepDeparted = (k: string) =>
    !has(opts.released, k) && (has(opts.held, k) || !has(opts.mayLeave, k))

  if (opts.frozen) {
    const out: SettledRow<T>[] = []
    const seen = new Set<string>()
    for (const p of prev) {
      seen.add(p.key)
      const fresh = nextByKey.get(p.key)
      if (fresh !== undefined) out.push({ key: p.key, row: fresh, state: 'live' })
      else if (!has(opts.released, p.key)) out.push({ key: p.key, row: p.row, state: 'departed' })
    }
    for (const r of next) {
      const k = keyOf(r)
      if (!seen.has(k)) out.push({ key: k, row: r, state: 'live' })
    }
    return out
  }

  const out: SettledRow<T>[] = next.map((r) => ({ key: keyOf(r), row: r, state: 'live' as const }))
  // Departed rows (already, or just now) that stay: placed after the nearest row they followed.
  const stays: Array<{ row: SettledRow<T>; after: string | null }> = []
  let lastKey: string | null = null
  for (const p of prev) {
    if (!nextByKey.has(p.key) && keepDeparted(p.key))
      stays.push({ row: { key: p.key, row: p.row, state: 'departed' }, after: lastKey })
    lastKey = p.key
  }
  for (const s of stays) {
    const at = s.after == null ? -1 : out.findIndex((r) => r.key === s.after)
    if (at < 0 && s.after != null) {
      // The row it followed left too: keep it after whatever precedes in the old order.
      const before = prev.slice(
        0,
        prev.findIndex((p) => p.key === s.row.key)
      )
      let idx = -1
      for (let i = before.length - 1; i >= 0 && idx < 0; i--)
        idx = out.findIndex((r) => r.key === before[i].key)
      out.splice(idx + 1, 0, s.row)
    } else out.splice(at + 1, 0, s.row)
  }
  return out
}

export interface SettledRowsOptions {
  /** Off: the server's rows as they are (no holding, nothing departs). */
  enabled?: boolean
  /** Keys that must not leave right now (an open confirm, a drawer on that row). */
  held?: Iterable<string>
  /**
   * The person's own view (search, sort, filter, tab): when it changes, the new answer shows
   * as it is — rows their filter dropped are not "departed", a sort they asked for applies.
   */
  resetKey?: string
}

export interface SettledRows<T> {
  rows: SettledRow<T>[]
  /** Put on the element that contains the rows (pointer / focus inside it holds the order). */
  containerRef: (el: HTMLElement | null) => void
  /** The person's own action removed these: let them go at once (no departed state). */
  release: (keys: Iterable<string>) => void
  /** Whether the list is holding its order right now (pointer or focus inside). */
  frozen: boolean
}

/**
 * `settleRows` with the person's pointer, focus and interactions wired in. A departed row
 * leaves at the first moment when the person has interacted (pointer down or a key) since it
 * left, the list is not held (pointer and focus outside it), and nothing holds the row.
 */
export function useSettledRows<T>(
  rows: readonly T[] | undefined,
  keyOf: (row: T) => string,
  opts: SettledRowsOptions = {}
): SettledRows<T> {
  const enabled = opts.enabled !== false
  const keyRef = useRef(keyOf)
  keyRef.current = keyOf
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const [interactions, setInteractions] = useState(0)
  /** key → the interaction count when it departed. */
  const departedAt = useRef(new Map<string, number>())
  /** Interactions (pointer down, key) seen so far. */
  const interactedAt = useRef(0)
  const released = useRef(new Set<string>())
  const [releaseTick, setReleaseTick] = useState(0)
  const heldKey = opts.held ? [...opts.held].sort().join('\u0001') : ''
  const [shown, setShown] = useState<SettledRow<T>[]>(() =>
    (rows ?? []).map((r) => ({ key: keyOf(r), row: r, state: 'live' as const }))
  )
  const viewKey = useRef(opts.resetKey)

  useEffect(() => {
    if (!el) return
    const enter = () => setPointerIn(true)
    const leave = () => setPointerIn(false)
    const fin = () => setFocusIn(true)
    const fout = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null
      if (!to || !el.contains(to)) setFocusIn(false)
    }
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('focusin', fin)
    el.addEventListener('focusout', fout)
    return () => {
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('focusin', fin)
      el.removeEventListener('focusout', fout)
    }
  }, [el])

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    const note = () => {
      interactedAt.current += 1
      // Only worth a render while something is waiting to leave.
      if (departedAt.current.size > 0) setInteractions((n) => n + 1)
    }
    document.addEventListener('pointerdown', note, true)
    document.addEventListener('keydown', note, true)
    return () => {
      document.removeEventListener('pointerdown', note, true)
      document.removeEventListener('keydown', note, true)
    }
  }, [enabled])

  // Calm (live-preference): the order also holds while the person is moving or typing anywhere,
  // until they pause; arrivals still append at the end meanwhile.
  const busy = useLiveBusy(enabled)
  const frozen = enabled && (pointerIn || focusIn || busy)

  // biome-ignore lint/correctness/useExhaustiveDependencies: interactions/releaseTick/heldKey re-run the fold
  useLayoutEffect(() => {
    if (rows === undefined) return
    const viewChanged = viewKey.current !== opts.resetKey
    viewKey.current = opts.resetKey
    if (!enabled || viewChanged) {
      departedAt.current.clear()
      const plain = rows.map((r) => ({ key: keyRef.current(r), row: r, state: 'live' as const }))
      setShown((prev) => (sameRows(prev, plain) ? prev : plain))
      return
    }
    setShown((prev) => {
      const held = new Set(opts.held ?? [])
      const next = settleRows(prev, rows, keyRef.current, {
        frozen,
        held,
        released: released.current,
        mayLeave: (k) =>
          (departedAt.current.get(k) ?? Number.POSITIVE_INFINITY) < interactedAt.current
      })
      // "Since it left" is counted in interactions, not milliseconds (same-tick events).
      const now = interactedAt.current
      const still = new Set<string>()
      for (const r of next) {
        if (r.state !== 'departed') continue
        still.add(r.key)
        if (!departedAt.current.has(r.key)) departedAt.current.set(r.key, now)
      }
      for (const k of [...departedAt.current.keys()])
        if (!still.has(k)) departedAt.current.delete(k)
      // A released key that is back in the answer is an ordinary row again.
      const present = new Set(rows.map((r) => keyRef.current(r)))
      for (const k of [...released.current]) if (present.has(k)) released.current.delete(k)
      return sameRows(prev, next) ? prev : next
    })
  }, [rows, enabled, frozen, interactions, releaseTick, heldKey, opts.resetKey])

  const release = useCallback((keys: Iterable<string>) => {
    for (const k of keys) released.current.add(String(k))
    setReleaseTick((n) => n + 1)
  }, [])

  return { rows: shown, containerRef: setEl, release, frozen }
}

function sameRows<T>(a: readonly SettledRow<T>[], b: readonly SettledRow<T>[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++)
    if (a[i].key !== b[i].key || a[i].row !== b[i].row || a[i].state !== b[i].state) return false
  return true
}

// ── Newest-first feeds: new rows wait while the person is scrolled down ─────

export interface TopInsertResult<T> {
  rows: T[]
  /** New rows waiting above (shown once the person is at the top or presses the pill). */
  held: number
}

/**
 * Pure (exported for tests). `shown`: keys on screen now (null = nothing yet). At the top, the
 * answer as it is. Scrolled down: rows on screen keep their order (taking new data), rows that
 * arrived ahead of every shown row are held back and counted, other arrivals go to the end.
 */
export function holdTopInserts<T>(
  shown: readonly string[] | null,
  next: readonly T[],
  keyOf: (row: T) => string,
  atTop: boolean
): TopInsertResult<T> {
  if (shown === null || atTop) return { rows: [...next], held: 0 }
  const shownSet = new Set(shown)
  const byKey = new Map<string, T>()
  for (const r of next) byKey.set(keyOf(r), r)
  let held = 0
  let leading = true
  const tail: T[] = []
  for (const r of next) {
    const k = keyOf(r)
    if (shownSet.has(k)) {
      leading = false
      continue
    }
    if (leading) held++
    else tail.push(r)
  }
  // Nothing on screen is in the answer any more (a whole page changed): show the answer.
  if (leading) return { rows: [...next], held: 0 }
  const kept: T[] = []
  for (const k of shown) {
    const r = byKey.get(k)
    if (r !== undefined) kept.push(r)
  }
  return { rows: [...kept, ...tail], held }
}

export interface TopInserts<T> {
  rows: T[]
  held: number
  /** Show the held rows (scrolls the feed to the top). */
  reveal: () => void
  /** Put on the feed's root element (its nearest scrolling ancestor is watched). */
  rootRef: (el: HTMLElement | null) => void
  /** Keys that slid in with the last reveal (for the entrance animation). */
  arrived: ReadonlySet<string>
}

/** Nearest ancestor that scrolls vertically (the document's scroller as a last resort). */
export function scrollParentOf(el: Element | null): HTMLElement | null {
  if (typeof window === 'undefined') return null
  let cur = el?.parentElement ?? null
  while (cur) {
    const s = window.getComputedStyle(cur)
    if (/(auto|scroll|overlay)/.test(s.overflowY) && cur.scrollHeight > cur.clientHeight) return cur
    cur = cur.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

const AT_TOP_SLACK = 24

/**
 * `holdTopInserts` wired to the feed's scroller. `resetKey` (a filter, a page) starts over:
 * whatever the new view's first answer is shows as it is.
 */
export function useTopInserts<T>(
  rows: readonly T[] | undefined,
  keyOf: (row: T) => string,
  opts: { enabled?: boolean; resetKey?: string } = {}
): TopInserts<T> {
  const enabled = opts.enabled !== false
  const keyRef = useRef(keyOf)
  keyRef.current = keyOf
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const [atTop, setAtTop] = useState(true)
  const shownRef = useRef<string[] | null>(null)
  const resetRef = useRef(opts.resetKey)
  const [revealTick, setRevealTick] = useState(0)
  const arrivedRef = useRef<ReadonlySet<string>>(new Set())
  const scrollerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!root) return
    const sc = scrollParentOf(root)
    scrollerRef.current = sc
    if (!sc) return
    const target: HTMLElement | Window =
      sc === document.scrollingElement || sc === document.documentElement ? window : sc
    const read = () => setAtTop(sc.scrollTop <= AT_TOP_SLACK)
    read()
    target.addEventListener('scroll', read, { passive: true })
    return () => target.removeEventListener('scroll', read)
  }, [root])

  const bump = useCallback(() => setRevealTick((n) => n + 1), [])
  const reveal = useRevealer(scrollerRef, setAtTop, bump)

  if (resetRef.current !== opts.resetKey) {
    resetRef.current = opts.resetKey
    shownRef.current = null
  }

  let result: TopInsertResult<T>
  if (rows === undefined) result = { rows: [], held: 0 }
  else if (!enabled) {
    // Not tracking (another view's placeholder, a later page): the next enabled answer is new.
    shownRef.current = null
    arrivedRef.current = EMPTY_KEYS
    return { rows: [...rows], held: 0, reveal, rootRef: setRoot, arrived: EMPTY_KEYS }
  } else result = holdTopInserts(shownRef.current, rows, keyRef.current, atTop)
  void revealTick // a reveal re-renders with the held rows shown

  const keys = result.rows.map((r) => keyRef.current(r))
  const before = shownRef.current
  if (rows !== undefined) {
    if (before) {
      const was = new Set(before)
      const fresh = keys.filter((k) => !was.has(k))
      if (fresh.length > 0) arrivedRef.current = new Set(fresh)
    } else arrivedRef.current = EMPTY_KEYS
    shownRef.current = keys
  }

  return {
    rows: result.rows,
    held: result.held,
    reveal,
    rootRef: setRoot,
    arrived: arrivedRef.current
  }
}

const EMPTY_KEYS: ReadonlySet<string> = new Set()

function useRevealer(
  scrollerRef: RefObject<HTMLElement | null>,
  setAtTop: (v: boolean) => void,
  bump: () => void
): () => void {
  return useCallback(() => {
    const sc = scrollerRef.current
    let smooth = true
    try {
      smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    } catch {
      /* default smooth */
    }
    sc?.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
    setAtTop(true)
    bump()
  }, [scrollerRef, setAtTop, bump])
}

/** Slide rows `keys` (matched by `data-live-key`) in under `root`. Reduced motion: nothing. */
export function slideIn(root: ParentNode | null | undefined, keys: Iterable<string>): void {
  if (!root || typeof window === 'undefined' || reducedMotion()) return
  for (const k of keys) {
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(k) : k.replace(/"/g, '\\"')
    const row = root.querySelector(`[data-live-key="${esc}"]`) as HTMLElement | null
    if (!row || typeof row.animate !== 'function') continue
    row.animate(
      [
        { opacity: 0, transform: 'translateY(-6px)' },
        { opacity: 1, transform: 'none' }
      ],
      { duration: 280, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    )
  }
}

// ── Changed figures fade in ───────────────────────────────────────────────

/** No live motion: reduced motion, or live updates set to Calm/Off (lib/live-preference.ts). */
function reducedMotion(): boolean {
  return !liveMotionAllowed()
}

const NO_FADE =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-live-nofade]'
const MAX_FADES = 60

/**
 * The elements a batch of DOM mutations changed, worth fading (pure-ish; exported for tests):
 * the parent of changed text, or an added element. Never inside an editor or a
 * `data-live-nofade` area, never the focused element's subtree, never the root itself.
 */
export function fadeTargets(
  root: Element,
  records: readonly Pick<MutationRecord, 'type' | 'target' | 'addedNodes'>[],
  active: Element | null = typeof document === 'undefined' ? null : document.activeElement
): Element[] {
  const out = new Set<Element>()
  const consider = (el: Element | null) => {
    if (!el || el === root || !root.contains(el) || out.size >= MAX_FADES) return
    if (el.closest(NO_FADE)) return
    if (active && active !== document.body && (el.contains(active) || active.contains(el))) return
    for (const o of out) if (o.contains(el)) return
    for (const o of [...out]) if (el.contains(o)) out.delete(o)
    out.add(el)
  }
  for (const r of records) {
    if (r.type === 'characterData') consider((r.target as Node).parentElement)
    else if (r.type === 'childList') {
      const t = r.target as Element
      let addedText = false
      for (const n of Array.from(r.addedNodes)) {
        if (n.nodeType === 1) consider(n as Element)
        else if (n.nodeType === 3 && (n.textContent ?? '').trim()) addedText = true
      }
      if (addedText) consider(t.nodeType === 1 ? t : t.parentElement)
    }
  }
  return [...out]
}

export interface LiveFadeOptions {
  enabled?: boolean
  /** How long after an arm DOM changes count as the live change (default 1.2 s). */
  windowMs?: number
}

/** How far back an arm reaches: the DOM may change a moment before the screen says why. */
const FADE_LOOKBACK_MS = 600

function fadeIn(targets: Element[]): void {
  for (const t of targets) {
    const h = t as HTMLElement
    if (!h.isConnected || typeof h.animate !== 'function') continue
    h.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' })
  }
}

/**
 * Fade in what changed under the element when `armKey` changes (pass the time the screen's data
 * was refreshed in the background — not on first load). Returns a callback ref for the element.
 * Changes seen up to 0.6 s before the arm and for `windowMs` after it fade; anything else (the
 * first render, typing, opening a menu) does not. Order does not matter: an arm set in an
 * effect after the refreshed rows were drawn still fades them.
 */
export function useLiveFade(
  armKey: unknown,
  opts: LiveFadeOptions = {}
): (el: HTMLElement | null) => void {
  const enabled = opts.enabled !== false
  const windowMs = opts.windowMs ?? 1200
  const armedUntil = useRef(0)
  const firstKey = useRef(true)
  const recent = useRef<Array<{ at: number; targets: Element[] }>>([])
  const [el, setEl] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (firstKey.current) {
      firstKey.current = false
      return
    }
    if (armKey == null || armKey === 0 || armKey === false) return
    const now = Date.now()
    armedUntil.current = now + windowMs
    if (reducedMotion()) {
      recent.current = []
      return
    }
    const seen = new Set<Element>()
    for (const r of recent.current) {
      if (now - r.at > FADE_LOOKBACK_MS) continue
      for (const t of r.targets) seen.add(t)
    }
    recent.current = []
    fadeIn([...seen])
  }, [armKey, windowMs])

  useEffect(() => {
    if (!enabled || !el || typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver((records) => {
      const now = Date.now()
      const targets = fadeTargets(el, records)
      if (targets.length === 0) return
      if (now <= armedUntil.current) {
        if (!reducedMotion()) fadeIn(targets)
        return
      }
      const keep = recent.current.filter((r) => now - r.at <= FADE_LOOKBACK_MS)
      keep.push({ at: now, targets })
      recent.current = keep.slice(-20)
    })
    mo.observe(el, { subtree: true, childList: true, characterData: true })
    return () => {
      mo.disconnect()
      recent.current = []
    }
  }, [el, enabled])

  return setEl
}

// ── "Updated 10 s ago" ─────────────────────────────────────────────────────

/** Footer text for a live figure's freshness; null before the first answer. */
export function updatedAgoLabel(at: number | null | undefined, now = Date.now()): string | null {
  if (!at) return null
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 5) return 'Updated just now'
  if (s < 60) return `Updated ${s} s ago`
  if (s < 3600) return `Updated ${Math.round(s / 60)} min ago`
  if (s < 86400) return `Updated ${Math.round(s / 3600)} h ago`
  return `Updated ${Math.round(s / 86400)} d ago`
}

/** `updatedAgoLabel` that re-reads the clock every 5 s while `active` (hovered / focused). */
export function useUpdatedAgo(at: number | null | undefined, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [active])
  return updatedAgoLabel(at, now)
}
