import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useActorNames, writerOf } from './live-list'

/**
 * How a live list takes in a stream of changes without getting in the way (realtime round 2,
 * 2026-11-14). live-list.ts says WHAT changed (flash, new mark, membership as the viewer);
 * this file decides WHEN and HOW MUCH reaches the screen:
 *
 * - Bursts (#10): an import or bulk change is one quiet pill ("Import added 500 records ·
 *   Show", "Beth updated 40 records · Show") instead of hundreds of row flashes; Show = one
 *   refetch. `createBurstTracker` / `useLiveBurst`.
 * - Pause (#11): "Pause live updates" on a list holds its feed (the button counts what is
 *   waiting) and Resume applies it in one go; remembered per list for the session.
 *   `useLivePause`.
 * - Steady rows (#12): nothing at or above the row under the pointer or keyboard focus moves;
 *   values still update in place, removed rows fade as "No longer in this list" until the
 *   pointer leaves (≤ 10 s). `planRowOrder` / `useSteadyRows`.
 * - Totals (#13): `totalsMayMove` says when a live change can have moved a totals row.
 */

// ── Bursts ────────────────────────────────────────────────────────────────

/**
 * What a list hears about one record (a plain or expanded-coalesced `collection:update`).
 * `source` is the server's 'import' / 'raw' marker; `bulk` the count of a write that named
 * no single record (`item: '*'`).
 */
export interface BurstEvent {
  item?: unknown
  action?: string
  source?: string
  bulk?: number
}

export interface BurstInfo {
  /** Records the burst touched (distinct ids, plus the counts of writes that named none). */
  count: number
  creates: number
  updates: number
  deletes: number
  /** 'import' / 'raw' when every event said so, else null. */
  source: 'import' | 'raw' | null
  /** A write named no records and gave no count: the count is a floor. */
  approx: boolean
  /** The first record ids (≤ 10) — one viewer read can name the writer. */
  sample: string[]
}

/** Distinct records inside BURST_WINDOW_MS that make a burst. A person editing never gets near. */
export const BURST_THRESHOLD = 12
export const BURST_WINDOW_MS = 2000
/** A burst ends after this long with nothing new; its pill stays until Show. */
export const BURST_QUIET_MS = 2500
const BURST_TRACK_MAX = 5000

export interface BurstTracker {
  /** Feed what arrived; true = it belongs to a burst (collapse it into the pill, no flashes). */
  push: (events: BurstEvent[], now?: number) => boolean
  /** The pill's burst (kept after it went quiet, until `clear`), or null. */
  current: () => BurstInfo | null
  /** Shown / refreshed: forget it. */
  clear: () => void
}

type Kind = 'create' | 'update' | 'delete'
const idOf = (ev: BurstEvent | null | undefined) =>
  ev?.item == null || String(ev.item) === '*' ? '*' : String(ev.item)

/**
 * Burst detection for a list feed: a write that named no single record (a bulk raw write),
 * or BURST_THRESHOLD distinct records within BURST_WINDOW_MS, starts a burst; everything
 * after it joins until BURST_QUIET_MS pass with nothing new. Records seen in the window before
 * it started count too, so the pill says the whole import.
 */
