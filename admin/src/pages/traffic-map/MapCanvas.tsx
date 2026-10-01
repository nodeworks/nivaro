// The flow map: callers → API lanes (entity rows) → data stores and partners, hand-drawn on a
// canvas. Every colour comes from the --tm-* tokens (readTokens), re-read on theme change.
// Data is recomputed once per frame tick; the rAF loop only animates particles, pulses, flashes
// and the hover/selection highlight. prefers-reduced-motion: no particles, no rAF loop.
import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { callerLabel, entityLabel } from './EventTicker'
import {
  bezierPoint,
  computeLayout,
  edgeWidth,
  hitTest,
  type MapLayout,
  type MapTokens,
  type Rect,
  readTokens
} from './layout'
import type { TrafficModel } from './model'
import { badgeFor, canvasLayers, nodeBadges } from './registry/canvasLayers'
import {
  type Filters,
  KIND_ORDER,
  type Kind,
  LANE_LABEL,
  LANE_ORDER,
  type Lane,
  type Selection,
  type TrafficCatalog,
  type TrafficEventWire
} from './types'

export interface MapCanvasProps {
  model: TrafficModel
  filters: Filters
  selection: Selection | null
  onSelect: (s: Selection) => void
  catalog: TrafficCatalog | null
  tick: number
  paused: boolean
  /** No frame for a while although live (socket dropped): footer shows the amber note (D9). */
  stale?: boolean
}

const ROUTE_HINT: Record<Lane, string> = {
  items: '/api/items/:collection',
  widgets: '/widgets-internal/:id/render',
  pages: '/pages/:slug/widget-data',
  queries: '/custom-queries/:slug/execute',
  graphql: '/graphql operations',
  inbound: '/api/inbound/:key',
  files: '/api/files',
  extension: 'extension routes',
  system: '/api/items/nivaro_*',
  other: 'other'
}
const CALLER_KIND_TEXT: Record<string, string> = {
  key: 'API key',
  person: 'signed-in person',
  machine: 'integration account',
  cron: 'crons and flows · no request',
  anon: 'no credentials'
}
const OTHERS = '__others__'
const MAX_CALLERS = 6
const MAX_ENTITIES_PER_LANE = 12
const MAX_PARTICLES = 300
/** Per edge, per frame (frames are one second apart): above this the particles are sampled. */
const PARTICLES_PER_EDGE = 24
const FLASH_MS = 1200
const PULSE_MS = 900
const HIGHLIGHT_MS = 160
const EVENT_MAX_AGE_MS = 5000

export interface EntityView {
  key: string
  entity: string
  label: string
  rps: number
  /** [read, create, update, delete, error] filtered by the kind filter. */
  kinds: number[]
  errFrac: number
}
export interface LaneView {
  id: Lane
  rps: number
  entities: EntityView[]
}
export interface NodeView {
  id: string
  label: string
  sub: string
  rps: number
  partner: boolean
}
/** What one paint draws (built once per frame tick) — canvas layers (registry/) receive it. */
export interface MapData {
  callers: NodeView[]
  lanes: LaneView[]
  downs: NodeView[]
  edgesIn: Array<{ from: string; to: Lane; rps: number }>
  edgesOut: Array<{ from: Lane; to: string; rps: number }>
  /** Lane → its out edges, for routing a particle's second leg. */
  laneOut: Map<Lane, Array<{ to: string; rps: number }>>
  entityDowns: Map<string, Array<[string, number]>>
  /** The model has received its first snapshot (before that: a quiet loading state). */
  loaded: boolean
  empty: boolean
  winLabel: string
  summary: string
}
interface Particle {
  stage: 0 | 1
  t: number
  a: { x: number; y: number }
  b: { x: number; y: number }
  kind: Kind
  lane: Lane
  entityKey: string
  speed: number
}

const fmtRate = (r: number) =>
  !Number.isFinite(r) || r <= 0 ? '0/s' : r < 10 ? `${r.toFixed(1)}/s` : `${Math.round(r)}/s`

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}
function edgePath(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number }
) {
  const mx = (a.x + b.x) / 2
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
}
/** Truncate to `max` px with an ellipsis (measured in the current font). */
function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  max: number,
  cache?: Map<string, string>
): string {
  if (max <= 0) return ''
  const key = cache ? `${ctx.font}|${Math.round(max)}|${text}` : ''
  const hit = cache?.get(key)
  if (hit !== undefined) return hit
  const out = ellipsizeUncached(ctx, text, max)
  cache?.set(key, out)
  return out
}
function ellipsizeUncached(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : ''
}
function pickWeighted<T>(list: Array<[T, number]>): T | null {
  const total = list.reduce((a, [, w]) => a + w, 0)
  if (total <= 0) return list[0]?.[0] ?? null
  let r = Math.random() * total
  for (const [v, w] of list) {
    r -= w
    if (r <= 0) return v
  }
  return list[list.length - 1][0]
}
const easeOut = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3
const sameSel = (a: Selection | null, b: Selection | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id)
const laneOfKey = (key: string) => key.slice(0, key.indexOf('/')) as Lane
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
/** "1 min" / "5 min" / "15 min" for the window selector's values. */
export const windowLabel = (win: number) => `${Math.max(1, Math.round(win / 60))} min`

