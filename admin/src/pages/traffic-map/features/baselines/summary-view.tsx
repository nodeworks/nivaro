/**
 * #2244 — Executive summary: a plain view of the Traffic Map for non-technical readers —
 * requests, errors, the slowest area, partners down and people active, each green, amber or red
 * against its normal for this hour (#2145), and one sentence on anything that is not green.
 * Figures are the last 15 minutes of every instance's request log (the server works them out).
 * `?view=summary` opens it, so a whole-view link or a shared view carries it.
 */
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard, Waypoints } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { entityLabel } from '../../EventTicker'
import { notifyPageViews, pageViews } from '../../registry/pageViews'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { viewParams } from '../../registry/viewParams'
import { LANE_LABEL, type Lane, type TrafficCatalog } from '../../types'

type Tone = 'green' | 'amber' | 'red'
interface Tile {
  id: 'requests' | 'errors' | 'slowest' | 'partners' | 'people'
  tone: Tone
  value: string
  usual: string | null
  sentence: string | null
  keys?: string[]
}
interface Summary {
  at: string
  slot: string
  window_min: number
  learning: boolean
  tone: Tone
  headline: string
  tiles: Tile[]
}

// ── view state (the `view` URL param) ──────────────────────────────────────────
let on = false
const subs = new Set<() => void>()
export function summaryViewOn(): boolean {
  return on
}
export function setSummaryView(v: boolean): void {
  if (on === v) return
  on = v
  for (const fn of subs) fn()
  notifyPageViews()
}
function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
register(viewParams, {
  id: 'summary-view',
  param: 'view',
  get: () => (on ? 'summary' : null),
  set: (v) => setSummaryView(v === 'summary'),
  subscribe
})

const TITLE: Record<Tile['id'], string> = {
  requests: 'Requests',
  errors: 'Errors',
  slowest: 'Slowest area',
  partners: 'Partner systems',
  people: 'People active'
}
const TONE_VAR: Record<Tone, string> = {
  green: 'var(--tm-create)',
  amber: 'var(--tm-update)',
  red: 'var(--tm-error)'
}
const TONE_WORD: Record<Tone, string> = { green: 'Normal', amber: 'Watch', red: 'Act' }

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A key the tile names, in words (pure). */
export function plainName(key: string, catalog: TrafficCatalog | null): string {
  if (key.startsWith('ext:')) return catalog?.partners[key.slice(4)] ?? `Partner ${key.slice(4)}`
  const cut = key.indexOf('/')
  if (cut < 0) return key
  const lane = key.slice(0, cut) as Lane
  const entity = key.slice(cut + 1)
  const label =
    lane === 'items' || lane === 'system'
      ? (catalog?.collections[entity]?.label ?? entity)
      : entityLabel(catalog, lane, entity)
  return `${label} (${LANE_LABEL[lane] ?? lane})`
}

function ToneMark({ tone }: { tone: Tone }) {
  return (
    <span
      className='inline-flex items-center gap-1.5 text-[12px] font-medium'
      style={{ color: `color-mix(in srgb, ${TONE_VAR[tone]} 75%, var(--tm-fg))` }}
    >
      <span
        aria-hidden='true'
        className='inline-block h-2.5 w-2.5 rounded-full'
        style={{ background: TONE_VAR[tone] }}
      />
      {TONE_WORD[tone]}
    </span>
  )
}

function SummaryView() {
  const { catalog } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'summary'],
    queryFn: async () => {
      const res = await api.get('/traffic-map/summary', { params: { tz: tz() } })
      return (res.data as { data: Summary }).data
    },
    refetchInterval: 30_000,
    staleTime: 15_000
  })
  const s = q.data
  return (
    <section aria-label='Executive summary' id='tm-summary-view' className='grid gap-3.5'>
      <div className='rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)] px-5 py-4'>
        {s ? (
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='min-w-0'>
              <h2 className='text-[18px] font-semibold tracking-tight' id='tm-summary-headline'>
                {s.headline}
              </h2>
              <p className='mt-0.5 text-[12.5px] text-[var(--tm-muted)]'>
                The last {s.window_min} minutes, compared with what is normal for {s.slot}.
                {s.learning ? ' Still learning what is normal: some comparisons are missing.' : ''}
              </p>
            </div>
            <ToneMark tone={s.tone} />
          </div>
        ) : q.isError ? (
          <p className='text-[13px] text-[var(--tm-error-ink)]'>The summary could not be loaded.</p>
        ) : (
          <div
            aria-hidden='true'
            className='h-10 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          />
        )}
      </div>
      <div className='grid gap-3.5 min-[700px]:grid-cols-2 min-[1200px]:grid-cols-5'>
        {(s?.tiles ?? []).map((t) => (
          <article
            key={t.id}
            data-tm-summary-tile={t.id}
            data-tm-summary-tone={t.tone}
            className='grid content-start gap-1.5 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)] px-4 py-3.5'
          >
            <div className='flex items-center justify-between gap-2'>
              <h3 className='text-[13px] font-medium text-[var(--tm-fg-2)]'>{TITLE[t.id]}</h3>
              <ToneMark tone={t.tone} />
            </div>
            <p className='text-[20px] font-semibold leading-tight tracking-tight'>{t.value}</p>
            {t.usual && <p className='text-[12px] text-[var(--tm-muted)]'>{t.usual}</p>}
            {t.keys && t.keys.length > 0 && t.tone !== 'green' && (
              <p className='text-[12px] text-[var(--tm-fg-2)]'>
                {t.keys
                  .slice(0, 3)
                  .map((k) => plainName(k, catalog))
                  .join(', ')}
              </p>
            )}
            {t.sentence && (
              <p className='border-t border-[var(--tm-line-2)] pt-1.5 text-[12.5px] leading-snug'>
                {t.sentence}
              </p>
            )}
          </article>
        ))}
      </div>
      {s && (
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          Updated {new Date(s.at).toLocaleTimeString()} · refreshes every 30 seconds · copy this
          page's address to share it with another administrator.
        </p>
      )}
    </section>
  )
}

register(pageViews, { id: 'summary-view', active: () => on, Component: SummaryView })

function SummaryToggle() {
  const [v, setV] = useState(on)
  useEffect(() => subscribe(() => setV(on)), [])
  return (
    <button
      type='button'
      id='tm-summary-toggle'
      aria-pressed={v}
      onClick={() => setSummaryView(!v)}
      data-tip={v ? 'Back to the live map' : 'A plain summary for non-technical readers'}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        v
          ? 'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      {v ? (
        <Waypoints className='h-3.5 w-3.5' aria-hidden='true' />
      ) : (
        <LayoutDashboard className='h-3.5 w-3.5' aria-hidden='true' />
      )}
      {v ? 'Live map' : 'Summary'}
    </button>
  )
}

register(toolbarItems, { id: 'summary-view', order: 20, slot: 'actions', Component: SummaryToggle })
