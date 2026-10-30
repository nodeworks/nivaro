import { useSyncExternalStore } from 'react'

/**
 * #3225 — breadcrumbs that know the path. A per-TAB record of the history
 * entries this tab walked through (sessionStorage, so a reload keeps it and
 * another tab has its own), keyed by the router's history index. The page
 * header turns the entries before the current one into crumbs — how the
 * person actually got here (Queue "Pending approvals" → PO 4471 → Line 3) —
 * and a crumb click goes BACK that many history entries, so the page comes
 * back exactly as it was left: same URL (filters, tab), and the scroll
 * position the trail remembered.
 *
 * The host feeds it: call `recordNavigation()` on every location change with
 * the router's action ('PUSH' | 'REPLACE' | 'POP'), the location key and
 * `history.state.idx` (React Router keeps the index there across reloads).
 * Nothing here touches the router, so any host (admin, efp-new) can wire it.
 *
 * Pure parts (`reduceTrail`, `trailChain`, `displayTrail`) are tested on their own.
 */

export type TrailAction = 'PUSH' | 'REPLACE' | 'POP'

export interface TrailScroll {
  /** '' = the page scroller itself; otherwise a child path from it (see scrollPathOf). */
  path: string
  top: number
}

export interface TrailEntry {
  key: string
  idx: number
  /** pathname + search + hash */
  path: string
  label?: string
  scroll?: TrailScroll[]
  at: number
}

export interface TrailState {
  entries: TrailEntry[]
  current: { key: string; idx: number } | null
}

export interface TrailEvent {
  action: TrailAction
  key: string
  idx: number
  path: string
  at?: number
}

export const NAV_TRAIL_KEY = 'nvr:nav-trail'
const MAX_ENTRIES = 60

const pathnameOf = (path: string) => path.split(/[?#]/)[0] || '/'

/** Fold one navigation into the trail. */
export function reduceTrail(state: TrailState, ev: TrailEvent): TrailState {
  const at = ev.at ?? Date.now()
  const idx = Number.isFinite(ev.idx) ? Math.max(0, Math.floor(ev.idx)) : 0
  const prev = state.entries.find((e) => e.idx === idx)
  let entries: TrailEntry[]
  if (ev.action === 'PUSH') {
    // A new entry at idx: everything at idx and beyond is gone (browser forward stack dropped).
    entries = [...state.entries.filter((e) => e.idx < idx), { key: ev.key, idx, path: ev.path, at }]
  } else if (prev && prev.key === ev.key && prev.path === ev.path) {
    // Back / forward / reload onto a known entry: nothing to change.
    entries = state.entries
  } else {
    // REPLACE, or a POP onto an entry we did not know: (re)write that one entry.
    // Same pathname keeps the label (a tab or filter change on the same page).
    const keep = prev && pathnameOf(prev.path) === pathnameOf(ev.path) ? prev : null
    const next: TrailEntry = {
      key: ev.key,
      idx,
      path: ev.path,
      at,
      ...(keep?.label ? { label: keep.label } : {}),
      ...(keep?.scroll && ev.action === 'REPLACE' ? { scroll: keep.scroll } : {})
    }
    entries = [...state.entries.filter((e) => e.idx !== idx), next].sort((a, b) => a.idx - b.idx)
  }
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES)
  return { entries, current: { key: ev.key, idx } }
}

/** The unbroken run of entries right before the current one, oldest first. */
export function trailChain(state: TrailState): TrailEntry[] {
  const cur = state.current
  if (!cur) return []
  const byIdx = new Map(state.entries.map((e) => [e.idx, e]))
  const out: TrailEntry[] = []
  for (let i = cur.idx - 1; i >= 0; i--) {
    const e = byIdx.get(i)
    if (!e) break
    out.unshift(e)
  }
  return out
}

export interface TrailCrumb {
  key: string
  path: string
  label?: string
  /** History steps to go back to reach it (negative). */
  delta: number
}

/**
 * The crumbs to show: walk back from the current page, newest first, skipping
 * the current page itself and repeats (the NEWEST visit of a page wins — the
 * fewest steps back), and stop after the first "root" page (a list or hub the
 * person started from) or `max` crumbs. Oldest first.
 */
export function displayTrail(
  chain: TrailEntry[],
  current: { idx: number; path: string },
  opts: { isRoot?: (pathname: string) => boolean; max?: number } = {}
): TrailCrumb[] {
  const max = opts.max ?? 4
  const here = pathnameOf(current.path)
  const seen = new Set<string>([here])
  const out: TrailCrumb[] = []
  for (let i = chain.length - 1; i >= 0 && out.length < max; i--) {
    const e = chain[i]
    const p = pathnameOf(e.path)
    if (seen.has(p)) continue
    seen.add(p)
    out.unshift({ key: e.key, path: e.path, label: e.label, delta: e.idx - current.idx })
    if (opts.isRoot?.(p)) break
  }
  return out
}

// ─── Store (sessionStorage, per tab) ──────────────────────────────────────────

const EMPTY: TrailState = { entries: [], current: null }
let state: TrailState | null = null
const listeners = new Set<() => void>()

function load(): TrailState {
  if (state) return state
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(NAV_TRAIL_KEY) : null
    const parsed = raw ? (JSON.parse(raw) as Partial<TrailState>) : null
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries.filter(
          (e): e is TrailEntry =>
            !!e && typeof e.key === 'string' && typeof e.path === 'string' && Number.isFinite(e.idx)
        )
      : []
    state = { entries, current: parsed?.current ?? null }
  } catch {
    state = EMPTY
  }
  return state
}

