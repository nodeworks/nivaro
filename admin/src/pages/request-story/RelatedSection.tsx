/**
 * What else is linked to this request (GET /ops/request-story/:id/related → the Traffic Map's
 * related rail): the same page load, chain, record, caller and error. A request opens its own
 * story here; everything else opens where it lives.
 */
import { ErrorNotice } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import { relatedRefPath, signedOffset } from './logic'
import type { Related, RelatedRef } from './types'
import { Hint, Panel, rowKeys, Section } from './ui'

const GROUP_HINT: Record<string, string> = {
  load: 'Sent by the same page load in the browser',
  chain: 'Part of the same chain of events',
  record: 'Touched the same record around that time',
  caller: 'Sent by the same caller within five minutes',
  error: 'Issues logged for the same error',
  statement: 'Statement shapes this request ran (open one for its plan and routes)'
}

const ROW =
  'flex w-full min-w-0 items-center gap-2 px-4 py-1.5 text-left text-[12.5px] outline-none hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-muted/50 dark:focus-visible:bg-muted/50'

export function RelatedSection({
  rid,
  startedAt,
  onOpenRequest,
  onShowPath
}: {
  rid: string
  /** The request's start (epoch ms): related times read as "+4 s" from it. */
  startedAt: number | null
  onOpenRequest: (rid: string) => void
  onShowPath: (() => void) | null
}) {
  const q = useQuery({
    queryKey: ['ops', 'request-story', rid, 'related'],
    staleTime: 60_000,
    queryFn: () =>
      api
        .get<{ data: Related }>(`/ops/request-story/${encodeURIComponent(rid)}/related`)
        .then((r) => r.data.data)
  })
  // Statement shapes are already in "SQL it ran", and the chain's writes and runs in "What it
  // wrote and set off" — the chain group keeps only its event path.
  const groups = (q.data?.groups ?? [])
    .filter((g) => g.key !== 'statement')
    .map((g) =>
      g.key === 'chain' ? { ...g, refs: g.refs.filter((r) => r.kind === 'chain'), more: 0 } : g
    )
    .filter((g) => g.refs.length > 0)
  const total = groups.reduce((n, g) => n + g.refs.length + (g.more ?? 0), 0)
  return (
    <Section id='related' title='Related' count={q.data ? total || undefined : undefined}>
      {q.isLoading ? (
        <Panel className='grid gap-2 px-4 py-3'>
          <Skeleton className='h-4 w-1/3' />
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-4 w-1/2' />
        </Panel>
      ) : q.isError ? (
        <ErrorNotice error={q.error} what='related requests' onRetry={() => void q.refetch()} />
      ) : (
        <div className='grid gap-3'>
          {groups.length === 0 && (
            <Panel className='px-4 py-3'>
              <Hint>Nothing else is linked to this request.</Hint>
            </Panel>
          )}
          {groups.map((g) => (
            <Panel key={g.key}>
              <div className='flex items-baseline gap-2 border-b border-slate-100 px-4 py-2 dark:border-border'>
                <h3 className='m-0 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                  {g.label}
                </h3>
                <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  {GROUP_HINT[g.key] ?? ''}
                </span>
              </div>
              <ul className='m-0 list-none p-0 py-1'>
                {g.refs.map((r) => (
                  <li key={`${r.kind}:${r.id}`}>
                    <RefRow
                      r={r}
                      list={`rel-${g.key}`}
                      base={startedAt}
                      onOpenRequest={onOpenRequest}
                      onShowPath={onShowPath}
                    />
                  </li>
                ))}
              </ul>
              {g.more ? (
                <Hint className='border-t border-slate-100 px-4 py-1.5 dark:border-border'>
                  and {g.more} more — the Traffic Map lists them all.
                </Hint>
              ) : null}
            </Panel>
          ))}
          {(q.data?.notes ?? []).map((n) => (
            <Hint key={n}>{n}</Hint>
          ))}
        </div>
      )}
    </Section>
  )
}

function RefRow({
  r,
  list,
  base,
  onOpenRequest,
  onShowPath
}: {
  r: RelatedRef
  list: string
  base: number | null
  onOpenRequest: (rid: string) => void
  onShowPath: (() => void) | null
}) {
  const when = r.at ? (
    <span
      className='ml-auto shrink-0 text-[11.5px] tabular-nums text-slate-400 dark:text-muted-foreground'
      data-tip={new Date(r.at).toLocaleString()}
    >
      {base != null ? signedOffset(r.at, base) : formatRelative(new Date(r.at))}
    </span>
  ) : null
  const label = (
    <span className='min-w-0 truncate text-slate-800 dark:text-foreground'>
      {r.label ?? `${r.kind} ${r.id}`}
    </span>
  )
  if (r.kind === 'request')
    return (
      <button
        type='button'
        data-rs-row={list}
        onKeyDown={rowKeys}
        className={ROW}
        onClick={() => onOpenRequest(r.id)}
      >
        <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
        {label}
        <span className='hidden shrink-0 font-mono text-[11px] text-slate-400 sm:inline dark:text-muted-foreground'>
          {r.id.slice(0, 8)}
        </span>
        {when}
      </button>
    )
  if (r.kind === 'chain' && onShowPath)
    return (
      <button
        type='button'
        data-rs-row={list}
        onKeyDown={rowKeys}
        className={ROW}
        onClick={onShowPath}
      >
        <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
        <span className='text-slate-800 dark:text-foreground'>Show the event path</span>
        {when}
      </button>
    )
  const to = relatedRefPath(r)
  if (!to)
    return (
      <div className='flex min-w-0 items-center gap-2 px-4 py-1.5 text-[12.5px]'>
        <span className='w-3.5' />
        {label}
        {when}
      </div>
    )
  return (
    <Link to={to} data-rs-row={list} onKeyDown={rowKeys} className={ROW}>
      <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
      {label}
      {when}
    </Link>
  )
}
