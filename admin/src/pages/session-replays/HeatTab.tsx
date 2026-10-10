import { useQuery } from '@tanstack/react-query'
import { Flame, MousePointerClick } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  cellAt,
  type HeatCellIn,
  heatDots,
  lastDays,
  reachCurve,
  VIEWPORT_LABELS
} from './heatLogic'

/**
 * Heat tab (#1364): where people click on a route and how far they scroll,
 * folded nightly from recordings into aggregates that keep no person. The
 * route renders under the overlay from its newest stored frame — a paused
 * rrweb Replayer — so admin and portal routes look the same here as they did
 * to the people using them.
 */

interface HeatRoute {
  app: string
  route: string
  clicks: number
  visits: number
}

interface HeatFrame {
  recording_id: string
  at_ms: number
  width: number | null
  height: number | null
}

interface HeatView {
  viewports: Array<{ viewport: string; clicks: number }>
  clicks: HeatCellIn[]
  total_clicks: number
  selectors: Array<{ selector: string; count: number }>
  unresolved_clicks: number
  scroll: Array<{ depth: number; visits: number }>
  total_visits: number
  frame: HeatFrame | null
}

const BASE = '/session-replay-insights'
/** One hue, alpha carries magnitude (sequential; never a rainbow). */
const HEAT_RGB = '225, 29, 72'

export function HeatTab() {
  const [range, setRange] = useState(() => lastDays(30))
  const [picked, setPicked] = useState<{ app: string; route: string } | null>(null)
  const [viewport, setViewport] = useState<string | null>(null)

  const { data: routes = [], isLoading } = useQuery({
    queryKey: ['replay-heat-routes', range.from, range.to],
    queryFn: () =>
      api
        .get<{ data: HeatRoute[] }>(`${BASE}/heat/routes`, { params: range })
        .then((r) => r.data.data)
  })
  const current = picked ?? (routes[0] ? { app: routes[0].app, route: routes[0].route } : null)
  const apps = useMemo(() => new Set(routes.map((r) => r.app)), [routes])

  const { data: heat, isFetching } = useQuery({
    queryKey: ['replay-heat', current?.app, current?.route, range.from, range.to, viewport],
    queryFn: () =>
      api
        .get<{ data: HeatView }>(`${BASE}/heat`, {
          params: { ...current, ...range, ...(viewport ? { viewport } : {}) }
        })
        .then((r) => r.data.data),
    enabled: !!current
  })

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden' data-testid='replay-heat'>
      <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='space-y-1.5 border-b border-slate-100 p-3 dark:border-border/50'>
          <div className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
            <input
              type='date'
              aria-label='From'
              value={range.from}
              max={range.to}
              onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
              className='h-7 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] dark:border-border dark:bg-card'
            />
            –
            <input
              type='date'
              aria-label='To'
              value={range.to}
              min={range.from}
              onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
              className='h-7 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] dark:border-border dark:bg-card'
            />
          </div>
          <div className='flex gap-1'>
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                type='button'
                onClick={() => setRange(lastDays(n))}
                className='rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-800 dark:border-border'
              >
                {n} days
              </button>
            ))}
          </div>
        </div>
        <div className='flex-1 overflow-y-auto'>
          {isLoading ? (
            <p className='p-4 text-[12px] text-slate-400'>Loading…</p>
          ) : routes.length === 0 ? (
            <div className='p-6 text-center text-slate-400'>
              <Flame className='mx-auto h-6 w-6 opacity-40' />
              <p className='mt-2 text-[12px]'>
                No heat in this range yet. Recordings are folded nightly once they finish.
              </p>
            </div>
          ) : (
            routes.map((r) => {
              const on = current?.app === r.app && current?.route === r.route
              return (
                <button
                  key={`${r.app} ${r.route}`}
                  type='button'
                  onClick={() => {
                    setPicked({ app: r.app, route: r.route })
                    setViewport(null)
                  }}
                  className={cn(
                    'block w-full border-b border-slate-100 px-4 py-2 text-left dark:border-border/50',
                    on ? 'bg-accent' : 'hover:bg-slate-50 dark:hover:bg-muted/40'
                  )}
                >
                  <span
                    className={cn(
                      'block truncate font-mono text-[12px]',
                      on
                        ? 'font-semibold text-nvr-navy dark:text-nvr-cyan'
                        : 'text-slate-700 dark:text-foreground'
                    )}
                    title={r.route}
                  >
                    {r.route}
                  </span>
                  <span className='block text-[11px] text-slate-400'>
                    {apps.size > 1 && `${r.app} · `}
                    {r.clicks.toLocaleString()} clicks · {r.visits.toLocaleString()} visits
                  </span>
                </button>
              )
            })
          )}
        </div>
      </aside>

      <div className='min-w-0 flex-1 overflow-y-auto bg-slate-50 px-6 py-5 dark:bg-background'>
        {!current ? null : (
          <>
            <div className='mb-3 flex flex-wrap items-center gap-2'>
              <h2 className='font-mono text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                {current.route}
              </h2>
              <span className='text-[12px] text-slate-400'>
                {heat
                  ? `${heat.total_clicks.toLocaleString()} clicks · ${heat.total_visits.toLocaleString()} visits`
                  : ''}
                {isFetching ? ' · loading…' : ''}
              </span>
              {heat && heat.viewports.length > 1 && (
                <div className='ml-auto flex gap-1'>
                  <ViewportChip on={viewport === null} onClick={() => setViewport(null)}>
                    All screens
                  </ViewportChip>
                  {heat.viewports.map((v) => (
                    <ViewportChip
                      key={v.viewport}
                      on={viewport === v.viewport}
                      onClick={() => setViewport(v.viewport)}
                    >
                      {VIEWPORT_LABELS[v.viewport] ?? v.viewport} · {v.clicks}
                    </ViewportChip>
                  ))}
                </div>
              )}
            </div>
            <div className='flex flex-col gap-5 xl:flex-row'>
              <div className='min-w-0 flex-1'>
                <HeatStage app={current.app} route={current.route} heat={heat ?? null} />
              </div>
              <div className='w-full shrink-0 space-y-5 xl:w-[280px]'>
                <ScrollReach heat={heat ?? null} />
                <TopElements heat={heat ?? null} />
              </div>
            </div>
            <p className='mt-4 text-[11px] text-slate-400'>
              Aggregates only: clicks and scroll depth are counted per route, day and screen size,
              with nothing that says whose they were. Positions are relative to the viewport, so
              mixing screen sizes blurs the map — pick one above for a sharper picture.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function ViewportChip({
  on,
  onClick,
  children
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px]',
        on
          ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
          : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border'
      )}
    >
      {children}
    </button>
  )
}

