// #2142 — the flow map as an image for incident write-ups and change requests. The map is
// rebuilt as an SVG from the same data and layout the canvas draws (whole map, not only what is
// scrolled into view), with a header (time window, filters, environment) and a legend printed
// on it. SVG downloads as is; PNG is that SVG rasterised on a canvas. Colours are the live
// --tm-* tokens normalised to rgb + opacity, so the image matches the theme it was taken in and
// opens in any SVG viewer.
import {
  type CanvasView,
  edgeWidthByMetric,
  fmtWeight,
  HAIRLINE,
  WEIGHT_MEANS,
  ZOOM_LABEL
} from './canvasView'
import { bezierPoint, type MapLayout, type MapTokens, type Rect } from './layout'
import type { MapData, NodeView } from './MapCanvas'
import { defaultFilters, type TrafficModel } from './model'
import { edgeStyleFor, edgeStyles } from './registry/canvasLayers'
import { makeColorParser } from './render/color'
import { type Filters, KIND_ORDER, LANE_LABEL, LANE_ORDER, type Selection } from './types'

export interface MapExportSource {
  data: MapData
  layout: MapLayout
  tokens: MapTokens
  fonts: { sans: string; mono: string }
  view: CanvasView
  filters: Filters
  model: TrafficModel
  selection?: Selection | null
}
let source: (() => MapExportSource | null) | null = null
/** The map canvas registers what it draws; null when it unmounts. */
export function setMapExportSource(fn: (() => MapExportSource | null) | null): void {
  source = fn
}
export function getMapExportSource(): MapExportSource | null {
  try {
    return source?.() ?? null
  } catch {
    return null
  }
}

export interface ExportMeta {
  /** e.g. "Acme · admin.example.com · api web-1 · production". */
  environment: string
  /** Display names for caller keys (the filter line names a caller, not its key). */
  callerLabel?: (key: string) => string
  /** When the image is taken (defaults to now). */
  takenAt?: Date
}

const fmtTime = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = (d: Date) =>
  d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** "Last 5 min to 14:32:05, 17 Oct 2026" (live) or "… rewound" (a past second). */
export function windowText(model: Pick<TrafficModel, 'at' | 'rewound'>, win: number): string {
  const end = new Date(model.at * 1000)
  const mins = Math.max(1, Math.round(win / 60))
  return `${model.rewound ? 'Rewound: ' : 'Last '}${mins} min to ${fmtTime(end)}, ${fmtDate(end)}`
}

/** The filters and view choices that change what the map shows, as short phrases. */
export function describeView(
  f: Filters,
  view: Pick<CanvasView, 'zoom' | 'weight' | 'scale' | 'density' | 'groupApps'>,
  callerLabel: (key: string) => string = (k) => k
): string[] {
  const d = defaultFilters()
  const out: string[] = []
  // filters first ("No filters" when none narrows the map), then the view choices
  const lanes = LANE_ORDER.filter((l) => l !== 'other' && f.types.has(l))
  const allLanes = LANE_ORDER.filter((l) => l !== 'other' && d.types.has(l))
  if (lanes.length !== allLanes.length)
    out.push(`Lanes: ${lanes.map((l) => LANE_LABEL[l]).join(', ')}`)
  if (f.kinds.size !== KIND_ORDER.length)
    out.push(`Kinds: ${KIND_ORDER.filter((k) => f.kinds.has(k)).join(', ')}`)
  if (f.caller) out.push(`Caller: ${callerLabel(f.caller)}`)
  else if (f.callers?.length) out.push(`${f.callers.length} callers`)
  if (f.workspace) out.push(`Workspace: ${f.workspace}`)
  if (!out.length) out.push('No filters')
  out.push(`${ZOOM_LABEL[view.zoom]} view`)
  out.push(
    `Edge width: ${WEIGHT_MEANS[view.weight]}${view.scale === 'sqrt' ? '' : ` (${view.scale})`}`
  )
  if (view.density === 'all') out.push('All nodes')
  if (view.groupApps) out.push('Callers grouped by app')
  return out
}

/** The PNG scale for a W x H image: crisp (2x) when it fits the browser's canvas limits. */
export function pngScale(w: number, h: number): number {
  const MAX_SIDE = 16384
  const MAX_AREA = 40_000_000
  return Math.min(2, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)))
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

type Measure = (text: string, font: string) => number
let measureCtx: CanvasRenderingContext2D | null | undefined
/** Text width in px: the browser's when it has a 2D canvas, else an estimate. */
function defaultMeasure(text: string, font: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx =
        typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    } catch {
      measureCtx = null
    }
  }
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 11)
  if (measureCtx && typeof measureCtx.measureText === 'function') {
    measureCtx.font = font
    const w = measureCtx.measureText(text).width
    if (Number.isFinite(w) && w > 0) return w
  }
  return text.length * px * 0.58
}
function fitText(text: string, max: number, font: string, measure: Measure): string {
  if (max <= 0) return ''
  if (measure(text, font) <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measure(`${text.slice(0, mid)}…`, font) <= max) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : ''
}