export function createBurstTracker(
  opts: { threshold?: number; windowMs?: number; quietMs?: number } = {}
): BurstTracker {
  const threshold = opts.threshold ?? BURST_THRESHOLD
  const windowMs = opts.windowMs ?? BURST_WINDOW_MS
  const quietMs = opts.quietMs ?? BURST_QUIET_MS
  let recent: Array<{ at: number; ev: BurstEvent }> = []
  let active = false
  let lastAt = 0
  let acc: {
    kinds: Map<string, Kind>
    extra: number
    overflow: Record<Kind, number>
    sources: Set<string>
    approx: boolean
  } | null = null

  const kindOf = (a?: string): Kind =>
    a === 'create' ? 'create' : a === 'delete' ? 'delete' : 'update'
  const add = (ev: BurstEvent) => {
    if (!acc) return
    acc.sources.add(ev.source === 'import' || ev.source === 'raw' ? ev.source : '')
    const id = idOf(ev)
    if (id === '*') {
      if (typeof ev.bulk === 'number' && ev.bulk > 0) acc.extra += ev.bulk
      else acc.approx = true
      return
    }
    const k = kindOf(ev.action)
    const prior = acc.kinds.get(id)
    if (prior) {
      // A create followed by updates stays a create; a delete is final.
      if (prior !== 'delete' && k === 'delete') acc.kinds.set(id, 'delete')
      return
    }
    if (acc.kinds.size >= BURST_TRACK_MAX) {
      acc.overflow[k]++
      return
    }
    acc.kinds.set(id, k)
  }

  return {
    push(events, now = Date.now()) {
      if (events.length === 0) return active
      if (active && now - lastAt > quietMs) active = false
      lastAt = now
      if (active) {
        for (const ev of events) add(ev)
        return true
      }
      recent = recent.filter((r) => now - r.at <= windowMs)
      for (const ev of events) recent.push({ at: now, ev })
      const ids = new Set<string>()
      let named = true
      for (const r of recent) {
        const id = idOf(r.ev)
        if (id === '*') named = false
        else ids.add(id)
      }
      if (named && ids.size < threshold) return false
      active = true
      if (!acc)
        acc = {
          kinds: new Map(),
          extra: 0,
          overflow: { create: 0, update: 0, delete: 0 },
          sources: new Set(),
          approx: false
        }
      for (const r of recent) add(r.ev)
      recent = []
      return true
    },
    current() {
      if (!acc) return null
      const n: Record<Kind, number> = { ...acc.overflow }
      for (const k of acc.kinds.values()) n[k]++
      const only = acc.sources.size === 1 ? [...acc.sources][0] : ''
      return {
        count: n.create + n.update + n.delete + acc.extra,
        creates: n.create,
        updates: n.update,
        deletes: n.delete,
        source: only === 'import' || only === 'raw' ? only : null,
        approx: acc.approx,
        sample: [...acc.kinds.keys()].slice(0, 10)
      }
    },
    clear() {
      acc = null
      active = false
      recent = []
    }
  }
}

/** "Import added 500 records" / "Beth updated 40 records" — the pill's words (before "· Show"). */
export function burstLabel(info: BurstInfo, who: string | null = null): string {
  const actor = who ?? (info.source === 'import' ? 'Import' : null)
  if (info.count === 0) return actor ? `${actor} changed many records` : 'Many records changed'
  const n = `${info.count.toLocaleString('en-US')}${info.approx ? '+' : ''}`
  const records = info.count === 1 && !info.approx ? 'record' : 'records'
  const kinds = [info.creates, info.updates, info.deletes].filter((c) => c > 0).length
  const only = (c: number) =>
    kinds === 1 && c > 0 && info.creates + info.updates + info.deletes === info.count
  if (only(info.creates)) return actor ? `${actor} added ${n} ${records}` : `${n} ${records} added`
  if (only(info.deletes))
    return actor ? `${actor} removed ${n} ${records}` : `${n} ${records} removed`
  if (only(info.updates))
    return actor ? `${actor} updated ${n} ${records}` : `${n} ${records} updated`
  return actor ? `${actor} changed ${n} ${records}` : `${n} ${records} changed`
}

/**
 * The writer of a burst, from the viewer's own read of a few of its rows (`writerOf`): one
 * person when every row that names a writer names the same one, else null.
 */
export function burstWriter(rows: Iterable<Record<string, unknown>>): string | null {
  let who: string | null = null
  for (const row of rows) {
    const w = writerOf(row)
    if (!w) continue
    if (who && who.toUpperCase() !== w.toUpperCase()) return null
    who = who ?? w
  }
  return who
}

export interface LiveBurst {
  /** The detector; feed it from the live handler (stable for the component's life). */
  tracker: BurstTracker
  /** Show the tracker's burst in the pill (call after a push that returned true). */
  publish: () => void
  /** Whether the writer still has to be read for the burst on show (asks once per burst). */
  claimWriterRead: () => boolean
  /** The writer read back as the viewer (null: nobody / several / unknown). */
  setWriter: (id: string | null) => void
  /** Pill words, or null when there is no burst to show. */
  label: string | null
  info: BurstInfo | null
  clear: () => void
}