function commit(next: TrailState) {
  state = next
  try {
    sessionStorage.setItem(NAV_TRAIL_KEY, JSON.stringify(next))
  } catch {
    /* storage full or blocked — the trail lives in memory for this page load */
  }
  for (const l of listeners) l()
}

export function getNavTrail(): TrailState {
  return load()
}

/** Feed one location change. Returns the entry now current. */
export function recordNavigation(ev: TrailEvent): TrailEntry | undefined {
  const next = reduceTrail(load(), ev)
  if (next !== state) commit(next)
  return next.entries.find((e) => e.idx === next.current?.idx)
}

function patchEntry(key: string | undefined, fn: (e: TrailEntry) => TrailEntry | null) {
  const s = load()
  const cur = s.current
  // With a key: only while that entry is the current one (a reload gives every
  // entry it lands on the key 'default', so a key alone is not unique).
  const i = key
    ? cur && cur.key === key
      ? s.entries.findIndex((e) => e.idx === cur.idx && e.key === key)
      : -1
    : cur
      ? s.entries.findIndex((e) => e.idx === cur.idx && e.key === cur.key)
      : -1
  if (i < 0) return
  const next = fn(s.entries[i])
  if (!next) return
  const entries = [...s.entries]
  entries[i] = next
  commit({ ...s, entries })
}

const patchCurrent = (fn: (e: TrailEntry) => TrailEntry | null) => patchEntry(undefined, fn)

/**
 * Name a page in the trail (what later crumbs will show for it): the current
 * entry — and, when a key is given, only while that key is still current (a
 * label that lands after the person moved on is dropped, never misfiled).
 */
export function setTrailLabel(label: string | null | undefined, key?: string) {
  const clean = (label ?? '').trim().slice(0, 120)
  if (!clean) return
  patchEntry(key, (e) => (e.label === clean ? null : { ...e, label: clean }))
}

/** Remember the current page's scroll positions (restored on a POP back to it). */
export function setTrailScroll(scroll: TrailScroll[]) {
  const list = scroll.filter((s) => Number.isFinite(s.top) && s.top >= 0).slice(0, 4)
  patchCurrent((e) =>
    JSON.stringify(e.scroll ?? []) === JSON.stringify(list) ? null : { ...e, scroll: list }
  )
}

export function subscribeNavTrail(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The tab's trail, re-rendering on every change. */
export function useNavTrail(): TrailState {
  return useSyncExternalStore(subscribeNavTrail, getNavTrail, () => EMPTY)
}

/** Test seam. */
export function resetNavTrailForTests() {
  state = null
  listeners.clear()
}

// ─── Scroll capture / restore helpers ─────────────────────────────────────────

/** A child's position under `root` as child indexes ('0.2.1'); '' = root itself. */
export function scrollPathOf(root: Element, el: Element): string | null {
  if (el === root) return ''
  const parts: number[] = []
  let node: Element | null = el
  while (node && node !== root) {
    const parent: Element | null = node.parentElement
    if (!parent) return null
    parts.unshift(Array.prototype.indexOf.call(parent.children, node))
    node = parent
  }
  return node === root ? parts.join('.') : null
}

export function elementAtScrollPath(root: Element, path: string): Element | null {
  if (path === '') return root
  let node: Element | null = root
  for (const part of path.split('.')) {
    const i = Number(part)
    node = node?.children[i] ?? null
    if (!node) return null
  }
  return node
}

/**
 * Put remembered scroll positions back, retrying while the page loads its data
 * (a list is short until its rows arrive). Gives up after `timeoutMs`, or as
 * soon as the person scrolls themselves. Returns a cancel function.
 */
export function restoreTrailScroll(
  root: Element,
  scroll: TrailScroll[],
  timeoutMs = 2000
): () => void {
  let done = false
  const start = Date.now()
  const pending = new Map(scroll.map((s) => [s.path, s.top]))
  const stop = () => {
    done = true
    root.removeEventListener('wheel', stop)
    root.removeEventListener('touchstart', stop)
    root.removeEventListener('keydown', stop)
  }
  root.addEventListener('wheel', stop, { passive: true })
  root.addEventListener('touchstart', stop, { passive: true })
  root.addEventListener('keydown', stop)
  const tick = () => {
    if (done) return
    for (const [path, top] of pending) {
      const el = elementAtScrollPath(root, path) as HTMLElement | null
      if (!el) continue
      if (el.scrollHeight - el.clientHeight >= top - 1) {
        el.scrollTop = top
        pending.delete(path)
      }
    }
    if (pending.size === 0 || Date.now() - start > timeoutMs) {
      stop()
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return stop
}
