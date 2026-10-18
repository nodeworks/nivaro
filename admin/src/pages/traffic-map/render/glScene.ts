// #2279 — what the WebGL renderer draws, built from the same MapData + layout the 2D canvas
// paints (pure, so it is tested without a GPU). Geometry only: edges as thick polylines, node
// boxes / lane cards / entity dots and kind bars as rounded rects. Text, badges, pulses, flashes,
// dashed outlines, path-trace veils and plug-in layers stay on the 2D pass over it, drawn only
// for what is on screen. Colours come from the --tm-* tokens, so light and dark follow the theme.
import { type EdgeScale, edgeWidthByMetric, HAIRLINE } from '../canvasView'
import {
  bezierPoint,
  type EdgeDir,
  type EdgeRoutes,
  edgeEnds,
  type MapLayout,
  type MapTokens,
  ROUTE_SEGS,
  routeKey
} from '../layout'
import type { MapData, NodeView } from '../MapCanvas'
import type { EdgeMetric } from '../model'
import { KIND_ORDER, type Kind, type Lane, type Selection } from '../types'
import type { RGBA } from './color'

/** Floats per segment instance: x0 y0 x1 y1, n0x n0y n1x n1y, half width, r g b a. */
export const SEG_FLOATS = 13
/** Floats per rect instance: x y w h, radius, stroke width, fill rgba, stroke rgba. */
export const RECT_FLOATS = 14
/** Off-path alpha while a caller's path is traced (the 2D canvas uses the same). */
export const FADED = 0.16

export interface TraceSet {
  caller: string
  lanes: Set<Lane>
  ents: Set<string>
  downs: Set<string>
}
export interface GlScene {
  /** Base edges, one instance per polyline segment. */
  segs: Float32Array
  segCount: number
  /** The hovered / selected node's edges in the accent colour (drawn at the highlight alpha). */
  accent: Float32Array
  accentCount: number
  rects: Float32Array
  rectCount: number
}
export interface SceneArgs {
  data: MapData
  layout: MapLayout
  routes: EdgeRoutes | null
  tokens: MapTokens
  color: (css: string) => RGBA
  scale: EdgeScale
  metric: EdgeMetric
  active: Selection | null
  trace: TraceSet | null
  /** Plug-in edge styles (registry edgeStyles): the tone a partner edge is recoloured to. */
  styleOf?: (
    dir: 'in' | 'out',
    e: { from: string; to: string; rps: number }
  ) => { tone: keyof MapTokens } | null
}