/** A list's burst pill (#10): one detector, the pill's words, the writer's name. */
export function useLiveBurst(): LiveBurst {
  const tracker = useMemo(() => createBurstTracker(), [])
  const [info, setInfo] = useState<BurstInfo | null>(null)
  const [writer, setWriterState] = useState<string | null>(null)
  const askedRef = useRef(false)
  const names = useActorNames(writer ? [writer] : [])
  const publish = useCallback(() => setInfo(tracker.current()), [tracker])
  const claimWriterRead = useCallback(() => {
    if (askedRef.current) return false
    askedRef.current = true
    return true
  }, [])
  const setWriter = useCallback((id: string | null) => setWriterState(id), [])
  const clear = useCallback(() => {
    tracker.clear()
    askedRef.current = false
    setWriterState(null)
    setInfo(null)
  }, [tracker])
  const who = writer ? (names.get(writer) ?? null) : null
  const label = info ? burstLabel(info, who) : null
  return useMemo(
    () => ({ tracker, publish, claimWriterRead, setWriter, label, info, clear }),
    [tracker, publish, claimWriterRead, setWriter, label, info, clear]
  )
}

// ── Pause live updates on one list (#11) ─────────────────────────────────

/**
 * How many changes a held queue stands for: distinct records, plus the counts of writes that
 * named none (a bulk write with no count counts 1).
 */
export function heldChangeCount(events: Array<BurstEvent | null | undefined>): number {
  const ids = new Set<string>()
  let extra = 0
  for (const ev of events) {
    const id = idOf(ev)
    if (id === '*') extra += typeof ev?.bulk === 'number' && ev.bulk > 0 ? ev.bulk : 1
    else ids.add(id)
  }
  return ids.size + extra
}

/** A resume this big is applied as one refetch instead of record by record. */
export function resumeAsRefetch(events: Array<BurstEvent | null | undefined>): boolean {
  return events.some((e) => idOf(e) === '*') || heldChangeCount(events) >= BURST_THRESHOLD
}

const PAUSE_KEY = 'nvr:live-paused'
let pausedLists: Set<string> | null = null
const pauseListeners = new Set<() => void>()

function pausedSet(): Set<string> {
  if (pausedLists) return pausedLists
  pausedLists = new Set()
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(PAUSE_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(arr)) for (const k of arr) if (typeof k === 'string') pausedLists.add(k)
  } catch {
    /* blocked storage — nothing remembered */
  }
  return pausedLists
}

/** Is this list paused (remembered per list for the browser session)? */
export function isListPaused(listKey: string | null | undefined): boolean {
  return !!listKey && pausedSet().has(listKey)
}

export function setListPaused(listKey: string, paused: boolean): void {
  const set = pausedSet()
  if (set.has(listKey) === paused) return
  if (paused) set.add(listKey)
  else set.delete(listKey)
  try {
    sessionStorage.setItem(PAUSE_KEY, JSON.stringify([...set].slice(-100)))
  } catch {
    /* unsaved — still applies for this page */
  }
  for (const l of pauseListeners) l()
}

function subscribePaused(l: () => void) {
  pauseListeners.add(l)
  return () => {
    pauseListeners.delete(l)
  }
}

/** Re-renders when the list's paused state changes. */
export function useListPaused(listKey: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribePaused,
    () => isListPaused(listKey),
    () => false
  )
}

export interface LivePause<E> {
  paused: boolean
  /** Changes waiting (distinct records). */
  held: number
  /** Route each live delivery through this: applied now, or held while paused. */
  gate: (events: E[], apply: (events: E[]) => void) => void
  /** Pause / resume; resuming hands everything held to `onResume` in one go. */
  toggle: () => void
  /** The list re-read everything (Refresh / Show): what was held is already on screen. */
  dropHeld: () => void
}