/**
 * The route as it looked (a paused Replayer at the stored frame) with the
 * click heat drawn over it. With no frame — the recording behind it expired —
 * the heat sits on a plain viewport-shaped box.
 */
function HeatStage({ app, route, heat }: { app: string; route: string; heat: HeatView | null }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [frameState, setFrameState] = useState<'none' | 'loading' | 'shown' | 'failed'>('none')
  const [hover, setHover] = useState<{ x: number; y: number; cell: HeatCellIn } | null>(null)
  const frame = heat?.frame ?? null
  const natural = { w: frame?.width || 1280, h: frame?.height || 800 }

  // Fit the frame's natural size to the stage width.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const fitToStage = () => {
      const scale = Math.min(1, (el.clientWidth || natural.w) / natural.w)
      setSize({ w: Math.round(natural.w * scale), h: Math.round(natural.h * scale) })
    }
    fitToStage()
    const ro = new ResizeObserver(fitToStage)
    ro.observe(el)
    return () => ro.disconnect()
  }, [natural.w, natural.h])

  // The route itself, from its stored frame.
  const frameKey = frame ? `${frame.recording_id}:${frame.at_ms}` : null
  const replayerRef = useRef<{
    wrapper: HTMLElement
    destroy?: () => void
    pause: (t?: number) => void
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!frameKey || !host) {
      setFrameState('none')
      return
    }
    setFrameState('loading')
    void (async () => {
      try {
        const r = await api.get<{ data: { events: Array<{ timestamp: number }>; at_ms: number } }>(
          `${BASE}/heat/frame`,
          { params: { app, route } }
        )
        const { events, at_ms } = r.data.data
        if (cancelled || events.length < 2) {
          if (!cancelled) setFrameState('failed')
          return
        }
        const rrweb = await import('rrweb')
        await import('rrweb/dist/style.css')
        if (cancelled) return
        host.replaceChildren()
        const rep = new rrweb.Replayer(events as never[], {
          root: host,
          mouseTail: false,
          showWarning: false,
          triggerFocus: false
        }) as unknown as NonNullable<typeof replayerRef.current>
        replayerRef.current = rep
        rep.pause(Math.max(0, at_ms - events[0].timestamp))
        setFrameState('shown')
      } catch {
        if (!cancelled) setFrameState('failed')
      }
    })()
    return () => {
      cancelled = true
      replayerRef.current?.destroy?.()
      replayerRef.current = null
      host.replaceChildren()
    }
  }, [frameKey, app, route])

  // Scale the replayer's full-size iframe to the stage.
  useEffect(() => {
    const rep = replayerRef.current
    if (!rep || frameState !== 'shown' || !size.w) return
    rep.wrapper.style.transform = `scale(${size.w / natural.w})`
    rep.wrapper.style.transformOrigin = 'top left'
    rep.wrapper.style.pointerEvents = 'none'
  }, [size.w, natural.w, frameState])

  // The heat layer.
  const cells = heat?.clicks ?? []
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.w) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const radius = Math.max(10, (size.w / 50) * 1.4)
    for (const d of heatDots(cells, size.w, size.h)) {
      const g = ctx.createRadialGradient(d.cx, d.cy, 0, d.cx, d.cy, radius)
      g.addColorStop(0, `rgba(${HEAT_RGB}, ${0.15 + 0.6 * d.weight})`)
      g.addColorStop(1, `rgba(${HEAT_RGB}, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(d.cx, d.cy, radius, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [cells, size.w, size.h])

  const total = heat?.total_clicks ?? 0
  return (
    <div ref={stageRef} className='w-full'>
      <div
        className='relative overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
        style={{ width: size.w || '100%', height: size.h || 400 }}
      >
        {frameState !== 'shown' && (
          <div
            aria-hidden
            className='absolute inset-0'
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(148,163,184,.15) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,.15) 1px, transparent 1px)',
              backgroundSize: '10% 10%'
            }}
          />
        )}
        <div ref={hostRef} className='absolute left-0 top-0' aria-hidden />
        <canvas
          ref={canvasRef}
          className='absolute inset-0 h-full w-full'
          aria-label={`Click heatmap: ${total} clicks`}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const cell = cellAt(cells, x, y, rect.width, rect.height)
            setHover(cell ? { x, y, cell } : null)
          }}
          onMouseLeave={() => setHover(null)}
        />
        {hover && (
          <div
            className='pointer-events-none absolute z-10 rounded-md bg-slate-900/90 px-2 py-1 text-[11px] text-white'
            style={{
              left: Math.min(hover.x + 12, Math.max(0, size.w - 140)),
              top: Math.max(0, hover.y - 30)
            }}
          >
            {hover.cell.count.toLocaleString()} click{hover.cell.count === 1 ? '' : 's'}
            {total > 0 && ` · ${((hover.cell.count / total) * 100).toFixed(1)}%`}
          </div>
        )}
      </div>
      <div className='mt-1.5 flex items-center gap-3 text-[11px] text-slate-400'>
        <span className='flex items-center gap-1.5'>
          Fewer
          <span
            className='inline-block h-2 w-20 rounded-full'
            style={{
              background: `linear-gradient(to right, rgba(${HEAT_RGB}, .12), rgba(${HEAT_RGB}, .75))`
            }}
          />
          More clicks
        </span>
        <span className='ml-auto'>
          {frameState === 'shown'
            ? 'Route shown as last recorded'
            : frameState === 'loading'
              ? 'Rendering the route…'
              : frameState === 'failed'
                ? 'The route could not be rendered'
                : 'No recording of this route is kept any more — the heat is shown on a blank viewport'}
        </span>
      </div>
    </div>
  )
}

function ScrollReach({ heat }: { heat: HeatView | null }) {
  const curve = useMemo(() => reachCurve(heat?.scroll ?? []), [heat])
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <h3 className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
        Scroll depth
      </h3>
      <p className='mb-2 text-[11px] text-slate-400'>Share of visits that reached each screen</p>
      {curve.length === 0 ? (
        <p className='text-[11.5px] text-slate-400'>No visits in this range.</p>
      ) : (
        <ul className='space-y-1' aria-label='Scroll depth'>
          {curve.slice(0, 12).map((c) => (
            <li
              key={c.screens}
              className='flex items-center gap-2 text-[11px]'
              title={`${c.reached.toLocaleString()} of ${heat?.total_visits.toLocaleString()} visits reached screen ${c.screens}`}
            >
              <span className='w-16 shrink-0 tabular-nums text-slate-500'>Screen {c.screens}</span>
              <span className='relative h-3 flex-1 rounded-sm bg-slate-100 dark:bg-muted'>
                <span
                  className='absolute inset-y-0 left-0 rounded-sm bg-nvr-cyan/70'
                  style={{ width: `${Math.max(c.share > 0 ? 2 : 0, c.share * 100)}%` }}
                />
              </span>
              <span className='w-10 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-300'>
                {Math.round(c.share * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function TopElements({ heat }: { heat: HeatView | null }) {
  const total = heat?.total_clicks ?? 0
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <h3 className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
        <MousePointerClick className='h-3.5 w-3.5 text-slate-400' /> Most clicked
      </h3>
      {!heat || heat.selectors.length === 0 ? (
        <p className='mt-2 text-[11.5px] text-slate-400'>No clicks in this range.</p>
      ) : (
        <ol className='mt-2 space-y-1'>
          {heat.selectors.slice(0, 15).map((s) => (
            <li key={s.selector} className='flex items-baseline gap-2 text-[11px]'>
              <span
                className='min-w-0 flex-1 truncate font-mono text-slate-600 dark:text-slate-300'
                title={s.selector}
              >
                {s.selector}
              </span>
              <span className='shrink-0 tabular-nums text-slate-500'>
                {s.count.toLocaleString()}
                {total > 0 && ` · ${Math.round((s.count / total) * 100)}%`}
              </span>
            </li>
          ))}
          {heat.unresolved_clicks > 0 && (
            <li className='text-[10.5px] text-slate-400'>
              {heat.unresolved_clicks.toLocaleString()} click(s) on elements the recording could not
              name
            </li>
          )}
        </ol>
      )}
    </section>
  )
}
