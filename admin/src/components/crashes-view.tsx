import { useQuery } from '@tanstack/react-query'
import { Bug, ChevronDown, ChevronRight, PlayCircle, Sparkles, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { MonCombobox } from '@/components/filter-combobox'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/** Mirrors the API's CrashRow / CrashList (api services/crash-tracking.ts). */
export interface CrashRow {
  id: number
  title: string
  message: string
  screen: string
  app: string
  release: string
  kind: 'render' | 'error' | 'rejection'
  status: string
  severity: string
  count: number
  first_seen: string | null
  last_seen: string | null
  people: number
  people_names: string[]
  new_in: string | null
  seen_in: string | null
  frame: string | null
  stack: string | null
  resolved_stack: string | null
  recording_id: string | null
  recording_offset_ms: number | null
  alerted_at: string | null
  legacy: boolean
}

export interface CrashList {
  crashes: CrashRow[]
  releases: string[]
  screens: string[]
  apps: string[]
  since_release: Array<{
    app: string
    release: string
    crashes: number
    hits: number
    new: number
    people: number
  }>
  truncated: boolean
}

const KIND_LABEL: Record<CrashRow['kind'], string> = {
  render: 'Screen crashed',
  error: 'Uncaught error',
  rejection: 'Unhandled promise'
}

const DAYS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' }
]

function replayHref(c: Pick<CrashRow, 'recording_id' | 'recording_offset_ms'>): string | null {
  if (!c.recording_id) return null
  return `/analytics/replays?recording=${c.recording_id}${c.recording_offset_ms != null ? `&t=${c.recording_offset_ms}` : ''}`
}

/**
 * Issue Log → Crashes (admins): front-end crashes grouped by signature + screen + release, the
 * release they are new in, how many times and how many people, the stack (source-mapped for the
 * admin when the build's maps are on the server) and the replay of the moment. Filters by
 * release, screen and app; the strip on top is what crashed since each app's current release.
 */
