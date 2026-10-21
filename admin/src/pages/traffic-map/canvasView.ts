// How the flow canvas draws (group D): semantic zoom (#1161), numbers on edges and edge
// thickness (#1162), callers grouped by app (#1163). A small module store so the canvas, its
// header controls and the whole-view link (#1166) read one value. The display choices persist
// per browser; zoom and the expanded group ride the URL instead.
import { useSyncExternalStore } from 'react'
import type { EdgeMetric } from './model'

/** 0 = lanes only, 1 = entities (default), 2 = entities with their busiest route and per-caller
 *  edges. */
export type Zoom = 0 | 1 | 2
export type EdgeScale = 'sqrt' | 'log' | 'linear'
/** #2279: `top` caps each column at its busiest nodes; `all` draws every node the model has. */
export type NodeDensity = 'top' | 'all'
/** #2279: `auto` picks WebGL past GL_AUTO_ITEMS; `2d` / `gl` force one (a link may carry it). */
export type RendererChoice = 'auto' | '2d' | 'gl'
export interface CanvasView {
  zoom: Zoom
  scale: EdgeScale
  labels: boolean
  groupApps: boolean
  /** The app group shown expanded while grouping (`app:<group>`), or null. */
  expanded: string | null
  /** #2185: what edge thickness (and the numbers on edges) means. */
  weight: EdgeMetric
  /** #2279 node caps. */
  density: NodeDensity
  /** #2279 renderer override (URL only, never persisted). */
  renderer: RendererChoice
}
export const ZOOM_LABEL: Record<Zoom, string> = { 0: 'Lanes', 1: 'Entities', 2: 'Routes' }
const STORE_KEY = 'nvr_tm_canvas_view'
const DEFAULT: CanvasView = {
  zoom: 1,
  scale: 'sqrt',
  labels: false,
  groupApps: false,
  expanded: null,
  weight: 'requests',
  density: 'top',
  renderer: 'auto'
}
const METRICS: EdgeMetric[] = ['requests', 'bytes', 'time', 'errors']
export const isEdgeMetric = (v: unknown): v is EdgeMetric => METRICS.includes(v as EdgeMetric)

function load(): CanvasView {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<CanvasView> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT }
    return {
      ...DEFAULT,
      scale: raw.scale === 'log' || raw.scale === 'linear' ? raw.scale : 'sqrt',
      labels: raw.labels === true,
      groupApps: raw.groupApps === true,
      weight: isEdgeMetric(raw.weight) ? raw.weight : 'requests',
      density: raw.density === 'all' ? 'all' : 'top'
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
    next.expanded === value.expanded &&
    next.weight === value.weight &&
    next.density === value.density &&
    next.renderer === value.renderer
  )
    return
  value = next
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        scale: value.scale,
        labels: value.labels,
        groupApps: value.groupApps,
        weight: value.weight,
        density: value.density
      })
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

// ── #2185 edge weight modes ─────────────────────────────────────────────────
export const WEIGHT_LABEL: Record<EdgeMetric, string> = {
  requests: 'Requests',
  bytes: 'Bytes',
  time: 'Time',
  errors: 'Errors'
}
/** What thickness means, for the Flow header and the legend. */
export const WEIGHT_MEANS: Record<EdgeMetric, string> = {
  requests: 'requests/s',
  bytes: 'response bytes/s',
  time: 'time spent/s',
  errors: 'errors/s'
}
export const WEIGHT_HINT: Record<EdgeMetric, string> = {
  requests: 'Requests per second on each edge',
  bytes: 'Response bytes per second: what each edge carries back',
  time: 'Total time per second: how much waiting each edge holds',
  errors: 'Failed requests per second (failed partner calls on downstream edges)'
}

/**
 * Line width for an edge weighing `w` in `metric` (per second). Requests keep their absolute
 * widths (edgeWidthFor); the other measures have no natural unit, so they are drawn relative to
 * the busiest edge drawn (`max`), through the same curve the scale picks. An edge with traffic
 * but no weight (no errors) returns 0: the canvas draws it as a hairline so the shape stays.
 */
export function edgeWidthByMetric(
  w: number,
  metric: EdgeMetric,
  scale: EdgeScale,
  max = 0
): number {
  if (metric === 'requests') return edgeWidthFor(w, scale, max)
  if (!(w > 0) || !(max > 0)) return 0
  const rel = Math.min(1, w / max)
  const f = scale === 'log' ? Math.log10(1 + 9 * rel) : scale === 'linear' ? rel : Math.sqrt(rel)
  return 1 + 10 * f
}
/** Hairline width/alpha for an edge with traffic but no weight in the chosen measure. */
export const HAIRLINE = { width: 0.75, alpha: 0.45 }

const fmtNum = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)))
/** An edge's figure in its measure: `3.2/s`, `14 KB/s`, `340 ms/s`, `0.2 err/s`. */
export function fmtWeight(w: number, metric: EdgeMetric): string {
  if (!Number.isFinite(w) || w <= 0) return metric === 'errors' ? '0 err/s' : '0/s'
  if (metric === 'bytes') {
    if (w < 1024) return `${Math.round(w)} B/s`
    if (w < 1024 * 1024) return `${fmtNum(w / 1024)} KB/s`
    return `${fmtNum(w / (1024 * 1024))} MB/s`
  }
  if (metric === 'time') return w < 1000 ? `${Math.round(w)} ms/s` : `${fmtNum(w / 1000)} s/s`
  if (metric === 'errors') return `${fmtNum(w)} err/s`
  return `${fmtNum(w)}/s`
}

// ── #1163 app groups ────────────────────────────────────────────────────────
export const APP_GROUP_LABEL: Record<string, string> = {
  'app:admin': 'Admin app',
  'app:efp-new': 'efp-new',
  'app:integrations': 'Integrations',
  'app:cron': 'Cron and sources',
  'app:people': 'People, no app header',
  'app:anon': 'No credentials',
  'app:mcp': 'AI assistants (MCP)',
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
  // #2469 — each MCP client (`m:<name>`) is its own caller, grouped with the other assistants.
  if (kind === 'mcp' || caller.startsWith('m:')) return 'app:mcp'
  if (kind === 'key' || kind === 'machine') return 'app:integrations'
  const app = apps.get(caller)
  if (app) return `app:${app}`
  if (kind === 'anon' || caller === 'anon') return 'app:anon'
  if (kind === 'person') return 'app:people'
  return 'app:other'
}
export const isAppGroup = (id: string) => id.startsWith('app:')
