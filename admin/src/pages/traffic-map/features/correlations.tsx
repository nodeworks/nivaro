import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { entityLabel } from '../EventTicker'
import { Section } from '../Inspector'
import { canvasLayers, requestCanvasRepaint } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import type { Selection } from '../types'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1149 — correlated spikes. The server compares the busiest entities' request series over the
 * window and returns the pairs that keep rising together; the map draws each pair as a dashed
 * "inferred" edge with its correlation, and the inspector lists an entity's partners. Polled every
 * 10 s while the page is live (never while paused or on a frozen snapshot).
 */
export interface CorrelationPair {
  a: string
  b: string
  r: number
  co_spikes: number
  leads: 'a' | 'b' | null
}
interface Corr {
  window_s: number
  compared: number
  pairs: CorrelationPair[]
}

let shown = true
let current: CorrelationPair[] = []
const subs = new Set<() => void>()
function emit() {
  for (const fn of subs) fn()
  requestCanvasRepaint()
}
export function setInferredShown(v: boolean): void {
  shown = v
  emit()
}
export function inferredShown(): boolean {
  return shown
}
export function subscribeInferred(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
function useShown(): boolean {
  return useSyncExternalStore(
    subscribeInferred,
    () => shown,
    () => shown
  )
}

const POLL_MS = 10_000

function useCorrelations() {
  const { win, paused, ready } = useTrafficMap()
  const frozen = useFrozenSnapshotId()
  return useQuery({
    queryKey: ['traffic-map', 'correlations', win],
    queryFn: async () =>
      (await api.get(`/traffic-map/correlations?window=${win}`)).data.data as Corr,
    enabled: ready && !frozen,
    refetchInterval: paused ? false : POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS - 1000
  })
}

/** Toolbar toggle; also the component that keeps the pairs current for the canvas layer. */
function InferredToggle() {
  const q = useCorrelations()
  const on = useShown()
  const pairs = q.data?.pairs ?? []
  useEffect(() => {
    current = pairs
    requestCanvasRepaint()
  }, [pairs])
  if (!pairs.length && !q.isError) return null
  return (
    <button
      type='button'
      id='tm-inferred'
      aria-pressed={on}
      onClick={() => setInferredShown(!on)}
      title={`Entities that keep rising together over the window (busiest ${q.data?.compared ?? 0} compared)`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)]',
        on
          ? 'border-[color-mix(in_srgb,var(--tm-inferred)_55%,var(--tm-line))] bg-[color-mix(in_srgb,var(--tm-inferred)_10%,var(--tm-card))] text-[var(--tm-inferred)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      <svg width='18' height='8' viewBox='0 0 18 8' aria-hidden='true'>
        <line
          x1='1'
          y1='4'
          x2='17'
          y2='4'
          stroke='currentColor'
          strokeWidth='1.6'
          strokeDasharray='3 3'
        />
      </svg>
      Inferred links <span className='tabular-nums'>{pairs.length}</span>
    </button>
  )
}

/** The pairs naming `key`, strongest first. */
export function pairsOf(key: string, pairs = current): Array<CorrelationPair & { other: string }> {
  return pairs
    .filter((p) => p.a === key || p.b === key)
    .map((p) => ({ ...p, other: p.a === key ? p.b : p.a }))
}

function EntityCorrelations({ sel }: { sel: Selection }) {
  const { catalog, setSelection } = useTrafficMap()
  const q = useCorrelations()
  const rows = pairsOf(sel.id, q.data?.pairs ?? [])
  if (!rows.length) return null
  return (
    <Section title='Moves with'>
      <ul className='grid gap-1.5 text-[12px]' id='tm-correlations'>
        {rows.map((p) => {
          const cut = p.other.indexOf('/')
          const leads =
            p.leads === null
              ? 'together'
              : (p.leads === 'a') === (p.a === sel.id)
                ? 'this one first'
                : 'that one first'
          return (
            <li key={p.other} className='flex min-w-0 items-baseline justify-between gap-3'>
              <button
                type='button'
                className='min-w-0 truncate rounded-sm text-left font-mono text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                onClick={() => setSelection({ kind: 'entity', id: p.other })}
                data-tm-correlation={p.other}
              >
                {entityLabel(catalog, p.other.slice(0, cut), p.other.slice(cut + 1))}
              </button>
              <span className='shrink-0 tabular-nums text-[11.5px] text-[var(--tm-fg-2)]'>
                r {p.r.toFixed(2)} · {p.co_spikes} spikes · {leads}
              </span>
            </li>
          )
        })}
      </ul>
      <p className='mt-1.5 text-[11.5px] text-[var(--tm-muted)]'>
        Inferred from the timing of requests, not from a known call: worth a look, not proof.
      </p>
    </Section>
  )
}

register(toolbarItems, { id: 'inferred', order: 45, Component: InferredToggle })
register(inspectorPanels, {
  id: 'correlations',
  order: 70,
  applies: (sel) => sel.kind === 'entity',
  Component: EntityCorrelations
})
register(canvasLayers, {
  id: 'inferred',
  order: 60,
  draw(ctx, { layout, tokens, fonts, active }) {
    if (!shown || !current.length) return
    // an entity row, else (lanes-only zoom, or the row is not drawn) its lane header
    const anchor = (key: string) => {
      const r = layout.ents[key] ?? layout.lanes[key.slice(0, key.indexOf('/'))]
      return r ? { x: r.x + r.w, y: r.y + Math.min(r.h, layout.rowH) / 2 } : null
    }
    ctx.lineCap = 'round'
    ctx.font = `600 9.5px ${fonts.mono}`
    for (const p of current) {
      const a = anchor(p.a)
      const b = anchor(p.b)
      if (!a || !b || (a.x === b.x && a.y === b.y)) continue
      const hot =
        active?.kind === 'entity' && (active.id === p.a || active.id === p.b) ? true : !active
      const bulge = 40 + Math.min(70, Math.abs(a.y - b.y) * 0.18)
      ctx.globalAlpha = hot ? 0.9 : 0.35
      ctx.strokeStyle = tokens.inferred
      ctx.lineWidth = 1.4 + p.r
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.bezierCurveTo(a.x + bulge, a.y, b.x + bulge, b.y, b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      // the correlation, on the curve's outer point
      const mx = (a.x + b.x) / 2 + bulge * 0.75
      const my = (a.y + b.y) / 2
      const t = `r ${p.r.toFixed(2)}`
      const w = ctx.measureText(t).width + 8
      ctx.globalAlpha = hot ? 1 : 0.5
      ctx.beginPath()
      ctx.roundRect(mx - w / 2, my - 7, w, 14, 7)
      ctx.fillStyle = tokens.card
      ctx.fill()
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = tokens.inferred
      ctx.textAlign = 'center'
      ctx.fillText(t, mx, my + 3.5)
      ctx.textAlign = 'left'
    }
    ctx.globalAlpha = 1
  }
})
