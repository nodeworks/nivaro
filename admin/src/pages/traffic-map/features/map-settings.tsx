import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatFileSize } from '@/lib/utils'
import { register } from '../registry/registry'
import { stripTiles } from '../registry/stripTiles'
import { toolbarItems } from '../registry/toolbarItems'
import { inMapOnly, isObj, StripCell, useTmRoute } from './ops-common'
import { BTN, errorOf, INPUT } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #2177 / #2173 / #2178 — one card on the map for how long map data is kept (with the room each
 * kind takes), when snapshots are taken by themselves, and what the map itself costs the API:
 * CPU, memory, socket and Redis bytes, and the request rate above which the ticker is sampled.
 * Settings live in nivaro_settings.traffic_map_settings (migration 449); a database without it
 * shows the defaults and cannot save.
 */
interface Settings {
  retention: { snapshots_days: number; scheduled_days: number; notebooks_days: number }
  schedule: { peak: boolean; every_hours: number }
  overhead: { sample_above_rps: number }
}
interface UsageRow {
  n: number
  bytes: number
  oldest: string | null
}
interface Usage {
  snapshots: UsageRow
  scheduled: UsageRow
  notebooks: UsageRow
}
export interface Overhead {
  window_s: number
  req_per_s: number
  cpu_ms_per_s: number
  cpu_pct: number
  record_us_per_req: number
  frame_ms: number
  frames_per_s: number
  socket_bytes_per_s: number
  redis_bytes_per_s: number
  events_seen_per_s: number
  events_sampled_per_s: number
  sampling: {
    on: boolean
    every: number
    threshold_rps: number
    rps: number
    since: string | null
  }
  memory: {
    entities: number
    callers: number
    downs: number
    bytes: number
    process_rss?: number
    process_heap_used?: number
  }
  watchers: number
}
interface Loaded {
  migrated: boolean
  settings: Settings
  usage: Usage | null
}
interface Draft {
  snapshots_days: string
  scheduled_days: string
  notebooks_days: string
  peak: boolean
  every_hours: string
  sample_above_rps: string
}

const EVERY_OPTIONS = [
  { value: '0', label: 'Not on a schedule' },
  { value: '1', label: 'Every hour' },
  { value: '2', label: 'Every 2 hours' },
  { value: '3', label: 'Every 3 hours' },
  { value: '4', label: 'Every 4 hours' },
  { value: '6', label: 'Every 6 hours' },
  { value: '8', label: 'Every 8 hours' },
  { value: '12', label: 'Every 12 hours' },
  { value: '24', label: 'Once a day' }
]

function toDraft(s: Settings): Draft {
  return {
    snapshots_days: String(s.retention.snapshots_days),
    scheduled_days: String(s.retention.scheduled_days),
    notebooks_days: String(s.retention.notebooks_days),
    peak: s.schedule.peak,
    every_hours: String(s.schedule.every_hours),
    sample_above_rps: String(s.overhead.sample_above_rps)
  }
}
const whole = (v: string): number | null => {
  const t = v.trim()
  if (!/^\d+$/.test(t)) return null
  return Number(t)
}

/** What the map costs, in plain words (pure). */
export function costLine(o: Overhead): string {
  const cpu = o.cpu_pct < 0.05 ? 'under 0.1%' : `${o.cpu_pct}%`
  return `${cpu} of one core, ${fmtBytes(o.memory.bytes)} of memory`
}
export function samplingLine(o: Overhead): string {
  if (!o.sampling.on) {
    return o.sampling.threshold_rps > 0
      ? `Ticker shows every event (sampling starts above ${o.sampling.threshold_rps} req/s)`
      : 'Ticker shows every event (sampling is off)'
  }
  return `Ticker thinned to 1 event in ${o.sampling.every} (${o.sampling.rps} req/s is over ${o.sampling.threshold_rps})`
}
function fmtBytes(n: number): string {
  return formatFileSize(Math.round(n))
}

