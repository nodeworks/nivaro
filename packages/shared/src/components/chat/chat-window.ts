import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

/**
 * Long rooms (#2783).
 *
 * `useMessageWindow` mounts only the messages near the screen once a room's
 * loaded history passes WINDOW_FROM rows; the rest are padding on the rows
 * container, sized from each message's measured height (an estimate until it
 * has been on screen once). It also keeps the reader's place: the first
 * message on screen is the anchor, and when history loads above it or a
 * message above it changes height (an image or link card arriving), the
 * scroller moves by exactly the anchor's shift. The browser's own scroll
 * anchoring is turned off on the scroller (`overflow-anchor: none`) so the
 * two never correct twice. While the reader sits at the bottom (pinned) the
 * room's own "follow the newest message" rule wins instead.
 *
 * `useNearViewport` mounts heavy row parts (link previews, cards) only when
 * they come within a screen of the room's visible area.
 */

export const WINDOW_FROM = 150
const OVERSCAN_PX = 1200
/** Rows mounted around a message we jump to before the scroller settles. */
const REVEAL_SPAN = 25

interface Range {
  from: number
  to: number
  /** The window runs to the newest message — new arrivals join it. */
  toEnd: boolean
}

export interface MessageWindow {
  windowed: boolean
  start: number
  end: number
  padTop: number
  padBottom: number
  rowRef: (id: number) => (el: HTMLElement | null) => void
  onScroll: () => void
  /** Bring a loaded message into the DOM and center it; false when it is not loaded. */
  reveal: (id: number) => boolean
}

/** Pure: which rows to mount for a scroll position (offsets from heights). */
export function windowFor(
  ids: number[],
  height: (id: number) => number,
  viewTop: number,
  viewHeight: number,
  overscan = OVERSCAN_PX
): Range | null {
  const n = ids.length
  if (n === 0) return null
  const lo = viewTop - overscan
  const hi = viewTop + viewHeight + overscan
  let y = 0
  let s = -1
  let e = n - 1
  for (let i = 0; i < n; i++) {
    const h = height(ids[i])
    if (s < 0 && y + h > lo) s = i
    if (y > hi) {
      e = i - 1
      break
    }
    y += h
  }
  if (s < 0) s = n - 1
  if (e < s) e = s
  return { from: ids[s], to: ids[e], toEnd: e === n - 1 }
}

/** Pure: mounted index span + padding for a range. */
export function spanFor(
  ids: number[],
  index: Map<number, number>,
  range: Range | null,
  height: (id: number) => number,
  windowed: boolean,
  fallbackAround: number | null
): { start: number; end: number; padTop: number; padBottom: number } {
  const n = ids.length
  if (!windowed || n === 0) return { start: 0, end: n, padTop: 0, padBottom: 0 }
  let start: number
  let end: number
  const a = range ? index.get(range.from) : undefined
  const b = range ? (range.toEnd ? n - 1 : index.get(range.to)) : undefined
  if (a != null && b != null && b >= a) {
    start = a
    end = b + 1
  } else {
    // No usable range yet: around the reader's anchor, else the newest rows.
    const at = fallbackAround != null ? index.get(fallbackAround) : undefined
    if (at != null) {
      start = Math.max(0, at - REVEAL_SPAN)
      end = Math.min(n, at + REVEAL_SPAN * 2)
    } else {
      start = Math.max(0, n - REVEAL_SPAN * 2)
      end = n
    }
  }
  let padTop = 0
  for (let i = 0; i < start; i++) padTop += height(ids[i])
  let padBottom = 0
  for (let i = end; i < n; i++) padBottom += height(ids[i])
  return { start, end, padTop, padBottom }
}

function relTop(el: HTMLElement, sc: HTMLElement): number {
  return el.getBoundingClientRect().top - sc.getBoundingClientRect().top
}