/** A growable float buffer (one allocation per scene, trimmed on finish). */
class Buf {
  a: Float32Array
  n = 0
  constructor(
    readonly stride: number,
    cap = 64
  ) {
    this.a = new Float32Array(cap * stride)
  }
  push(...v: number[]): void {
    if ((this.n + 1) * this.stride > this.a.length) {
      const b = new Float32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a.set(v, this.n * this.stride)
    this.n++
  }
  done(): Float32Array {
    return this.a.subarray(0, this.n * this.stride)
  }
}

const laneOfKey = (key: string) => key.slice(0, key.indexOf('/')) as Lane

/** The edge's polyline: from the worker's routes when it has the edge, else flattened here. */
export function polyline(
  l: MapLayout,
  routes: EdgeRoutes | null,
  dir: EdgeDir,
  from: string,
  to: string
): Float32Array | null {
  const slot = routes?.index.get(routeKey(dir, from, to))
  if (routes && slot !== undefined) {
    const per = (routes.segs + 1) * 2
    return routes.points.subarray(slot * per, slot * per + per)
  }
  const ends = edgeEnds(l, dir, from, to)
  if (!ends) return null
  const out = new Float32Array((ROUTE_SEGS + 1) * 2)
  for (let k = 0; k <= ROUTE_SEGS; k++) {
    const p = bezierPoint(ends[0], ends[1], k / ROUTE_SEGS)
    out[k * 2] = p.x
    out[k * 2 + 1] = p.y
  }
  return out
}

/** Push a polyline as segment instances, with shared per-point normals (no overlapping joins). */
export function pushPolyline(buf: Buf, pts: Float32Array, halfW: number, c: RGBA, alpha = 1): void {
  const n = pts.length / 2
  if (n < 2 || !(halfW > 0)) return
  const normal = (i: number): [number, number] => {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    const tx = pts[b * 2] - pts[a * 2]
    const ty = pts[b * 2 + 1] - pts[a * 2 + 1]
    const len = Math.hypot(tx, ty) || 1
    return [-ty / len, tx / len]
  }
  let n0 = normal(0)
  for (let i = 0; i < n - 1; i++) {
    const n1 = normal(i + 1)
    buf.push(
      pts[i * 2],
      pts[i * 2 + 1],
      pts[i * 2 + 2],
      pts[i * 2 + 3],
      n0[0],
      n0[1],
      n1[0],
      n1[1],
      halfW,
      c[0],
      c[1],
      c[2],
      c[3] * alpha
    )
    n0 = n1
  }
}

function pushRect(
  buf: Buf,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  strokeW: number,
  fill: RGBA | null,
  stroke: RGBA | null
): void {
  const f = fill ?? [0, 0, 0, 0]
  const s = stroke ?? [0, 0, 0, 0]
  buf.push(x, y, w, h, radius, stroke ? strokeW : 0, f[0], f[1], f[2], f[3], s[0], s[1], s[2], s[3])
}

export function buildGlScene(a: SceneArgs): GlScene {
  const { data: d, layout: l, routes, tokens: T, color, scale, metric, active: sel, trace: tr } = a
  const segs = new Buf(SEG_FLOATS, 1024)
  const accent = new Buf(SEG_FLOATS, 128)
  const rects = new Buf(RECT_FLOATS, 256)

  // ── edges (same order, widths and fades as the 2D canvas) ──
  const selLane: Lane | null =
    sel?.kind === 'lane' ? sel.id : sel?.kind === 'entity' ? laneOfKey(sel.id) : null
  const selEntityDowns =
    sel?.kind === 'entity' ? d.entityDowns.get(sel.id)?.map(([id]) => id) : undefined
  const entFrom = new Set(d.edgesEnt.map((e) => e.from))
  const onPathIn = (e: { from: string; to: Lane }) =>
    !tr || (e.from === tr.caller && tr.lanes.has(e.to))
  const onPathOut = (e: { from: Lane; to: string }) =>
    !tr || (tr.lanes.has(e.from) && tr.downs.has(e.to))
  const base = color(T.edge)
  const accentC = color(T.accent)
  const tone = (dir: 'in' | 'out', e: { from: string; to: string; rps: number }) => {
    const st = a.styleOf?.(dir, e)
    return st ? color(T[st.tone] ?? T.edge) : base
  }
  const width = (w: number, rps: number, max: number): { w: number; alpha: number } => {
    const px = edgeWidthByMetric(w, metric, scale, max)
    if (px > 0) return { w: px, alpha: 1 }
    // traffic with no weight in this measure: a hairline keeps the map's shape
    return rps > 0 && metric !== 'requests'
      ? { w: HAIRLINE.width, alpha: HAIRLINE.alpha }
      : { w: 0, alpha: 0 }
  }
  const edge = (
    dir: EdgeDir,
    from: string,
    to: string,
    w: number,
    rps: number,
    max: number,
    c: RGBA,
    alpha: number,
    entScale = 1
  ) => {
    const ww = width(w, rps, max)
    if (ww.w <= 0) return
    const pts = polyline(l, routes, dir, from, to)
    if (pts) pushPolyline(segs, pts, (ww.w * entScale) / 2, c, alpha * ww.alpha)
  }
  for (const e of d.edgesIn) {
    if (entFrom.has(e.from)) continue
    edge('in', e.from, e.to, e.w, e.rps, d.maxIn, tone('in', e), onPathIn(e) ? 1 : FADED)
  }
  for (const e of d.edgesEnt) {
    const onPath = !tr || (e.from === tr.caller && tr.ents.has(e.to))
    const c = tone('in', { from: e.from, to: laneOfKey(e.to), rps: e.rps })
    const ww = width(e.w, e.rps, d.maxIn)
    if (ww.w <= 0) continue
    const pts = polyline(l, routes, 'ent', e.from, e.to)
    // the 2D canvas strokes entity edges at 0.8 of their width (never under 0.75 px)
    if (pts)
      pushPolyline(segs, pts, Math.max(0.75, ww.w * 0.8) / 2, c, (onPath ? 1 : FADED) * ww.alpha)
  }
  for (const e of d.edgesOut)
    edge('out', e.from, e.to, e.w, e.rps, d.maxOut, tone('out', e), onPathOut(e) ? 1 : FADED)

  if (sel && !tr) {
    const hi = (dir: EdgeDir, from: string, to: string, w: number, rps: number, max: number) => {
      const px = Math.max(1.5, edgeWidthByMetric(w, metric, scale, max))
      if (!(rps > 0)) return
      const pts = polyline(l, routes, dir, from, to)
      if (pts) pushPolyline(accent, pts, px / 2, accentC)
    }
    for (const e of d.edgesIn)
      if (
        !entFrom.has(e.from) &&
        ((sel.kind === 'caller' && sel.id === e.from) || (selLane !== null && e.to === selLane))
      )
        hi('in', e.from, e.to, e.w, e.rps, d.maxIn)
    for (const e of d.edgesEnt)
      if (
        (sel.kind === 'caller' && sel.id === e.from) ||
        (sel.kind === 'entity' && sel.id === e.to)
      )
        hi('ent', e.from, e.to, e.w, e.rps, d.maxIn)
    for (const e of d.edgesOut)
      if (
        (sel.kind === 'down' && sel.id === e.to) ||
        (sel.kind === 'lane' && sel.id === e.from) ||
        (sel.kind === 'entity' &&
          e.from === selLane &&
          (!selEntityDowns?.length || selEntityDowns.includes(e.to)))
      )
        hi('out', e.from, e.to, e.w, e.rps, d.maxOut)
  }

  // ── nodes ──
  const isSel = (kind: Selection['kind'], id: string) => !!sel && sel.kind === kind && sel.id === id
  const node = (
    r: { x: number; y: number; w: number; h: number },
    n: NodeView,
    selected: boolean
  ) => {
    if (n.kind === 'group')
      pushRect(rects, r.x + 4, r.y + 4, r.w, r.h, 8, 1, color(T.card2), color(T.nodeLine))
    // a partner's dashed outline is drawn by the 2D pass (dashes are cheap there, costly here)
    const stroke = n.partner ? null : color(selected ? T.accent : T.nodeLine)
    pushRect(rects, r.x, r.y, r.w, r.h, 8, selected ? 2 : 1, color(T.node), stroke)
  }
  for (const c of [...d.callers, ...d.sources]) {
    const r = l.callers[c.id]
    if (r) node(r, c, isSel('caller', c.id))
  }
  const KC: Record<Kind, RGBA> = {
    read: color(T.read),
    create: color(T.create),
    update: color(T.update),
    delete: color(T.delete),
    error: color(T.error)
  }
  for (const lane of d.lanes) {
    const r = l.lanes[lane.id]
    if (!r) continue
    const laneSel = isSel('lane', lane.id)
    pushRect(
      rects,
      r.x,
      r.y,
      r.w,
      r.h,
      8,
      laneSel ? 2 : 1,
      color(T.card2),
      color(laneSel ? T.accent : T.line)
    )
    const maxR = Math.max(0.1, ...lane.entities.map((e) => e.rps))
    for (const e of lane.entities) {
      const er = l.ents[e.key]
      if (!er) continue
      const cy = er.y + er.h / 2
      const dot = e.errFrac > 0.05 ? color(T.error) : color(T.nodeLine)
      pushRect(rects, er.x + 7 - 2.5, cy - 2.5, 5, 5, 2.5, 0, dot, null)
      const bw = Math.min(92, Math.max(48, er.w * 0.27))
      const bx = er.x + er.w - bw - 46
      const by = er.y + 8
      pushRect(rects, bx, by, bw, 4, 0, 0, color(T.line2), null)
      const tot = e.kinds.reduce((x, y) => x + y, 0)
      if (tot > 0) {
        const s = (e.rps / maxR) * bw
        let acc = 0
        e.kinds.forEach((n, i) => {
          const w = s * (n / tot)
          if (w <= 0) return
          pushRect(rects, bx + acc, by, Math.max(w, 0.5), 4, 0, 0, KC[KIND_ORDER[i]], null)
          acc += w
        })
      }
    }
  }
  for (const dn of d.downs) {
    const r = l.downs[dn.id]
    if (r) node(r, dn, isSel('down', dn.id))
  }

  return {
    segs: segs.done(),
    segCount: segs.n,
    accent: accent.done(),
    accentCount: accent.n,
    rects: rects.done(),
    rectCount: rects.n
  }
}

/** Particles as round rect instances (dots, plus a ring round an error), drawn every frame. */
export function particleRects(
  list: Array<{ x: number; y: number; kind: Kind }>,
  kc: Record<Kind, RGBA>
): { rects: Float32Array; count: number } {
  const buf = new Buf(RECT_FLOATS, Math.max(16, list.length * 2))
  for (const p of list) {
    const r = p.kind === 'read' ? 2.2 : 3
    const c = kc[p.kind]
    const fill: RGBA = [c[0], c[1], c[2], c[3] * (p.kind === 'read' ? 0.75 : 1)]
    pushRect(buf, p.x - r, p.y - r, r * 2, r * 2, r, 0, fill, null)
    if (p.kind === 'error') {
      const ring: RGBA = [c[0], c[1], c[2], c[3] * 0.5]
      pushRect(buf, p.x - 6, p.y - 6, 12, 12, 6, 1, null, ring)
    }
  }
  return { rects: buf.done(), count: buf.n }
}
