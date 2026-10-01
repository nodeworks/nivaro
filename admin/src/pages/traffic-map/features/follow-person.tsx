import { useQuery } from '@tanstack/react-query'
import { Footprints, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { entityLabel, fmtCount } from '../EventTicker'
import { Empty } from '../Inspector'
import { canvasLayers, requestCanvasRepaint } from '../registry/canvasLayers'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { ago, createStore, inPage, useStore } from './b1-shared'
import { BTN, INPUT } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1178 — follow one person. Pick someone and the map marks their requests live as they move
 * page to page: their caller node is ringed, the entities they touched in the last seconds glow
 * (fading), and a panel lists the screens they went through (the `x-nivaro-page` header both
 * apps send). "Keep full traces" asks the server to trace their next 50 requests whatever their
 * speed — the same tracing the Ops Console's follow-user starts.
 */
export interface FollowTarget {
  /** Caller key, `u<ID>`. */
  key: string
  name: string
}
export interface TrailStep {
  t: number
  key: string
  route: string
  status: number
  ms: number
  page: string | null
  app: string | null
}
export interface Visit {
  page: string | null
  app: string | null
  from: number
  to: number
  n: number
  errors: number
  keys: string[]
}
export interface FollowData {
  caller: string
  steps: TrailStep[]
  visits: Visit[]
  current: TrailStep | null
  last_sec: number | null
}

/** How long a touched entity keeps glowing on the canvas. */
export const GLOW_MS = 20_000

export const following = createStore<FollowTarget | null>(null)

let trail: FollowData | null = null
let version = 0
const subs = new Set<() => void>()
function setTrail(d: FollowData | null): void {
  trail = d
  version++
  for (const fn of subs) fn()
  requestCanvasRepaint()
}
function useTrail(): FollowData | null {
  useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    () => version,
    () => version
  )
  return trail
}

/** Entities touched within GLOW_MS, newest touch per entity: key → age 0..1 (0 = just now). */
export function glowingEntities(steps: TrailStep[], now: number): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    const age = (now - s.t) / GLOW_MS
    if (age > 1) break
    if (!out.has(s.key)) out.set(s.key, Math.max(0, age))
  }
  return out
}

/** "admin · /collections/workflows/:id" → a readable screen line. */
export function screenText(page: string | null, app: string | null): string {
  if (!page) return 'Unknown screen (no page header)'
  return app ? `${page} · ${app}` : page
}