function downLabel(m: TrafficModel, cat: TrafficCatalog | null, id: string): string {
  if (cat?.down[id]) return cat.down[id]
  if (id.startsWith('ext:') && cat?.partners[id.slice(4)]) return cat.partners[id.slice(4)]
  return m.downLabels.get(id) ?? id
}
function downSub(id: string): string {
  if (id === 'db') return 'reads and writes'
  if (id === 'redis') return 'cache hits'
  if (id === 'store') return 'uploads and downloads'
  return 'partner calls'
}

/** Everything the frame needs, computed once per tick (not per animation frame). */
function buildData(m: TrafficModel, filters: Filters, cat: TrafficCatalog | null): MapData {
  const win = filters.win
  // lanes + entities: hot() already applies the lane, kind and caller filters
  const rows = m.hot(win, filters, 100000)
  const byLane = new Map<Lane, typeof rows>()
  for (const r of rows) {
    if (r.lane === 'other') continue // lane `other` is never drawn (counted in totals only)
    const list = byLane.get(r.lane) ?? []
    list.push(r)
    byLane.set(r.lane, list)
  }
  const lanes: LaneView[] = []
  for (const id of LANE_ORDER) {
    if (id === 'other' || !filters.types.has(id)) continue
    const list = byLane.get(id)
    if (!list?.length) continue
    lanes.push({
      id,
      rps: list.reduce((a, r) => a + r.rps, 0),
      entities: list.slice(0, MAX_ENTITIES_PER_LANE).map((r) => {
        const s = m.entitySum(r.key, win)
        const kinds = KIND_ORDER.map((k, i) => (filters.kinds.has(k) ? s[i + 1] : 0))
        return {
          key: r.key,
          entity: r.entity,
          label: entityLabel(cat, id, r.entity),
          rps: r.rps,
          kinds,
          errFrac: r.errPct / 100
        }
      })
    })
  }

  // downstream: data stores first (db always), partners after, busiest first
  const ids = m.downIds()
  const core = ['db', 'redis', 'store'].filter((d) => d === 'db' || ids.includes(d))
  const partners = ids
    .filter((d) => d.startsWith('ext:'))
    .map((d) => ({ d, r: m.downSum(d, win)[0] }))
    .sort((a, b) => b.r - a.r)
    .map((p) => p.d)
  const downs: NodeView[] = [...core, ...partners].map((id) => ({
    id,
    label: downLabel(m, cat, id),
    sub: downSub(id),
    rps: m.downSum(id, win)[0] / win,
    partner: id.startsWith('ext:')
  }))
  const downSet = new Set(downs.map((d) => d.id))
  const laneSet = new Set(lanes.map((l) => l.id))

  // callers are ranked on the traffic they send into DRAWN lanes, so a caller whose requests
  // all land in lane `other` or a hidden lane never floats in the column without an edge
  const edges = m.edges(win, filters)
  const drawnIn: Array<[string, Lane, number]> = []
  const perCaller = new Map<string, number>()
  for (const [key, rps] of edges.in) {
    const [caller, lane] = key.split('>') as [string, Lane]
    if (!laneSet.has(lane) || rps <= 0) continue
    drawnIn.push([caller, lane, rps])
    perCaller.set(caller, (perCaller.get(caller) ?? 0) + rps)
  }
  const ranked = [...perCaller].sort((a, b) => b[1] - a[1])
  const top = ranked.slice(0, MAX_CALLERS)
  const rest = ranked.slice(MAX_CALLERS)
  const callers: NodeView[] = top.map(([k, rps]) => {
    const kind = cat?.callers[k]?.kind
    const sub =
      (kind && CALLER_KIND_TEXT[kind]) || (k === 'cron' ? CALLER_KIND_TEXT.cron : 'caller')
    const errors = m.callerSum(k, win)[1]
    return {
      id: k,
      label: callerLabel(cat, k),
      sub: errors > 0 ? `${sub} · ${errors} errors` : sub,
      rps,
      partner: false
    }
  })
  if (rest.length)
    callers.push({
      id: OTHERS,
      label: 'Other callers',
      sub: `${rest.length} more`,
      rps: rest.reduce((a, [, r]) => a + r, 0),
      partner: false
    })
  const topIds = new Set(top.map(([k]) => k))
  const inAgg = new Map<string, number>()
  for (const [caller, lane, rps] of drawnIn) {
    const k = `${topIds.has(caller) ? caller : OTHERS}>${lane}`
    inAgg.set(k, (inAgg.get(k) ?? 0) + rps)
  }
  const edgesIn = [...inAgg].map(([k, rps]) => {
    const [from, to] = k.split('>') as [string, Lane]
    return { from, to, rps }
  })
  const edgesOut: MapData['edgesOut'] = []
  const laneOut = new Map<Lane, Array<{ to: string; rps: number }>>()
  for (const [key, rps] of edges.out) {
    const i = key.indexOf('>')
    const from = key.slice(0, i) as Lane
    const to = key.slice(i + 1)
    if (!laneSet.has(from) || !downSet.has(to)) continue
    edgesOut.push({ from, to, rps })
    const list = laneOut.get(from) ?? []
    list.push({ to, rps })
    laneOut.set(from, list)
  }
  const entityDowns = new Map<string, Array<[string, number]>>()
  for (const lane of lanes)
    for (const e of lane.entities) {
      const d = m.entityMeta(e.key)?.down
      if (d)
        entityDowns.set(
          e.key,
          Object.entries(d).filter(([id, n]) => downSet.has(id) && n > 0)
        )
    }

  const busiest = lanes
    .slice()
    .sort((a, b) => b.rps - a.rps)
    .slice(0, 3)
    .map((l) => `${LANE_LABEL[l.id]} ${fmtRate(l.rps)}`)
  const loaded = m.snapshotTotals !== null
  const winLabel = windowLabel(win)
  const summary = !loaded
    ? 'Flow of API traffic: loading.'
    : lanes.length
      ? `Flow of API traffic over the last ${winLabel}. Busiest lanes: ${busiest.join(', ')}. ${plural(callers.length, 'caller')}, ${plural(downs.length, 'downstream system')}.`
      : `Flow of API traffic: no requests in the last ${winLabel}.`
  return {
    callers,
    lanes,
    downs,
    edgesIn,
    edgesOut,
    laneOut,
    entityDowns,
    loaded,
    empty: lanes.length === 0,
    winLabel,
    summary
  }
}

