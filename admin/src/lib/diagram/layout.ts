// Pure layered left-to-right graph layout used by the read-only Diagram views
// (pipelines, flows). No DOM, no randomness: the same input always yields the
// same positions. Back-edges (cycles) are drawn as curves BELOW the graph.

export type NodeRole = 'normal' | 'initial' | 'terminal' | 'virtual' | 'trigger' | 'fork'
export type EdgeTone = 'normal' | 'fail' | 'split' | 'any'

export interface DiagramNodeIn {
  id: string
  title: string
  role?: NodeRole
  /** Short marker chips shown under the title ("Start", "End", ...). */
  tags?: string[]
  /** Plain-language detail lines (wrapped by the layout). */
  notes?: string[]
  /** Accent colour (hex) or null. */
  color?: string | null
}

export interface DiagramEdgeIn {
  id: string
  from: string
  to: string
  /** Label lines; first line is the emphasised one. */
  lines?: string[]
  dashed?: boolean
  tone?: EdgeTone
  /** True = does not influence column placement. */
  noLayer?: boolean
}

export interface LayoutOptions {
  nodeW?: number
  gapX?: number
  gapY?: number
  pad?: number
}

export interface DiagramNode extends DiagramNodeIn {
  x: number
  y: number
  w: number
  h: number
  layer: number
  titleLines: string[]
  noteLines: string[]
}

export interface DiagramEdge extends DiagramEdgeIn {
  d: string
  back: boolean
  labelX: number
  labelY: number
  labelW: number
  labelH: number
  /** Arrow tip. */
  end: { x: number; y: number }
}

export interface Diagram {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  width: number
  height: number
}

export const CHAR_W = 6.4