const HELD_MAX = 2000

/**
 * "Pause live updates" for one list (#11): while paused, deliveries queue here (the button
 * shows the count); Resume hands them all to `onResume` at once. Remembered per list key for
 * the session; what was held lives with the mounted list (a list opened again reads fresh).
 */
export function useLivePause<E extends BurstEvent | null | undefined>(
  listKey: string | null | undefined,
  onResume: (held: E[]) => void
): LivePause<E> {
  const paused = useListPaused(listKey)
  const heldRef = useRef<E[]>([])
  const [held, setHeld] = useState(0)
  const resumeRef = useRef(onResume)
  resumeRef.current = onResume
  const keyRef = useRef(listKey)
  keyRef.current = listKey
  const gate = useCallback((events: E[], apply: (events: E[]) => void) => {
    if (!isListPaused(keyRef.current)) {
      apply(events)
      return
    }
    heldRef.current.push(...events)
    // A long pause keeps the newest changes; a resume that big refetches anyway.
    if (heldRef.current.length > HELD_MAX) heldRef.current = heldRef.current.slice(-HELD_MAX)
    setHeld(heldChangeCount(heldRef.current))
  }, [])
  const release = useCallback(() => {
    const events = heldRef.current
    heldRef.current = []
    setHeld(0)
    if (events.length > 0) resumeRef.current(events)
  }, [])
  const toggle = useCallback(() => {
    const key = keyRef.current
    if (!key) return
    const next = !isListPaused(key)
    setListPaused(key, next)
    if (!next) release()
  }, [release])
  const dropHeld = useCallback(() => {
    heldRef.current = []
    setHeld(0)
  }, [])
  // Resumed elsewhere (the same list open in another place): apply what this one held.
  useEffect(() => {
    if (!paused) release()
  }, [paused, release])
  return { paused, held, gate, toggle, dropHeld }
}

// ── Rows never move under the pointer or keyboard focus (#12) ────────────

export interface RowOrderPlan {
  /** Row keys in the order to draw. */
  order: string[]
  /** Kept in place but no longer in the list (drawn faded). */
  gone: string[]
  /** New rows that would land above the anchor: drawn once the hold ends. */
  hidden: string[]
  held: boolean
}

/**
 * Where to draw rows when the list's new order is `next` and the person's pointer / focus
 * rests on `anchors` (row keys; the lowest on screen counts). Nothing at or above it may move:
 * unless the rows up to it are the same rows in the same order, those rows stay put (removed
 * ones as `gone`), new rows that would land above it wait (`hidden`), and the rest follows
 * below in the new order. The caller draws each kept row from its newest data.
 */
export function planRowOrder(
  shown: string[],
  next: string[],
  anchors: Array<string | null | undefined>
): RowOrderPlan {
  let ai = -1
  for (const a of anchors) if (a != null) ai = Math.max(ai, shown.indexOf(a))
  if (ai < 0) return { order: next, gone: [], hidden: [], held: false }
  let same = next.length > ai
  for (let i = 0; same && i <= ai; i++) if (shown[i] !== next[i]) same = false
  if (same) return { order: next, gone: [], hidden: [], held: false }
  const prefix = shown.slice(0, ai + 1)
  const nextSet = new Set(next)
  const prefixSet = new Set(prefix)
  const shownSet = new Set(shown)
  const anchorNext = next.indexOf(shown[ai])
  const tail: string[] = []
  const hidden: string[] = []
  next.forEach((k, i) => {
    if (prefixSet.has(k)) return
    if (!shownSet.has(k) && (anchorNext < 0 || i < anchorNext)) hidden.push(k)
    else tail.push(k)
  })
  return {
    order: [...prefix, ...tail],
    gone: prefix.filter((k) => !nextSet.has(k)),
    hidden,
    held: true
  }
}

/** Longest a reorder waits for the pointer to leave or focus to move. */
export const ROW_HOLD_MAX_MS = 10_000

export const GONE_ROW_TITLE =
  'No longer matches this view — it leaves when you move the pointer away'
