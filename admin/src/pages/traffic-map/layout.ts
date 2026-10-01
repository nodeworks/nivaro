import type { Lane, Selection } from './types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface MapLayout {
  W: number
  H: number
  callers: Record<string, Rect>
  lanes: Record<string, Rect>
  ents: Record<string, Rect>
  downs: Record<string, Rect>
  rowH: number
  laneHead: number
}
const COL_W = 164
const ROW_H = 20
const LANE_HEAD = 24
/** Below this the map box scrolls horizontally; above it the canvas fills its box (R34). */
const MIN_W = 720
/** At or above this width the side columns keep their full COL_W. */
const FULL_W = 860
/** Band above the columns for the canvas captions (Callers / API lanes / Data and partners). */
const TOP = 22

export function computeLayout(input: {
  width: number
  callers: string[]
  /** `entities` are BARE entity ids (no lane prefix); rects are keyed `${lane}/${entity}`. */
  lanes: Array<{ id: Lane; entities: string[] }>
  downs: string[]
}): MapLayout {
  const W = Number.isFinite(input.width) ? Math.max(MIN_W, Math.floor(input.width)) : MIN_W
  // narrower boxes shrink the side columns (164 → 141 px at 720) before the lane floor (280)
  const colW = W >= FULL_W ? COL_W : Math.max(140, COL_W - Math.round((FULL_W - W) / 6))
  const laneW = Math.min(360, Math.max(280, W - 2 * (colW + 40) - 160))
  const laneX = Math.round((W - laneW) / 2)
  const lanes: Record<string, Rect> = {}
  const ents: Record<string, Rect> = {}
  let y = TOP + 4
  for (const lane of input.lanes) {
    const h = LANE_HEAD + lane.entities.length * ROW_H + 8
    lanes[lane.id] = { x: laneX, y, w: laneW, h }
    let ey = y + LANE_HEAD + 2
    for (const entity of lane.entities) {
      // keyed `${lane}/${entity}` like the server/model keys, so equal ids in two lanes never collide
      ents[`${lane.id}/${entity}`] = { x: laneX + 6, y: ey, w: laneW - 12, h: ROW_H }
      ey += ROW_H
    }
    y += h + 10
  }
  const H = Math.max(
    y + 6,
    320,
    TOP + 10 + input.downs.length * 40,
    TOP + 10 + input.callers.length * 44
  )
  const place = (list: string[], x: number, h: number): Record<string, Rect> => {
    const out: Record<string, Rect> = {}
    const gap = list.length > 1 ? (H - TOP - 10 - list.length * h) / (list.length - 1) : 0
    list.forEach((id, i) => {
      out[id] = { x, y: TOP + i * (h + Math.max(0, gap)), w: colW, h }
    })
    return out
  }
  return {
    W,
    H,
    callers: place(input.callers, 14, 44),
    lanes,
    ents,
    downs: place(input.downs, W - colW - 14, 40),
    rowH: ROW_H,
    laneHead: LANE_HEAD
  }
}

const inside = (r: Rect, x: number, y: number) =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

export function hitTest(l: MapLayout, x: number, y: number): Selection | null {
  for (const id in l.ents) if (inside(l.ents[id], x, y)) return { kind: 'entity', id }
  for (const id in l.lanes) if (inside(l.lanes[id], x, y)) return { kind: 'lane', id: id as Lane }
  for (const id in l.callers) if (inside(l.callers[id], x, y)) return { kind: 'caller', id }
  for (const id in l.downs) if (inside(l.downs[id], x, y)) return { kind: 'down', id }
  return null
}

export function bezierPoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number
): { x: number; y: number } {
  const mx = (a.x + b.x) / 2
  const u = 1 - t
  const x = u ** 3 * a.x + 3 * u * u * t * mx + 3 * u * t * t * mx + t ** 3 * b.x
  const y = u ** 3 * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t ** 3 * b.y
  return { x, y }
}

/** Returns 0 for rps <= 0: the canvas must skip zero-width edges rather than stroke them. */
export function edgeWidth(rps: number): number {
  return rps <= 0 ? 0 : Math.min(11, 1 + Math.sqrt(rps) * 2.2)
}

export interface MapTokens {
  card: string
  card2: string
  fg: string
  fg2: string
  muted: string
  line: string
  line2: string
  accent: string
  accentSoft: string
  read: string
  create: string
  update: string
  delete: string
  error: string
  errorSoft: string
  edge: string
  node: string
  nodeLine: string
}
export const TOKEN_FALLBACK: MapTokens = {
  card: '#ffffff',
  card2: '#f8fafc',
  fg: '#172940',
  fg2: '#475569',
  muted: '#64748b',
  line: '#dbe2ea',
  line2: '#eceff3',
  accent: '#00ceff',
  accentSoft: 'rgba(0, 206, 255, 0.12)',
  read: '#0891b2',
  create: '#15803d',
  update: '#b45309',
  delete: '#475569',
  error: '#dc2626',
  errorSoft: 'rgba(220, 38, 38, 0.10)',
  edge: 'rgba(23, 41, 64, 0.16)',
  node: '#ffffff',
  nodeLine: '#cbd5e1'
}
const TOKEN_VARS: Record<keyof MapTokens, string> = {
  card: '--tm-card',
  card2: '--tm-card-2',
  fg: '--tm-fg',
  fg2: '--tm-fg-2',
  muted: '--tm-muted',
  line: '--tm-line',
  line2: '--tm-line-2',
  accent: '--tm-accent',
  accentSoft: '--tm-accent-soft',
  read: '--tm-read',
  create: '--tm-create',
  update: '--tm-update',
  delete: '--tm-delete',
  error: '--tm-error',
  errorSoft: '--tm-error-soft',
  edge: '--tm-edge',
  node: '--tm-node',
  nodeLine: '--tm-node-line'
}
export function readTokens(el: Element): MapTokens {
  const cs = getComputedStyle(el)
  const out = { ...TOKEN_FALLBACK }
  for (const k of Object.keys(TOKEN_VARS) as Array<keyof MapTokens>) {
    const v = cs.getPropertyValue(TOKEN_VARS[k]).trim()
    if (v) out[k] = v
  }
  return out
}