function UsageLine({ row }: { row: UsageRow | undefined }) {
  if (!row) return null
  return (
    <span className='text-[11.5px] text-[var(--tm-muted)] tabular-nums'>
      {row.n.toLocaleString('en-US')} kept · {fmtBytes(row.bytes)}
    </span>
  )
}

function Fig({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className='min-w-0 bg-[var(--tm-card)] px-2.5 py-1.5' data-tip={hint}>
      <div className='text-[11.5px] text-[var(--tm-muted)]'>{label}</div>
      <div className='truncate text-[13px] font-medium tabular-nums'>{value}</div>
    </div>
  )
}

export function MapSettings() {
  const frozen = useFrozenSnapshotId()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const q = useQuery({
    queryKey: ['traffic-map', 'map-settings'],
    queryFn: async () => (await api.get('/traffic-map/map-settings')).data.data as Loaded,
    enabled: open && !frozen,
    retry: false
  })
  const live = useQuery({
    queryKey: ['traffic-map', 'overhead'],
    queryFn: async () => (await api.get('/traffic-map/overhead')).data.data as Overhead,
    enabled: open && !frozen,
    refetchInterval: open ? 5000 : false,
    retry: false
  })
  const settings = q.data?.settings
  useEffect(() => {
    if (settings) setDraft(toDraft(settings))
  }, [settings])
  if (frozen) return null

  const d = draft
  const days = d
    ? ([d.snapshots_days, d.scheduled_days, d.notebooks_days, d.sample_above_rps] as string[])
    : []
  const invalid = !d || days.some((v) => whole(v) === null)
  const dirty = !!(d && settings && JSON.stringify(d) !== JSON.stringify(toDraft(settings)))

  const save = async () => {
    if (!d || invalid) return
    setBusy(true)
    try {
      await api.patch('/traffic-map/map-settings', {
        retention: {
          snapshots_days: whole(d.snapshots_days),
          scheduled_days: whole(d.scheduled_days),
          notebooks_days: whole(d.notebooks_days)
        },
        schedule: { peak: d.peak, every_hours: Number(d.every_hours) },
        overhead: { sample_above_rps: whole(d.sample_above_rps) }
      })
      toast.success('Map settings saved')
      await qc.invalidateQueries({ queryKey: ['traffic-map', 'map-settings'] })
      await qc.invalidateQueries({ queryKey: ['traffic-map', 'overhead'] })
    } catch (e) {
      toast.error(errorOf(e))
    } finally {
      setBusy(false)
    }
  }

  const o = live.data
  const set = (patch: Partial<Draft>) => setDraft((cur) => (cur ? { ...cur, ...patch } : cur))
  const keepRow = (
    id: string,
    label: string,
    hint: string,
    key: 'snapshots_days' | 'scheduled_days' | 'notebooks_days',
    row: UsageRow | undefined
  ) => (
    <div className='flex items-center justify-between gap-3 py-1'>
      <div className='min-w-0'>
        <label htmlFor={id} className='block text-[12.5px] text-[var(--tm-fg)]'>
          {label}
        </label>
        <span className='block text-[11.5px] text-[var(--tm-muted)]'>{hint}</span>
        <UsageLine row={row} />
      </div>
      <div className='flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--tm-muted)]'>
        <input
          id={id}
          inputMode='numeric'
          className={cn(INPUT, 'w-16 text-right tabular-nums')}
          value={d?.[key] ?? ''}
          onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)}
          aria-invalid={d ? whole(d[key]) === null : false}
        />
        days
      </div>
    </div>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-map-settings'
          className={cn(BTN, o?.sampling.on && 'border-[var(--tm-update)] text-[var(--tm-update)]')}
          aria-haspopup='dialog'
          data-tip='Retention, scheduled snapshots and what the map costs'
        >
          <Gauge className='h-3.5 w-3.5' aria-hidden='true' />
          Map data
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='traffic-map max-h-[80vh] w-[460px] max-w-[calc(100vw-32px)] overflow-y-auto border-[var(--tm-line)] bg-[var(--tm-card)] p-0 text-[var(--tm-fg)]'
        data-tm-map-settings=''
      >
        <div className='border-b border-[var(--tm-line-2)] px-3.5 py-2.5'>
          <h3 className='text-[13px] font-semibold'>Map data and cost</h3>
          <p className='mt-0.5 text-[11.5px] text-[var(--tm-muted)]'>
            How long the map keeps what it saves, when it saves by itself, and what watching it
            costs this API.
          </p>
        </div>

        <div className='border-b border-[var(--tm-line-2)] px-3.5 py-3'>
          <h4 className='mb-1.5 text-[12px] font-medium text-[var(--tm-muted)]'>
            What the map costs (last minute)
          </h4>
          {!o ? (
            <p className='text-[12px] text-[var(--tm-muted)]'>
              {live.isError ? 'The cost is not available here.' : 'Measuring…'}
            </p>
          ) : (
            <>
              <div className='grid grid-cols-3 gap-px overflow-hidden rounded-md border border-[var(--tm-line)] bg-[var(--tm-line)]'>
                <Fig
                  label='CPU'
                  value={`${o.cpu_ms_per_s} ms/s`}
                  hint={`${o.cpu_pct}% of one core — recording requests (${o.record_us_per_req} µs each) and building frames (${o.frame_ms} ms each)`}
                />
                <Fig
                  label='Memory (estimate)'
                  value={fmtBytes(o.memory.bytes)}
                  hint={`${o.memory.entities} nodes, ${o.memory.callers} callers, ${o.memory.downs} downstream${o.memory.process_rss != null ? `; the whole process holds ${fmtBytes(o.memory.process_rss)}` : ''}`}
                />
                <Fig
                  label='To browsers'
                  value={`${fmtBytes(o.socket_bytes_per_s)}/s`}
                  hint={`${o.watchers} open ${o.watchers === 1 ? 'tab' : 'tabs'} watching, measured on every fourth frame`}
                />
                <Fig label='Redis relay' value={`${fmtBytes(o.redis_bytes_per_s)}/s`} />
                <Fig
                  label='Requests'
                  value={`${o.req_per_s}/s`}
                  hint='Requests this process recorded, averaged over the last minute'
                />
                <Fig
                  label='Ticker events'
                  value={`${o.events_seen_per_s}/s`}
                  hint={`${o.events_sampled_per_s} a second left out by sampling`}
                />
              </div>
              <p
                className={cn(
                  'mt-1.5 text-[12px]',
                  o.sampling.on ? 'font-medium text-[var(--tm-update)]' : 'text-[var(--tm-fg-2)]'
                )}
                data-tm-sampling={o.sampling.on ? 'on' : 'off'}
              >
                {costLine(o)}. {samplingLine(o)}.
              </p>
            </>
          )}
          {d && (
            <div className='mt-2 flex items-center justify-between gap-3'>
              <label htmlFor='tm-sample-rps' className='text-[12.5px]'>
                Thin the ticker above
                <span className='block text-[11.5px] text-[var(--tm-muted)]'>
                  Counts, errors and the canvas stay exact. 0 never samples.
                </span>
              </label>
              <div className='flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--tm-muted)]'>
                <input
                  id='tm-sample-rps'
                  inputMode='numeric'
                  className={cn(INPUT, 'w-20 text-right tabular-nums')}
                  value={d.sample_above_rps}
                  onChange={(e) => set({ sample_above_rps: e.target.value })}
                  aria-invalid={whole(d.sample_above_rps) === null}
                />
                req/s
              </div>
            </div>
          )}
        </div>

        {q.isError || (q.isLoading && !q.data) ? (
          <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
            {q.isError ? 'Settings are not available here.' : 'Loading…'}
          </p>
        ) : (
          d && (
            <>
              <div className='border-b border-[var(--tm-line-2)] px-3.5 py-3'>
                <h4 className='mb-1.5 text-[12px] font-medium text-[var(--tm-muted)]'>
                  Snapshots taken by themselves
                </h4>
                <label className='flex items-start gap-2 text-[12.5px]'>
                  <input
                    type='checkbox'
                    className='mt-0.5 accent-[var(--tm-accent)]'
                    checked={d.peak}
                    onChange={(e) => set({ peak: e.target.checked })}
                  />
                  <span>
                    At each day's busiest minute
                    <span className='block text-[11.5px] text-[var(--tm-muted)]'>
                      Taken a few minutes after the peak, so ordinary days can be compared.
                    </span>
                  </span>
                </label>
                <div className='mt-2 flex items-center justify-between gap-3'>
                  <span className='text-[12.5px]'>And on a schedule</span>
                  <SimpleSelect
                    value={d.every_hours}
                    onChange={(v) => set({ every_hours: v })}
                    options={EVERY_OPTIONS}
                    ariaLabel='Snapshot schedule'
                    className='h-7 w-[170px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
                  />
                </div>
              </div>

              <div className='px-3.5 py-3'>
                <h4 className='mb-1 text-[12px] font-medium text-[var(--tm-muted)]'>Keep for</h4>
                {keepRow(
                  'tm-keep-snapshots',
                  'Shared snapshots',
                  '0 keeps them until someone deletes them',
                  'snapshots_days',
                  q.data?.usage?.snapshots
                )}
                {keepRow(
                  'tm-keep-scheduled',
                  'Peak and scheduled snapshots',
                  '0 keeps them for ever',
                  'scheduled_days',
                  q.data?.usage?.scheduled
                )}
                {keepRow(
                  'tm-keep-notebooks',
                  'Investigation notebooks',
                  'Counted from the last time one was saved; 0 keeps them',
                  'notebooks_days',
                  q.data?.usage?.notebooks
                )}
                <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
                  Recordings of the map are saved to your computer or attached to an issue, not kept
                  here.
                </p>
              </div>

              {!q.data?.migrated && (
                <p className='border-t border-[var(--tm-line-2)] px-3.5 py-2 text-[12px] text-[var(--tm-update)]'>
                  These settings need a database update that has not run here yet, so they show
                  their defaults and cannot be saved.
                </p>
              )}
              <div className='flex items-center justify-end gap-2 border-t border-[var(--tm-line-2)] px-3.5 py-2.5'>
                <button
                  type='button'
                  className={BTN}
                  disabled={!dirty || busy}
                  onClick={() => settings && setDraft(toDraft(settings))}
                >
                  Reset
                </button>
                <button
                  type='button'
                  className={cn(
                    BTN,
                    'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                  )}
                  disabled={!dirty || invalid || busy || !q.data?.migrated}
                  onClick={() => void save()}
                  data-tm-map-settings-save=''
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          )
        )}
      </PopoverContent>
    </Popover>
  )
}