/** Faded look of a row kept only until the hold ends (light + dark). On the cells, not the row:
 *  the row's enter animation fills `both`, so its last frame (opacity 1) wins over a row class.
 *  A pinned (sticky) cell fades its content only: its opaque background must keep covering what
 *  scrolls under it. */
export const GONE_ROW_CLASS = '[&>td:not(.sticky)]:opacity-50 [&>td.sticky>*]:opacity-50'

export interface SteadyRows<T> {
  rows: T[]
  /** Kept on screen only until the hold ends: no longer in this list. */
  isGone: (key: string) => boolean
  holding: boolean
}

const EMPTY_SET: Set<string> = new Set()

/**
 * Draw `rows` without moving anything under the person's pointer or keyboard focus (#12):
 * while either rests on a row inside `rootRef` (rows carry `data-row-key`), a new order that
 * would move, insert or remove rows at or above it waits (planRowOrder) until the pointer
 * leaves the list, focus moves out of it, or ROW_HOLD_MAX_MS pass. Values update in place the
 * whole time. `resetKey` = the list's page/sort/filter key: a change there is the person's own
 * doing and is drawn at once.
 */
export function useSteadyRows<T>(
  rows: T[],
  keyOf: (row: T) => string,
  rootRef: React.RefObject<HTMLElement | null>,
  opts: { enabled?: boolean; resetKey?: string; maxHoldMs?: number } = {}
): SteadyRows<T> {
  const enabled = opts.enabled !== false
  const pointerRef = useRef<string | null>(null)
  const focusRef = useRef<string | null>(null)
  const shownRef = useRef<{ order: string[]; byKey: Map<string, T>; resetKey?: string }>({
    order: [],
    byKey: new Map()
  })
  const holdingRef = useRef(false)
  const [, setTick] = useState(0)

  // Pointer / focus anchors on the rows (re-attached when the list's element changes).
  const attachedRef = useRef<HTMLElement | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const el = enabled ? rootRef.current : null
    if (attachedRef.current === el) return
    detachRef.current?.()
    detachRef.current = null
    attachedRef.current = el
    pointerRef.current = null
    focusRef.current = null
    if (!el) return
    const rowKey = (t: EventTarget | null) =>
      t instanceof Element
        ? (t.closest('[data-row-key]')?.getAttribute('data-row-key') ?? null)
        : null
    const release = () => {
      if (holdingRef.current) setTick((n) => n + 1)
    }
    const onOver = (e: Event) => {
      pointerRef.current = rowKey(e.target)
    }
    const onLeave = () => {
      pointerRef.current = null
      release()
    }
    const onFocusIn = (e: Event) => {
      focusRef.current = rowKey(e.target)
    }
    const onFocusOut = (e: Event) => {
      const to = (e as FocusEvent).relatedTarget
      if (to instanceof Node && el.contains(to)) return
      focusRef.current = null
      release()
    }
    el.addEventListener('pointerover', onOver)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    detachRef.current = () => {
      el.removeEventListener('pointerover', onOver)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  })
  // Forget the element too: StrictMode runs this cleanup and the effects again on mount, and
  // the attach effect must then attach afresh (it skips an element it thinks it holds).
  useEffect(
    () => () => {
      detachRef.current?.()
      detachRef.current = null
      attachedRef.current = null
    },
    []
  )

  const nextKeys = rows.map(keyOf)
  const shown = shownRef.current
  const plan =
    enabled && shown.resetKey === opts.resetKey
      ? planRowOrder(shown.order, nextKeys, [pointerRef.current, focusRef.current])
      : null
  const holding = !!plan?.held

  // The longest hold: then draw the new order even if the pointer stays (moving re-arms it).
  const maxHoldMs = opts.maxHoldMs ?? ROW_HOLD_MAX_MS
  useEffect(() => {
    holdingRef.current = holding
    if (!holding) return
    const t = setTimeout(() => {
      pointerRef.current = null
      focusRef.current = null
      setTick((n) => n + 1)
    }, maxHoldMs)
    return () => clearTimeout(t)
  }, [holding, maxHoldMs])

  let out: T[] = rows
  let gone: Set<string> = EMPTY_SET
  let order = nextKeys
  if (plan?.held) {
    const byNext = new Map<string, T>()
    rows.forEach((r, i) => {
      byNext.set(nextKeys[i], r)
    })
    out = []
    order = []
    for (const k of plan.order) {
      const r = byNext.has(k) ? byNext.get(k) : shown.byKey.get(k)
      if (r === undefined) continue
      out.push(r as T)
      order.push(k)
    }
    gone = new Set(plan.gone)
  }
  // A row left the screen (a held row released, or a live removal): re-lay the rows once,
  // before paint. Chrome otherwise kept painting the pinned (sticky) cells of the rows that
  // moved up at their old offsets — dividers and text 2–3 px out of step with the row, while
  // their layout boxes were already right (design review 2026-11-15, measured in the browser).
  const shownKeysRef = useRef<string[]>([])
  useLayoutEffect(() => {
    const before = shownKeysRef.current
    shownKeysRef.current = order
    if (!enabled || before.length === 0) return
    const now = new Set(order)
    if (!before.some((k) => !now.has(k))) return
    relayoutRows(rootRef.current)
  })
  // What is on screen now: the next render plans against it.
  useEffect(() => {
    const byKey = new Map<string, T>()
    order.forEach((k, i) => {
      byKey.set(k, out[i])
    })
    shownRef.current = { order, byKey, resetKey: opts.resetKey }
  })
  const goneKey = [...gone].join('\u0001')
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined keys are the dependency
  const isGone = useCallback((key: string) => gone.has(key), [goneKey])
  return { rows: out, isGone, holding }
}

