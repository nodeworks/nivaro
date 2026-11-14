import { ErrorNotice, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Play, RefreshCw, Search, Square, Unlink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative } from '@/lib/utils'

/**
 * Data Integrity → Orphans: rows whose links point at records that no longer exist (api
 * routes/orphans.ts). Every link the metadata claims is listed once it is seen in the live
 * schema; a full sweep counts all of them in the background, one link can be recounted on
 * its own, and the repairs (empty the link / delete a link-table row) are previewed, run as
 * you through the items service and logged.
 */

type Kind = 'm2o' | 'o2m' | 'junction' | 'file'

interface OrphanCheckRow {
  key: string
  kind: Kind
  kind_label: string
  child: string
  field: string
  fk: string
  parent: string
  enforced: boolean
  can_clear: boolean
  can_delete: boolean
  clear_refusal: string | null
  delete_refusal: string | null
}
interface CheckResult {
  key: string
  orphans: number | null
  samples: Array<{ id: string; fk_value: string }>
  ms: number
  at: number
  enforced?: boolean
  error?: string
}
interface SweepState {
  id: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  started_at: number
  finished_at: number | null
  total: number
  done: number
  current: string | null
  results: Record<string, CheckResult>
  error?: string
}
interface OrphanList {
  checks: OrphanCheckRow[]
  skipped: Array<{ label: string; reason: string }>
  sweep: SweepState | null
}
interface Preview {
  key: string
  action: 'clear' | 'delete'
  ids: string[]
  gone: number
  plan_hash: string
  sentence: string
}

const KIND_FILTERS: Array<{ id: 'all' | 'found' | Kind; label: string }> = [
  { id: 'found', label: 'With orphans' },
  { id: 'all', label: 'All links' },
  { id: 'm2o', label: 'Links' },
  { id: 'o2m', label: 'Children' },
  { id: 'junction', label: 'Link tables' },
  { id: 'file', label: 'Files' }
]