export function MapCanvas({
  model: m,
  filters,
  selection,
  onSelect,
  catalog,
  tick,
  paused,
  stale
}: MapCanvasProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const monoRef = useRef<HTMLSpanElement>(null)
  const tokensRef = useRef<{ T: MapTokens; sans: string; mono: string } | null>(null)
  const particles = useRef<Particle[]>([])
  const spawned = useRef(new WeakSet<TrafficEventWire>())
  const [hover, setHover] = useState<Selection | null>(null)
  const [width, setWidth] = useState(0)
  const [themeV, setThemeV] = useState(0)
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  const data = useMemo(() => buildData(m, filters, catalog), [m, filters, catalog, tick])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    setWidth(box.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(box.clientWidth))
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(
    () =>
      computeLayout({
        width,
        callers: data.callers.map((c) => c.id),
        lanes: data.lanes.map((l) => ({ id: l.id, entities: l.entities.map((e) => e.entity) })),
        downs: data.downs.map((d) => d.id)
      }),
    [width, data]
  )
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __tmLayout?: MapLayout }).__tmLayout = layout
  }, [layout])

  // tokens follow the theme: admin dark mode is the .dark class on <html>; also the OS scheme
  // and a runtime brand colour (style attribute) — re-read and repaint on any of them
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = () => {
      const sans = getComputedStyle(el).fontFamily || 'sans-serif'
      const mono = monoRef.current ? getComputedStyle(monoRef.current).fontFamily : ''
      tokensRef.current = { T: readTokens(el), sans, mono: mono || 'monospace' }
      setThemeV((v) => v + 1)
    }
    update()
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener('change', update)
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style']
    })
    return () => {
      mq?.removeEventListener('change', update)
      mo.disconnect()
    }
  }, [])

  // highlight easing: when the hovered/selected thing changes, the accent edges fade in
  const active = hover ?? selection
  const hlRef = useRef<{ sel: Selection | null; at: number }>({ sel: null, at: 0 })
  // layout effect: runs before the next paint, so no frame shows the new highlight at full alpha
  useLayoutEffect(() => {
    if (!sameSel(hlRef.current.sel, active)) hlRef.current = { sel: active, at: performance.now() }
  })

  // live state for the animation loop (read through refs so the loop never restarts)
  const live = useRef({ data, layout, active, selection, filters, paused, reduced })
  live.current = { data, layout, active, selection, filters, paused, reduced }

  // spawn one particle per new event (sampled per edge), only when motion is allowed.
  // Runs once per frame tick; filters/layout/motion are read from that render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  useEffect(() => {
    if (reduced || paused || (typeof document !== 'undefined' && document.hidden)) return
    // age is measured against the newest event (server clock), never the client clock
    const newest = m.events[0]?.t ?? 0
    const perEdge = new Map<string, number>()
    const callerIds = new Set(Object.keys(layout.callers))
    for (const ev of m.events) {
      if (spawned.current.has(ev)) break // newest first: everything after this was seen
      spawned.current.add(ev)
      if (newest - ev.t > EVENT_MAX_AGE_MS) continue
      if (
        !filters.types.has(ev.lane) ||
        !filters.kinds.has(ev.kind) ||
        (filters.caller && ev.caller !== filters.caller)
      )
        continue
      const from = callerIds.has(ev.caller) ? ev.caller : callerIds.has(OTHERS) ? OTHERS : null
      const c = from ? layout.callers[from] : undefined
      const lane = layout.lanes[ev.lane]
      if (!c || !lane) continue
      const edgeKey = `${from}>${ev.lane}`
      const n = (perEdge.get(edgeKey) ?? 0) + 1
      perEdge.set(edgeKey, n)
      if (n > PARTICLES_PER_EDGE || particles.current.length >= MAX_PARTICLES) continue
      particles.current.push({
        stage: 0,
        t: -Math.random() * 0.4,
        a: { x: c.x + c.w, y: c.y + c.h / 2 },
        b: { x: lane.x, y: lane.y + 11 },
        kind: ev.kind,
        lane: ev.lane,
        entityKey: `${ev.lane}/${ev.entity}`,
        speed: 0.9 + Math.random() * 0.5
      })
    }
  }, [m, tick])

  // motion turned off or paused: drop in-flight particles so nothing hangs mid-edge
  useEffect(() => {
    if (reduced || paused) particles.current = []
  }, [reduced, paused])

  // the loop draws only when something changed or something is still animating
  const dirtyRef = useRef(true)
  const fitCache = useRef(new Map<string, string>())
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the repaint triggers
  useEffect(() => {
    fitCache.current.clear()
  }, [data, layout, themeV])
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the repaint triggers
  useLayoutEffect(() => {
    dirtyRef.current = true
  }, [data, layout, active, themeV, paused, reduced])

  // draw: one loop per motion mode; reduced motion repaints through drawRef instead of a loop
  const drawRef = useRef<((dt: number) => boolean) | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d') ?? null
    if (!canvas || !ctx) return
    let raf = 0
    let last = performance.now()

    /** Paints one frame; returns true while something is still animating. */
    const draw = (dt: number): boolean => {
      const {
        data: d,
        layout: l,
        active: sel,
        paused: pz,
        reduced: rd,
        filters: lf,
        selection: lsel
      } = live.current
      const tok = tokensRef.current ?? {
        T: readTokens(rootRef.current ?? document.documentElement),
        sans: 'sans-serif',
        mono: 'monospace'
      }
      const { T, sans, mono } = tok
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const pw = Math.round(l.W * dpr)
      const ph = Math.round(l.H * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
        canvas.style.width = `${l.W}px`
        canvas.style.height = `${l.H}px`
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, l.W, l.H)
      ctx.fillStyle = T.card
      ctx.fillRect(0, 0, l.W, l.H)
      ctx.textBaseline = 'alphabetic'
      const KC: Record<Kind, string> = {
        read: T.read,
        create: T.create,
        update: T.update,
        delete: T.delete,
        error: T.error
      }
      const now = Date.now()
      const pnow = performance.now()
      const fc = fitCache.current
      let animating = false

      if (!d.loaded) {
        // quiet loading state (D9): skeleton columns until the first snapshot answers
        ctx.fillStyle = T.line2
        const colW = Math.min(164, Math.round(l.W * 0.19))
        const laneW = Math.min(360, Math.round(l.W * 0.36))
        const laneX = Math.round((l.W - laneW) / 2)
        for (const [i, h] of [44, 44, 44].entries()) {
          rr(ctx, 14, 26 + i * 70, colW, h, 8)
          ctx.fill()
          rr(ctx, l.W - colW - 14, 26 + i * 70, colW, 40, 8)
          ctx.fill()
        }
        ctx.lineWidth = 1
        ctx.strokeStyle = T.line2
        for (const [i, rows] of [5, 3].entries()) {
          const y = 26 + i * 150
          rr(ctx, laneX, y, laneW, 24 + rows * 20 + 8, 8)
          ctx.stroke()
          rr(ctx, laneX + 10, y + 8, 90, 8, 4)
          ctx.fill()
          for (let r = 0; r < rows; r++) {
            rr(ctx, laneX + 16, y + 34 + r * 20, laneW * (0.35 + ((r * 37) % 30) / 100), 6, 3)
            ctx.fill()
          }
        }
        return false
      }
      if (d.empty) {
        ctx.font = `500 12px ${sans}`
        ctx.fillStyle = T.muted
        ctx.textAlign = 'center'
        ctx.fillText(
          `No traffic in the last ${d.winLabel}. Requests appear here as they happen.`,
          l.W / 2,
          l.H / 2
        )
        ctx.textAlign = 'left'
        return false
      }

      // column captions (sentence case, D1)
      ctx.font = `500 11px ${sans}`
      ctx.fillStyle = T.muted
      ctx.fillText('Callers', 14, 14)
      const firstLane = d.lanes[0] ? l.lanes[d.lanes[0].id] : null
      if (firstLane) ctx.fillText('API lanes', firstLane.x, 14)
      ctx.textAlign = 'right'
      ctx.fillText('Data and partners', l.W - 14, 14)
      ctx.textAlign = 'left'

      // edges: base weight first, then the accent highlight for the hovered/selected node
      const selLane: Lane | null =
        sel?.kind === 'lane' ? sel.id : sel?.kind === 'entity' ? laneOfKey(sel.id) : null
      const selEntityDowns =
        sel?.kind === 'entity' ? d.entityDowns.get(sel.id)?.map(([id]) => id) : undefined
      const inHit = (e: { from: string; to: Lane }) =>
        !!sel &&
        ((sel.kind === 'caller' && sel.id === e.from) || (selLane !== null && e.to === selLane))
      const outHit = (e: { from: Lane; to: string }) =>
        !!sel &&
        ((sel.kind === 'down' && sel.id === e.to) ||
          (sel.kind === 'lane' && sel.id === e.from) ||
          (sel.kind === 'entity' &&
            e.from === selLane &&
            (!selEntityDowns?.length || selEntityDowns.includes(e.to))))
      const hlT = (pnow - hlRef.current.at) / HIGHLIGHT_MS
      const hl = rd ? 1 : easeOut(hlT)
      if (sel && !rd && hlT < 1) animating = true
      ctx.lineCap = 'round'
      const strokeIn = (e: { from: string; to: Lane; rps: number }, accent: boolean) => {
        const c = l.callers[e.from]
        const ln = l.lanes[e.to]
        const w = edgeWidth(e.rps)
        if (!c || !ln || w <= 0) return
        edgePath(ctx, { x: c.x + c.w, y: c.y + c.h / 2 }, { x: ln.x, y: ln.y + 11 })
        ctx.lineWidth = accent ? Math.max(1.5, w) : w
        ctx.stroke()
      }
      const strokeOut = (e: { from: Lane; to: string; rps: number }, accent: boolean) => {
        const ln = l.lanes[e.from]
        const dn = l.downs[e.to]
        const w = edgeWidth(e.rps)
        if (!ln || !dn || w <= 0) return
        edgePath(ctx, { x: ln.x + ln.w, y: ln.y + 11 }, { x: dn.x, y: dn.y + dn.h / 2 })
        ctx.lineWidth = accent ? Math.max(1.5, w) : w
        ctx.stroke()
      }
      ctx.strokeStyle = T.edge
      for (const e of d.edgesIn) strokeIn(e, false)
      for (const e of d.edgesOut) strokeOut(e, false)
      if (sel) {
        ctx.strokeStyle = T.accent
        ctx.globalAlpha = 0.55 * hl
        for (const e of d.edgesIn) if (inHit(e)) strokeIn(e, true)
        for (const e of d.edgesOut) if (outHit(e)) strokeOut(e, true)
        ctx.globalAlpha = 1
      }

      const isSel = (kind: Selection['kind'], id: string) =>
        !!sel && sel.kind === kind && sel.id === id
      const node = (r: Rect, n: NodeView, selected: boolean) => {
        rr(ctx, r.x, r.y, r.w, r.h, 8)
        ctx.fillStyle = T.node
        ctx.fill()
        ctx.lineWidth = selected ? 2 : 1
        ctx.strokeStyle = selected ? T.accent : T.nodeLine
        if (n.partner) ctx.setLineDash([3, 3])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.font = `500 10px ${mono}`
        const rate = fmtRate(n.rps)
        const rateW = ctx.measureText(rate).width
        ctx.textAlign = 'right'
        ctx.fillStyle = T.fg2
        ctx.fillText(rate, r.x + r.w - 8, r.y + 16)
        ctx.textAlign = 'left'
        ctx.font = `600 11px ${sans}`
        ctx.fillStyle = T.fg
        ctx.fillText(ellipsize(ctx, n.label, r.w - 26 - rateW, fc), r.x + 10, r.y + 16)
        ctx.font = `10px ${sans}`
        ctx.fillStyle = T.muted
        ctx.fillText(ellipsize(ctx, n.sub, r.w - 18, fc), r.x + 10, r.y + r.h - 8)
      }
      for (const c of d.callers) {
        const r = l.callers[c.id]
        if (r) node(r, c, isSel('caller', c.id))
      }

      for (const lane of d.lanes) {
        const r = l.lanes[lane.id]
        if (!r) continue
        const laneSel = isSel('lane', lane.id)
        rr(ctx, r.x, r.y, r.w, r.h, 8)
        ctx.fillStyle = T.card2
        ctx.fill()
        ctx.lineWidth = laneSel ? 2 : 1
        ctx.strokeStyle = laneSel ? T.accent : T.line
        ctx.stroke()
        // the lane header flashes when any of its entities just errored
        let laneFlash = 0
        for (const e of lane.entities) {
          const at = m.flashes.get(e.key)
          if (at) laneFlash = Math.max(laneFlash, 1 - (now - at) / FLASH_MS)
        }
        if (laneFlash > 0.02) {
          animating = true
          rr(ctx, r.x, r.y, r.w, l.laneHead, 8)
          ctx.fillStyle = T.errorSoft
          ctx.globalAlpha = laneFlash
          ctx.fill()
          ctx.globalAlpha = 1
        }
        const title = LANE_LABEL[lane.id]
        ctx.font = `500 10px ${mono}`
        const laneRate = fmtRate(lane.rps)
        const laneRateW = ctx.measureText(laneRate).width
        ctx.fillStyle = T.muted
        ctx.textAlign = 'right'
        ctx.fillText(laneRate, r.x + r.w - 10, r.y + 15)
        ctx.textAlign = 'left'
        ctx.font = `600 11px ${sans}`
        ctx.fillStyle = T.fg
        ctx.fillText(title, r.x + 10, r.y + 15)
        const titleW = ctx.measureText(title).width
        ctx.font = `10px ${mono}`
        ctx.fillStyle = T.muted
        const hintRoom = r.w - titleW - 30 - laneRateW - 16
        const hint = ellipsize(ctx, ROUTE_HINT[lane.id], hintRoom, fc)
        if (hint && hintRoom > 60) ctx.fillText(hint, r.x + titleW + 20, r.y + 15)

        const maxR = Math.max(0.1, ...lane.entities.map((e) => e.rps))
        for (const e of lane.entities) {
          const er = l.ents[e.key]
          if (!er) continue
          const entSel = isSel('entity', e.key)
          if (entSel) {
            rr(ctx, er.x, er.y + 1, er.w, er.h - 2, 4)
            ctx.fillStyle = T.accentSoft
            ctx.fill()
          }
          const flashAt = m.flashes.get(e.key)
          const flash = flashAt ? 1 - (now - flashAt) / FLASH_MS : 0
          if (flash > 0.02) {
            animating = true
            rr(ctx, er.x, er.y + 1, er.w, er.h - 2, 4)
            ctx.fillStyle = T.errorSoft
            ctx.globalAlpha = Math.min(1, flash * 1.6)
            ctx.fill()
            ctx.globalAlpha = 1
          }
          const pulse = m.pulses.get(e.key)
          const p = pulse ? 1 - (now - pulse.t) / PULSE_MS : 0
          const cx = er.x + 7
          const cy = er.y + er.h / 2
          if (p > 0.02 && !rd) {
            animating = true
            ctx.beginPath()
            ctx.arc(cx, cy, 3 + 5 * (1 - p), 0, Math.PI * 2)
            ctx.strokeStyle = KC[pulse?.kind ?? 'update']
            ctx.lineWidth = 1.5
            ctx.globalAlpha = p
            ctx.stroke()
            ctx.globalAlpha = 1
          }
          ctx.beginPath()
          ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
          ctx.fillStyle =
            e.errFrac > 0.05 ? T.error : p > 0.02 ? KC[pulse?.kind ?? 'update'] : T.nodeLine
          ctx.fill()
          // stacked kind mini-bar, scaled to the lane's busiest entity
          const bw = Math.min(92, Math.max(48, er.w * 0.27))
          const bx = er.x + er.w - bw - 46
          const by = er.y + 8
          ctx.fillStyle = T.line2
          ctx.fillRect(bx, by, bw, 4)
          const tot = e.kinds.reduce((a, b) => a + b, 0)
          if (tot > 0) {
            const scale = (e.rps / maxR) * bw
            let acc = 0
            e.kinds.forEach((n, i) => {
              const w = scale * (n / tot)
              if (w <= 0) return
              ctx.fillStyle = KC[KIND_ORDER[i]]
              ctx.fillRect(bx + acc, by, Math.max(w, 0.5), 4)
              acc += w
            })
          }
          ctx.font = `10px ${mono}`
          ctx.fillStyle = T.muted
          ctx.textAlign = 'right'
          ctx.fillText(fmtRate(e.rps), er.x + er.w - 4, er.y + 14)
          ctx.textAlign = 'left'
          // a plug-in badge (registry/canvasLayers) takes room from the label
          let labelRoom = bx - er.x - 24
          const badge = nodeBadges.length ? badgeFor(e.key, m) : null
          if (badge) {
            ctx.font = `600 9.5px ${mono}`
            const text = ellipsize(ctx, badge.text, 64, fc)
            const pw = ctx.measureText(text).width + 8
            const px = bx - pw - 6
            const tone =
              badge.tone === 'error' ? T.error : badge.tone === 'warn' ? T.update : T.read
            rr(ctx, px, er.y + 4, pw, 12, 6)
            ctx.fillStyle = T.card
            ctx.fill()
            ctx.lineWidth = 1
            ctx.strokeStyle = tone
            ctx.stroke()
            ctx.fillStyle = tone
            ctx.fillText(text, px + 4, er.y + 13)
            labelRoom = px - er.x - 22
          }
          ctx.font = `${entSel ? '600 ' : ''}11px ${mono}`
          ctx.fillStyle = T.fg
          ctx.fillText(ellipsize(ctx, e.label, labelRoom, fc), er.x + 16, er.y + 14)
        }
      }

      for (const dn of d.downs) {
        const r = l.downs[dn.id]
        if (r) node(r, dn, isSel('down', dn.id))
      }

      // plug-in layers (registry/canvasLayers), each isolated
      for (const layer of canvasLayers) {
        ctx.save()
        try {
          const more = layer.draw(ctx, {
            layout: l,
            data: d,
            tokens: T,
            fonts: { sans, mono },
            model: m,
            filters: lf,
            selection: lsel,
            active: sel,
            now
          })
          if (more === true) animating = true
        } catch {
          /* a broken layer never stops the paint */
        }
        ctx.restore()
      }

      // particles: two legs (caller → lane, lane → the store or partner the entity reaches)
      if (rd) return false
      const list = particles.current
      if (list.length && !pz) animating = true
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i]
        if (!pz) p.t += dt * p.speed
        if (p.t >= 1) {
          if (p.stage === 0) {
            const ln = l.lanes[p.lane]
            const fromEntity = d.entityDowns.get(p.entityKey)
            const target = fromEntity?.length
              ? pickWeighted(fromEntity)
              : pickWeighted((d.laneOut.get(p.lane) ?? []).map((o) => [o.to, o.rps]))
            const dn = target ? l.downs[target] : undefined
            if (!ln || !dn) {
              list.splice(i, 1)
              continue
            }
            p.stage = 1
            p.t = 0
            p.a = { x: ln.x + ln.w, y: ln.y + 11 }
            p.b = { x: dn.x, y: dn.y + dn.h / 2 }
            p.speed = 1.1 + Math.random() * 0.5
          } else {
            list.splice(i, 1)
            continue
          }
        }
        if (p.t < 0) continue
        const pt = bezierPoint(p.a, p.b, p.t)
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, p.kind === 'read' ? 2.2 : 3, 0, Math.PI * 2)
        ctx.fillStyle = KC[p.kind]
        ctx.globalAlpha = p.kind === 'read' ? 0.75 : 1
        ctx.fill()
        if (p.kind === 'error') {
          ctx.beginPath()
          ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2)
          ctx.strokeStyle = T.error
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.5
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
      return animating
    }

    let warned = false
    const safeDraw = (dt: number): boolean => {
      try {
        return draw(dt)
      } catch (err) {
        // a canvas error must never take the page down; the next frame tries again
        if (!warned) {
          warned = true
          // biome-ignore lint/suspicious/noConsole: one warning per mount, the loop keeps going
          console.warn('[traffic-map] draw failed', err)
        }
        return false
      }
    }
    drawRef.current = safeDraw
    if (reduced) {
      safeDraw(0)
      return () => {
        drawRef.current = null
      }
    }
    let animating = true
    let lastDpr = window.devicePixelRatio
    const frame = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000)
      last = t
      if (window.devicePixelRatio !== lastDpr) {
        lastDpr = window.devicePixelRatio
        dirtyRef.current = true
      }
      // idle frames (nothing changed, nothing moving) are skipped entirely
      if (!document.hidden && (dirtyRef.current || animating)) {
        dirtyRef.current = false
        animating = safeDraw(dt)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      drawRef.current = null
    }
  }, [m, reduced])

  // reduced motion: no loop, so repaint once for every change that shows on the canvas
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the repaint triggers
  useEffect(() => {
    if (reduced) drawRef.current?.(0)
  }, [reduced, data, layout, active, themeV, paused])

  // hover tooltip: instant, anchored above the hovered node (below it near the top edge)
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads the mutable model
  const tip = useMemo(() => {
    if (!hover) return null
    const win = filters.win
    let r: Rect | undefined
    let name = ''
    let text = ''
    if (hover.kind === 'entity') {
      r = layout.ents[hover.id]
      const lane = laneOfKey(hover.id)
      const s = m.entitySum(hover.id, win)
      name = entityLabel(catalog, lane, hover.id.slice(hover.id.indexOf('/') + 1))
      const err = s[0] ? `${((100 * s[5]) / s[0]).toFixed(1)}%` : '0.0%'
      const p95 = m.entityP95(hover.id)
      text = `${fmtRate(s[0] / win)} · p95 ${p95 ? `${Math.round(p95)} ms` : '—'} · err ${err}`
    } else if (hover.kind === 'lane') {
      // anchored on the lane header, not the whole card (the card can be tall)
      const lr = layout.lanes[hover.id]
      r = lr ? { ...lr, h: layout.laneHead } : undefined
      const lv = data.lanes.find((l) => l.id === hover.id)
      name = LANE_LABEL[hover.id]
      text = `${fmtRate(lv?.rps ?? 0)} · ${ROUTE_HINT[hover.id]}`
    } else if (hover.kind === 'caller') {
      r = layout.callers[hover.id]
      const c = data.callers.find((x) => x.id === hover.id)
      name = c?.label ?? hover.id
      if (hover.id === OTHERS) text = `${fmtRate(c?.rps ?? 0)} · ${c?.sub ?? ''}`
      else {
        const [, e] = m.callerSum(hover.id, win)
        text = `${fmtRate(c?.rps ?? 0)} · ${e} ${e === 1 ? 'error' : 'errors'}`
      }
    } else {
      r = layout.downs[hover.id]
      const [req, e, p95] = m.downSum(hover.id, win)
      name = downLabel(m, catalog, hover.id)
      text = `${fmtRate(req / win)} · p95 ${p95 ? `${Math.round(p95)} ms` : '—'} · ${e} failed`
    }
    if (!r) return null
    const below = r.y < 44
    return { name, text, x: r.x + r.w / 2, y: below ? r.y + r.h : r.y, below }
  }, [hover, layout, data, m, catalog, filters.win, tick])

  const pointer = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return hitTest(layout, e.clientX - rect.left, e.clientY - rect.top)
  }

  return (
    <section
      ref={rootRef}
      id='tm-map'
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Traffic map'
      data-tm-motion={reduced ? 'off' : 'on'}
    >
      <div className='flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold'>Flow</h2>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Callers → API lanes → data and partners · edge width = requests/s
          </p>
        </div>
        <ul
          className='flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] text-[var(--tm-fg-2)]'
          aria-label='Kind colours'
        >
          {KIND_ORDER.map((k) => (
            <li
              key={k}
              className={filters.kinds.has(k) ? '' : 'opacity-50'}
              title={filters.kinds.has(k) ? undefined : `${k} is filtered out`}
            >
              <span
                aria-hidden='true'
                className='mr-1.5 inline-block h-2 w-2 rounded-full align-[0px]'
                style={{ background: `var(--tm-${k})` }}
              />
              {k}
            </li>
          ))}
        </ul>
      </div>
      <div ref={boxRef} className='relative overflow-auto'>
        <canvas
          ref={canvasRef}
          id='tm-canvas'
          data-tm-canvas=''
          role='img'
          aria-label={data.summary}
          className='block min-w-[720px]'
          onMouseMove={(e) => {
            const h = pointer(e)
            if (!sameSel(h, hover)) setHover(h)
            e.currentTarget.style.cursor =
              h && !(h.kind === 'caller' && h.id === OTHERS) ? 'pointer' : 'default'
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const h = pointer(e)
            if (h && !(h.kind === 'caller' && h.id === OTHERS)) onSelect(h)
          }}
        />
        {tip && (
          <div
            data-tm-tip=''
            role='tooltip'
            className='pointer-events-none absolute z-10 max-w-[320px] truncate whitespace-nowrap rounded-md bg-[var(--tm-fg)] px-2 py-1 text-[11px] tabular-nums text-[var(--tm-card)]'
            style={{
              left: tip.x,
              top: tip.y,
              transform: `translate(-50%, ${tip.below ? '8px' : 'calc(-100% - 8px)'})`
            }}
          >
            <span className='font-semibold'>{tip.name}</span> · {tip.text}
          </div>
        )}
        <span ref={monoRef} aria-hidden='true' className='hidden font-mono' />
      </div>
      <div className='flex flex-wrap justify-between gap-2.5 border-t border-[var(--tm-line-2)] px-3.5 py-1.5 text-[11px] text-[var(--tm-muted)]'>
        <span>
          {reduced
            ? 'Reduced motion: particles off, edge weights still update. '
            : `Particles are sampled above ${PARTICLES_PER_EDGE} requests/s per edge. Rows pulse on writes and flash on errors. `}
          This node only · api · <span className='font-mono'>{m.instance || '…'}</span>
        </span>
        {stale ? (
          <span className='text-[var(--tm-update)]'>reconnecting — showing the last frame</span>
        ) : paused ? (
          <span>Paused — frames are not applied.</span>
        ) : null}
      </div>
    </section>
  )
}
