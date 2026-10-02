/**
 * The investigation stack: the drill-down levels open in the docked Investigation panel.
 * A plain module store (subscribe / getSnapshot for useSyncExternalStore) so any feature — a
 * ticker row, an inspector button, a link inside a panel — can push a level without a prop path.
 *
 * `levels` is the breadcrumb path, root first; the current level is the last one (`index`).
 * `back()` moves the current level onto `forward`; opening a new level clears `forward`.
 */
import { type InspectRef, inspectableFor } from '../registry/inspectables'
import { register } from '../registry/registry'
import { viewParams } from '../registry/viewParams'
import { sameRef } from './format'

export interface InspectStackState {
  levels: InspectRef[]
  /** Index of the current level (levels.length - 1; -1 when closed). */
  index: number
  /** Levels `back()` stepped off, next first. */
  forward: InspectRef[]
  /** Level shown in the left column when split; null = single column. */
  pinned: number | null
  /** Epoch ms the investigation is anchored at. */
  anchor: number | null
  /** Seconds around the anchor panels look at. */
  windowSec: number
}

export const DEFAULT_WINDOW_SEC = 300
export const MAX_URL_LEVELS = 8

const EMPTY: InspectStackState = {
  levels: [],
  index: -1,
  forward: [],
  pinned: null,
  anchor: null,
  windowSec: DEFAULT_WINDOW_SEC
}

let state: InspectStackState = EMPTY
const listeners = new Set<() => void>()

function set(next: Omit<InspectStackState, 'index'> & { index?: number }): void {
  const levels = next.levels
  const pinned = next.pinned != null && next.pinned < levels.length ? next.pinned : null
  state = { ...next, levels, pinned, index: levels.length - 1 }
  for (const fn of listeners) fn()
}

export function subscribeInspect(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getInspectSnapshot(): InspectStackState {
  return state
}

/** The level on screen (right column when split); null when the panel is closed. */
export function currentRef(): InspectRef | null {
  return state.levels[state.index] ?? null
}

/**
 * Open a level. `root` starts a new investigation (clears the stack, anchors at `ref.at`, or
 * null = now);
 * otherwise the level is pushed and forward history dropped. Opening the current level again
 * does nothing.
 */
export function openInspect(ref: InspectRef, opts: { root?: boolean } = {}): void {
  if (!ref?.kind || !ref.id) return
  if (opts.root) {
    if (state.levels.length === 1 && sameRef(state.levels[0], ref)) return
    set({
      ...state,
      levels: [ref],
      forward: [],
      pinned: null,
      anchor: ref.at ?? null
    })
    return
  }
  if (sameRef(currentRef(), ref)) return
  set({
    ...state,
    levels: [...state.levels, ref],
    forward: [],
    anchor: state.levels.length === 0 ? (ref.at ?? null) : state.anchor
  })
}

/** One level back (no-op at the root). */
export function back(): void {
  if (state.index <= 0) return
  const cur = state.levels[state.index]
  set({ ...state, levels: state.levels.slice(0, -1), forward: [cur, ...state.forward] })
}

/** Re-open the level `back()` last stepped off. */
export function forwardStep(): void {
  const [next, ...rest] = state.forward
  if (!next) return
  set({ ...state, levels: [...state.levels, next], forward: rest })
}

/** Jump to breadcrumb `i`; the levels after it become forward history. */
export function goTo(i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= state.index) return
  set({
    ...state,
    levels: state.levels.slice(0, i + 1),
    forward: [...state.levels.slice(i + 1), ...state.forward]
  })
}

/** Pin the current level to the left column (split view), or unpin. */
export function togglePin(): void {
  if (state.index < 0) return
  set({ ...state, pinned: state.pinned == null ? state.index : null })
}

export function closeInspect(): void {
  if (state.levels.length === 0 && state.forward.length === 0) return
  set({ ...EMPTY, windowSec: state.windowSec })
}

export function setAnchor(ms: number | null): void {
  const v = ms != null && Number.isFinite(ms) ? ms : null
  if (v === state.anchor) return
  set({ ...state, anchor: v })
}

export function setWindow(sec: number): void {
  if (!Number.isFinite(sec)) return
  const v = Math.min(86_400, Math.max(10, Math.round(sec)))
  if (v === state.windowSec) return
  set({ ...state, windowSec: v })
}

/** Replace the whole stack (a link). The first level's time anchors it. */
export function replaceInspect(levels: InspectRef[]): void {
  if (levels.length === 0) {
    closeInspect()
    return
  }
  set({ ...state, levels: [...levels], forward: [], pinned: null, anchor: levels[0].at ?? null })
}

// ── URL form: `kind:id(@at)/kind:id/…` ──

/** Same shape as the server's INSPECT_KIND_RE: a kind a source could actually register. */
const KIND_RE = /^[a-z][a-z0-9-]{1,30}$/
/** A URL piece that opens a new `kind:` segment (see decodeStack). */
const SEG_START_RE = /^[a-z][a-z0-9-]{1,30}:/

/** The stack as a URL value (the newest MAX_URL_LEVELS levels); null when closed. */
export function encodeStack(levels: InspectRef[] = state.levels): string | null {
  if (levels.length === 0) return null
  return levels
    .slice(-MAX_URL_LEVELS)
    .map((r) => {
      const at = r.at != null && Number.isFinite(r.at) ? `@${Math.round(r.at)}` : ''
      return `${r.kind}:${encodeURIComponent(r.id)}${at}`
    })
    .join('/')
}

/**
 * Parse a URL value back into levels. Malformed segments, kinds nothing can show (`known`,
 * default: a registered inspectable) and anything past MAX_URL_LEVELS are dropped.
 */
export function decodeStack(
  s: string | null | undefined,
  known: (kind: string) => boolean = (k) => !!inspectableFor(k)
): InspectRef[] {
  if (!s || typeof s !== 'string' || s.length > 4000) return []
  // Split on '/', but a piece that does not start a `kind:` segment belongs to the id before
  // it: a hand-written link spells an entity id as `items%2Fworkflows`, and URLSearchParams
  // hands that to us already decoded as `items/workflows`.
  const segs: string[] = []
  for (const piece of s.split('/')) {
    if (segs.length > 0 && !SEG_START_RE.test(piece)) segs[segs.length - 1] += `/${piece}`
    else segs.push(piece)
  }
  const out: InspectRef[] = []
  for (const seg of segs) {
    if (out.length >= MAX_URL_LEVELS) break
    const cut = seg.indexOf(':')
    if (cut <= 0) continue
    const kind = seg.slice(0, cut)
    if (!KIND_RE.test(kind) || !known(kind)) continue
    let rest = seg.slice(cut + 1)
    let at: number | undefined
    const atCut = rest.lastIndexOf('@')
    if (atCut >= 0) {
      const raw = rest.slice(atCut + 1)
      if (!/^\d{1,15}$/.test(raw)) continue
      at = Number(raw)
      rest = rest.slice(0, atCut)
    }
    let id: string
    try {
      id = decodeURIComponent(rest)
    } catch {
      continue
    }
    if (!id || id.length > 512) continue
    out.push(at != null ? { kind, id, at } : { kind, id })
  }
  return out
}

register(viewParams, {
  id: 'inspect',
  param: 'inspect',
  get: () => encodeStack(),
  set: (v) => replaceInspect(decodeStack(v)),
  subscribe: subscribeInspect
})

/** Tests only: back to the closed state. */
export function resetInspectForTests(): void {
  state = EMPTY
  for (const fn of listeners) fn()
}
