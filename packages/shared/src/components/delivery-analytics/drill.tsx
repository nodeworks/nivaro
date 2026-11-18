import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, Download, ExternalLink, ListFilter, Mail, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useApiFetchConfig, useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { ErrorDetails } from '../ErrorNotice'
import { QueryErrorState } from '../QueryErrorState'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import type {
  DaCond,
  DaMailLeaf,
  DaMailRow,
  DaMuteRow,
  DaNotificationLeaf,
  DaNotificationRow,
  DaRowsPage,
  DaSplit,
  DaSummary
} from './types'
import { FilterPicker, OutcomeChip, ShareBar } from './ui'
import {
  clearDrill,
  type DrillState,
  drillQuery,
  encodeCond,
  fmtInt,
  fmtRange,
  fmtWhen,
  mins,
  readDrill,
  type SetParams,
  titleize
} from './url'

const SOURCE_NOUN = { n: 'notifications', m: 'emails', x: 'mutes' } as const

/** Link helpers shared by the leaves: record, person page, Mail log row. */
function useLinks() {
  const nav = useNavigation()
  const items = useItemNavigation()
  const go = (href: string) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    nav.navigate(href)
  }
  return {
    record: (collection: string | null, item: string | null) =>
      collection && item && !/^(nivaro|directus)_/i.test(collection)
        ? items.urlFor({ collection, itemId: item })
        : null,
    person: (id: string | null | undefined) =>
      id ? (nav.userUrl ? nav.userUrl(id) : `/users/${id.toLowerCase()}`) : null,
    mailLog: (id: number) =>
      nav.consoleUrl ? nav.consoleUrl(`/delivery?id=${id}`) : `/delivery?id=${id}`,
    go
  }
}

function A({
  href,
  children,
  onClick
}: {
  href: string | null
  children: ReactNode
  onClick?: (e: React.MouseEvent) => void
}) {
  if (!href) return <>{children}</>
  return (
    <a
      href={href}
      onClick={onClick}
      className='inline-flex items-center gap-1 rounded-sm font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'
    >
      {children}
    </a>
  )
}

/** The panel for whatever the URL says is open: a drill list, a split, or one leaf. */
export function DrillSheet({
  params,
  setParams,
  summary,
  labels
}: {
  params: URLSearchParams
  setParams: SetParams
  summary: DaSummary | undefined
  /** Names for dimension values the page already knows (people, senders…). */
  labels: Map<string, string>
}) {
  const drill = readDrill(params)
  const open = !!drill
  const close = () => setParams(clearDrill)
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side='right'
        data-da-drill=''
        aria-describedby={undefined}
        className='flex w-[96vw] flex-col gap-0 p-0 sm:max-w-[860px]'
      >
        {drill && !summary && (
          <div className='space-y-2 p-5' aria-busy='true'>
            <SheetTitle className='sr-only'>Loading</SheetTitle>
            <Skeleton className='h-5 w-1/2' />
            <Skeleton className='h-40 w-full' />
          </div>
        )}
        {drill && summary && drill.leaf && (
          <LeafView drill={drill} setParams={setParams} summary={summary} />
        )}
        {drill && summary && !drill.leaf && (
          <DrillList
            drill={drill}
            params={params}
            setParams={setParams}
            summary={summary}
            labels={labels}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function useDimensions() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['delivery-analytics', 'dimensions'],
    queryFn: () =>
      client
        .request<{ data: Record<string, Array<{ key: string; label: string }>> }>(
          get('/delivery-analytics/dimensions')
        )
        .then((r) => r.data),
    staleTime: Number.POSITIVE_INFINITY
  })
}

function condText(
  [dim, values]: DaCond,
  dims: Array<{ key: string; label: string }> | undefined,
  labels: Map<string, string>
) {
  const name = dims?.find((d) => d.key === dim)?.label ?? titleize(dim.replace(/^ch[._]/, ''))
  const vs = values.map((v) => labels.get(`${dim}=${v}`) ?? labels.get(v) ?? titleize(v))
  return `${name}: ${vs.length > 2 ? `${vs.slice(0, 2).join(', ')} +${vs.length - 2}` : vs.join(', ')}`
}

