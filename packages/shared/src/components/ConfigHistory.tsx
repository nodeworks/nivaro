import { useInfiniteQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useState } from 'react'
import { useNavigation, useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn, formatDateTime, formatRelative } from '../lib/utils'
import { AgentBadge } from './AgentBadge'
import { Button } from './ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet'

/**
 * #12 — "History" on a config screen: the audit-log entries for one config row (a role, a
 * flow, a webhook…), newest first, from GET /api/activity?collection=&item= (administrators).
 *
 * The line text goes through `configHistoryLine` — a small adapter so the shared sentence
 * renderer (`renderActivitySentence` in lib/activity-sentence, when it lands) can replace it
 * in one place without touching the screens.
 */

export interface ConfigHistoryEntry {
  id: number
  action: string
  timestamp: string
  user: string | null
  collection: string | null
  item: string | null
  comment: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  via_agent?: string | null
}

const VERBS: Record<string, string> = {
  create: 'created this',
  update: 'changed this',
  delete: 'deleted this',
  revert: 'reverted a change',
  restore: 'restored this'
}

export function entryPerson(e: ConfigHistoryEntry): string {
  const n = [e.first_name, e.last_name].filter(Boolean).join(' ').trim()
  return n || e.user_email || (e.user ? 'Someone' : 'The system')
}

/** Adapter: one entry → who / what / detail. Swap for the shared sentence renderer later. */
export function configHistoryLine(e: ConfigHistoryEntry): {
  who: string
  what: string
  detail: string | null
} {
  const what = VERBS[e.action] ?? e.action.replace(/[-_]/g, ' ')
  const detail = e.comment?.trim() ? e.comment.trim() : null
  return { who: entryPerson(e), what, detail }
}

const PAGE = 20

export function ConfigHistory({
  collection,
  item,
  className,
  pageSize = PAGE
}: {
  /** The config table the entries are logged under (e.g. `nivaro_roles`). */
  collection: string
  /** The row id; null/empty = nothing to show yet (an unsaved draft). */
  item: string | number | null | undefined
  className?: string
  pageSize?: number
}) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const id = item == null ? '' : String(item)
  const q = useInfiniteQuery({
    queryKey: ['nvr-config-history', collection, id, pageSize],
    enabled: !!id,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      client
        .request<{ data: ConfigHistoryEntry[]; total: number }>(
          get('/activity', { collection, item: id, limit: pageSize, offset: pageParam })
        )
        .then((r) => r as unknown as { data: ConfigHistoryEntry[]; total: number }),
    getNextPageParam: (last, all) => {
      const seen = all.reduce((n, p) => n + (p.data?.length ?? 0), 0)
      return seen < (last.total ?? 0) && (last.data?.length ?? 0) > 0 ? seen : undefined
    },
    staleTime: 15_000
  })
  const entries = q.data?.pages.flatMap((p) => p.data ?? []) ?? []
  const total = q.data?.pages[0]?.total ?? 0
  const detailUrl = (entryId: number) => {
    const path = `/activity/${entryId}`
    return nav.consoleUrl ? nav.consoleUrl(path) : path
  }

  if (!id) {
    return (
      <p className={cn('text-[12px] text-slate-500 dark:text-slate-400', className)}>
        History starts once this is saved.
      </p>
    )
  }
  if (q.isLoading) {
    return (
      <div className={cn('space-y-2', className)} aria-busy='true' data-config-history-loading>
        {[0, 1, 2].map((i) => (
          <div key={i} className='h-10 animate-pulse rounded-md bg-slate-100 dark:bg-muted' />
        ))}
      </div>
    )
  }
  if (q.isError) {
    return (
      <p className={cn('text-[12px] text-red-600 dark:text-red-400', className)}>
        History could not be loaded.
      </p>
    )
  }
  if (entries.length === 0) {
    return (
      <p className={cn('text-[12px] text-slate-500 dark:text-slate-400', className)}>
        No changes recorded yet.
      </p>
    )
  }
  return (
    <div className={cn('flex flex-col gap-2', className)} data-config-history>
      <ol className='divide-y divide-slate-100 rounded-md border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
        {entries.map((e) => {
          const line = configHistoryLine(e)
          const href = detailUrl(e.id)
          return (
            <li key={e.id} className='px-3 py-2' data-config-history-entry={e.id}>
              <div className='flex items-baseline gap-2 text-[12.5px]'>
                <span className='min-w-0 truncate text-slate-800 dark:text-slate-100'>
                  <span className='font-medium'>{line.who}</span> {line.what}
                </span>
                <AgentBadge label={e.via_agent} />
                <time
                  className='ml-auto shrink-0 text-[11px] text-slate-500 dark:text-slate-400'
                  dateTime={e.timestamp}
                  data-tip={formatDateTime(e.timestamp)}
                >
                  {formatRelative(e.timestamp)}
                </time>
              </div>
              {(line.detail || href) && (
                <div className='mt-0.5 flex items-start gap-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
                  {line.detail && <p className='min-w-0 flex-1 break-words'>{line.detail}</p>}
                  {href && (
                    <button
                      type='button'
                      className='ml-auto shrink-0 text-nvr-navy hover:underline dark:text-nvr-cyan'
                      onClick={() => nav.navigate(href)}
                    >
                      Details
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <div className='flex items-center justify-between text-[11.5px] text-slate-500 dark:text-slate-400'>
        <span>
          {entries.length} of {total}
        </span>
        {q.hasNextPage && (
          <Button
            variant='outline'
            size='sm'
            className='h-7 text-[12px]'
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {q.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </Button>
        )}
      </div>
    </div>
  )
}

/** A header button that opens ConfigHistory in a side sheet — one line on any config screen. */
export function ConfigHistoryButton({
  collection,
  item,
  title = 'History',
  className
}: {
  collection: string
  item: string | number | null | undefined
  title?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  if (item == null || item === '' || item === 'new') return null
  return (
    <>
      <Button
        type='button'
        variant='outline'
        size='sm'
        className={cn('h-8 gap-1.5 text-[12px]', className)}
        onClick={() => setOpen(true)}
        data-config-history-button
      >
        <History className='h-3.5 w-3.5' />
        History
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side='right'
          className='flex w-full flex-col gap-3 overflow-y-auto sm:max-w-md'
        >
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>Every change recorded for this, newest first.</SheetDescription>
          </SheetHeader>
          {open && <ConfigHistory collection={collection} item={item} />}
        </SheetContent>
      </Sheet>
    </>
  )
}