export function useMessageWindow(opts: {
  scrollerRef: RefObject<HTMLElement | null>
  listRef: RefObject<HTMLElement | null>
  ids: number[]
  estimate: number
  /** Changes when the room (or its anchor) changes: measurements start over. */
  resetKey: string
  /** True while the reader sits at the newest message. */
  pinnedRef: RefObject<boolean>
}): MessageWindow {
  const { scrollerRef, listRef, ids, estimate, resetKey, pinnedRef } = opts
  const heights = useRef(new Map<number, number>())
  const els = useRef(new Map<number, HTMLElement>())
  const refs = useRef(new Map<number, (el: HTMLElement | null) => void>())
  const anchor = useRef<{ id: number; rel: number } | null>(null)
  const pendingReveal = useRef<number | null>(null)
  const prevFirst = useRef<number | null>(null)
  const raf = useRef<number | null>(null)
  const [range, setRange] = useState<Range | null>(null)
  const windowed = ids.length > WINDOW_FROM

  const index = useMemo(() => {
    const m = new Map<number, number>()
    for (let i = 0; i < ids.length; i++) m.set(ids[i], i)
    return m
  }, [ids])
  const idsRef = useRef(ids)
  idsRef.current = ids
  const height = useCallback((id: number) => heights.current.get(id) ?? estimate, [estimate])

  // Declared before the layout effects below, so a new room starts over first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: start over per room/anchor
  useLayoutEffect(() => {
    heights.current.clear()
    anchor.current = null
    pendingReveal.current = null
    prevFirst.current = null
    setRange(null)
  }, [resetKey])

  /** The first mounted message whose bottom is below the top of the screen. */
  const recordAnchor = useCallback(() => {
    const sc = scrollerRef.current
    if (!sc) return
    for (const id of idsRef.current) {
      const el = els.current.get(id)
      if (!el) continue
      const rel = relTop(el, sc)
      if (rel + el.offsetHeight > 0) {
        anchor.current = { id, rel }
        return
      }
    }
  }, [scrollerRef])

  /** Put the anchor back where the reader last saw it. */
  const restoreAnchor = useCallback(() => {
    const sc = scrollerRef.current
    const a = anchor.current
    if (!sc || !a || pinnedRef.current) return
    const el = els.current.get(a.id)
    if (!el) return
    const shift = relTop(el, sc) - a.rel
    if (Math.abs(shift) >= 1) sc.scrollTop += shift
  }, [scrollerRef, pinnedRef])

  const compute = useCallback(() => {
    const sc = scrollerRef.current
    const list = listRef.current
    const cur = idsRef.current
    if (!sc || !list || cur.length <= WINDOW_FROM) return
    const listTop = list.getBoundingClientRect().top - sc.getBoundingClientRect().top
    const next = windowFor(cur, height, -listTop, sc.clientHeight)
    if (!next) return
    setRange((r) =>
      r && r.from === next.from && r.to === next.to && r.toEnd === next.toEnd ? r : next
    )
  }, [scrollerRef, listRef, height])

  const ro = useMemo(
    () =>
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const e of entries) {
              const el = e.target as HTMLElement
              const id = Number(el.dataset.chatRow)
              if (Number.isFinite(id)) heights.current.set(id, el.offsetHeight)
            }
            restoreAnchor()
          }),
    [restoreAnchor]
  )
  useEffect(() => () => ro?.disconnect(), [ro])

  const rowRef = useCallback(
    (id: number) => {
      let cb = refs.current.get(id)
      if (!cb) {
        cb = (el: HTMLElement | null) => {
          const prev = els.current.get(id)
          if (prev && prev !== el) ro?.unobserve(prev)
          if (el) {
            els.current.set(id, el)
            heights.current.set(id, el.offsetHeight)
            ro?.observe(el)
          } else {
            els.current.delete(id)
          }
        }
        refs.current.set(id, cb)
      }
      return cb
    },
    [ro]
  )
  // A new observer (rare) takes over every mounted row.
  useEffect(() => {
    for (const el of els.current.values()) ro?.observe(el)
  }, [ro])
  useEffect(() => {
    if (refs.current.size > ids.length * 2 + 200) {
      for (const id of [...refs.current.keys()]) if (!index.has(id)) refs.current.delete(id)
    }
  }, [ids, index])

  // History loaded above (the first message changed but the anchor is still
  // here): keep the anchor where it was. Runs before paint.
  useLayoutEffect(() => {
    const first = ids[0] ?? null
    const prev = prevFirst.current
    prevFirst.current = first
    if (prev != null && first !== prev && anchor.current && index.has(anchor.current.id)) {
      restoreAnchor()
    }
    if (windowed) compute()
  }, [ids, index, windowed, compute, restoreAnchor])

  // After every commit: a jump that landed its row in the DOM is centered, and
  // an anchor whose row left the DOM (the window moved) is taken afresh.
  useLayoutEffect(() => {
    const id = pendingReveal.current
    if (id == null) {
      if (!anchor.current || !els.current.has(anchor.current.id)) recordAnchor()
      return
    }
    const el = els.current.get(id)
    if (!el) return
    pendingReveal.current = null
    el.scrollIntoView({ block: 'center' })
    recordAnchor()
  })

  const onScroll = useCallback(() => {
    recordAnchor()
    if (!windowed || raf.current != null) return
    raf.current = requestAnimationFrame(() => {
      raf.current = null
      compute()
    })
  }, [recordAnchor, windowed, compute])
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current)
    },
    []
  )

  const reveal = useCallback(
    (id: number) => {
      const i = index.get(id)
      if (i == null) return false
      pendingReveal.current = id
      const cur = idsRef.current
      const lo = Math.max(0, i - REVEAL_SPAN)
      const hi = Math.min(cur.length - 1, i + REVEAL_SPAN)
      setRange({ from: cur[lo], to: cur[hi], toEnd: hi === cur.length - 1 })
      return true
    },
    [index]
  )

  const span = spanFor(ids, index, range, height, windowed, anchor.current?.id ?? null)
  return { windowed, ...span, rowRef, onScroll, reveal }
}

/**
 * Mount a heavy part (a link preview, a card) only once it comes within
 * `margin` px of the room's visible area. Once shown it stays mounted.
 */
export function useNearViewport<T extends HTMLElement>(
  margin = 600
): [(el: T | null) => void, boolean] {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  const obs = useRef<IntersectionObserver | null>(null)
  useEffect(() => () => obs.current?.disconnect(), [])
  const ref = useCallback(
    (el: T | null) => {
      obs.current?.disconnect()
      obs.current = null
      if (!el || near || typeof IntersectionObserver === 'undefined') return
      const root = el.closest<HTMLElement>('[data-chat-messages]')
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setNear(true)
            io.disconnect()
          }
        },
        { root, rootMargin: `${margin}px 0px` }
      )
      io.observe(el)
      obs.current = io
    },
    [near, margin]
  )
  return [ref, near]
}