function DrillList({
  drill,
  params,
  setParams,
  summary,
  labels
}: {
  drill: DrillState
  params: URLSearchParams
  setParams: SetParams
  summary: DaSummary
  labels: Map<string, string>
}) {
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const dims = useDimensions()
  const sourceDims = dims.data?.[drill.source]
  const win = { ...summary.window, asof: summary.asof, acted_hours: summary.acted_hours }
  const base = drillQuery(params, drill, win)
  const sort = drill.sort
  const baseKey = base.toString()
  const rows = useInfiniteQuery({
    queryKey: ['delivery-analytics', 'rows', baseKey, sort],
    initialPageParam: '0',
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams(base)
      q.set('cursor', String(pageParam))
      q.set('limit', '50')
      if (sort === 'ttr') q.set('sort', 'ttr')
      if (sort === 'time-asc') q.set('dir', 'asc')
      return client
        .request<{ data: DaRowsPage }>(get(`/delivery-analytics/rows?${q.toString()}`))
        .then((r) => r.data)
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 60_000
  })
  const split = useQuery({
    queryKey: ['delivery-analytics', 'split', baseKey, drill.splitBy],
    enabled: !!drill.splitBy,
    queryFn: () => {
      const q = new URLSearchParams(base)
      q.set('by', String(drill.splitBy))
      return client
        .request<{ data: DaSplit }>(get(`/delivery-analytics/split?${q.toString()}`))
        .then((r) => r.data)
    },
    staleTime: 60_000
  })
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const total = rows.data?.pages[0]?.total
  const all = useMemo(() => rows.data?.pages.flatMap((p) => p.rows) ?? [], [rows.data])
  const noun = SOURCE_NOUN[drill.source]
  const windowText = drill.prev
    ? `previous period, ${fmtRange(summary.window.prev_from, summary.window.prev_to)}`
    : drill.source === 'x'
      ? 'standing mutes'
      : fmtRange(summary.window.from, summary.window.to)

  const removeCond = (i: number) =>
    setParams((p) => {
      const kept = p.getAll('dw').filter((_, j) => j !== i)
      p.delete('dw')
      for (const k of kept) p.append('dw', k)
      p.delete('dby')
    })
  const addCond = (c: DaCond, label: string) =>
    setParams((p) => {
      p.append('dw', encodeCond(c))
      p.delete('dby')
      const dl = p.get('dl')
      p.set('dl', dl ? `${dl} · ${label}` : label)
    })
  const setSort = (s: DrillState['sort']) =>
    setParams(
      (p) => {
        if (s === 'time') p.delete('ds')
        else p.set('ds', s)
      },
      { replace: true }
    )
  const download = async () => {
    setDownloading(true)
    setDownloadFailed(false)
    try {
      const q = new URLSearchParams(base)
      q.set('format', 'csv')
      if (sort === 'ttr') q.set('sort', 'ttr')
      if (sort === 'time-asc') q.set('dir', 'asc')
      const resp = await fetch(`${fetchCfg.apiBase}/delivery-analytics/rows?${q}`, {
        headers: fetchCfg.authHeaders,
        credentials: fetchCfg.credentials
      })
      if (!resp.ok) throw new Error(String(resp.status))
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `delivery-${noun}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      // The rows on screen are still there; the button says it failed.
      setDownloadFailed(true)
    } finally {
      setDownloading(false)
    }
  }
  return (
    <>
      <div className='shrink-0 border-b border-slate-200 px-5 pb-3 pt-4 pr-12 dark:border-border'>
        <SheetTitle className='truncate text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          {drill.label ?? `${titleize(noun)}`}
        </SheetTitle>
        <SheetDescription className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          <span
            data-da-drill-total={total ?? ''}
            className='font-medium tabular-nums text-slate-800 dark:text-foreground'
          >
            {total == null ? '…' : fmtInt(total)}
          </span>{' '}
          {total === 1 ? noun.replace(/s$/, '') : noun} · {windowText}
        </SheetDescription>
        {drill.where.length > 0 && (
          <ul className='mt-2 flex flex-wrap gap-1.5' aria-label='Conditions'>
            {drill.where.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same condition may repeat; position is its identity
              <li key={`${c[0]}:${i}`}>
                <span className='inline-flex max-w-[320px] items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11.5px] text-slate-700 dark:border-border dark:bg-muted dark:text-foreground'>
                  <span className='truncate'>{condText(c, sourceDims, labels)}</span>
                  <button
                    type='button'
                    aria-label='Remove this condition'
                    data-tip='Remove this condition'
                    onClick={() => removeCond(i)}
                    className='rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-border dark:hover:text-foreground'
                  >
                    <X className='h-3 w-3' />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          {sourceDims && (
            <FilterPicker
              label='Break down by'
              allLabel='Nothing'
              value={drill.splitBy}
              options={sourceDims
                .filter((d) => !drill.where.some(([k]) => k === d.key))
                .map((d) => ({ value: d.key, label: d.label }))}
              onChange={(v) =>
                setParams((p) => {
                  if (v) p.set('dby', v)
                  else p.delete('dby')
                })
              }
            />
          )}
          <span className='flex-1' />
          {drill.source !== 'x' && (
            // biome-ignore lint/a11y/useSemanticElements: a toolbar toggle group, not a form fieldset
            <div
              className='inline-flex rounded-md border border-slate-200 p-0.5 text-[12px] dark:border-border'
              role='group'
              aria-label='Order'
            >
              {(
                [
                  ['time', 'Newest'],
                  ['time-asc', 'Oldest'],
                  ...(drill.source === 'n' ? [['ttr', 'Slowest read'] as const] : [])
                ] as Array<readonly [DrillState['sort'], string]>
              ).map(([k, l]) => (
                <button
                  key={k}
                  type='button'
                  aria-pressed={sort === k}
                  onClick={() => setSort(k)}
                  className={cn(
                    'rounded px-2 py-0.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                    sort === k
                      ? 'bg-slate-900 text-white dark:bg-nvr-cyan dark:text-[#172940]'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
          <button
            type='button'
            onClick={() => void download()}
            disabled={downloading || !total}
            data-tip={
              downloadFailed
                ? 'The file could not be made — try again'
                : 'Download these rows as CSV'
            }
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:text-foreground dark:hover:bg-muted'
          >
            <Download className='h-3.5 w-3.5' aria-hidden />
            {downloading ? 'Preparing…' : downloadFailed ? 'Try CSV again' : 'CSV'}
          </button>
        </div>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto bg-white dark:bg-background'>
        {drill.splitBy && (
          <SplitList
            split={split}
            onPick={(key, label) => {
              const by = String(drill.splitBy)
              addCond([by, [key]], label)
            }}
          />
        )}
        {rows.isLoading ? (
          <div className='space-y-2 p-5' aria-busy='true'>
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows
              <Skeleton key={i} className='h-9 w-full' />
            ))}
          </div>
        ) : rows.isError ? (
          <div className='p-5'>
            <QueryErrorState
              error={rows.error}
              what='these rows'
              onRetry={() => void rows.refetch()}
            />
          </div>
        ) : all.length === 0 ? (
          <p className='px-5 py-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Nothing here now. The rows may have changed since the figure was read — reload the page
            to recount.
          </p>
        ) : (
          <div className='px-5 py-4'>
            <RowsTable
              source={drill.source}
              rows={all}
              onOpen={(id) =>
                setParams((p) => {
                  p.set('leaf', `${drill.source}:${id}`)
                })
              }
            />
            <div className='mt-3 flex items-center justify-between text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              <span className='tabular-nums'>
                Showing {fmtInt(all.length)} of {fmtInt(total ?? all.length)}
              </span>
              {rows.hasNextPage && (
                <button
                  type='button'
                  onClick={() => void rows.fetchNextPage()}
                  disabled={rows.isFetchingNextPage}
                  className='rounded-md border border-slate-200 px-3 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-foreground dark:hover:bg-muted'
                >
                  {rows.isFetchingNextPage ? 'Loading…' : 'Load 50 more'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function SplitList({
  split,
  onPick
}: {
  split: ReturnType<typeof useQuery<DaSplit>>
  onPick: (key: string, label: string) => void
}) {
  if (split.isLoading)
    return (
      <div
        className='space-y-1.5 border-b border-slate-100 px-5 py-4 dark:border-border'
        aria-busy='true'
      >
        <Skeleton className='h-6 w-full' />
        <Skeleton className='h-6 w-5/6' />
        <Skeleton className='h-6 w-2/3' />
      </div>
    )
  if (split.isError || !split.data)
    return (
      <div className='border-b border-slate-100 px-5 py-4 dark:border-border'>
        <QueryErrorState
          error={split.error}
          what='this breakdown'
          onRetry={() => void split.refetch()}
        />
      </div>
    )
  const d = split.data
  const max = Math.max(1, ...d.rows.map((r) => r.cell.n))
  return (
    <section
      aria-label={`By ${d.label}`}
      className='border-b border-slate-100 bg-slate-50/60 px-5 py-3 dark:border-border dark:bg-muted/20'
    >
      <h4 className='mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
        <ListFilter className='h-3.5 w-3.5 text-slate-400' aria-hidden />
        By {d.label.toLowerCase()}
        <span className='font-normal text-slate-500 dark:text-muted-foreground'>
          — pick one to narrow the list
        </span>
      </h4>
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {d.rows.map((r) => (
          <li key={r.key}>
            <button
              type='button'
              data-da-split-row={r.cell.n}
              onClick={() => onPick(r.key, r.label)}
              className='grid w-full grid-cols-[minmax(0,1fr)_120px_64px] items-center gap-3 rounded px-1 py-1.5 text-left text-[12.5px] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted'
            >
              <span className='truncate text-slate-800 dark:text-foreground'>{r.label}</span>
              <ShareBar value={r.cell.n} max={max} />
              <span className='text-right tabular-nums text-slate-700 dark:text-foreground'>
                {fmtInt(r.cell.n)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {d.more && (
        <p className='mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
          The 50 largest are shown.
        </p>
      )}
    </section>
  )
}

const th =
  'whitespace-nowrap px-3 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide text-slate-500 dark:text-muted-foreground'
const td = 'px-3 py-2 align-top'

function RowsTable({
  source,
  rows,
  onOpen
}: {
  source: 'n' | 'm' | 'x'
  rows: DaRowsPage['rows']
  onOpen: (id: number) => void
}) {
  const links = useLinks()
  const rowProps = (id: number) =>
    source === 'x'
      ? {}
      : {
          tabIndex: 0,
          role: 'link',
          'aria-label': 'Open this row',
          onClick: () => onOpen(id),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen(id)
            }
          },
          className:
            'group cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:border-border/60 dark:hover:bg-muted/60'
        }
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
      <table className='w-full text-[12.5px]'>
        <thead className='border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'>
          {source === 'n' ? (
            <tr>
              <th className={th}>Sent</th>
              <th className={cn(th, 'hidden sm:table-cell')}>To</th>
              <th className={th}>Subject</th>
              <th className={cn(th, 'hidden md:table-cell')}>Channels</th>
              <th className={cn(th, 'text-right')}>Read</th>
              <th className='w-6' />
            </tr>
          ) : source === 'm' ? (
            <tr>
              <th className={th}>When</th>
              <th className={cn(th, 'hidden sm:table-cell')}>To</th>
              <th className={th}>Subject</th>
              <th className={th}>Outcome</th>
              <th className='w-6' />
            </tr>
          ) : (
            <tr>
              <th className={th}>Muted</th>
              <th className={th}>Person</th>
              <th className={th}>Record</th>
            </tr>
          )}
        </thead>
        <tbody className='text-slate-700 dark:text-foreground'>
          {source === 'n' &&
            (rows as DaNotificationRow[]).map((r) => (
              <tr key={r.id} data-da-row={r.id} {...rowProps(r.id)}>
                <td
                  className={cn(
                    td,
                    'whitespace-nowrap tabular-nums text-slate-500 dark:text-muted-foreground'
                  )}
                >
                  {fmtWhen(r.timestamp)}
                </td>
                <td className={cn(td, 'hidden max-w-[150px] truncate sm:table-cell')}>
                  {r.recipient_name ?? '–'}
                </td>
                <td className={cn(td, 'min-w-[160px]')}>
                  <span className='line-clamp-2 [overflow-wrap:anywhere]'>
                    {r.subject ?? '(no subject)'}
                  </span>
                  <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    <span className='sm:hidden'>To {r.recipient_name ?? 'nobody'} · </span>
                    {r.sender_name ? `from ${r.sender_name} · ` : ''}
                    {r.reason_label}
                  </span>
                </td>
                <td className={cn(td, 'hidden md:table-cell')}>
                  <span className='flex flex-wrap gap-1'>
                    {r.channels.length === 0 ? (
                      <span className='text-[11px] text-slate-400'>not recorded</span>
                    ) : (
                      r.channels.map((c) => (
                        <OutcomeChip key={c.channel} outcome={c.outcome}>
                          <span data-tip={c.label}>
                            {c.channel === 'inapp'
                              ? 'in-app'
                              : c.channel === 'sms'
                                ? 'SMS'
                                : c.channel}{' '}
                            {c.status.replace(/_/g, ' ')}
                          </span>
                        </OutcomeChip>
                      ))
                    )}
                  </span>
                </td>
                <td className={cn(td, 'whitespace-nowrap text-right tabular-nums')}>
                  {r.status === 'inbox' ? (
                    <span className='text-amber-700 dark:text-[#d4936a]'>Unread</span>
                  ) : r.ttr_min != null ? (
                    mins(r.ttr_min)
                  ) : (
                    <span className='text-slate-500 dark:text-muted-foreground'>Read</span>
                  )}
                </td>
                <td className='w-6 pr-2 pt-2.5 align-top'>
                  <ChevronRight
                    className='h-3.5 w-3.5 text-slate-300 group-hover:text-slate-500 dark:text-muted-foreground/50'
                    aria-hidden
                  />
                </td>
              </tr>
            ))}
          {source === 'm' &&
            (rows as DaMailRow[]).map((r) => (
              <tr key={r.id} data-da-row={r.id} {...rowProps(r.id)}>
                <td
                  className={cn(
                    td,
                    'whitespace-nowrap tabular-nums text-slate-500 dark:text-muted-foreground'
                  )}
                >
                  {fmtWhen(r.created_at)}
                </td>
                <td className={cn(td, 'hidden max-w-[180px] truncate sm:table-cell')}>
                  {r.to ?? '–'}
                </td>
                <td className={cn(td, 'min-w-[160px]')}>
                  <span className='line-clamp-2 [overflow-wrap:anywhere]'>
                    {r.subject ?? '(no subject)'}
                  </span>
                  <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                    <span className='sm:hidden'>To {r.to ?? 'nobody'}</span>
                    {r.template && <span className='hidden sm:inline'>{r.template}</span>}
                  </span>
                </td>
                <td className={td}>
                  <OutcomeChip outcome={r.outcome}>{r.reason_label}</OutcomeChip>
                </td>
                <td className='w-6 pr-2 pt-2.5 align-top'>
                  <ChevronRight
                    className='h-3.5 w-3.5 text-slate-300 group-hover:text-slate-500 dark:text-muted-foreground/50'
                    aria-hidden
                  />
                </td>
              </tr>
            ))}
          {source === 'x' &&
            (rows as DaMuteRow[]).map((r) => (
              <tr
                key={r.id}
                className='border-b border-slate-100 last:border-0 dark:border-border/60'
              >
                <td
                  className={cn(
                    td,
                    'whitespace-nowrap tabular-nums text-slate-500 dark:text-muted-foreground'
                  )}
                >
                  {fmtWhen(r.created_at)}
                </td>
                <td className={td}>
                  <A
                    href={links.person(r.user)}
                    onClick={
                      links.person(r.user) ? links.go(String(links.person(r.user))) : undefined
                    }
                  >
                    {r.user_name ?? 'Unknown person'}
                  </A>
                </td>
                <td className={td}>
                  {(() => {
                    const href = links.record(r.collection, r.item)
                    return (
                      <A href={href} onClick={href ? links.go(href) : undefined}>
                        {titleize(r.collection ?? '')} #{r.item}
                      </A>
                    )
                  })()}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Leaves ─────────────────────────────────────────────────────────────────

function LeafHeader({
  title,
  sub,
  onBack,
  backLabel
}: {
  title: string
  sub: ReactNode
  onBack: (() => void) | null
  backLabel: string
}) {
  return (
    <div className='shrink-0 border-b border-slate-200 px-5 pb-3.5 pt-4 pr-12 dark:border-border'>
      {onBack && (
        <button
          type='button'
          data-da-back=''
          onClick={onBack}
          className='mb-1.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] font-medium text-sky-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'
        >
          <ArrowLeft className='h-3 w-3' aria-hidden />
          {backLabel}
        </button>
      )}
      <SheetTitle className='line-clamp-2 text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
        {title}
      </SheetTitle>
      <SheetDescription className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
        {sub}
      </SheetDescription>
    </div>
  )
}

function Facts({ items }: { items: Array<{ k: string; v: ReactNode }> }) {
  return (
    <dl className='grid grid-cols-[minmax(110px,max-content)_1fr] gap-x-6 gap-y-1.5 text-[12.5px]'>
      {items.map(({ k, v }) => (
        <div key={k} className='contents'>
          <dt className='text-slate-500 dark:text-muted-foreground'>{k}</dt>
          <dd className='min-w-0 break-words text-slate-900 dark:text-foreground'>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className='mb-1.5 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
        {title}
      </h4>
      {children}
    </section>
  )
}

function LeafView({
  drill,
  setParams,
  summary
}: {
  drill: DrillState
  setParams: SetParams
  summary: DaSummary
}) {
  const leaf = drill.leaf as NonNullable<DrillState['leaf']>
  // Back to the list it came from; a leaf opened on its own closes the panel.
  const back =
    drill.where.length > 0 || drill.label ? () => setParams((p) => p.delete('leaf')) : null
  const backLabel = drill.label ? `Back to ${drill.label}` : 'Back'
  return leaf.source === 'n' ? (
    <NotificationLeafView
      id={leaf.id}
      onBack={back}
      backLabel={backLabel}
      summary={summary}
      setParams={setParams}
    />
  ) : (
    <MailLeafView id={leaf.id} onBack={back} backLabel={backLabel} />
  )
}

function LeafLoading() {
  return (
    <div className='space-y-3 p-5' aria-busy='true'>
      <SheetTitle className='sr-only'>Loading</SheetTitle>
      <Skeleton className='h-5 w-2/3' />
      <Skeleton className='h-24 w-full' />
      <Skeleton className='h-40 w-full' />
    </div>
  )
}

function NotificationLeafView({
  id,
  onBack,
  backLabel,
  summary,
  setParams
}: {
  id: number
  onBack: (() => void) | null
  backLabel: string
  summary: DaSummary
  setParams: SetParams
}) {
  const client = useNivaroClient()
  const links = useLinks()
  const q = useQuery({
    queryKey: ['delivery-analytics', 'leaf', 'n', id, summary.acted_hours],
    queryFn: () =>
      client
        .request<{ data: DaNotificationLeaf }>(
          get(`/delivery-analytics/notifications/${id}`, { acted_hours: summary.acted_hours })
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  if (q.isLoading) return <LeafLoading />
  if (q.isError || !q.data)
    return (
      <div className='p-5'>
        <SheetTitle className='sr-only'>Notification</SheetTitle>
        <QueryErrorState
          error={q.error}
          what='this notification'
          onRetry={() => void q.refetch()}
        />
      </div>
    )
  const n = q.data
  const record = links.record(n.collection, n.item)
  const recipient = links.person(n.recipient?.id)
  const sender = links.person(n.sender?.id)
  const ttr =
    n.read_at && n.timestamp
      ? (new Date(n.read_at).getTime() - new Date(n.timestamp).getTime()) / 60_000
      : null
  const windowOpen = new Date(n.acted.window_ends).getTime() > Date.now()
  return (
    <>
      <LeafHeader
        title={n.subject ?? '(no subject)'}
        sub={
          <>
            Notification #{n.id} · sent {fmtWhen(n.timestamp)}
          </>
        }
        onBack={onBack}
        backLabel={backLabel}
      />
      <div className='min-h-0 flex-1 space-y-5 overflow-y-auto bg-white p-5 dark:bg-background'>
        <Facts
          items={[
            {
              k: 'To',
              v: n.recipient ? (
                <>
                  <A href={recipient} onClick={recipient ? links.go(recipient) : undefined}>
                    {n.recipient.name}
                  </A>
                  <span className='text-slate-500 dark:text-muted-foreground'>
                    {[
                      n.recipient.role,
                      n.recipient.status && n.recipient.status !== 'active'
                        ? n.recipient.status
                        : null
                    ]
                      .filter(Boolean)
                      .map((x) => ` · ${x}`)
                      .join('')}
                  </span>
                </>
              ) : (
                'Nobody'
              )
            },
            {
              k: 'From',
              v: n.sender ? (
                <A href={sender} onClick={sender ? links.go(sender) : undefined}>
                  {n.sender.name}
                </A>
              ) : (
                'The system'
              )
            },
            { k: 'Category', v: titleize(n.category ?? 'none') },
            { k: 'Lane', v: titleize(n.lane ?? 'fyi') },
            {
              k: 'Record',
              v: record ? (
                <A href={record} onClick={links.go(record)}>
                  {titleize(n.collection ?? '')} #{n.item}
                  <ExternalLink className='h-3 w-3' aria-hidden />
                </A>
              ) : n.collection ? (
                `${titleize(n.collection)}${n.item ? ` #${n.item}` : ''}`
              ) : (
                'None'
              )
            },
            {
              k: 'Read',
              v:
                n.status === 'inbox'
                  ? n.snoozed_until
                    ? `Snoozed until ${fmtWhen(n.snoozed_until)}`
                    : 'Not yet'
                  : n.read_at
                    ? `${fmtWhen(n.read_at)} · ${mins(ttr)} after it was sent`
                    : `Yes (${n.status}) — no read time recorded`
            }
          ]}
        />

        <Block title='Why they got it'>
          {n.reason ? (
            <div className='rounded-lg border border-slate-200 px-3.5 py-3 text-[12.5px] dark:border-border'>
              <p className='font-medium text-slate-900 dark:text-foreground'>
                {n.reason.kind_label}
                {n.reason.critical && (
                  <span className='ml-2'>
                    <OutcomeChip outcome='failed'>Critical</OutcomeChip>
                  </span>
                )}
              </p>
              <p className='mt-0.5 text-slate-600 dark:text-muted-foreground'>{n.reason.text}</p>
              {n.reason.rules.length > 0 && (
                <ul className='mt-2 space-y-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                  {n.reason.rules.map((r, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rules have no id
                    <li key={i}>
                      <span className='text-slate-400'>
                        {r.channel === 'all' ? 'All channels' : titleize(r.channel)} ·{' '}
                      </span>
                      {r.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Not recorded — this notification was sent before the reason was stored.
            </p>
          )}
        </Block>

        <Block title='Where it went'>
          <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-[12.5px]'>
              <tbody>
                {n.channels.map((c) => (
                  <tr
                    key={c.channel}
                    className='border-b border-slate-100 last:border-0 dark:border-border/60'
                  >
                    <td className='w-[110px] px-3 py-2 align-top font-medium text-slate-800 dark:text-foreground'>
                      {c.channel === 'inapp'
                        ? 'In-app'
                        : c.channel === 'sms'
                          ? 'SMS'
                          : titleize(c.channel)}
                    </td>
                    <td className='px-3 py-2 align-top'>
                      <OutcomeChip outcome={c.outcome}>{c.label}</OutcomeChip>
                      {c.reason &&
                        c.reason.replace(/\.$/, '') !== c.label.replace(/\.$/, '') &&
                        !c.reason.startsWith(c.label) && (
                          <p className='mt-1 text-[12px] text-slate-600 dark:text-muted-foreground'>
                            {c.reason}
                          </p>
                        )}
                    </td>
                    <td className='whitespace-nowrap px-3 py-2 text-right align-top text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                      {c.at ? fmtWhen(c.at) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {n.mail && (
            <div className='mt-2 rounded-lg border border-slate-200 px-3.5 py-3 text-[12.5px] dark:border-border'>
              <p className='flex flex-wrap items-center gap-2'>
                <Mail className='h-3.5 w-3.5 text-slate-400' aria-hidden />
                <span className='font-medium text-slate-900 dark:text-foreground'>
                  Email log #{n.mail.id}
                </span>
                <OutcomeChip
                  outcome={n.mail.status === 'sent' ? 'delivered' : (n.mail.status ?? 'other')}
                >
                  {n.mail.reason_label}
                </OutcomeChip>
                <span className='flex-1' />
                <button
                  type='button'
                  onClick={() => setParams((p) => p.set('leaf', `m:${n.mail?.id}`))}
                  className='font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
                >
                  Open this email
                </button>
                <A
                  href={links.mailLog(n.mail.id)}
                  onClick={
                    links.mailLog(n.mail.id)
                      ? links.go(String(links.mailLog(n.mail.id)))
                      : undefined
                  }
                >
                  Mail log <ExternalLink className='h-3 w-3' aria-hidden />
                </A>
              </p>
              {n.mail.hint && (
                <p className='mt-1 text-slate-600 dark:text-muted-foreground'>{n.mail.hint}</p>
              )}
              {n.mail.error && (
                <ErrorDetails
                  className='mt-1.5'
                  description={{ title: n.mail.reason_label, technical: n.mail.error }}
                  action='Send a notification email'
                />
              )}
            </div>
          )}
        </Block>

        <Block title={`Acted within ${n.acted.hours} hours`}>
          <p className='text-[12.5px] text-slate-700 dark:text-foreground'>
            {!n.acted.eligible
              ? 'Not about a record they could act on, so it does not count either way.'
              : n.acted.actions.length > 0
                ? n.acted.actions
                    .map(
                      (a) =>
                        `${a.kind === 'transition' ? 'Moved the record' : a.kind === 'comment' ? 'Commented' : 'Completed a task'} ${fmtWhen(a.at)}`
                    )
                    .join(' · ')
                : windowOpen
                  ? `Nothing yet — the window stays open until ${fmtWhen(n.acted.window_ends)}.`
                  : 'No transition, comment or task on the record in that time.'}
          </p>
        </Block>

        <Block title='Message'>
          {n.message_hidden ? (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Not shown: this notification can quote a private conversation.
            </p>
          ) : n.message ? (
            <p className='whitespace-pre-wrap rounded-lg bg-slate-50 px-3.5 py-3 text-[12.5px] text-slate-800 dark:bg-muted/40 dark:text-foreground'>
              {n.message}
            </p>
          ) : (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              No message text.
            </p>
          )}
        </Block>
      </div>
    </>
  )
}

function MailLeafView({
  id,
  onBack,
  backLabel
}: {
  id: number
  onBack: (() => void) | null
  backLabel: string
}) {
  const client = useNivaroClient()
  const links = useLinks()
  const q = useQuery({
    queryKey: ['delivery-analytics', 'leaf', 'm', id],
    queryFn: () =>
      client
        .request<{ data: DaMailLeaf }>(get(`/delivery-analytics/mail/${id}`))
        .then((r) => r.data),
    staleTime: 60_000
  })
  if (q.isLoading) return <LeafLoading />
  if (q.isError || !q.data)
    return (
      <div className='p-5'>
        <SheetTitle className='sr-only'>Email</SheetTitle>
        <QueryErrorState error={q.error} what='this email' onRetry={() => void q.refetch()} />
      </div>
    )
  const m = q.data
  const record = links.record(m.collection, m.item)
  const mailLog = links.mailLog(m.id)
  return (
    <>
      <LeafHeader
        title={m.subject ?? '(no subject)'}
        sub={
          <>
            Email log #{m.id} · {fmtWhen(m.created_at)}
          </>
        }
        onBack={onBack}
        backLabel={backLabel}
      />
      <div className='min-h-0 flex-1 space-y-5 overflow-y-auto bg-white p-5 dark:bg-background'>
        <div className='rounded-lg border border-slate-200 px-3.5 py-3 text-[12.5px] dark:border-border'>
          <p className='flex flex-wrap items-center gap-2'>
            <OutcomeChip outcome={m.outcome}>{m.outcome_label}</OutcomeChip>
            {m.reason_label !== m.outcome_label && (
              <span className='font-medium text-slate-900 dark:text-foreground'>
                {m.reason_label}
              </span>
            )}
          </p>
          {m.hint && <p className='mt-1 text-slate-600 dark:text-muted-foreground'>{m.hint}</p>}
          {m.error && (
            <ErrorDetails
              className='mt-1.5'
              description={{ title: m.reason_label, technical: m.error }}
              action='Send an email'
            />
          )}
        </div>
        <Facts
          items={[
            {
              k: 'To',
              v: (
                <>
                  {m.to ?? '–'}
                  {m.recipients.length > 0 && (
                    <span className='block text-[12px]'>
                      {m.recipients.map((r, i) => {
                        const href = links.person(r.id)
                        return (
                          <span key={r.id}>
                            {i > 0 && ', '}
                            <A href={href} onClick={href ? links.go(href) : undefined}>
                              {r.name}
                            </A>
                          </span>
                        )
                      })}
                    </span>
                  )}
                </>
              )
            },
            { k: 'Template', v: m.template ?? 'None' },
            {
              k: 'Record',
              v: record ? (
                <A href={record} onClick={links.go(record)}>
                  {titleize(m.collection ?? '')} #{m.item}
                  <ExternalLink className='h-3 w-3' aria-hidden />
                </A>
              ) : m.collection ? (
                `${titleize(m.collection)}${m.item ? ` #${m.item}` : ''}`
              ) : (
                'None'
              )
            },
            ...(m.resend_of ? [{ k: 'Resend of', v: `Email log #${m.resend_of}` }] : []),
            {
              k: 'Mail log',
              v: (
                <A href={mailLog} onClick={mailLog ? links.go(mailLog) : undefined}>
                  Open this row in the Mail log <ExternalLink className='h-3 w-3' aria-hidden />
                </A>
              )
            }
          ]}
        />
        <Block title='The email as sent'>
          {m.body ? (
            <iframe
              title='Rendered email'
              sandbox=''
              srcDoc={m.body}
              className='h-[520px] w-full rounded-md border border-slate-200 bg-white dark:border-border'
            />
          ) : (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              No stored body for this row
              {m.status === 'dropped' || m.status === 'deferred' ? ' — it was never sent.' : '.'}
            </p>
          )}
        </Block>
      </div>
    </>
  )
}