const fmtRate = (r: number) =>
  !Number.isFinite(r) || r <= 0 ? '0/s' : r < 10 ? `${r.toFixed(1)}/s` : `${Math.round(r)}/s`
const laneOfKey = (key: string) => key.slice(0, key.indexOf('/'))

const HEADER = 76
const LEGEND = 64
const PAD = 16

/**
 * The whole map as an SVG document, `width` x `height` px: header, map, legend. `measure` sizes
 * text for ellipsis (the browser's canvas by default).
 */
export function buildMapSvg(
  src: MapExportSource,
  meta: ExportMeta,
  measure: Measure = defaultMeasure
): { svg: string; width: number; height: number } {
  const { data: d, layout: l, tokens: T, fonts, view, filters, model } = src
  const color = makeColorParser()
  /** `fill="…" fill-opacity="…"` for a token colour (rgb + opacity: any viewer reads it). */
  const paint = (attr: 'fill' | 'stroke', css: string, alpha = 1) => {
    const [r, g, b, a] = color(css)
    const hex = `#${[r, g, b]
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')}`
    const o = Math.round(a * alpha * 1000) / 1000
    return o >= 1 ? `${attr}="${hex}"` : `${attr}="${hex}" ${attr}-opacity="${o}"`
  }
  const sans = esc(fonts.sans || 'sans-serif')
  const mono = esc(fonts.mono || 'monospace')
  const W = Math.max(l.W, 720)
  const H = HEADER + l.H + LEGEND
  const out: string[] = []
  const text = (
    x: number,
    y: number,
    s: string,
    o: { size?: number; weight?: number; mono?: boolean; tone?: string; anchor?: 'end' | 'middle' }
  ) => {
    const size = o.size ?? 11
    out.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${o.mono ? mono : sans}" font-size="${size}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''} ${paint('fill', o.tone ?? T.fg)}>${esc(s)}</text>`
    )
  }
  const fontOf = (size: number, weight = 400, isMono = false) =>
    `${weight} ${size}px ${isMono ? fonts.mono : fonts.sans}`
  const rect = (
    r: Rect,
    rx: number,
    fill: string | null,
    stroke: string | null,
    sw = 1,
    dash?: string
  ) =>
    out.push(
      `<rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="${rx}" ${fill ? paint('fill', fill) : 'fill="none"'}${stroke ? ` ${paint('stroke', stroke)} stroke-width="${sw}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
    )

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  )
  out.push(`<rect width="${W}" height="${H}" ${paint('fill', T.card)}/>`)

  // ── header: what, when, where, and which filters ──
  const taken = meta.takenAt ?? new Date()
  text(PAD, 24, 'Traffic Map · Flow', { size: 14, weight: 600 })
  text(W - PAD, 24, `Taken ${fmtTime(taken)}, ${fmtDate(taken)}`, {
    size: 11,
    tone: T.muted,
    anchor: 'end'
  })
  text(PAD, 42, fitText(meta.environment, W - PAD * 2, fontOf(11.5), measure), {
    size: 11.5,
    tone: T.fg2
  })
  const line3 = [
    windowText(model, filters.win),
    ...describeView(filters, view, meta.callerLabel)
  ].join(' · ')
  text(PAD, 60, fitText(line3, W - PAD * 2, fontOf(11.5), measure), { size: 11.5, tone: T.fg2 })
  out.push(
    `<line x1="0" y1="${HEADER - 6}" x2="${W}" y2="${HEADER - 6}" ${paint('stroke', T.line2)} stroke-width="1"/>`
  )

  // ── the map, in layout coordinates ──
  out.push(`<g transform="translate(0 ${HEADER})">`)
  text(14, 14, 'Callers', { size: 11, weight: 500, tone: T.muted })
  const firstLane = d.lanes[0] ? l.lanes[d.lanes[0].id] : null
  if (firstLane) text(firstLane.x, 14, 'API lanes', { size: 11, weight: 500, tone: T.muted })
  text(l.W - 14, 14, 'Data and partners', { size: 11, weight: 500, tone: T.muted, anchor: 'end' })
  if (l.sourcesCaptionY != null && d.sources.length)
    text(14, l.sourcesCaptionY, 'Sources', { size: 11, weight: 500, tone: T.muted })

  const metric = view.weight
  const path = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const mx = (a.x + b.x) / 2
    return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}C${mx.toFixed(1)} ${a.y.toFixed(1)} ${mx.toFixed(1)} ${b.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
  }
  const labels: Array<{ p: { x: number; y: number }; w: number }> = []
  const edge = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    w: number,
    rps: number,
    max: number,
    dir: 'in' | 'out',
    from: string,
    to: string,
    ent = false
  ) => {
    let px = edgeWidthByMetric(w, metric, view.scale, max)
    let alpha = 1
    if (!(px > 0)) {
      if (!(rps > 0) || metric === 'requests') return
      px = HAIRLINE.width
      alpha = HAIRLINE.alpha
    } else if (ent) px = Math.max(0.75, px * 0.8)
    const st = edgeStyles.length ? edgeStyleFor({ dir, from, to, rps }, model) : null
    out.push(
      `<path d="${path(a, b)}" fill="none" ${paint('stroke', st ? (T[st.tone] ?? T.edge) : T.edge, alpha)} stroke-width="${px.toFixed(2)}" stroke-linecap="round"${st?.dash?.length ? ` stroke-dasharray="${st.dash.join(' ')}"` : ''}/>`
    )
    if (view.labels && w > 0) labels.push({ p: bezierPoint(a, b, 0.5), w })
  }
  const entFrom = new Set(d.edgesEnt.map((e) => e.from))
  for (const e of d.edgesIn) {
    if (entFrom.has(e.from)) continue
    const c = l.callers[e.from]
    const ln = l.lanes[e.to]
    if (c && ln)
      edge(
        { x: c.x + c.w, y: c.y + c.h / 2 },
        { x: ln.x, y: ln.y + 11 },
        e.w,
        e.rps,
        d.maxIn,
        'in',
        e.from,
        e.to
      )
  }
  for (const e of d.edgesEnt) {
    const c = l.callers[e.from]
    const er = l.ents[e.to]
    if (c && er)
      edge(
        { x: c.x + c.w, y: c.y + c.h / 2 },
        { x: er.x, y: er.y + er.h / 2 },
        e.w,
        e.rps,
        d.maxIn,
        'in',
        e.from,
        laneOfKey(e.to),
        true
      )
  }
  for (const e of d.edgesOut) {
    const ln = l.lanes[e.from]
    const dn = l.downs[e.to]
    if (ln && dn)
      edge(
        { x: ln.x + ln.w, y: ln.y + 11 },
        { x: dn.x, y: dn.y + dn.h / 2 },
        e.w,
        e.rps,
        d.maxOut,
        'out',
        e.from,
        e.to
      )
  }

  const sel = src.selection ?? null
  const isSel = (kind: Selection['kind'], id: string) => !!sel && sel.kind === kind && sel.id === id
  const node = (r: Rect, n: NodeView, selected: boolean) => {
    if (n.kind === 'group') rect({ ...r, x: r.x + 4, y: r.y + 4 }, 8, T.card2, T.nodeLine)
    rect(
      r,
      8,
      T.node,
      selected ? T.accent : T.nodeLine,
      selected ? 2 : 1,
      n.partner ? '3 3' : undefined
    )
    const rate = fmtRate(n.rps)
    const rateW = measure(rate, fontOf(10, 500, true))
    text(r.x + r.w - 8, r.y + 16, rate, {
      size: 10,
      weight: 500,
      mono: true,
      tone: T.fg2,
      anchor: 'end'
    })
    text(r.x + 10, r.y + 16, fitText(n.label, r.w - 26 - rateW, fontOf(11, 600), measure), {
      size: 11,
      weight: 600
    })
    text(r.x + 10, r.y + r.h - 8, fitText(n.sub, r.w - 18, fontOf(10), measure), {
      size: 10,
      tone: T.muted
    })
  }
  for (const c of [...d.callers, ...d.sources]) {
    const r = l.callers[c.id]
    if (r) node(r, c, isSel('caller', c.id))
  }
  const KC: Record<string, string> = {
    read: T.read,
    create: T.create,
    update: T.update,
    delete: T.delete,
    error: T.error
  }
  for (const lane of d.lanes) {
    const r = l.lanes[lane.id]
    if (!r) continue
    const laneSel = isSel('lane', lane.id)
    rect(r, 8, T.card2, laneSel ? T.accent : T.line, laneSel ? 2 : 1)
    text(r.x + r.w - 10, r.y + 15, fmtRate(lane.rps), {
      size: 10,
      weight: 500,
      mono: true,
      tone: T.muted,
      anchor: 'end'
    })
    text(r.x + 10, r.y + 15, LANE_LABEL[lane.id], { size: 11, weight: 600 })
    const maxR = Math.max(0.1, ...lane.entities.map((e) => e.rps))
    for (const e of lane.entities) {
      const er = l.ents[e.key]
      if (!er) continue
      if (isSel('entity', e.key))
        rect({ x: er.x, y: er.y + 1, w: er.w, h: er.h - 2 }, 4, T.accentSoft, null)
      const cy = er.y + er.h / 2
      out.push(
        `<circle cx="${(er.x + 7).toFixed(1)}" cy="${cy.toFixed(1)}" r="2.5" ${paint('fill', e.errFrac > 0.05 ? T.error : T.nodeLine)}/>`
      )
      const bw = Math.min(92, Math.max(48, er.w * 0.27))
      const bx = er.x + er.w - bw - 46
      const by = er.y + 8
      rect({ x: bx, y: by, w: bw, h: 4 }, 0, T.line2, null)
      const tot = e.kinds.reduce((a, b) => a + b, 0)
      if (tot > 0) {
        const s = (e.rps / maxR) * bw
        let acc = 0
        e.kinds.forEach((n, i) => {
          const w = s * (n / tot)
          if (w <= 0) return
          rect({ x: bx + acc, y: by, w: Math.max(w, 0.5), h: 4 }, 0, KC[KIND_ORDER[i]], null)
          acc += w
        })
      }
      text(er.x + er.w - 4, er.y + 14, fmtRate(e.rps), {
        size: 10,
        mono: true,
        tone: T.muted,
        anchor: 'end'
      })
      text(er.x + 16, er.y + 14, fitText(e.label, bx - er.x - 24, fontOf(11, 400, true), measure), {
        size: 11,
        mono: true
      })
      if (view.zoom === 2) {
        const route = model.entityMeta(e.key)?.routes[0]
        if (route)
          text(
            er.x + 16,
            er.y + 28,
            fitText(`${route.route} · ${route.n}`, er.w - 24, fontOf(10, 400, true), measure),
            {
              size: 10,
              mono: true,
              tone: T.muted
            }
          )
      }
    }
  }
  for (const dn of d.downs) {
    const r = l.downs[dn.id]
    if (r) node(r, dn, isSel('down', dn.id))
  }
  for (const { p, w } of labels) {
    const t = fmtWeight(w, metric)
    const tw = measure(t, fontOf(9.5, 600, true)) + 8
    rect({ x: p.x - tw / 2, y: p.y - 7, w: tw, h: 14 }, 7, T.card, T.line)
    text(p.x, p.y + 3.5, t, { size: 9.5, weight: 600, mono: true, tone: T.fg2, anchor: 'middle' })
  }
  out.push('</g>')

  // ── legend ──
  const ly = HEADER + l.H + 10
  out.push(
    `<line x1="0" y1="${ly - 4}" x2="${W}" y2="${ly - 4}" ${paint('stroke', T.line2)} stroke-width="1"/>`
  )
  let x = PAD
  const ky = ly + 18
  for (const k of KIND_ORDER) {
    out.push(`<circle cx="${x + 4}" cy="${ky - 4}" r="4" ${paint('fill', KC[k])}/>`)
    text(x + 12, ky, k, { size: 11, tone: T.fg2 })
    x += 12 + measure(k, fontOf(11)) + 16
  }
  out.push(
    `<line x1="${x}" y1="${ky - 4}" x2="${x + 28}" y2="${ky - 4}" ${paint('stroke', T.edge)} stroke-width="4" stroke-linecap="round"/>`
  )
  const means = `Edge width = ${WEIGHT_MEANS[metric]}${view.scale === 'sqrt' ? '' : ` (${view.scale})`}`
  text(x + 36, ky, means, { size: 11, tone: T.fg2 })
  x += 36 + measure(means, fontOf(11)) + 18
  rect({ x, y: ky - 10, w: 26, h: 12 }, 4, null, T.nodeLine, 1, '3 3')
  text(x + 32, ky, 'Partner', { size: 11, tone: T.fg2 })
  text(
    PAD,
    ly + 40,
    'Callers on the left, API lanes in the middle (one row per entity), data stores and partners on the right. Rates are per second over the window.',
    { size: 10.5, tone: T.muted }
  )
  out.push('</svg>')
  return { svg: out.join(''), width: W, height: H }
}

/** Rasterise the SVG (data URL → image → canvas). Throws when the map is too big for a PNG. */
export async function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const scale = pngScale(width, height)
  if (scale < 0.3) throw new Error('This map is too large for a PNG. Download the SVG instead.')
  const img = new Image()
  img.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('The browser could not draw the map image'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas in this browser')
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.drawImage(img, 0, 0, width, height)
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the PNG'))),
      'image/png'
    )
  )
}

/** `traffic-map-2026-10-17-1432.png` */
export function exportFileName(ext: 'png' | 'svg', at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `traffic-map-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.${ext}`
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