interface UserRow {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  account_kind?: string | null
}
const personName = (u: UserRow) =>
  `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email?.split('@')[0] || u.id.slice(0, 8)

function FollowControl() {
  const target = useStore(following)
  const frozen = useFrozenSnapshotId()
  const { ready } = useTrafficMap()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const search = useQuery({
    queryKey: ['traffic-map', 'follow-search', q.trim()],
    queryFn: async () =>
      ((await api.get('/users', { params: { search: q.trim(), limit: 8 } })).data.data ??
        []) as UserRow[],
    enabled: open && q.trim().length >= 2,
    staleTime: 30_000
  })
  // poll the followed person's trail
  const poll = useQuery({
    queryKey: ['traffic-map', 'follow', target?.key],
    queryFn: async () =>
      (await api.get('/traffic-map/follow', { params: { caller: target?.key } })).data
        .data as FollowData,
    enabled: !!target && ready && !frozen,
    refetchInterval: 2000,
    staleTime: 1500
  })
  useEffect(() => {
    setTrail(target && poll.data?.caller === target.key ? poll.data : null)
  }, [poll.data, target])
  useEffect(() => () => setTrail(null), [])
  if (frozen) return null
  if (target)
    return (
      <span
        className='inline-flex items-center gap-1 rounded-md border border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] py-[3px] pl-2 pr-1 text-[12px] font-medium leading-tight text-[var(--tm-accent-ink)]'
        id='tm-following'
        data-tm-following={target.key}
      >
        <Footprints className='h-3.5 w-3.5' aria-hidden='true' />
        Following {target.name}
        <button
          type='button'
          aria-label={`Stop following ${target.name}`}
          onClick={() => following.set(null)}
          className='rounded p-0.5 hover:bg-[var(--tm-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <X className='h-3 w-3' aria-hidden='true' />
        </button>
      </span>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-follow'
          className={BTN}
          title='Follow one person: their requests light up as they move page to page'
        >
          <Footprints className='h-3.5 w-3.5' aria-hidden='true' />
          Follow
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[280px] p-2'>
        <div className='traffic-map grid gap-1.5'>
          <label htmlFor='tm-follow-search' className='text-[12px] font-medium text-[var(--tm-fg)]'>
            Follow a person
          </label>
          <input
            id='tm-follow-search'
            className={INPUT}
            value={q}
            placeholder='Name or email'
            autoComplete='off'
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className='grid gap-0.5' id='tm-follow-results'>
            {q.trim().length < 2 ? (
              <li className='px-1 py-1 text-[11.5px] text-[var(--tm-muted)]'>
                Type two letters to search.
              </li>
            ) : search.isLoading ? (
              <li className='px-1 py-1 text-[11.5px] text-[var(--tm-muted)]'>Searching…</li>
            ) : (search.data ?? []).length === 0 ? (
              <li className='px-1 py-1 text-[11.5px] text-[var(--tm-muted)]'>No one matches.</li>
            ) : (
              (search.data ?? []).map((u) => (
                <li key={u.id}>
                  <button
                    type='button'
                    data-tm-follow-pick={u.id}
                    onClick={() => {
                      following.set({ key: `u${u.id.toUpperCase()}`, name: personName(u) })
                      setOpen(false)
                      setQ('')
                    }}
                    className='grid w-full rounded px-1.5 py-1 text-left hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                  >
                    <span className='truncate text-[12px] font-medium text-[var(--tm-fg)]'>
                      {personName(u)}
                    </span>
                    {u.email && (
                      <span className='truncate text-[11px] text-[var(--tm-fg-2)]'>{u.email}</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function FollowPanel() {
  const target = useStore(following)
  const d = useTrail()
  const { catalog, setSelection } = useTrafficMap()
  const [busy, setBusy] = useState(false)
  if (!target) return null
  const cur = d?.current ?? null
  const live = cur ? Date.now() - cur.t < 60_000 : false
  const keepTraces = async () => {
    setBusy(true)
    try {
      await api.post('/traffic-map/follow/trace', { caller: target.key, requests: 50 })
      toast.success(`Tracing ${target.name}'s next 50 requests — see Slow traces`)
    } catch {
      toast.error('Could not start tracing')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label={`Following ${target.name}`}
      id='tm-follow-panel'
    >
      <div className='flex items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='truncate text-[13px] font-semibold'>Following {target.name}</h2>
          <p className='truncate text-[11.5px] text-[var(--tm-muted)]' data-tm-follow-now=''>
            {cur
              ? `${live ? 'Now on' : 'Last on'} ${screenText(cur.page, cur.app)} · ${ago(new Date(cur.t).toISOString())}`
              : 'No requests from them yet. The map marks them as soon as they make one.'}
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-1.5'>
          <button
            type='button'
            className={BTN}
            disabled={busy}
            onClick={() => void keepTraces()}
            title='Keep full traces of their next 50 requests, whatever their speed'
            data-tm-follow-trace=''
          >
            Keep full traces
          </button>
          <button type='button' className={BTN} onClick={() => following.set(null)}>
            Stop
          </button>
        </div>
      </div>
      <div className='max-h-[360px] overflow-y-auto px-3.5 py-2.5'>
        {!d?.visits.length ? (
          <Empty>Their screens show here as they move around.</Empty>
        ) : (
          <ol className='grid gap-1.5' id='tm-follow-visits'>
            {d.visits.map((v, i) => (
              <li
                key={`${v.from}-${v.to}-${v.page ?? ''}`}
                className='min-w-0 text-[12px]'
                data-tm-follow-visit={v.page ?? ''}
              >
                <div className='flex min-w-0 items-baseline justify-between gap-2'>
                  <span className='flex min-w-0 items-center gap-1.5'>
                    <i
                      aria-hidden='true'
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        i === 0 ? 'bg-[var(--tm-accent)]' : 'bg-[var(--tm-line)]'
                      )}
                    />
                    <span className='min-w-0 truncate font-mono text-[11.5px] font-medium'>
                      {screenText(v.page, v.app)}
                    </span>
                  </span>
                  <span className='shrink-0 tabular-nums text-[11.5px] text-[var(--tm-fg-2)]'>
                    {new Date(v.from).toTimeString().slice(0, 8)}
                  </span>
                </div>
                <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 pl-3 text-[11.5px] text-[var(--tm-fg-2)]'>
                  <span className='tabular-nums'>
                    {fmtCount(v.n)} {v.n === 1 ? 'request' : 'requests'}
                    {v.errors > 0 && (
                      <span className='text-[var(--tm-error-ink)]'>
                        {' '}
                        · {v.errors} {v.errors === 1 ? 'error' : 'errors'}
                      </span>
                    )}
                  </span>
                  {v.keys.map((k) => {
                    const cut = k.indexOf('/')
                    return (
                      <button
                        key={k}
                        type='button'
                        className='rounded-sm text-[11.5px] text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                        onClick={() => setSelection({ kind: 'entity', id: k })}
                      >
                        {entityLabel(catalog, k.slice(0, cut), k.slice(cut + 1))}
                      </button>
                    )
                  })}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}

register(toolbarItems, { id: 'follow-person', order: 50, Component: inPage(FollowControl) })
register(pagePanels, { id: 'follow-person', order: 3, Component: inPage(FollowPanel) })

register(canvasLayers, {
  id: 'follow-person',
  order: 40,
  draw(ctx, { layout, tokens, now }) {
    const target = following.get()
    if (!target || !trail || trail.caller !== target.key) return false
    const glow = glowingEntities(trail.steps, now)
    const callerRect = layout.callers[target.key]
    if (callerRect) {
      ctx.lineWidth = 2
      ctx.strokeStyle = tokens.accent
      ctx.beginPath()
      ctx.roundRect(callerRect.x - 3, callerRect.y - 3, callerRect.w + 6, callerRect.h + 6, 7)
      ctx.stroke()
    }
    for (const [key, age] of glow) {
      const r = layout.ents[key]
      if (!r) continue
      const alpha = 0.25 + 0.75 * (1 - age)
      ctx.globalAlpha = alpha
      ctx.lineWidth = 2
      ctx.strokeStyle = tokens.accent
      ctx.beginPath()
      ctx.roundRect(r.x - 2, r.y - 1, r.w + 4, r.h + 2, 5)
      ctx.stroke()
      if (callerRect) {
        const a = { x: callerRect.x + callerRect.w, y: callerRect.y + callerRect.h / 2 }
        const b = { x: r.x, y: r.y + r.h / 2 }
        const mx = (a.x + b.x) / 2
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1.25
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
    ctx.globalAlpha = 1
    // keep painting while something is still fading
    return glow.size > 0
  }
})
