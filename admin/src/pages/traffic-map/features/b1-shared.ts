import { useQuery } from '@tanstack/react-query'
import {
  type ComponentType,
  createElement,
  type FunctionComponent,
  useContext,
  useSyncExternalStore
} from 'react'
import { api } from '@/lib/api'
import { TrafficMapContext, useTrafficMap } from '../context'
import type { MapLayout } from '../layout'
import type { TrafficModel } from '../model'

/**
 * Helpers shared by the B1 request-lens features (#1095–#1154): reading tap figures off the
 * model, and tiny page-scoped stores for lens toggles.
 */

/**
 * Renders `C` only inside the Traffic Map page (its context present). Registered pieces can be
 * rendered by a host component on its own (tests, embeds) — there they render nothing.
 */
export function inPage<P extends object>(C: ComponentType<P>): FunctionComponent<P> {
  const Guarded: FunctionComponent<P> = (props: P) =>
    useContext(TrafficMapContext) ? createElement(C, props) : null
  Guarded.displayName = `InPage(${C.displayName ?? C.name ?? 'feature'})`
  return Guarded
}

/** A tap's snapshot-level figures (`snapshot.ext[tapId]`). */
export function snapExt<T>(m: TrafficModel, tapId: string): T | undefined {
  return m.snapshotExt?.[tapId] as T | undefined
}
/** A tap's figures in the newest applied frame (`frame.ext[tapId]`). */
export function frameExt<T>(m: TrafficModel, tapId: string): T | undefined {
  return m.frameExt?.[tapId] as T | undefined
}

interface Held {
  v: unknown
  sec: number
}
interface TapHeld {
  frame: number
  byKey: Map<string, Held>
  /** Numeric frame values per key, per second (for rolling counts). */
  counts: Map<string, Array<[number, number]>>
}
const held = new WeakMap<TrafficModel, Map<string, TapHeld>>()

function sync(m: TrafficModel, tapId: string): TapHeld {
  let byTap = held.get(m)
  if (!byTap) {
    byTap = new Map()
    held.set(m, byTap)
  }
  let h = byTap.get(tapId)
  if (!h) {
    h = { frame: -1, byKey: new Map(), counts: new Map() }
    byTap.set(tapId, h)
  }
  // every frame applied since the last read (the model keeps a short log of their tap figures)
  for (const entry of m.frameExtLog ?? []) {
    if (entry.seq <= h.frame) continue
    h.frame = entry.seq
    const f = entry.ext[tapId] as Record<string, unknown> | undefined
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue
    for (const [k, v] of Object.entries(f)) {
      h.byKey.set(k, { v, sec: entry.sec })
      if (typeof v === 'number') {
        const list = h.counts.get(k) ?? []
        list.push([entry.sec, v])
        if (list.length > 120) list.shift()
        h.counts.set(k, list)
      }
    }
  }
  if (h.byKey.size > 600) h.byKey.clear()
  if (h.counts.size > 600) h.counts.clear()
  return h
}

/**
 * Sum of a tap's per-second numeric frame values for `key` over the last `windowS` seconds seen
 * live, else the last snapshot's `n` (`entities[i].ext[tapId].n`, or the snapshot-level map).
 */
export function recentCount(m: TrafficModel, tapId: string, key: string, windowS = 60): number {
  const h = sync(m, tapId)
  let n = 0
  for (const [sec, v] of h.counts.get(key) ?? []) if (sec > m.now - windowS) n += v
  if (n > 0) return n
  const snap = m.entityMeta(key)?.ext?.[tapId] as { n?: number } | number | undefined
  return typeof snap === 'number' ? snap : (snap?.n ?? 0)
}

/**
 * The newest per-entity value a tap sent: a frame's `{ [entityKey]: v }` wins while it is at
 * most `maxAgeS` old, else the last snapshot's `entities[i].ext[tapId]`. Frames are merged on
 * read (call it from render — the page re-renders on every applied frame).
 */
export function liveEntityExt<T>(
  m: TrafficModel,
  tapId: string,
  key: string,
  maxAgeS = 60
): T | undefined {
  const h = sync(m, tapId)
  const live = h.byKey.get(key)
  if (live && m.now - live.sec <= maxAgeS) return live.v as T
  return m.entityMeta(key)?.ext?.[tapId] as T | undefined
}

/** A page-scoped value with subscribers (lens toggles, focus picks). */
export interface Store<T> {
  get(): T
  set(v: T): void
  subscribe(fn: () => void): () => void
}
export function createStore<T>(init: T): Store<T> {
  let value = init
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set(v) {
      value = v
      for (const fn of subs) fn()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    }
  }
}
export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get)
}

/** Bytes as "512 B", "14.2 KB", "1.3 MB". */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Short relative age of an ISO time against now ("12 s ago", "4 min ago"). */
export function ago(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}

/** Shared chip class for small inline tags inside panels. */
export const TAG =
  'inline-flex items-center gap-1 rounded border border-[var(--tm-line)] px-1.5 py-px text-[11px] font-medium leading-tight text-[var(--tm-fg-2)]'

/** Live figures of one B1 tap (GET /traffic-map/lens/:tap), refreshed every 5 s while the page
 *  is live; the newest snapshot's copy stands in until the first read lands. */
export function useLens<T>(tapId: string): { data: T | null; loading: boolean } {
  const { model, win, paused, ready } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'lens', tapId, win],
    queryFn: async () => {
      const res = await api.get(`/traffic-map/lens/${tapId}?window=${win}`)
      return (res.data.data ?? null) as T | null
    },
    enabled: ready,
    refetchInterval: paused ? false : 5000,
    staleTime: 4000
  })
  if (q.data !== undefined) return { data: q.data, loading: false }
  return { data: snapExt<T>(model, tapId) ?? null, loading: q.isLoading }
}

/** Every tap's live detail for one entity (GET /traffic-map/entity-detail), every 5 s. */
export function useEntityDetail(key: string | null): Record<string, unknown> | null {
  const { win, paused, ready } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'entity-detail', key, win],
    queryFn: async () => {
      const res = await api.get(
        `/traffic-map/entity-detail?key=${encodeURIComponent(key ?? '')}&window=${win}`
      )
      return (res.data.data ?? {}) as Record<string, unknown>
    },
    enabled: ready && !!key && !key.endsWith('/__background__'),
    refetchInterval: paused ? false : 5000,
    staleTime: 4000
  })
  return q.data ?? null
}

// ── canvas helpers (shared by the B1 canvas layers) ───────────────────────────
/** End points of the drawn caller → lane edge (the same geometry MapCanvas strokes). */
export function inEdgeEnds(
  layout: MapLayout,
  caller: string,
  lane: string
): { a: { x: number; y: number }; b: { x: number; y: number } } | null {
  const c = layout.callers[caller]
  const ln = layout.lanes[lane]
  if (!c || !ln) return null
  return { a: { x: c.x + c.w, y: c.y + c.h / 2 }, b: { x: ln.x, y: ln.y + 11 } }
}
export function strokeEdge(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number }
): void {
  const mx = (a.x + b.x) / 2
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
  ctx.stroke()
}
/** A small outlined pill with text, its left edge at `x` (or right edge with align 'right'). */
export function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  card: string,
  font: string,
  align: 'left' | 'right' = 'left'
): number {
  ctx.font = font
  const w = ctx.measureText(text).width + 8
  const px = align === 'right' ? x - w : x
  ctx.beginPath()
  ctx.roundRect(px, y, w, 12, 6)
  ctx.fillStyle = card
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.fillText(text, px + 4, y + 9)
  return w
}
