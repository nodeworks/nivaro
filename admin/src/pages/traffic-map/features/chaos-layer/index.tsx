/**
 * #2851 Chaos layer on the Traffic Map. While a fault is armed on this instance the nodes it acts
 * on are hatched with the fault and its time left (the database for a database fault, the lanes
 * or routes an HTTP fault targets, Redis, Email, a partner…), so nobody reads a drill as a real
 * outage. Right-clicking a node (or the inspector's action row) offers "Inject fault here", which
 * opens the chaos console's start form aimed at that node. Off — no requests after the first
 * refusal, nothing drawn, nothing offered — unless /api/chaos/status says chaos is allowed here.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Siren } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { adminRealtime } from '@/lib/socket'
import { cn } from '@/lib/utils'
import {
  type Catalog,
  type ChaosStatus,
  chaosKeys,
  fetchCatalog,
  fetchStatus
} from '@/pages/chaos/api'
import { useTrafficMap } from '../../context'
import { type InspectorData, Section } from '../../Inspector'
import type { MapLayout, MapTokens } from '../../layout'
import type { MapData } from '../../MapCanvas'
import type { TrafficModel } from '../../model'
import { canvasLayers, requestCanvasRepaint } from '../../registry/canvasLayers'
import { inspectorActions } from '../../registry/inspectorActions'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { nodeMenuProviders } from '../../registry/nodeMenu'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { LANE_ORDER, type Selection } from '../../types'
import { createStore, inPage, strokeEdge, useStore } from '../b1-shared'
import { BTN, LINK, SafeLink } from '../shared'
import { simulation } from '../simulate-down'
import { isTarget } from '../simulate-down/overlay'
import {
  type ArmedShape,
  type ChaosMarks,
  chaosMarks,
  type FaultShape,
  injectOptions,
  type Mark,
  timeLeft
} from './mapping'

interface ChaosState {
  allowed: boolean
  armed: ArmedShape[]
  faults: Map<string, FaultShape>
}
/** What the layer, the menu and the inspector read (allowed=false until the server says so). */
export const chaosState = createStore<ChaosState>({ allowed: false, armed: [], faults: new Map() })
/** The page's map, for the node menu (its providers get only the node). */
let mapRef: TrafficModel | null = null

function marksFor(model: TrafficModel, lanes: string[], now = Date.now()): ChaosMarks | null {
  const s = chaosState.get()
  if (!s.allowed || !s.armed.length) return null
  return chaosMarks(s.armed, s.faults, model, lanes, now)
}

function marksOn(m: ChaosMarks, sel: Selection): Mark[] {
  if (sel.kind === 'entity')
    return m.ents.get(sel.id) ?? m.lanes.get(sel.id.slice(0, sel.id.indexOf('/'))) ?? []
  if (sel.kind === 'lane') return m.lanes.get(sel.id) ?? []
  if (sel.kind === 'caller') return m.callers.get(sel.id) ?? []
  return m.downs.get(sel.id) ?? []
}

// ── the one read (toolbar status slot): status + catalog, live on `chaos:armed` ─
function ChaosHost() {
  const { ready, paused, model } = useTrafficMap()
  const qc = useQueryClient()
  useEffect(() => {
    mapRef = model
    return () => {
      mapRef = null
    }
  }, [model])
  const status = useQuery<ChaosStatus>({
    queryKey: chaosKeys.status,
    queryFn: fetchStatus,
    enabled: ready,
    retry: false,
    refetchInterval: (q) =>
      q.state.status === 'error' ? false : q.state.data?.armed.length ? 5_000 : 30_000
  })
  const allowed = status.data?.allowed === true
  const catalog = useQuery<Catalog>({
    queryKey: chaosKeys.catalog,
    queryFn: fetchCatalog,
    enabled: allowed,
    retry: false,
    staleTime: 5 * 60_000
  })
  useEffect(() => {
    const off = adminRealtime.on('chaos:armed', () => {
      void qc.invalidateQueries({ queryKey: chaosKeys.status })
    })
    return off
  }, [qc])
  useEffect(() => {
    chaosState.set({
      allowed,
      armed: allowed ? ((status.data?.armed ?? []) as ArmedShape[]) : [],
      faults: new Map((catalog.data?.faults ?? []).map((f) => [f.key, f]))
    })
    requestCanvasRepaint()
  }, [allowed, status.data, catalog.data])
  useEffect(() => () => chaosState.set({ allowed: false, armed: [], faults: new Map() }), [])
  // the countdowns on the canvas move once a second while something is armed
  const armedCount = allowed ? (status.data?.armed.length ?? 0) : 0
  const [, setNow] = useState(0)
  useEffect(() => {
    if (!armedCount || paused) return
    const t = window.setInterval(() => {
      setNow(Date.now())
      requestCanvasRepaint()
    }, 1000)
    return () => window.clearInterval(t)
  }, [armedCount, paused])
  if (!armedCount) return null
  const first = status.data?.armed[0]
  return (
    <SafeLink
      to={first?.run_id ? `/chaos?tab=runs&run=${first.run_id}` : '/chaos?tab=runs'}
      className='inline-flex items-center gap-1.5 rounded-md border border-[var(--tm-error)] bg-[var(--tm-error-soft)] px-2 py-[3px] text-[12px] font-medium leading-tight text-[var(--tm-error-ink)] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
    >
      <Siren className='h-3.5 w-3.5' aria-hidden='true' />
      <span id='tm-chaos-armed' data-tm-chaos-armed={armedCount}>
        {armedCount === 1 && first
          ? `Drill: ${first.label} · ${timeLeft(first.ends_at)} left`
          : `${armedCount} drills armed`}
      </span>
    </SafeLink>
  )
}