export function OrphansTab() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const selected = params.get('link')
  const [filter, setFilter] = useState<'all' | 'found' | Kind>('found')
  const [q, setQ] = useState('')

  const list = useQuery({
    queryKey: ['orphans', 'list'],
    queryFn: () => api.get<{ data: OrphanList }>('/orphans').then((r) => r.data.data),
    refetchInterval: (query) => (query.state.data?.sweep?.status === 'running' ? 3000 : false)
  })
  const sweep = list.data?.sweep ?? null
  const running = sweep?.status === 'running'

  const start = useMutation({
    mutationFn: () => api.post('/orphans/sweep'),
    onSuccess: () => {
      toast.success('Sweep started — it runs in the background; you can leave this page')
      void qc.invalidateQueries({ queryKey: ['orphans', 'list'] })
    },
    onError: (e) => toastError(e, 'Could not start the sweep')
  })
  const stop = useMutation({
    mutationFn: () => api.post('/orphans/sweep/cancel'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['orphans', 'list'] }),
    onError: (e) => toastError(e, 'Could not stop the sweep')
  })

  const rows = useMemo(() => {
    const checks = list.data?.checks ?? []
    const needle = q.trim().toLowerCase()
    return checks
      .map((c) => ({ check: c, result: sweep?.results[c.key] ?? null }))
      .filter(({ check, result }) => {
        if (
          needle &&
          !`${check.child}.${check.field} ${check.parent}`.toLowerCase().includes(needle)
        )
          return false
        if (filter === 'found') return (result?.orphans ?? 0) > 0 || !!result?.error
        if (filter === 'all') return true
        return check.kind === filter
      })
      .sort(
        (a, b) =>
          (b.result?.orphans ?? -1) - (a.result?.orphans ?? -1) ||
          a.check.key.localeCompare(b.check.key)
      )
  }, [list.data, sweep, filter, q])

  const totals = useMemo(() => {
    const res = Object.values(sweep?.results ?? {})
    return {
      links: res.filter((r) => (r.orphans ?? 0) > 0).length,
      rows: res.reduce((n, r) => n + (r.orphans ?? 0), 0),
      failed: res.filter((r) => r.error).length
    }
  }, [sweep])

  const current = list.data?.checks.find((c) => c.key === selected) ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col' data-orphans>
      <HubToolbar
        description='Rows whose links point at records that no longer exist: links to a deleted record, children whose parent is gone, link-table rows with a side missing, and files that were removed.'
        actions={
          running ? (
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12px]'
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              data-orphans-stop
            >
              <Square className='mr-1.5 h-3.5 w-3.5' /> Stop sweep
            </Button>
          ) : (
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
              onClick={() => start.mutate()}
              disabled={start.isPending || !list.data}
              data-orphans-sweep
            >
              {start.isPending ? (
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
              ) : (
                <Play className='mr-1.5 h-3.5 w-3.5' />
              )}
              {sweep ? 'Sweep again' : 'Run a full sweep'}
            </Button>
          )
        }
      >
        <SweepLine sweep={sweep} totals={totals} checks={list.data?.checks.length ?? 0} />
      </HubToolbar>

      {list.isError ? (
        <div className='p-6'>
          <ErrorNotice
            error={list.error}
            what='the link list'
            onRetry={() => void list.refetch()}
          />
        </div>
      ) : (
        <div className='flex flex-1 min-h-0 flex-col overflow-hidden md:flex-row'>
          <aside className='flex max-h-[45vh] shrink-0 flex-col border-b border-slate-200 bg-white md:max-h-none md:w-[340px] md:border-b-0 md:border-r dark:border-border dark:bg-card'>
            <div className='space-y-2 border-b border-slate-200 p-3 dark:border-border'>
              <div className='relative'>
                <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder='Find a table or field'
                  aria-label='Find a table or field'
                  className='h-8 pl-7 text-[12px]'
                />
              </div>
              <fieldset className='flex flex-wrap gap-1'>
                <legend className='sr-only'>Show</legend>
                {KIND_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type='button'
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    data-orphans-filter={f.id}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      filter === f.id
                        ? 'border-nvr-cyan/60 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                        : 'border-slate-200 text-slate-500 hover:text-slate-800 dark:border-border dark:text-muted-foreground dark:hover:text-foreground'
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </fieldset>
            </div>
            <div className='flex-1 overflow-y-auto'>
              {list.isLoading ? (
                <div className='space-y-2 p-3'>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className='h-10 w-full' />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <p className='p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {filter === 'found'
                    ? sweep
                      ? 'No orphans found in the last sweep.'
                      : 'No sweep has run yet. Run one, or show all links and check one.'
                    : 'No links match.'}
                </p>
              ) : (
                <ul data-orphans-list>
                  {rows.map(({ check, result }) => (
                    <li key={check.key}>
                      <button
                        type='button'
                        onClick={() => {
                          const next = new URLSearchParams(params)
                          next.set('link', check.key)
                          setParams(next, { replace: true })
                        }}
                        data-orphans-link={check.key}
                        aria-current={selected === check.key ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left dark:border-border/60',
                          selected === check.key ? 'bg-accent' : 'hover:bg-muted'
                        )}
                      >
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                            {check.child}.{check.field}
                          </span>
                          <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
                            → {check.parent} · {check.kind_label}
                          </span>
                        </span>
                        <CountPill
                          result={result}
                          enforced={check.enforced}
                          running={sweep?.current === check.key}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {(list.data?.skipped.length ?? 0) > 0 && (
                <details
                  className='border-t border-slate-200 px-3 py-2 dark:border-border'
                  data-orphans-skipped
                >
                  <summary className='cursor-pointer text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {list.data?.skipped.length} links not checked
                  </summary>
                  <ul className='mt-1.5 space-y-1'>
                    {list.data?.skipped.map((s) => (
                      <li key={`${s.label}|${s.reason}`} className='text-[11px] leading-snug'>
                        <span className='font-medium text-slate-700 dark:text-foreground'>
                          {s.label}
                        </span>
                        <span className='text-slate-500 dark:text-muted-foreground'>
                          {' '}
                          — {s.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </aside>
          <section className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
            {current ? (
              <CheckDetail
                key={current.key}
                check={current}
                stored={sweep?.results[current.key] ?? null}
              />
            ) : (
              <div className='flex h-full min-h-[200px] flex-col items-center justify-center text-center'>
                <Unlink className='mb-2 h-6 w-6 text-slate-300 dark:text-slate-600' />
                <p className='text-[13px] font-medium text-slate-700 dark:text-foreground'>
                  Pick a link
                </p>
                <p className='mt-1 max-w-[46ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
                  See the rows that point at nothing, open them, and empty the link or remove the
                  link-table row.
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function SweepLine({
  sweep,
  totals,
  checks
}: {
  sweep: SweepState | null
  totals: { links: number; rows: number; failed: number }
  checks: number
}) {
  if (!sweep)
    return (
      <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        {formatNumber(checks)} links to check. A full sweep reads every one in the background.
      </p>
    )
  if (sweep.status === 'running') {
    const pct = sweep.total ? Math.round((sweep.done / sweep.total) * 100) : 0
    return (
      <div className='mt-2 flex items-center gap-3 text-[11.5px]' data-orphans-progress={pct}>
        <span
          role='progressbar'
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label='Sweep progress'
          className='h-1.5 w-40 overflow-hidden rounded-full bg-slate-200 dark:bg-muted'
        >
          <span className='block h-full bg-nvr-cyan' style={{ width: `${pct}%` }} />
        </span>
        <span className='text-slate-600 dark:text-muted-foreground'>
          {sweep.done} of {sweep.total} links
          {sweep.current ? ` · now ${sweep.current.split('>')[0]}` : ''}
        </span>
      </div>
    )
  }
  const when = sweep.finished_at ? formatRelative(new Date(sweep.finished_at)) : ''
  return (
    <p
      className='mt-1.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'
      data-orphans-summary
    >
      {sweep.status === 'cancelled'
        ? `Stopped ${when} after ${sweep.done} of ${sweep.total} links. `
        : sweep.status === 'error'
          ? `${sweep.error ?? 'The sweep stopped'} ${when}. `
          : `Swept ${when}. `}
      <strong className='font-semibold text-slate-800 dark:text-foreground'>
        {formatNumber(totals.rows)} orphan rows
      </strong>{' '}
      across {totals.links} {totals.links === 1 ? 'link' : 'links'}
      {totals.failed > 0
        ? `; ${totals.failed} ${totals.failed === 1 ? 'link' : 'links'} could not be read in time`
        : ''}
      .
    </p>
  )
}

function CountPill({
  result,
  enforced,
  running
}: {
  result: CheckResult | null
  enforced: boolean
  running: boolean
}) {
  if (running) return <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-slate-400' />
  if (enforced)
    return (
      <span
        className='shrink-0 text-[10.5px] text-slate-400'
        data-tip='The database enforces this link, so it cannot point at nothing'
      >
        enforced
      </span>
    )
  if (!result) return <span className='shrink-0 text-[11px] text-slate-400'>—</span>
  if (result.error)
    return (
      <span
        className='shrink-0 text-[10.5px] text-amber-700 dark:text-amber-400'
        data-tip={result.error}
      >
        not read
      </span>
    )
  if (!result.orphans)
    return <span className='shrink-0 text-[11px] text-emerald-700 dark:text-emerald-400'>0</span>
  return (
    <span className='shrink-0 rounded-full bg-amber-100 px-1.5 py-px text-[11px] font-semibold tabular-nums text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>
      {formatNumber(result.orphans)}
    </span>
  )
}

function CheckDetail({ check, stored }: { check: OrphanCheckRow; stored: CheckResult | null }) {
  const qc = useQueryClient()
  const live = useQuery({
    queryKey: ['orphans', 'check', check.key],
    queryFn: () =>
      api
        .get<{ data: CheckResult }>('/orphans/check', { params: { key: check.key } })
        .then((r) => r.data.data),
    enabled: false,
    retry: false
  })
  const result = live.data ?? stored
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<Preview | null>(null)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(t)
  }, [armed])

  const ask = useMutation({
    mutationFn: (action: 'clear' | 'delete') =>
      api
        .post<{ data: Preview }>('/orphans/preview', {
          key: check.key,
          action,
          ids: picked.size > 0 ? [...picked] : undefined
        })
        .then((r) => r.data.data),
    onSuccess: (p) => {
      setPreview(p)
      setArmed(false)
    },
    onError: (e) => toastError(e, 'Could not prepare the change')
  })
  const apply = useMutation({
    mutationFn: (p: Preview) =>
      api
        .post<{
          data: {
            done: number
            failed: Array<{ id: string; reason: string }>
            already_fixed: number
          }
        }>('/orphans/apply', { key: p.key, action: p.action, ids: p.ids, plan_hash: p.plan_hash })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      const extra = [
        d.failed.length ? `${d.failed.length} refused` : '',
        d.already_fixed ? `${d.already_fixed} already fixed` : ''
      ]
        .filter(Boolean)
        .join(', ')
      toast.success(`${d.done} row(s) fixed${extra ? ` (${extra})` : ''}`)
      setPreview(null)
      setPicked(new Set())
      void live.refetch()
      void qc.invalidateQueries({ queryKey: ['orphans', 'list'] })
    },
    onError: (e) => {
      toastError(e, 'Could not apply the change')
      setPreview(null)
    }
  })

  const samples = result?.samples ?? []
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className='space-y-4' data-orphans-detail={check.key}>
      <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0'>
            <p className='text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
              {check.kind_label}
            </p>
            <h2 className='mt-0.5 break-all text-[15px] font-semibold text-slate-900 dark:text-foreground'>
              {check.child}.{check.field}
              <span className='font-normal text-slate-400'> → </span>
              {check.parent}
            </h2>
            {check.fk !== check.field && (
              <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                Stored in column {check.fk}
              </p>
            )}
          </div>
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12px]'
            onClick={() => void live.refetch()}
            disabled={live.isFetching || check.enforced}
            data-orphans-recount
          >
            {live.isFetching ? (
              <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
            ) : (
              <RefreshCw className='mr-1.5 h-3.5 w-3.5' />
            )}
            Count now
          </Button>
        </div>
        <div className='mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
          <Meta
            label='Orphan rows'
            value={
              check.enforced
                ? 'None possible'
                : result?.orphans != null
                  ? formatNumber(result.orphans)
                  : (result?.error ?? 'Not counted yet')
            }
          />
          <Meta label='Counted' value={result ? formatRelative(new Date(result.at)) : '—'} />
          <Meta
            label='Took'
            value={result && !result.enforced ? `${formatNumber(result.ms)} ms` : '—'}
          />
        </div>
        {check.enforced && (
          <p className='mt-3 text-[12px] text-slate-600 dark:text-muted-foreground'>
            The database itself enforces this link (a foreign key), so a row here can never point at
            a missing {check.parent} record.
          </p>
        )}
        {live.isError && (
          <div className='mt-3'>
            <ErrorNotice error={live.error} what='this link' onRetry={() => void live.refetch()} />
          </div>
        )}
      </div>

      {samples.length > 0 && (
        <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-border'>
            <p className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
              Newest {samples.length} of {formatNumber(result?.orphans ?? samples.length)}
              {picked.size > 0 && (
                <span className='ml-2 font-normal text-slate-500'>· {picked.size} picked</span>
              )}
            </p>
            <div className='flex flex-wrap gap-2'>
              {check.kind !== 'junction' && (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  disabled={!check.can_clear || ask.isPending}
                  data-tip={check.clear_refusal ?? undefined}
                  onClick={() => ask.mutate('clear')}
                  data-orphans-action='clear'
                >
                  Empty the link…
                </Button>
              )}
              {check.kind === 'junction' && (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  disabled={!check.can_delete || ask.isPending}
                  data-tip={check.delete_refusal ?? undefined}
                  onClick={() => ask.mutate('delete')}
                  data-orphans-action='delete'
                >
                  Remove link rows…
                </Button>
              )}
            </div>
          </div>
          {preview && (
            <div
              className='border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-500/10'
              data-orphans-preview={preview.action}
            >
              <p className='text-[12.5px] text-slate-800 dark:text-foreground'>
                {preview.sentence}
              </p>
              {preview.gone > 0 && (
                <p className='mt-1 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                  {preview.gone} of the rows you picked were fixed meanwhile and are left alone.
                </p>
              )}
              <div className='mt-2 flex gap-2'>
                <Button
                  size='sm'
                  className={cn(
                    'h-7 text-[12px] text-white',
                    armed ? 'bg-red-600 hover:bg-red-700' : 'bg-nvr-cyan hover:bg-nvr-cyan/90'
                  )}
                  disabled={preview.ids.length === 0 || apply.isPending}
                  onClick={() => {
                    if (!armed) setArmed(true)
                    else {
                      setArmed(false)
                      apply.mutate(preview)
                    }
                  }}
                  data-orphans-apply={armed ? 'armed' : ''}
                >
                  {apply.isPending && <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />}
                  {armed
                    ? `Yes, ${preview.action === 'clear' ? 'empty' : 'remove'} ${preview.ids.length}`
                    : `${preview.action === 'clear' ? 'Empty' : 'Remove'} ${preview.ids.length} row(s)`}
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 text-[12px]'
                  onClick={() => setPreview(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <div className='overflow-x-auto'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-left text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                  <th className='w-8 px-4 py-2'>
                    <span className='sr-only'>Pick</span>
                  </th>
                  <th className='px-2 py-2 font-medium'>Row</th>
                  <th className='px-2 py-2 font-medium'>{check.field} points at</th>
                  <th className='px-4 py-2' />
                </tr>
              </thead>
              <tbody>
                {samples.map((s) => (
                  <tr
                    key={s.id}
                    className='border-b border-slate-100 last:border-0 dark:border-border/60'
                    data-orphans-row={s.id}
                  >
                    <td className='px-4 py-1.5'>
                      <input
                        type='checkbox'
                        checked={picked.has(s.id)}
                        onChange={() => toggle(s.id)}
                        aria-label={`Pick row ${s.id}`}
                        className='h-3.5 w-3.5 accent-[var(--nvr-cyan,#00ceff)]'
                      />
                    </td>
                    <td className='px-2 py-1.5 font-mono text-[11.5px] text-slate-800 dark:text-foreground'>
                      {s.id}
                    </td>
                    <td className='px-2 py-1.5 font-mono text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                      {s.fk_value}{' '}
                      <span className='font-sans text-[10.5px] text-amber-700 dark:text-amber-400'>
                        missing
                      </span>
                    </td>
                    <td className='px-4 py-1.5 text-right'>
                      <Link
                        to={`/collections/${encodeURIComponent(check.child)}/${encodeURIComponent(s.id)}`}
                        target='_blank'
                        className='inline-flex items-center gap-1 text-[11.5px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
                      >
                        Open <ExternalLink className='h-3 w-3' />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className='border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
            With nothing picked, an action covers the newest {Math.min(200, result?.orphans ?? 0)}{' '}
            rows. Every change goes through the record&apos;s own save as you, with history, and is
            logged.
          </p>
        </div>
      )}
      {result && !check.enforced && result.orphans === 0 && (
        <p className='text-[12.5px] text-emerald-700 dark:text-emerald-400' data-orphans-clean>
          Every {check.child} row with a {check.field} points at a {check.parent} record that
          exists.
        </p>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <p className='text-[10.5px] uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
        {label}
      </p>
      <p className='mt-0.5 truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
        {value}
      </p>
    </div>
  )
}
