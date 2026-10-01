// How the flow canvas draws (group D): semantic zoom (#1161), numbers on edges and edge
// thickness (#1162), callers grouped by app (#1163). A small module store so the canvas, its
// header controls and the whole-view link (#1166) read one value. The display choices persist
// per browser; zoom and the expanded group ride the URL instead.
import { useSyncExternalStore } from 'react'

/** 0 = lanes only, 1 = entities (default), 2 = entities with their busiest route and per-caller
 *  edges. */
export type Zoom = 0 | 1 | 2
export type EdgeScale = 'sqrt' | 'log' | 'linear'
export interface CanvasView {
  zoom: Zoom
  scale: EdgeScale
  labels: boolean
  groupApps: boolean
  /** The app group shown expanded while grouping (`app:<group>`), or null. */
  expanded: string | null
}
export const ZOOM_LABEL: Record<Zoom, string> = { 0: 'Lanes', 1: 'Entities', 2: 'Routes' }
const STORE_KEY = 'nvr_tm_canvas_view'
const DEFAULT: CanvasView = {
  zoom: 1,
  scale: 'sqrt',
  labels: false,
  groupApps: false,
  expanded: null
}

function load(): CanvasView {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<CanvasView> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT }
    return {
      ...DEFAULT,
      scale: raw.scale === 'log' || raw.scale === 'linear' ? raw.scale : 'sqrt',
      labels: raw.labels === true,
      groupApps: raw.groupApps === true
    }
  } catch {
    return { ...DEFAULT }
  }
}

let value: CanvasView = typeof window === 'undefined' ? { ...DEFAULT } : load()
const subs = new Set<() => void>()

export function getCanvasView(): CanvasView {
  return value
}
export function setCanvasView(patch: Partial<CanvasView>): void {
  const next = { ...value, ...patch }
  if (
    next.zoom === value.zoom &&
    next.scale === value.scale &&
    next.labels === value.labels &&
    next.groupApps === value.groupApps &&
    next.expanded === value.expanded
  )
    return
  value = next
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ scale: value.scale, labels: value.labels, groupApps: value.groupApps })
    )
  } catch {
    /* private mode: the choice lasts the session */
  }
  for (const fn of subs) fn()
}
export function subscribeCanvasView(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
export function useCanvasView(): CanvasView {
  return useSyncExternalStore(subscribeCanvasView, getCanvasView, getCanvasView)
}
export function zoomBy(step: 1 | -1): void {
  const z = Math.min(2, Math.max(0, value.zoom + step)) as Zoom
  setCanvasView({ zoom: z })
}

/** Line width for an edge of `rps` requests/s. `max` = the busiest edge drawn (linear only). */
export function edgeWidthFor(rps: number, scale: EdgeScale, max = 0): number {
  if (!(rps > 0)) return 0
  if (scale === 'log') return Math.min(11, 1 + Math.log10(1 + rps) * 3.6)
  if (scale === 'linear') return max > 0 ? 1 + 10 * Math.min(1, rps / max) : 1
  return Math.min(11, 1 + Math.sqrt(rps) * 2.2)
}

// ── #1163 app groups ────────────────────────────────────────────────────────
export const APP_GROUP_LABEL: Record<string, string> = {
  'app:admin': 'Admin app',
  'app:efp-new': 'efp-new',
  'app:integrations': 'Integrations',
  'app:cron': 'Cron and sources',
  'app:people': 'People, no app header',
  'app:anon': 'No credentials',
  'app:other': 'Other callers'
}
export function appGroupLabel(id: string): string {
  return APP_GROUP_LABEL[id] ?? id.replace(/^app:/, '')
}
/**
 * The group a caller falls in: its front end when it sent one (x-nivaro-app), else by kind —
 * API keys and integration accounts are integrations, cron jobs / imports / sockets are sources.
 */
export function appGroupOf(
  caller: string,
  apps: Map<string, string>,
  kind: string | undefined,
  isSource: boolean
): string {
  if (isSource || caller === 'cron' || kind === 'cron' || kind === 'source') return 'app:cron'
  if (kind === 'key' || kind === 'machine') return 'app:integrations'
  const app = apps.get(caller)
  if (app) return `app:${app}`
  if (kind === 'anon' || caller === 'anon') return 'app:anon'
  if (kind === 'person') return 'app:people'
  return 'app:other'
}
export const isAppGroup = (id: string) => id.startsWith('app:')