// ── inject here: inspector action + node menu ────────────────────────────────
function useInjectOptions(sel: Selection) {
  const s = useStore(chaosState)
  const { model } = useTrafficMap()
  if (!s.allowed) return []
  return injectOptions(sel, [...s.faults.values()], model)
}

function InjectAction({ sel }: { sel: Selection; d: InspectorData }) {
  const opts = useInjectOptions(sel)
  const [open, setOpen] = useState(false)
  if (!opts.length) return null
  if (opts.length === 1)
    return (
      <SafeLink
        to={opts[0].href}
        className={BTN}
        data-tm-inject={opts[0].fault_key}
        data-tip={`Open the chaos console with ${opts[0].label} aimed here`}
      >
        Inject fault here
      </SafeLink>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type='button' className={BTN} id='tm-inject'>
          Inject fault here
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[240px] p-1'>
        <ul className='traffic-map grid' id='tm-inject-list'>
          {opts.map((o) => (
            <li key={o.fault_key}>
              <SafeLink
                to={o.href}
                data-tm-inject={o.fault_key}
                className='block rounded px-2 py-1.5 text-[12px] font-medium text-[var(--tm-fg)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
              >
                {o.label}
              </SafeLink>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** Armed faults acting on the selected node, with their time left. */
function ArmedHerePanel({ sel }: { sel: Selection; d: InspectorData }) {
  const s = useStore(chaosState)
  const { model } = useTrafficMap()
  if (!s.allowed || !s.armed.length) return null
  const marks = marksOn(chaosMarks(s.armed, s.faults, model, LANE_ORDER), sel)
  if (!marks.length) return null
  return (
    <Section title='Drill running here'>
      <ul className='grid gap-1 text-[12px]' id='tm-chaos-here'>
        {marks.map((m) => (
          <li key={m.id} className='flex min-w-0 items-baseline justify-between gap-2'>
            <span className='min-w-0 truncate font-medium text-[var(--tm-error-ink)]'>
              {m.label}
            </span>
            <span className='flex shrink-0 items-baseline gap-2 text-[11.5px] text-[var(--tm-fg-2)]'>
              <span className='tabular-nums'>{timeLeft(m.ends_at)} left</span>
              <SafeLink
                to={m.run_id ? `/chaos?tab=runs&run=${m.run_id}` : '/chaos?tab=runs'}
                className={cn(LINK, 'text-[11.5px]')}
              >
                Open run
              </SafeLink>
            </span>
          </li>
        ))}
      </ul>
      <p className='mt-1.5 text-[11px] text-[var(--tm-muted)]'>
        A chaos drill is acting on this node: its errors and slowness are expected until it ends.
      </p>
    </Section>
  )
}

// ── canvas: hatched nodes with the fault and its time left ───────────────────
function hatch(
  ctx: CanvasRenderingContext2D,
  r: { x: number; y: number; w: number; h: number },
  color: string
) {
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 7)
  ctx.clip()
  // light enough that the node's own name and figures stay readable through it
  ctx.globalAlpha = 0.16
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  for (let x = r.x - r.h; x < r.x + r.w; x += 5) {
    ctx.beginPath()
    ctx.moveTo(x, r.y + r.h)
    ctx.lineTo(x + r.h, r.y)
    ctx.stroke()
  }
  ctx.restore()
  ctx.beginPath()
  ctx.roundRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3, 8)
  ctx.setLineDash([5, 3])
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.setLineDash([])
}

/** The pill's words: the soonest fault's label, then " · 4:17" and " +1" for more. */
interface PillText {
  label: string
  tail: string
}

/**
 * `label · 4:17 +1` cut to `max` px: the label loses letters (with an ellipsis) before the time
 * does, so a long fault name never runs off the node or under a neighbour's pill.
 */
export function fitPill(ctx: CanvasRenderingContext2D, p: PillText, max: number): string {
  const full = `${p.label}${p.tail}`
  if (ctx.measureText(full).width <= max) return full
  let lo = 0
  let hi = p.label.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${p.label.slice(0, mid).trimEnd()}…${p.tail}`).width <= max) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${p.label.slice(0, lo).trimEnd()}…${p.tail}` : p.tail.replace(/^ · /, '')
}

function pill(
  ctx: CanvasRenderingContext2D,
  r: { x: number; y: number; w: number; h: number },
  words: PillText,
  t: MapTokens,
  font: string,
  inside: boolean,
  /** px kept free at the right of the top edge (Simulate down's own pill sits there). */
  reserve = 0
) {
  ctx.font = font
  // node boxes: on the top edge; entity rows (packed tight): inside, left of the rate. When
  // Simulate down's pill leaves too little of the top edge, the drill's pill takes the bottom.
  const bottom = !inside && reserve > 0 && r.w - 12 - reserve < 96
  const max = inside ? Math.max(56, r.w * 0.45) : r.w - 12 - (bottom ? 0 : reserve)
  const text = fitPill(ctx, words, max - 8)
  const w = ctx.measureText(text).width + 8
  const x = inside ? r.x + r.w - 52 - w : r.x + 6
  const y = inside ? r.y + (r.h - 13) / 2 : bottom ? r.y + r.h - 6 : r.y - 7
  ctx.beginPath()
  ctx.roundRect(x, y, w, 13, 6.5)
  ctx.fillStyle = t.card
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = t.error
  ctx.stroke()
  ctx.fillStyle = t.error
  ctx.textAlign = 'left'
  ctx.fillText(text, x + 4, y + 9.5)
}

const pillText = (marks: Mark[], now: number): PillText => {
  const soonest = marks.reduce((a, b) => (a.ends_at <= b.ends_at ? a : b))
  const more = marks.length > 1 ? ` +${marks.length - 1}` : ''
  return { label: soonest.label, tail: ` · ${timeLeft(soonest.ends_at, now)}${more}` }
}

export function drawChaos(
  ctx: CanvasRenderingContext2D,
  marks: ChaosMarks,
  layout: MapLayout,
  data: MapData,
  t: MapTokens,
  font: string,
  now: number,
  /** The node Simulate down is shading, if any: its pill owns the right of that top edge. */
  simulated: string | null = null
): number {
  let drawn = 0
  ctx.font = font
  const simReserve = simulated ? ctx.measureText('Simulated down').width + 22 : 0
  // edges into a faulted down node
  ctx.strokeStyle = t.error
  ctx.globalAlpha = 0.6
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  for (const e of data.edgesOut) {
    if (!marks.downs.has(e.to)) continue
    const ln = layout.lanes[e.from]
    const dn = layout.downs[e.to]
    if (ln && dn) strokeEdge(ctx, { x: ln.x + ln.w, y: ln.y + 11 }, { x: dn.x, y: dn.y + dn.h / 2 })
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  const groups: Array<
    [Map<string, Mark[]>, Record<string, { x: number; y: number; w: number; h: number }>]
  > = [
    [marks.lanes, layout.lanes],
    [marks.ents, layout.ents],
    [marks.downs, layout.downs]
  ]
  for (const [m, rects] of groups)
    for (const [id, list] of m) {
      const r = rects[id]
      if (!r) continue
      hatch(ctx, r, t.error)
      const reserve = m === marks.downs && simulated && isTarget(simulated, id) ? simReserve : 0
      pill(ctx, r, pillText(list, now), t, font, m === marks.ents, reserve)
      drawn++
    }
  const seen = new Set<string>()
  for (const [id, list] of marks.callers) {
    const node = data.callerNode.get(id) ?? id
    const r = layout.callers[node]
    if (!r || seen.has(node)) continue
    seen.add(node)
    hatch(ctx, r, t.error)
    pill(ctx, r, pillText(list, now), t, font, false)
    drawn++
  }
  return drawn
}

register(toolbarItems, {
  id: 'chaos-layer',
  slot: 'status',
  order: 5,
  Component: inPage(ChaosHost)
})
register(inspectorActions, {
  id: 'chaos-inject',
  order: 41,
  // static (the inspector does not re-check on a status change); the action renders nothing
  // while chaos is refused or no fault fits the node
  applies: (sel) => sel.kind !== 'caller' || sel.id.startsWith('u'),
  Component: inPage(InjectAction)
})
register(inspectorPanels, {
  id: 'chaos-armed-here',
  order: 1,
  // first thing under the actions: it explains every error and slow figure below it
  top: true,
  history: true,
  applies: () => true,
  Component: inPage(ArmedHerePanel)
})
register(nodeMenuProviders, {
  id: 'chaos-inject',
  order: 20,
  entries: (sel) => {
    const s = chaosState.get()
    if (!s.allowed) return []
    return injectOptions(sel, [...s.faults.values()], mapRef).map((o) => ({
      key: `inject:${o.fault_key}`,
      label: o.label,
      group: 'Inject fault here',
      groupHint: 'Opens the chaos console aimed at this node',
      run: ({ navigate }) => navigate(o.href)
    }))
  }
})
register(canvasLayers, {
  id: 'chaos-layer',
  order: 96,
  draw(ctx, { layout, data, tokens, fonts, model, now }) {
    const marks = marksFor(model, Object.keys(layout.lanes), now)
    if (!marks) return false
    const sim = simulation.get()?.node ?? null
    drawChaos(ctx, marks, layout, data, tokens, `500 9.5px ${fonts.sans}`, now, sim)
    return false
  }
})
