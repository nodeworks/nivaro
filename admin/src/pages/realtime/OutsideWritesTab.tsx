import { toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative } from '@/lib/utils'

interface Settings {
  enabled: boolean
  interval_seconds: number
  mode: 'viewed' | 'chosen'
  collections: string[]
  env: boolean | null
  cloud: boolean
}

interface Row {
  collection: string
  watchable: boolean
  reason: string | null
  reason_code: string | null
  ts_column: string | null
  /** How it is watched: change tracking, the changed-at column, or null (cannot be). */
  method: 'change-tracking' | 'timestamp' | null
  viewers: number
  chosen: boolean
  state: 'watching' | 'starting' | 'refused' | 'live-off' | 'error' | null
  state_reason: string | null
  last_caught_at: number | null
  caught_24h: number
  deduped_24h: number
}

interface Data {
  settings: Settings
  limits: { min_interval: number; max_interval: number; max_watched: number }
  last_tick: { at: number; watched: number; caught: number; deduped: number; ms: number } | null
  collections: Row[]
}

const KEY = ['realtime', 'outside-writes']

const INTERVALS = [5, 10, 15, 30, 60, 120, 300]

/**
 * Realtime → Outside writes: the safety net for records changed outside the app without an
 * announcement (procedures, scripts). Its setting, which collections it watches and why not, and
 * per collection the rows it caught in 24 hours — each one a write still made without announcing.
 */