/**
 * A per-row lookup (labels, owners, pipeline state…) read for the rows on the page, with the
 * previous read's entries kept for keys the new read lacks. A row held on screen after it left
 * the list (useSteadyRows) keeps its labels while it fades, instead of blanking to "—". The
 * newest read always wins for a key it has; only one read back is kept.
 */
export function useKeptEntries<V>(
  current: Record<string, V> | null | undefined
): Record<string, V> | undefined {
  const lastRef = useRef<Record<string, V> | null | undefined>(current)
  const prevRef = useRef<Record<string, V> | null | undefined>(undefined)
  if (lastRef.current !== current) {
    prevRef.current = lastRef.current ?? prevRef.current
    lastRef.current = current
  }
  const prev = prevRef.current
  return useMemo(() => {
    if (!current) return prev ?? undefined
    if (!prev) return current
    return { ...prev, ...current }
  }, [current, prev])
}

/**
 * Re-lay a list's table rows in place (no visible change): hiding and showing the body inside
 * one task makes the browser recompute the rows and their pinned cells together. Exported for
 * tests.
 */
export function relayoutRows(root: HTMLElement | null | undefined): void {
  const body = root?.querySelector('tbody')
  if (!body) return
  const prev = body.style.display
  body.style.display = 'none'
  void body.offsetHeight
  body.style.display = prev
}

// ── Totals rows follow the rows (#13) ────────────────────────────────────

/**
 * Can these changes have moved a totals row? A create or delete, an update that named no
 * fields, or one that touched a totalled column or a field the list's filter reads (a record
 * entering or leaving the list). Aspect-only notices (`$tasks`…) never do.
 */
export function totalsMayMove(
  events: Array<{ action?: string; changed_fields?: string[] } | null | undefined>,
  totalled: Set<string>,
  filterFields: Set<string> = new Set()
): boolean {
  if (totalled.size === 0) return false
  for (const ev of events) {
    if (!ev) continue
    if (ev.action === 'create' || ev.action === 'delete') return true
    const f = ev.changed_fields
    if (!f || f.length === 0) return true
    if (f.every((x) => x.startsWith('$'))) continue
    if (f.some((x) => totalled.has(x) || filterFields.has(x))) return true
  }
  return false
}
// The re-read itself is coalesced with `createCoalescer` (lib/live-counts.ts).