export function wrapText(text: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > max) {
      if (line) out.push(line)
      line = ''
      out.push(`${word.slice(0, max - 1)}…`)
      continue
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= max) line += ` ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out
}

function round(n: number) {
  return Math.round(n * 10) / 10
}

function bez(p0: number, p1: number, p2: number, p3: number, t: number) {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

export function layoutGraph(
  nodesIn: DiagramNodeIn[],
  edgesIn: DiagramEdgeIn[],
  opts: LayoutOptions = {}
): Diagram {
  const nodeW = opts.nodeW ?? 210
  const gapX = opts.gapX ?? 110
  const gapY = opts.gapY ?? 36
  const pad = opts.pad ?? 40
  const maxChars = Math.floor((nodeW - 24) / CHAR_W)

  const idx = new Map(nodesIn.map((n, i) => [n.id, i]))
  const edges = edgesIn.filter((e) => idx.has(e.from) && idx.has(e.to))

  // Node sizes (text wrapped here so heights are known).
  const sized = nodesIn.map((n) => {
    const titleLines = wrapText(n.title, maxChars - 2).slice(0, 3)
    const noteLines = (n.notes ?? []).flatMap((t) => wrapText(t, maxChars + 4))
    const tagH = n.tags?.length ? 20 : 0
    const h =
      18 + titleLines.length * 16 + tagH + (noteLines.length ? 6 + noteLines.length * 13 : 0)
    return { n, titleLines, noteLines, h: Math.max(44, h) }
  })

  // Cycle detection (DFS in input order) over layered edges.
  const out = new Map<string, DiagramEdgeIn[]>()
  for (const n of nodesIn) out.set(n.id, [])
  for (const e of edges) if (!e.noLayer && e.from !== e.to) out.get(e.from)?.push(e)
  const hasIn = new Set(edges.filter((e) => !e.noLayer && e.from !== e.to).map((e) => e.to))
  const color = new Map<string, 1 | 2>()
  const backIds = new Set<string>()
  const visit = (id: string) => {
    color.set(id, 1)
    for (const e of out.get(id) ?? []) {
      const c = color.get(e.to)
      if (c === 1) backIds.add(e.id)
      else if (!c) visit(e.to)
    }
    color.set(id, 2)
  }
  for (const n of nodesIn) if (!hasIn.has(n.id) && !color.get(n.id)) visit(n.id)
  for (const n of nodesIn) if (!color.get(n.id)) visit(n.id)

  // Layers: longest path over forward layered edges (Kahn, input order).
  const fwd = edges.filter((e) => !e.noLayer && e.from !== e.to && !backIds.has(e.id))
  const indeg = new Map<string, number>(nodesIn.map((n) => [n.id, 0]))
  for (const e of fwd) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  const layer = new Map<string, number>(nodesIn.map((n) => [n.id, 0]))
  const queue = nodesIn.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  while (queue.length) {
    const id = queue.shift() as string
    for (const e of fwd.filter((x) => x.from === id)) {
      layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(id) ?? 0) + 1))
      indeg.set(e.to, (indeg.get(e.to) ?? 0) - 1)
      if (indeg.get(e.to) === 0) queue.push(e.to)
    }
  }

  // Order inside each layer: input order, then barycentre sweeps.
  const layerCount = Math.max(0, ...layer.values()) + 1
  const cols: string[][] = Array.from({ length: layerCount }, () => [])
  for (const n of nodesIn) cols[layer.get(n.id) ?? 0].push(n.id)
  const rowOf = new Map<string, number>()
  const setRows = () => {
    for (const c of cols) {
      c.forEach((id, r) => {
        rowOf.set(id, r)
      })
    }
  }
  setRows()
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < layerCount; l++) {
      const score = (id: string) => {
        const preds = fwd.filter((e) => e.to === id).map((e) => rowOf.get(e.from) ?? 0)
        return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : (rowOf.get(id) ?? 0)
      }
      const keyed = cols[l].map((id) => ({ id, s: score(id), i: idx.get(id) ?? 0 }))
      keyed.sort((a, b) => a.s - b.s || a.i - b.i)
      cols[l] = keyed.map((k) => k.id)
      setRows()
    }
  }

  // Coordinates.
  const byId = new Map(sized.map((s) => [s.n.id, s]))
  const colH = cols.map((c) =>
    c.reduce((a, id, i) => a + (byId.get(id)?.h ?? 0) + (i ? gapY : 0), 0)
  )
  const maxColH = Math.max(0, ...colH)
  const topExtra = edges.some((e) => e.from === e.to) ? 50 : 0
  const pos = new Map<string, DiagramNode>()
  cols.forEach((c, l) => {
    let y = pad + topExtra + (maxColH - colH[l]) / 2
    for (const id of c) {
      const s = byId.get(id)
      if (!s) continue
      pos.set(id, {
        ...s.n,
        x: pad + l * (nodeW + gapX),
        y: round(y),
        w: nodeW,
        h: s.h,
        layer: l,
        titleLines: s.titleLines,
        noteLines: s.noteLines
      })
      y += s.h + gapY
    }
  })
  const nodes = nodesIn.map((n) => pos.get(n.id) as DiagramNode)

  const graphBottom = pad + topExtra + maxColH
  const right = pad + layerCount * nodeW + (layerCount - 1) * gapX
  let backIdx = 0

  const outEdges: DiagramEdge[] = edges.map((e) => {
    const a = pos.get(e.from) as DiagramNode
    const b = pos.get(e.to) as DiagramNode
    const ls = e.lines ?? []
    const labelW = ls.length ? round(Math.max(...ls.map((l) => l.length)) * CHAR_W + 14) : 0
    const labelH = ls.length ? ls.length * 13 + 8 : 0
    const base = { ...e, labelW, labelH }

    if (e.from === e.to) {
      const x1 = a.x + a.w * 0.3
      const x2 = a.x + a.w * 0.7
      return {
        ...base,
        d: `M ${round(x1)} ${a.y} C ${round(x1 - 10)} ${a.y - 46}, ${round(x2 + 10)} ${a.y - 46}, ${round(x2)} ${a.y}`,
        back: true,
        labelX: round((x1 + x2) / 2),
        labelY: round(a.y - 40 - labelH / 2),
        end: { x: round(x2), y: a.y }
      }
    }
    const isBack = backIds.has(e.id) || b.layer < a.layer
    if (!isBack && b.layer > a.layer) {
      const sx = a.x + a.w
      const sy = a.y + a.h / 2
      const tx = b.x
      const ty = b.y + b.h / 2
      const off = Math.max(40, (tx - sx) / 2)
      return {
        ...base,
        d: `M ${round(sx)} ${round(sy)} C ${round(sx + off)} ${round(sy)}, ${round(tx - off)} ${round(ty)}, ${round(tx)} ${round(ty)}`,
        back: false,
        labelX: round(bez(sx, sx + off, tx - off, tx, 0.5)),
        labelY: round(bez(sy, sy, ty, ty, 0.5)),
        end: { x: round(tx), y: round(ty) }
      }
    }
    if (!isBack) {
      // Same column: a straight vertical hop.
      const down = b.y >= a.y
      const sx = a.x + a.w / 2
      const sy = down ? a.y + a.h : a.y
      const ty = down ? b.y : b.y + b.h
      return {
        ...base,
        d: `M ${round(sx)} ${round(sy)} L ${round(sx)} ${round(ty)}`,
        back: false,
        labelX: round(sx),
        labelY: round((sy + ty) / 2),
        end: { x: round(sx), y: round(ty) }
      }
    }
    // Back-edge: loop below the whole graph, one lane per edge.
    const k = backIdx++
    const depth = graphBottom + 30 + k * 26
    const sx = a.x + a.w / 2 + (k % 3) * 10
    const sy = a.y + a.h
    const tx = b.x + b.w / 2 - (k % 3) * 10
    const ty = b.y + b.h
    const c1 = sy + (depth - sy) / 0.75
    const c2 = ty + (depth - ty) / 0.75
    return {
      ...base,
      d: `M ${round(sx)} ${round(sy)} C ${round(sx)} ${round(c1)}, ${round(tx)} ${round(c2)}, ${round(tx)} ${round(ty)}`,
      back: true,
      labelX: round(bez(sx, sx, tx, tx, 0.5)),
      labelY: round(bez(sy, c1, c2, ty, 0.5)),
      end: { x: round(tx), y: round(ty) }
    }
  })

  const bottom = graphBottom + (backIdx ? 30 + backIdx * 26 : 0)
  return { nodes, edges: outEdges, width: round(right + pad), height: round(bottom + pad) }
}