register(toolbarItems, { id: 'map-settings', order: 95, slot: 'menu', Component: MapSettings })

/** The strip tile: the map's CPU share and whether the ticker is being sampled. */
export function MapCostTile() {
  const { data } = useTmRoute<Overhead>(['overhead-tile'], '/overhead', 10_000)
  const o = isObj(data) && isObj(data.sampling) ? (data as Overhead) : null
  return (
    <StripCell
      label='Map cost'
      value={o ? (o.cpu_pct < 0.05 ? '<0.1' : String(o.cpu_pct)) : '—'}
      unit='% of a core'
      tone={o?.sampling.on ? 'warn' : undefined}
      testId='tm-strip-map-cost'
    >
      <span className='truncate tabular-nums'>
        {o
          ? `${fmtBytes(o.socket_bytes_per_s)}/s to browsers · ${fmtBytes(o.redis_bytes_per_s)}/s Redis`
          : '—'}
      </span>
      <span className='truncate' data-tm-strip-sampling={o?.sampling.on ? 'on' : 'off'}>
        {o ? (o.sampling.on ? `Ticker 1 in ${o.sampling.every}` : 'Ticker shows every event') : '—'}
      </span>
    </StripCell>
  )
}
register(stripTiles, { id: 'map-cost', order: 13, Component: inMapOnly(MapCostTile) })