export function CrashesView({ onOpen }: { onOpen: (id: number) => void }) {
  const [days, setDays] = useState('14')
  const [release, setRelease] = useState('')
  const [screen, setScreen] = useState('')
  const [app, setApp] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)

  const qs = new URLSearchParams({ days })
  if (onlyOpen) qs.set('status', 'open')
  const { data, isLoading, isError, refetch } = useQuery<CrashList>({
    queryKey: ['issues', 'crashes', qs.toString()],
    queryFn: () =>
      api.get<{ data: CrashList }>(`/issues/crashes?${qs.toString()}`).then((r) => r.data.data),
    staleTime: 30_000
  })

  // Filters apply locally: the facets stay complete whatever is picked.
  const rows = useMemo(
    () =>
      (data?.crashes ?? []).filter(
        (c) =>
          (!release || c.release === release) &&
          (!screen || c.screen === screen) &&
          (!app || c.app === app)
      ),
    [data, release, screen, app]
  )

  return (
    <div className='flex flex-col'>
      {data && data.since_release.length > 0 && (
        <div
          data-crash-since
          className='grid shrink-0 grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-px overflow-hidden border-b border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
        >
          {data.since_release.map((s) => (
            <button
              key={s.app}
              type='button'
              onClick={() => {
                setApp(s.app)
                setRelease(s.release)
              }}
              className='flex flex-col gap-1 bg-white px-6 py-3 text-left hover:bg-slate-50 dark:bg-card dark:hover:bg-muted/40'
            >
              <span className='text-[11px] text-muted-foreground'>
                Since <span className='font-mono'>{s.app}</span>{' '}
                <span className='font-mono font-medium text-slate-700 dark:text-foreground'>
                  {s.release}
                </span>
              </span>
              <span className='flex items-baseline gap-3 text-[13px] text-slate-800 dark:text-foreground'>
                <span>
                  <span className='text-lg font-semibold tabular-nums'>{s.crashes}</span>{' '}
                  {s.crashes === 1 ? 'crash' : 'crashes'}
                </span>
                <span
                  className={cn(
                    'tabular-nums',
                    s.new > 0
                      ? 'font-medium text-rose-700 dark:text-rose-300'
                      : 'text-muted-foreground'
                  )}
                >
                  {s.new} new
                </span>
                <span className='tabular-nums text-muted-foreground'>
                  {s.hits} {s.hits === 1 ? 'time' : 'times'} · {s.people}{' '}
                  {s.people === 1 ? 'person' : 'people'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-6 py-2.5 dark:border-border'>
        <MonCombobox
          value={days}
          onChange={(v) => setDays(v || '14')}
          options={DAYS}
          placeholder='Last 14 days'
          className='w-36'
        />
        <MonCombobox
          value={release}
          onChange={setRelease}
          options={(data?.releases ?? []).map((r) => ({ value: r, label: r }))}
          placeholder='All releases'
          className='w-36 font-mono'
        />
        <MonCombobox
          value={screen}
          onChange={setScreen}
          options={(data?.screens ?? []).map((r) => ({ value: r, label: r }))}
          placeholder='All screens'
          className='w-56 font-mono'
        />
        {(data?.apps.length ?? 0) > 1 && (
          <MonCombobox
            value={app}
            onChange={setApp}
            options={(data?.apps ?? []).map((r) => ({ value: r, label: r }))}
            placeholder='All apps'
            className='w-32 font-mono'
          />
        )}
        <label className='ml-1 flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
          <input
            type='checkbox'
            checked={onlyOpen}
            onChange={(e) => setOnlyOpen(e.target.checked)}
            className='h-3.5 w-3.5'
          />
          Open only
        </label>
        {(release || screen || app) && (
          <Button
            variant='ghost'
            size='sm'
            className='h-8 text-[11px]'
            onClick={() => {
              setRelease('')
              setScreen('')
              setApp('')
            }}
          >
            Clear
          </Button>
        )}
        <span className='ml-auto text-[11px] tabular-nums text-muted-foreground'>
          {rows.length} {rows.length === 1 ? 'crash' : 'crashes'}
          {data?.truncated ? ' (newest 1,000)' : ''}
        </span>
      </div>

      {isLoading ? (
        <div className='space-y-2 p-6'>
          {[1, 2, 3].map((i) => (
            <div key={i} className='h-12 animate-pulse rounded-lg bg-muted' />
          ))}
        </div>
      ) : isError ? (
        <div className='flex flex-col items-center gap-2 py-16 text-center'>
          <p className='text-sm font-medium'>Crashes could not be loaded</p>
          <Button size='sm' variant='outline' onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-24 text-center'>
          <Bug className='mb-3 h-10 w-10 text-muted-foreground/40' />
          <p className='mb-1 text-sm font-medium'>No crashes</p>
          <p className='max-w-sm text-xs text-muted-foreground'>
            {release || screen || app
              ? 'Nothing crashed with these filters. Clear them to see every release.'
              : 'Screens that crash, uncaught errors and unhandled promises in the admin and other front ends show up here, grouped by release.'}
          </p>
        </div>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border'>
          {rows.map((c) => {
            const open = expanded === c.id
            const replay = replayHref(c)
            return (
              <li key={c.id} data-crash-row={c.id}>
                <button
                  type='button'
                  onClick={() => setExpanded(open ? null : c.id)}
                  aria-expanded={open}
                  className='flex w-full flex-wrap items-start gap-x-3 gap-y-1.5 px-6 py-3 text-left hover:bg-slate-50 sm:flex-nowrap dark:hover:bg-muted/30'
                >
                  {open ? (
                    <ChevronDown className='mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground' />
                  ) : (
                    <ChevronRight className='mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground' />
                  )}
                  <span className='min-w-0 flex-1'>
                    <span className='flex flex-wrap items-center gap-2'>
                      {c.new_in ? (
                        <span className='inline-flex items-center gap-1 rounded border border-rose-500/25 bg-rose-500/10 px-1.5 py-px text-[10.5px] font-medium text-rose-700 dark:text-rose-300'>
                          <Sparkles className='h-3 w-3' />
                          New in {c.new_in}
                        </span>
                      ) : c.seen_in ? (
                        <span className='rounded border border-slate-500/20 bg-slate-500/10 px-1.5 py-px text-[10.5px] text-slate-600 dark:text-muted-foreground'>
                          Seen since {c.seen_in}
                        </span>
                      ) : null}
                      <span className='min-w-0 font-mono text-[12.5px] font-medium text-slate-800 [overflow-wrap:anywhere] dark:text-foreground'>
                        {c.message}
                      </span>
                    </span>
                    <span className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground'>
                      <span className='font-mono'>{c.screen}</span>
                      <span className='font-mono'>
                        {c.app} {c.release}
                      </span>
                      <span>{KIND_LABEL[c.kind]}</span>
                      {c.status !== 'open' && (
                        <span className='capitalize'>{c.status.replace('_', ' ')}</span>
                      )}
                    </span>
                  </span>
                  <span className='ml-6 flex shrink-0 items-center gap-4 text-[11.5px] tabular-nums text-slate-600 sm:ml-0 dark:text-muted-foreground'>
                    <span title='Times'>{c.count}×</span>
                    <span className='inline-flex items-center gap-1' title='People affected'>
                      <Users className='h-3 w-3' />
                      {c.people}
                    </span>
                    {replay && (
                      <PlayCircle className='h-3.5 w-3.5 text-nvr-cyan' aria-label='Has a replay' />
                    )}
                    <span className='text-right sm:w-20'>
                      {c.last_seen ? formatRelative(c.last_seen) : '—'}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className='space-y-3 bg-slate-50 px-6 pb-4 pt-1 pl-12 dark:bg-background/60'>
                    <div className='flex flex-wrap items-center gap-2'>
                      {replay && (
                        <Link
                          to={replay}
                          className='inline-flex items-center gap-1.5 rounded-md bg-nvr-cyan px-2.5 py-1 text-[12px] font-semibold text-white hover:brightness-110'
                        >
                          <PlayCircle className='h-3.5 w-3.5' />
                          Watch the replay
                        </Link>
                      )}
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-7 text-[12px]'
                        onClick={() => onOpen(c.id)}
                      >
                        Open issue #{c.id}
                      </Button>
                      {c.alerted_at && (
                        <span className='text-[11px] text-muted-foreground'>
                          Admins were told {formatRelative(c.alerted_at)}
                        </span>
                      )}
                    </div>
                    <dl className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-[12px] dark:border-border dark:bg-border sm:grid-cols-4'>
                      {[
                        ['First seen', c.first_seen ? formatRelative(c.first_seen) : '—'],
                        ['Last seen', c.last_seen ? formatRelative(c.last_seen) : '—'],
                        ['Times', String(c.count)],
                        ['People', String(c.people)]
                      ].map(([k, v]) => (
                        <div key={k} className='bg-white px-3 py-2 dark:bg-card'>
                          <dt className='text-[10.5px] text-muted-foreground'>{k}</dt>
                          <dd className='tabular-nums text-slate-800 dark:text-foreground'>{v}</dd>
                        </div>
                      ))}
                    </dl>
                    {c.people_names.length > 0 && (
                      <p className='text-[12px] text-slate-700 dark:text-foreground'>
                        <span className='text-muted-foreground'>Affected: </span>
                        {c.people_names.join(', ')}
                        {c.people > c.people_names.length
                          ? ` and ${c.people - c.people_names.length} more`
                          : ''}
                      </p>
                    )}
                    {c.resolved_stack && (
                      <div>
                        <p className='mb-1 text-[11px] font-medium text-muted-foreground'>
                          Source-mapped stack
                        </p>
                        <pre className='max-h-56 overflow-auto rounded-md border border-slate-200 bg-white p-2 text-[11px] leading-relaxed dark:border-border dark:bg-card'>
                          {c.resolved_stack}
                        </pre>
                      </div>
                    )}
                    {c.stack && (
                      <div>
                        <p className='mb-1 text-[11px] font-medium text-muted-foreground'>
                          {c.resolved_stack ? 'Stack as the browser saw it' : 'Stack'}
                        </p>
                        <pre className='max-h-56 overflow-auto rounded-md border border-slate-200 bg-white p-2 text-[11px] leading-relaxed dark:border-border dark:bg-card'>
                          {c.stack}
                        </pre>
                      </div>
                    )}
                    {c.legacy && (
                      <p className='text-[11px] text-muted-foreground'>
                        Filed before crashes were grouped by release; its release is read from its
                        hits.
                      </p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
