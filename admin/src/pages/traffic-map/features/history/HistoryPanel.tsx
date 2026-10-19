/**
 * The History panel under the map: Time-lapse (#2183, with people online #2249), Jobs against
 * peaks (#2165) and Search (#2175), plus the switch for the optional minute history (#2228).
 * Nothing is read until a tab is opened.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { TwoClickButton } from '../ops-common'
import { errorOf, Note } from '../shared'
import { HistorySearch } from './HistorySearch'
import { JobsPeaks } from './JobsPeaks'
import { type HistoryTab, historyStore, type MinuteSettingsBody, useHistoryState } from './shared'
import { Timelapse } from './Timelapse'

const TABS: Array<{ id: HistoryTab; label: string }> = [
  { id: 'timelapse', label: 'Time-lapse' },
  { id: 'jobs', label: 'Jobs against peaks' },
  { id: 'search', label: 'Search' }
]
const KEEP = [7, 14, 30, 60, 90].map((d) => ({ value: String(d), label: `keep ${d} days` }))

function MinuteHistorySwitch() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['traffic-map', 'history', 'settings'],
    queryFn: async () =>
      ((await api.get('/traffic-map/history/settings'))?.data?.data ??
        null) as MinuteSettingsBody | null,
    staleTime: 60_000
  })
  const save = useMutation({
    mutationFn: async (patch: Partial<MinuteSettingsBody['settings']>) =>
      ((await api.put('/traffic-map/history/settings', patch))?.data?.data ??
        null) as MinuteSettingsBody | null,
    onSuccess: (d) => {
      if (d) qc.setQueryData(['traffic-map', 'history', 'settings'], d)
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'history', 'timelapse'] })
    }
  })
  const d = q.data
  if (!d || d.cloud) return null
  const s = d.settings
  // #2544 — the telemetry stack keeps the map's minutes for 13 months: say so, and offer to stop
  // the database copy (never turned off for anyone).
  if (d.stack)
    return (
      <div
        className='flex flex-wrap items-center justify-end gap-1.5 text-[11.5px]'
        data-tm-minute-history={s.enabled ? 'on' : 'off'}
        data-tm-minute-history-stack=''
      >
        <span className='text-[var(--tm-muted)]'>
          Traffic history is kept for 13 months on the telemetry stack
          {s.enabled ? ', so the minute history in this database isn’t needed.' : '.'}
        </span>
        {s.enabled && (
          <TwoClickButton
            id='tm-minute-toggle'
            label='Turn off'
            armedLabel='Click again to stop recording'
            busy={save.isPending}
            onConfirm={() => save.mutate({ enabled: false })}
          />
        )}
        {save.isError && <Note tone='error'>{errorOf(save.error)}</Note>}
      </div>
    )
  const held = d.coverage.first
    ? `holds minutes since ${new Date(d.coverage.first).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : s.enabled
      ? 'the first minutes land within two minutes (on the instance that runs scheduled jobs)'
      : 'off'
  return (
    <div
      className='flex flex-wrap items-center justify-end gap-1.5 text-[11.5px]'
      data-tm-minute-history={s.enabled ? 'on' : 'off'}
    >
      <span className='text-[var(--tm-muted)]'>
        Minute history: <span className='text-[var(--tm-fg-2)]'>{held}</span>
      </span>
      {s.enabled && (
        <SimpleSelect
          value={String(s.retention_days)}
          onChange={(v) => save.mutate({ retention_days: Number(v) })}
          options={
            KEEP.some((k) => k.value === String(s.retention_days))
              ? KEEP
              : [
                  ...KEEP,
                  { value: String(s.retention_days), label: `keep ${s.retention_days} days` }
                ]
          }
          ariaLabel='Keep minute history for'
          triggerProps={{ id: 'tm-minute-keep' }}
          className='h-6 w-auto min-w-[104px] border-[var(--tm-line)] bg-[var(--tm-card)] px-1.5 text-[11.5px]'
        />
      )}
      <TwoClickButton
        id='tm-minute-toggle'
        label={s.enabled ? 'Turn off' : 'Turn on'}
        armedLabel={
          s.enabled ? 'Click again to stop recording' : 'Click again to record every minute'
        }
        busy={save.isPending}
        onConfirm={() => save.mutate({ enabled: !s.enabled })}
      />
      {save.isError && <Note tone='error'>{errorOf(save.error)}</Note>}
    </div>
  )
}

export function HistoryPanel() {
  const st = useHistoryState()
  return (
    <section
      id='tm-history'
      aria-label='History'
      className='min-w-0 scroll-mt-4 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)] min-[1100px]:col-span-2'
    >
      <div className='flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='flex min-w-0 flex-wrap items-center gap-3'>
          <h2 className='inline-flex items-center gap-1.5 text-[13px] font-semibold'>
            <History className='h-3.5 w-3.5 text-[var(--tm-muted)]' aria-hidden='true' />
            History
          </h2>
          <div className='flex flex-wrap gap-1' role='tablist' aria-label='History views'>
            {TABS.map((t) => (
              <button
                key={t.id}
                type='button'
                role='tab'
                aria-selected={st.tab === t.id}
                id={`tm-history-tab-${t.id}`}
                onClick={() => historyStore.set({ tab: st.tab === t.id ? null : t.id })}
                className={cn(
                  'rounded-md px-2 py-[3px] text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                  st.tab === t.id
                    ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                    : 'text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <MinuteHistorySwitch />
      </div>
      {st.tab === null ? (
        <p className='px-3.5 py-2.5 text-[12px] text-[var(--tm-muted)]'>
          Play back the last day or week, see scheduled jobs against the day&apos;s peaks, or search
          the request log. Pick a view to load it.
        </p>
      ) : st.tab === 'timelapse' ? (
        <Timelapse />
      ) : st.tab === 'jobs' ? (
        <JobsPeaks />
      ) : (
        <HistorySearch />
      )}
    </section>
  )
}