export function OutsideWritesTab() {
  const qc = useQueryClient()
  const q = useQuery<Data>({
    queryKey: KEY,
    queryFn: () => api.get('/realtime/outside-writes').then((r) => r.data.data),
    refetchInterval: 15_000
  })
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) =>
      api.patch('/realtime/outside-writes', patch).then((r) => r.data.data as Data),
    onSuccess: (d) => qc.setQueryData(KEY, d),
    onError: (e) => toastError(e, 'Couldn’t save the setting')
  })
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState<'relevant' | 'all'>('relevant')
  const [search, setSearch] = useState('')

  const d = q.data
  const rows = useMemo(() => {
    if (!d) return []
    const s = search.trim().toLowerCase()
    return d.collections
      .filter((r) => (s ? r.collection.toLowerCase().includes(s) : true))
      .filter(
        (r) =>
          filter === 'all' ||
          s !== '' ||
          r.caught_24h > 0 ||
          r.state != null ||
          r.chosen ||
          r.viewers > 0
      )
      .sort(
        (a, b) =>
          b.caught_24h - a.caught_24h ||
          Number(b.state != null) - Number(a.state != null) ||
          b.viewers - a.viewers ||
          a.collection.localeCompare(b.collection)
      )
  }, [d, filter, search])

  if (q.isLoading)
    return (
      <div className='grid gap-3' role='status' aria-label='Loading outside writes'>
        <Skeleton className='h-20 rounded-lg' />
        <Skeleton className='h-48 rounded-lg' />
      </div>
    )
  if (!d)
    return (
      <p className='text-[13px] text-red-600 dark:text-red-400'>
        Couldn’t load the outside-write watcher.
      </p>
    )

  const s = d.settings
  const caughtTotal = d.collections.reduce((n, r) => n + r.caught_24h, 0)
  const watchingNow = d.collections.filter((r) => r.state === 'watching').length
  const locked = s.cloud || s.env != null
  const chosen = new Set(s.collections.map((c) => c.toLowerCase()))
  const addable = d.collections
    .filter((r) => r.watchable && !chosen.has(r.collection.toLowerCase()))
    .map((r) => ({ value: r.collection, label: r.collection }))

  return (
    <div className='space-y-5'>
      <p className='max-w-[76ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Changes made in the app reach open screens at once. Procedures and scripts that write
        straight to the tables only do when they announce it. This watcher looks every few seconds
        at the collections people have open for rows whose changed-at time moved, and tells their
        screens. Each row it catches is a write still made without announcing —{' '}
        <Link
          to='/database/sql-checks'
          className='text-nvr-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          SQL checks
        </Link>{' '}
        (check “Writes without announcing”) proposes the fix for the procedure.
      </p>

      <section
        aria-label='Watcher setting'
        className='grid gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      >
        <div className='flex flex-wrap items-center gap-x-6 gap-y-3'>
          <label
            htmlFor='outside-writes-on'
            className='flex items-center gap-2 text-[13px] font-medium'
          >
            <Switch
              id='outside-writes-on'
              checked={s.enabled}
              disabled={locked || save.isPending}
              onCheckedChange={(v) => save.mutate({ enabled: v })}
              aria-label='Watch for writes made outside the app'
            />
            {s.enabled ? 'Watching' : 'Off'}
          </label>
          <div className='flex items-center gap-2 text-[12.5px] text-muted-foreground'>
            Look every
            <SimpleSelect
              value={String(s.interval_seconds)}
              onChange={(v) => save.mutate({ interval_seconds: Number(v) })}
              options={[...new Set([...INTERVALS, s.interval_seconds].sort((a, b) => a - b))].map(
                (n) => ({
                  value: String(n),
                  label: n < 60 ? `${n} seconds` : `${n / 60} minute${n === 60 ? '' : 's'}`
                })
              )}
              ariaLabel='How often to look'
              className='h-8 w-[130px] text-[12.5px]'
              disabled={!s.enabled || locked}
            />
          </div>
          <div className='flex items-center gap-2 text-[12.5px] text-muted-foreground'>
            Watch
            <SimpleSelect
              value={s.mode}
              onChange={(v) => save.mutate({ mode: v as Settings['mode'] })}
              options={[
                { value: 'viewed', label: 'What people have open' },
                { value: 'chosen', label: 'Chosen collections' }
              ]}
              ariaLabel='Which collections to watch'
              className='h-8 w-[210px] text-[12.5px]'
              disabled={!s.enabled || locked}
            />
          </div>
        </div>
        {s.cloud ? (
          <p className='m-0 text-[12px] text-muted-foreground'>Not available on hosted plans.</p>
        ) : s.env != null ? (
          <p className='m-0 text-[12px] text-muted-foreground'>
            Set by the server (OUTSIDE_WRITE_WATCH={s.env ? 'on' : 'off'}); change it there.
          </p>
        ) : null}
        {s.mode === 'chosen' && (
          <div className='grid gap-2'>
            <div className='flex flex-wrap gap-1.5'>
              {s.collections.length === 0 && (
                <span className='text-[12px] text-muted-foreground'>
                  No collections chosen yet — nothing is watched.
                </span>
              )}
              {s.collections.map((c) => (
                <span
                  key={c}
                  className='inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[12px] dark:border-border dark:bg-muted/40'
                >
                  {c}
                  <button
                    type='button'
                    aria-label={`Stop watching ${c}`}
                    disabled={locked || save.isPending}
                    onClick={() =>
                      save.mutate({ collections: s.collections.filter((x) => x !== c) })
                    }
                    className='rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                  >
                    <X className='h-3 w-3' aria-hidden='true' />
                  </button>
                </span>
              ))}
            </div>
            {addable.length > 0 && s.collections.length < d.limits.max_watched && (
              <SimpleSelect
                value={draft}
                onChange={(v) => {
                  if (!v) return
                  save.mutate({ collections: [...s.collections, v] })
                  setDraft('')
                }}
                options={[{ value: '', label: 'Add a collection…' }, ...addable]}
                ariaLabel='Add a collection to watch'
                className='h-8 w-[240px] text-[12.5px]'
                disabled={locked}
              />
            )}
            <p className='m-0 text-[11.5px] text-muted-foreground'>
              Only collections that can be watched (change tracking, or an index on their changed-at
              column) can be chosen; up to {d.limits.max_watched}.
            </p>
          </div>
        )}
        <p className='m-0 text-[12px] text-muted-foreground'>
          {d.last_tick
            ? `Last look ${formatRelative(new Date(d.last_tick.at).toISOString())}: ${d.last_tick.watched} ${d.last_tick.watched === 1 ? 'collection' : 'collections'} in ${d.last_tick.ms} ms. `
            : 'No look yet on this server (looks run where scheduled jobs run). '}
          {watchingNow > 0 && `${watchingNow} watched now. `}
          {formatNumber(caughtTotal)} {caughtTotal === 1 ? 'row' : 'rows'} caught in 24 hours.
        </p>
      </section>

      <section aria-label='Collections' className='grid gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative'>
            <Search
              className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground'
              aria-hidden='true'
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Find a collection'
              aria-label='Find a collection'
              className='h-8 w-[220px] pl-8 text-[12.5px]'
            />
          </div>
          <SimpleSelect
            value={filter}
            onChange={(v) => setFilter(v as 'relevant' | 'all')}
            options={[
              { value: 'relevant', label: 'Open, watched or caught' },
              { value: 'all', label: 'Every collection' }
            ]}
            ariaLabel='Which collections to list'
            className='h-8 w-[200px] text-[12.5px]'
          />
        </div>
        {rows.length === 0 ? (
          <p className='rounded-lg border border-dashed border-slate-200 p-4 text-[12.5px] text-muted-foreground dark:border-border'>
            {search
              ? 'No collection by that name.'
              : 'Nobody has a collection open right now, and nothing was caught today.'}
          </p>
        ) : (
          <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border dark:bg-muted/40'>
                  <th className='px-3 py-2 font-medium'>Collection</th>
                  <th className='px-3 py-2 font-medium'>How</th>
                  <th className='px-3 py-2 font-medium'>Now</th>
                  <th className='px-3 py-2 text-right font-medium'>Caught, 24 h</th>
                  <th className='px-3 py-2 font-medium'>Last caught</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 bg-white dark:divide-border/60 dark:bg-card'>
                {rows.map((r) => (
                  <tr key={r.collection} className='align-top'>
                    <td className='px-3 py-2 font-medium'>
                      {r.collection}
                      {r.viewers > 0 && (
                        <span className='ml-1.5 font-normal text-muted-foreground'>
                          · {r.viewers} open
                        </span>
                      )}
                    </td>
                    <td className='px-3 py-2'>
                      {r.method === 'change-tracking' ? (
                        <span>
                          Change tracking
                          <span className='block text-[11px] text-muted-foreground'>
                            adds, changes and removals
                          </span>
                        </span>
                      ) : r.watchable ? (
                        <span>
                          Changed-at column{' '}
                          <span className='font-mono text-[11.5px]'>{r.ts_column}</span>
                          <span className='block text-[11px] text-muted-foreground'>
                            adds and changes
                          </span>
                        </span>
                      ) : (
                        <span className='block max-w-[44ch] text-muted-foreground'>{r.reason}</span>
                      )}
                    </td>
                    <td className='px-3 py-2'>
                      <StateText row={r} />
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums',
                        r.caught_24h > 0 && 'font-semibold text-amber-700 dark:text-amber-300'
                      )}
                    >
                      {r.caught_24h ? formatNumber(r.caught_24h) : '—'}
                      {r.deduped_24h > 0 && (
                        <span
                          className='block text-[11px] font-normal text-muted-foreground'
                          data-tip='Rows the app had already announced: skipped, so no screen re-read them twice'
                        >
                          {formatNumber(r.deduped_24h)} already told
                        </span>
                      )}
                    </td>
                    <td className='px-3 py-2 text-muted-foreground'>
                      {r.last_caught_at
                        ? formatRelative(new Date(r.last_caught_at).toISOString())
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function StateText({ row }: { row: Row }) {
  const map: Record<string, { label: string; tone: string }> = {
    watching: { label: 'Watching', tone: 'text-emerald-700 dark:text-emerald-400' },
    starting: { label: 'Starting', tone: 'text-muted-foreground' },
    refused: { label: 'Can’t watch', tone: 'text-muted-foreground' },
    'live-off': { label: 'Realtime off', tone: 'text-muted-foreground' },
    error: { label: 'Look failed', tone: 'text-red-600 dark:text-red-400' }
  }
  if (!row.state) return <span className='text-muted-foreground'>—</span>
  const m = map[row.state]
  return (
    <span className={m.tone} data-tip={row.state_reason ?? undefined}>
      {m.label}
    </span>
  )
}
