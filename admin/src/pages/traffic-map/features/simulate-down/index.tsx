/**
 * #2841 Simulate down — pick a dependency (the database, Redis, file storage, a channel, an AI
 * provider, a partner, the sign-in provider) and see what would break if it went away. Nothing is
 * switched off: the server works the affected set out from recorded traffic over a window
 * (`GET /traffic-map/blast-radius?node=&window=`), the map shades it (direct strong, through
 * another node lighter, the rest dimmed) and the inspector lists the routes, screens, jobs and
 * channels, plus what keeps working degraded.
 *
 * Started from the toolbar (any dependency, including ones not drawn) or from a down node's
 * inspector actions. Works on a rewound map or a frozen snapshot too: the window then ends there.
 */
import { useQuery } from '@tanstack/react-query'
import { Unplug, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { entityLabel, fmtCount } from '../../EventTicker'
import { type InspectorData, Section } from '../../Inspector'
import type { MapLayout, MapTokens } from '../../layout'
import type { MapData } from '../../MapCanvas'
import type { TrafficModel } from '../../model'
import { downLabel } from '../../nodeKinds'
import { canvasLayers, requestCanvasRepaint } from '../../registry/canvasLayers'
import { inspectorActions } from '../../registry/inspectorActions'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { nodeMenuProviders } from '../../registry/nodeMenu'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import { createStore, inEdgeEnds, inPage, strokeEdge, useStore } from '../b1-shared'
import { BTN, errorOf, Figs, LINK, Note, Segmented } from '../shared'
import { useFrozenSnapshotId } from '../snapshots'
import {
  isDependency,
  type Overlay,
  overlayFrom,
  pct,
  perMinText,
  SIM_WINDOWS,
  type SimClaim,
  type SimResult,
  type SimWindow
} from './overlay'

export interface Simulation {
  node: string
  window: SimWindow
}

/** The running simulation (null = off). */
export const simulation = createStore<Simulation | null>(null)
/** The server's answer for it, read by the panel and the canvas layer. */
const answer = createStore<{
  data: SimResult | null
  loading: boolean
  error: string | null
  retry: () => void
}>({ data: null, loading: false, error: null, retry: () => {} })

export function startSimulation(node: string, window: SimWindow = '24h'): void {
  simulation.set({ node, window })
  requestCanvasRepaint()
}
export function stopSimulation(): void {
  simulation.set(null)
  requestCanvasRepaint()
}

const FIXED: Array<{ id: string; group: string; hint: string }> = [
  { id: 'db', group: 'Data', hint: 'Every read and write' },
  { id: 'redis', group: 'Data', hint: 'Sessions, caches, scheduler' },
  { id: 'store', group: 'Data', hint: 'Uploads and downloads' },
  { id: 'signin', group: 'Sign-in', hint: 'New sign-ins' },
  { id: 'mail', group: 'Channels', hint: 'Outgoing email' },
  { id: 'sms', group: 'Channels', hint: 'Text messages' },
  { id: 'push', group: 'Channels', hint: 'Browser push' },
  { id: 'ai', group: 'AI', hint: 'Every AI provider' }
]
const SIGNIN_LABEL = 'Sign-in provider'

function nodeName(m: TrafficModel, cat: Parameters<typeof downLabel>[1], id: string): string {
  if (id === 'signin') return SIGNIN_LABEL
  if (id === 'ai') return 'AI (every provider)'
  return downLabel(m, cat, id)
}

/** The window end for a rewound map or a frozen snapshot (epoch seconds, to the minute). */
function untilOf(m: TrafficModel, frozen: boolean): number | null {
  if (!frozen && !m.rewound) return null
  return Math.floor(m.at / 60) * 60
}

// ── toolbar: pick + status, and the one read ─────────────────────────────────
function SimulateControl() {
  const sim = useStore(simulation)
  const { model, catalog, setSelection, tick } = useTrafficMap()
  const frozen = !!useFrozenSnapshotId()
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState<SimWindow>('24h')
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick moves the rewound second
  const until = useMemo(() => untilOf(model, frozen), [model, frozen, tick])
  const q = useQuery({
    queryKey: ['traffic-map', 'simulate-down', sim?.node, sim?.window, until],
    queryFn: async () =>
      (
        await api.get('/traffic-map/blast-radius', {
          params: { node: sim?.node, window: sim?.window, ...(until ? { until } : {}) }
        })
      ).data.data as SimResult,
    enabled: !!sim,
    staleTime: 5 * 60_000,
    retry: false
  })
  const { refetch } = q
  useEffect(() => {
    answer.set({
      data: sim && q.data?.node === sim.node ? q.data : null,
      loading: !!sim && q.isLoading,
      error: sim && q.isError ? errorOf(q.error) : null,
      retry: () => void refetch()
    })
    requestCanvasRepaint()
  }, [sim, q.data, q.isLoading, q.isError, q.error, refetch])
  useEffect(() => () => stopSimulation(), [])

  // Dependencies the map has met (read each render: a handful of ids, and new ones arrive)
  const partners = open
    ? model
        .downIds()
        .filter((id) => /^(ext:|x:|ai:|teams$|webhook:)/.test(id) && isDependency(id))
        .map((id) => ({
          id,
          group: id.startsWith('ai:')
            ? 'AI'
            : /^(teams|webhook:)/.test(id)
              ? 'Channels'
              : 'Partners',
          hint: id.startsWith('ai:')
            ? 'One provider'
            : id.startsWith('webhook:')
              ? 'Webhook'
              : 'Partner'
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : []
  const pick = (id: string) => {
    startSimulation(id, win)
    setSelection({ kind: 'down', id })
    setOpen(false)
  }

  if (sim) {
    const label = nodeName(model, catalog, sim.node)
    return (
      <span
        id='tm-simulating'
        data-tm-simulating={sim.node}
        className='inline-flex items-center gap-1.5 rounded-md border border-[var(--tm-error)] bg-[var(--tm-error-soft)] py-[3px] pl-2 pr-1 text-[12px] font-medium leading-tight text-[var(--tm-error-ink)]'
      >
        <Unplug className='h-3.5 w-3.5' aria-hidden='true' />
        <button
          type='button'
          className='rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          onClick={() => setSelection({ kind: 'down', id: sim.node })}
        >
          Simulating {label} down
        </button>
        <span className='tabular-nums font-normal opacity-80'>· {sim.window}</span>
        <button
          type='button'
          id='tm-simulate-stop'
          aria-label='Stop simulating'
          data-tip='Stop simulating'
          onClick={stopSimulation}
          className='rounded p-0.5 hover:bg-[var(--tm-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <X className='h-3 w-3' aria-hidden='true' />
        </button>
      </span>
    )
  }

  const options = [...FIXED, ...partners]
  const groups = ['Data', 'Sign-in', 'Channels', 'AI', 'Partners']
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-simulate'
          className={BTN}
          data-tip='What would break if a dependency went down — worked out from recorded traffic'
        >
          <Unplug className='h-3.5 w-3.5' aria-hidden='true' />
          Simulate down
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[300px] p-0'>
        <div className='traffic-map grid gap-2 p-2.5' id='tm-simulate-picker'>
          <div className='grid gap-0.5'>
            <p className='text-[12.5px] font-medium text-[var(--tm-fg)]'>What if this went down?</p>
            <p className='text-[11.5px] leading-snug text-[var(--tm-fg-2)]'>
              The map shades everything that depends on it, from recorded traffic. Nothing is
              switched off.
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-[11.5px] text-[var(--tm-muted)]'>Traffic from the last</span>
            <Segmented
              label='Window'
              id='tm-simulate-window'
              value={win}
              options={SIM_WINDOWS}
              onChange={setWin}
            />
          </div>
          <div className='-mx-2.5 max-h-[320px] overflow-y-auto overscroll-contain border-t border-[var(--tm-line-2)] px-1.5 pb-0.5 pt-1.5'>
            {groups.map((g) => {
              const list = options.filter((o) => o.group === g)
              if (!list.length) return null
              return (
                <div key={g} className='mb-1 last:mb-0'>
                  <p className='px-1 pb-0.5 text-[11px] font-medium text-[var(--tm-muted)]'>{g}</p>
                  <ul className='grid'>
                    {list.map((o) => (
                      <li key={o.id}>
                        <button
                          type='button'
                          data-tm-simulate-pick={o.id}
                          onClick={() => pick(o.id)}
                          className='flex w-full min-w-0 items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
                        >
                          <span className='min-w-0 truncate text-[12px] font-medium text-[var(--tm-fg)]'>
                            {nodeName(model, catalog, o.id)}
                          </span>
                          <span className='shrink-0 text-[11px] text-[var(--tm-fg-2)]'>
                            {o.hint}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── inspector action on a dependency node ────────────────────────────────────
function SimulateAction({ sel }: { sel: Selection; d: InspectorData }) {
  const sim = useStore(simulation)
  const on = sim?.node === sel.id
  return on ? (
    <button type='button' id='tm-simulate-node-stop' className={BTN} onClick={stopSimulation}>
      Stop simulating
    </button>
  ) : (
    <button
      type='button'
      id='tm-simulate-node'
      className={BTN}
      data-tip='Shade what would break if this went down (nothing is switched off)'
      onClick={() => startSimulation(sel.id, sim?.window ?? '24h')}
    >
      Simulate down
    </button>
  )
}

// ── inspector panel: the affected set ────────────────────────────────────────
const SHOW = 8

function Group({
  title,
  count,
  id,
  children,
  more
}: {
  title: string
  count: number
  id: string
  children: (limit: number) => ReactNode
  more?: string
}) {
  const [all, setAll] = useState(false)
  if (count === 0) return null
  return (
    <div className='min-w-0' data-tm-sim-group={id}>
      <h4 className='mb-1 text-[11.5px] font-medium text-[var(--tm-fg-2)]'>
        {title} <span className='tabular-nums text-[var(--tm-muted)]'>{fmtCount(count)}</span>
      </h4>
      <ul className='grid gap-0.5 text-[12px]'>{children(all ? count : SHOW)}</ul>
      {count > SHOW ? (
        <button
          type='button'
          className={cn(LINK, 'mt-1 text-[11.5px]')}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show fewer' : `Show all ${fmtCount(count)}${more ?? ''}`}
        </button>
      ) : null}
    </div>
  )
}

function Row({
  left,
  right,
  tone
}: {
  left: ReactNode
  right?: ReactNode
  tone?: 'direct' | 'indirect'
}) {
  return (
    <li className='flex min-w-0 items-baseline justify-between gap-2'>
      <span className='flex min-w-0 items-baseline gap-1.5'>
        {tone ? (
          <i
            aria-hidden='true'
            className={cn(
              'relative top-[-1px] h-2 w-2 shrink-0 rounded-sm border',
              tone === 'direct'
                ? 'border-[var(--tm-error)] bg-[var(--tm-error-soft)]'
                : 'border-dashed border-[var(--tm-error)]'
            )}
          />
        ) : null}
        <span className='min-w-0 truncate'>{left}</span>
      </span>
      {right != null ? (
        <span className='shrink-0 tabular-nums text-[11.5px] text-[var(--tm-fg-2)]'>{right}</span>
      ) : null}
    </li>
  )
}

function Claims({ title, list, tone }: { title: string; list: SimClaim[]; tone: string }) {
  if (!list.length) return null
  return (
    <div className='min-w-0'>
      <h4 className='mb-1 text-[11.5px] font-medium text-[var(--tm-fg-2)]'>{title}</h4>
      <ul className='grid gap-1 text-[12px] leading-snug text-[var(--tm-fg)]'>
        {list.map((c) => (
          <li key={c.text} className='flex gap-1.5' data-tip={`From ${c.source}`}>
            <i
              aria-hidden='true'
              className={cn('mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full', tone)}
            />
            <span className='min-w-0'>{c.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Skeleton() {
  return (
    <div className='grid gap-2.5' aria-hidden='true'>
      {[60, 100, 80, 90, 70].map((w, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
          key={i}
          className='h-3 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

function SimulatePanel({ sel }: { sel: Selection; d: InspectorData }) {
  const sim = useStore(simulation)
  const a = useStore(answer)
  const { catalog, setSelection, model } = useTrafficMap()
  const ref = useRef<HTMLDivElement>(null)
  const shown = !!sim && sel.kind === 'down' && sel.id === sim.node
  // The panel sits under the node's live sections: bring it into view when a simulation starts.
  useEffect(() => {
    if (!shown) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [shown])
  if (!sim || !shown) return null
  const b = a.data
  const label = b?.label ?? nodeName(model, catalog, sim.node)
  const channelRows = (b?.downstream ?? []).filter((d) =>
    /^(mail|sms|push|teams|webhook:)/.test(d.id)
  )
  const partnerRows = (b?.downstream ?? []).filter((d) => !channelRows.includes(d))
  const channelClaims = (b?.claims.fails ?? []).filter((c) => c.area === 'channel')
  return (
    <Section title={`If ${label} went down`}>
      <div ref={ref} className='grid gap-3' id='tm-simulate-panel' data-tm-simulate={sim.node}>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <Segmented
            label='Window'
            id='tm-simulate-panel-window'
            value={sim.window}
            options={SIM_WINDOWS}
            onChange={(w) => startSimulation(sim.node, w)}
          />
          <span className='flex items-center gap-2.5 text-[11px] text-[var(--tm-fg-2)]'>
            <span className='inline-flex items-center gap-1'>
              <i className='h-2 w-2 rounded-sm border border-[var(--tm-error)] bg-[var(--tm-error-soft)]' />
              Breaks
            </span>
            <span className='inline-flex items-center gap-1'>
              <i className='h-2 w-2 rounded-sm border border-dashed border-[var(--tm-error)]' />
              Through another node
            </span>
          </span>
        </div>
        {a.loading ? (
          <Skeleton />
        ) : a.error ? (
          <div className='flex flex-wrap items-center gap-2'>
            <Note tone='error'>{a.error}</Note>
            <button type='button' className={BTN} onClick={a.retry}>
              Try again
            </button>
          </div>
        ) : !b ? null : (
          <>
            <Figs
              items={[
                ['Routes', fmtCount(b.totals.routes), b.totals.routes > 0],
                ['Calls', perMinText(b.totals.per_min), b.totals.calls > 0],
                ['Of all traffic', pct(b.totals.share_of_calls)]
              ]}
            />
            <Figs
              items={[
                ['Screens', fmtCount(b.totals.screens)],
                ['Jobs', fmtCount(b.totals.jobs)],
                ['Channels', fmtCount(b.totals.channels)]
              ]}
            />
            <Claims title='Stops working' list={b.claims.fails} tone='bg-[var(--tm-error)]' />
            {b.routes.length === 0 ? (
              <p className='text-[12px] text-[var(--tm-muted)]'>
                No recorded request used it in the last {b.window}.
              </p>
            ) : null}
            <Group title='Routes' id='routes' count={b.routes.length}>
              {(n) =>
                b.routes.slice(0, n).map((r) => (
                  <Row
                    key={r.route}
                    tone={r.strength}
                    left={
                      <button
                        type='button'
                        className={cn(LINK, 'font-mono text-[11.5px]')}
                        data-tip={
                          r.share != null ? `${pct(r.share)} of its calls · ${r.why}` : r.why
                        }
                        onClick={() => setSelection({ kind: 'entity', id: r.entity })}
                      >
                        {r.route}
                      </button>
                    }
                    right={perMinText(r.per_min)}
                  />
                ))
              }
            </Group>
            <Group title='Screens' id='screens' count={b.screens.length}>
              {(n) =>
                b.screens.slice(0, n).map((s) => (
                  <Row
                    key={s.screen}
                    tone='indirect'
                    left={
                      <span
                        className='font-mono text-[11.5px]'
                        data-tip={`Calls ${s.entities
                          .map((k) =>
                            entityLabel(
                              catalog,
                              k.slice(0, k.indexOf('/')),
                              k.slice(k.indexOf('/') + 1)
                            )
                          )
                          .join(', ')}`}
                      >
                        {s.screen}
                      </span>
                    }
                    right={`${fmtCount(s.calls)} calls`}
                  />
                ))
              }
            </Group>
            <Group title='Scheduled jobs' id='jobs' count={b.jobs.length}>
              {(n) =>
                b.jobs.slice(0, n).map((j) => (
                  <Row
                    key={j.id}
                    tone={j.strength}
                    left={
                      <>
                        <button
                          type='button'
                          className={cn(LINK, 'font-mono text-[11.5px]')}
                          onClick={() => setSelection({ kind: 'caller', id: `cron:${j.id}` })}
                        >
                          {j.id}
                        </button>{' '}
                        <span className='text-[11px] text-[var(--tm-muted)]'>{j.why}</span>
                      </>
                    }
                    right={j.runs ? `${fmtCount(j.runs)} ${j.runs === 1 ? 'run' : 'runs'}` : null}
                  />
                ))
              }
            </Group>
            <Group title='Channels' id='channels' count={channelRows.length + channelClaims.length}>
              {(n) => [
                ...channelClaims
                  .slice(0, n)
                  .map((c) => (
                    <Row
                      key={c.text}
                      tone='direct'
                      left={<span className='whitespace-normal'>{c.text}</span>}
                    />
                  )),
                ...channelRows
                  .slice(0, Math.max(0, n - channelClaims.length))
                  .map((d) => (
                    <Row
                      key={d.id}
                      tone='indirect'
                      left={nodeName(model, catalog, d.id)}
                      right={`${fmtCount(d.calls)} sends`}
                    />
                  ))
              ]}
            </Group>
            <Group title='Partners fed only through it' id='downstream' count={partnerRows.length}>
              {(n) =>
                partnerRows.slice(0, n).map((d) => (
                  <Row
                    key={d.id}
                    tone='indirect'
                    left={
                      <button
                        type='button'
                        className={LINK}
                        onClick={() => setSelection({ kind: 'down', id: d.id })}
                      >
                        {nodeName(model, catalog, d.id)}
                      </button>
                    }
                    right={`${fmtCount(d.calls)} calls`}
                  />
                ))
              }
            </Group>
            <Claims
              title='Keeps working, degraded'
              list={b.claims.degrades}
              tone='bg-[var(--tm-update)]'
            />
            <Claims title='Unaffected' list={b.claims.keeps} tone='bg-[var(--tm-line)]' />
            <p className='text-[11px] leading-snug text-[var(--tm-muted)]' id='tm-simulate-basis'>
              Worked out from {b.sources.length ? b.sources.join(', ') : 'no recorded traffic'},{' '}
              {hhmm(b.from)} to {hhmm(b.to)}. Nothing was switched off.
              {b.notes.map((n) => (
                <span key={n} className='block'>
                  {n}
                </span>
              ))}
            </p>
          </>
        )}
      </div>
    </Section>
  )
}

// ── canvas: dim the rest, shade what breaks ──────────────────────────────────
let wash: HTMLCanvasElement | null = null
let memo: { key: string; ov: Overlay } | null = null

function overlayNow(model: TrafficModel): Overlay | null {
  const sim = simulation.get()
  if (!sim) return null
  const data = answer.get().data
  const key = `${sim.node}|${data?.computed_at ?? ''}|${model.frameNo}|${model.at}`
  if (memo?.key !== key) memo = { key, ov: overlayFrom(sim.node, data, model) }
  return memo.ov
}

type Rect = { x: number; y: number; w: number; h: number }

/** Every rect the overlay keeps bright (keys resolved to drawn nodes). */
export function shadedRects(
  ov: Overlay,
  layout: Pick<MapLayout, 'callers' | 'lanes' | 'ents' | 'downs'>,
  callerNode: Map<string, string>
): Array<{
  r: Rect
  s: 'direct' | 'indirect' | 'target'
  kind: 'ent' | 'lane' | 'caller' | 'down'
}> {
  const out: Array<{
    r: Rect
    s: 'direct' | 'indirect' | 'target'
    kind: 'ent' | 'lane' | 'caller' | 'down'
  }> = []
  for (const [k, s] of ov.ents) if (layout.ents[k]) out.push({ r: layout.ents[k], s, kind: 'ent' })
  for (const [k, s] of ov.lanes)
    if (layout.lanes[k]) out.push({ r: layout.lanes[k], s, kind: 'lane' })
  const seen = new Set<string>()
  for (const [k, s] of ov.callers) {
    const node = callerNode.get(k) ?? k
    if (seen.has(node) || !layout.callers[node]) continue
    seen.add(node)
    out.push({ r: layout.callers[node], s, kind: 'caller' })
  }
  for (const [k, s] of ov.downs)
    if (layout.downs[k]) out.push({ r: layout.downs[k], s, kind: 'down' })
  return out
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  ov: Overlay,
  layout: MapLayout,
  data: MapData,
  tokens: MapTokens,
  font: string
): void {
  const rects = shadedRects(ov, layout, data.callerNode)
  // 1. Dim everything outside the shaded nodes (an offscreen wash with holes, so overlapping
  //    rects never double up).
  if (typeof document !== 'undefined') {
    const cv = ctx.canvas
    wash ??= document.createElement('canvas')
    if (wash.width !== cv.width || wash.height !== cv.height) {
      wash.width = cv.width
      wash.height = cv.height
    }
    const w = wash.getContext('2d')
    if (w) {
      w.setTransform(1, 0, 0, 1, 0, 0)
      w.clearRect(0, 0, wash.width, wash.height)
      w.globalAlpha = 0.62
      w.fillStyle = tokens.card
      w.fillRect(0, 0, wash.width, wash.height)
      w.globalAlpha = 1
      w.setTransform(ctx.getTransform())
      for (const { r } of rects) w.clearRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6)
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(wash, 0, 0)
      ctx.restore()
    }
  }
  // 2. Edges into the target (lane → node) strong, into nodes only it feeds lighter; affected
  //    callers → their lanes lighter still.
  ctx.strokeStyle = tokens.error
  ctx.lineCap = 'round'
  for (const [down, s] of ov.downs) {
    const dn = layout.downs[down]
    if (!dn) continue
    for (const [lane, ls] of ov.lanes) {
      const ln = layout.lanes[lane]
      // only edges the map really draws (a session failure is not traffic into Redis)
      if (!ln || !data.edgesOut.some((e) => e.from === lane && e.to === down)) continue
      ctx.globalAlpha = s === 'target' && ls === 'direct' ? 0.85 : 0.4
      ctx.lineWidth = s === 'target' && ls === 'direct' ? 2 : 1.25
      ctx.setLineDash(s === 'target' ? [] : [4, 4])
      strokeEdge(ctx, { x: ln.x + ln.w, y: ln.y + 11 }, { x: dn.x, y: dn.y + dn.h / 2 })
    }
  }
  ctx.setLineDash([4, 4])
  ctx.lineWidth = 1.25
  ctx.globalAlpha = 0.45
  const drawnCallers = new Set<string>()
  for (const k of ov.callers.keys()) {
    const node = data.callerNode.get(k) ?? k
    if (drawnCallers.has(node)) continue
    drawnCallers.add(node)
    for (const lane of ov.lanes.keys()) {
      if (!data.edgesIn.some((e) => e.from === node && e.to === lane)) continue
      const ends = inEdgeEnds(layout, node, lane)
      if (ends) strokeEdge(ctx, ends.a, ends.b)
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  // 3. Node outlines: direct = soft fill + solid line, through another node = dashed line.
  for (const { r, s, kind } of rects) {
    const pad = kind === 'ent' ? 1 : 2
    ctx.beginPath()
    ctx.roundRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, kind === 'ent' ? 5 : 8)
    if (s === 'target') {
      ctx.save()
      ctx.clip()
      ctx.globalAlpha = 0.35
      ctx.strokeStyle = tokens.error
      ctx.lineWidth = 1
      for (let x = r.x - r.h; x < r.x + r.w + r.h; x += 6) {
        ctx.beginPath()
        ctx.moveTo(x, r.y + r.h + pad)
        ctx.lineTo(x + r.h + pad * 2, r.y - pad)
        ctx.stroke()
      }
      ctx.restore()
      ctx.beginPath()
      ctx.roundRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 8)
      ctx.lineWidth = 2
      ctx.strokeStyle = tokens.error
      ctx.stroke()
      ctx.font = font
      const tw = ctx.measureText('Simulated down').width + 8
      ctx.beginPath()
      // sits on the node's top edge, clear of the node above
      ctx.roundRect(r.x + r.w - tw - 6, r.y - 7, tw, 12, 6)
      ctx.fillStyle = tokens.error
      ctx.fill()
      ctx.fillStyle = tokens.card
      ctx.textAlign = 'left'
      ctx.fillText('Simulated down', r.x + r.w - tw - 2, r.y + 2)
    } else if (s === 'direct') {
      ctx.fillStyle = tokens.errorSoft
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = tokens.error
      ctx.stroke()
    } else {
      ctx.setLineDash([3, 3])
      ctx.globalAlpha = 0.75
      ctx.lineWidth = 1.25
      ctx.strokeStyle = tokens.error
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
  }
}

register(toolbarItems, {
  id: 'simulate-down',
  slot: 'actions',
  order: 15,
  Component: inPage(SimulateControl)
})
register(nodeMenuProviders, {
  id: 'simulate-down',
  order: 10,
  entries: (sel) => {
    if (sel.kind !== 'down' || !isDependency(sel.id)) return []
    const sim = simulation.get()
    if (sim?.node === sel.id)
      return [{ key: 'simulate-down', label: 'Stop simulating', run: () => stopSimulation() }]
    return [
      {
        key: 'simulate-down',
        label: 'Simulate down',
        hint: 'Shade what would break, from recorded traffic',
        run: ({ select }) => {
          startSimulation(sel.id, sim?.window ?? '24h')
          select(sel)
        }
      }
    ]
  }
})
register(inspectorActions, {
  id: 'simulate-down',
  order: 40,
  applies: (sel) => sel.kind === 'down' && isDependency(sel.id),
  Component: inPage(SimulateAction)
})
register(inspectorPanels, {
  id: 'simulate-down',
  order: 2,
  history: true,
  // Always offered on a dependency; the panel itself shows only while that node is simulated
  // (it subscribes to the simulation, so starting one from the action row shows it at once).
  applies: (sel) => sel.kind === 'down' && isDependency(sel.id),
  Component: inPage(SimulatePanel)
})
register(canvasLayers, {
  id: 'simulate-down',
  order: 95,
  draw(ctx, { layout, data, tokens, fonts, model }) {
    const ov = overlayNow(model)
    if (!ov) return false
    drawOverlay(ctx, ov, layout, data, tokens, `500 9.5px ${fonts.sans}`)
    return false
  }
})
