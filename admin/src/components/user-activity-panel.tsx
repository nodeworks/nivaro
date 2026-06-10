import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Activity, ArrowDownAZ, ArrowUpAZ, Globe, SlidersHorizontal, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'

interface ActivityEntry {
  id: number
  action: string
  timestamp: string
  collection: string | null
  item: string | null
  comment: string | null
  ip: string | null
}

interface ActivitySummary {
  total: number
  actions: Array<{ action: string; count: number }>
  collections: Array<{ collection: string; count: number }>
}

const ACTION_META: Record<string, { label: string; cls: string; dot: string }> = {
  create: {
    label: 'create',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
    dot: 'bg-emerald-500'
  },
  update: {
    label: 'update',
    cls: 'bg-[#00ceff]/10 text-[#172940] dark:bg-[#00ceff]/15 dark:text-[#00ceff]',
    dot: 'bg-[#00ceff]'
  },
  delete: {
    label: 'delete',
    cls: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400',
    dot: 'bg-red-500'
  },
  login: {
    label: 'login',
    cls: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
    dot: 'bg-violet-500'
  },
  logout: {
    label: 'logout',
    cls: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
    dot: 'bg-slate-400'
  }
}

function fallback(action: string) {
  return {
    label: action,
    cls: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
    dot: 'bg-slate-400'
  }
}

const PAGE_LIMIT = 50

export function UserActivityPanel({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false)
  const [filterAction, setFilterAction] = useState('')
  const [filterCollection, setFilterCollection] = useState('')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [showFilters, setShowFilters] = useState(false)

  const hasFilters = !!filterAction || !!filterCollection

  const { data: summary } = useQuery<ActivitySummary>({
    queryKey: ['user-activity-summary', userId],
    queryFn: () =>
      api
        .get<{ data: ActivitySummary }>(`/user-activity/${userId}/summary`)
        .then((r) => r.data.data),
    enabled: open
  })

  const {
    data: pages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading
  } = useInfiniteQuery({
    queryKey: ['user-activity', userId, filterAction, filterCollection, sortDir],
    queryFn: ({ pageParam }) =>
      api
        .get<{ data: ActivityEntry[]; total: number; page: number; limit: number }>(
          `/user-activity/${userId}`,
          {
            params: {
              page: pageParam,
              limit: PAGE_LIMIT,
              ...(filterAction && { action: filterAction }),
              ...(filterCollection && { collection: filterCollection }),
              sort: sortDir
            }
          }
        )
        .then((r) => r.data),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
    enabled: open
  })

  const entries = pages?.pages.flatMap((p) => p.data) ?? []
  const total = pages?.pages[0]?.total ?? 0

  function clearFilters() {
    setFilterAction('')
    setFilterCollection('')
  }

  // Group entries by calendar date for the timeline
  const grouped: Array<{ date: string; entries: ActivityEntry[] }> = []
  for (const entry of entries) {
    const date = new Date(entry.timestamp).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    const last = grouped[grouped.length - 1]
    if (last?.date === date) {
      last.entries.push(entry)
    } else {
      grouped.push({ date, entries: [entry] })
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant='outline' size='sm' className='gap-1.5'>
          <Activity className='h-3.5 w-3.5' />
          Activity
        </Button>
      </SheetTrigger>

      <SheetContent side='right' className='flex w-[480px] flex-col gap-0 p-0 sm:max-w-[480px]'>
        {/* Header */}
        <SheetHeader className='shrink-0 border-b border-slate-200 px-5 py-4 dark:border-border'>
          <div className='flex items-center justify-between'>
            <SheetTitle className='flex items-center gap-2 text-[14px]'>
              <Activity className='h-4 w-4 text-slate-400' />
              Activity
              {summary && (
                <span className='rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                  {summary.total.toLocaleString()}
                </span>
              )}
            </SheetTitle>
            <Button
              variant='ghost'
              size='sm'
              className={cn('h-7 gap-1.5 text-[12px]', showFilters && 'bg-slate-100 dark:bg-muted')}
              onClick={() => setShowFilters((v) => !v)}
            >
              <SlidersHorizontal className='h-3.5 w-3.5' />
              Filter
              {hasFilters && (
                <span className='flex h-4 w-4 items-center justify-center rounded-full bg-[#00ceff] text-[9px] font-bold text-[#172940]'>
                  {(filterAction ? 1 : 0) + (filterCollection ? 1 : 0)}
                </span>
              )}
            </Button>
          </div>

          {/* Summary chips */}
          {summary && summary.actions.length > 0 && (
            <div className='mt-2 flex flex-wrap gap-1.5'>
              {summary.actions.map((a) => {
                const meta = ACTION_META[a.action] ?? fallback(a.action)
                return (
                  <button
                    key={a.action}
                    type='button'
                    onClick={() => setFilterAction(filterAction === a.action ? '' : a.action)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-opacity',
                      meta.cls,
                      filterAction && filterAction !== a.action && 'opacity-40'
                    )}
                  >
                    {a.action}
                    <span className='font-mono opacity-70'>{a.count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </SheetHeader>

        {/* Filter bar */}
        {showFilters && (
          <div className='shrink-0 border-b border-slate-200 bg-slate-50 px-5 py-3 dark:border-border dark:bg-muted/30'>
            <div className='flex items-center gap-2'>
              <Select
                value={filterAction || '_all'}
                onValueChange={(v) => setFilterAction(v === '_all' ? '' : v)}
              >
                <SelectTrigger className='h-8 w-[140px] text-[12px]'>
                  <SelectValue placeholder='All actions' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='_all'>All actions</SelectItem>
                  {(summary?.actions ?? []).map((a) => (
                    <SelectItem key={a.action} value={a.action}>
                      {a.action}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                className='h-8 flex-1 font-mono text-[12px]'
                placeholder='Filter by collection…'
                value={filterCollection}
                onChange={(e) => setFilterCollection(e.target.value)}
              />

              <Button
                variant='ghost'
                size='sm'
                className='h-8 w-8 p-0 text-slate-400'
                title={sortDir === 'desc' ? 'Newest first' : 'Oldest first'}
                onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
              >
                {sortDir === 'desc' ? (
                  <ArrowDownAZ className='h-3.5 w-3.5' />
                ) : (
                  <ArrowUpAZ className='h-3.5 w-3.5' />
                )}
              </Button>

              {hasFilters && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-8 gap-1 text-[12px] text-slate-400 hover:text-slate-700'
                  onClick={clearFilters}
                >
                  <X className='h-3.5 w-3.5' />
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Sort indicator when filters not shown */}
        {!showFilters && (
          <div className='flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-2 dark:border-border'>
            <span className='text-[11px] text-slate-400'>
              {hasFilters
                ? `${total.toLocaleString()} filtered events`
                : `${(total || summary?.total || 0).toLocaleString()} events`}
            </span>
            <button
              type='button'
              onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
              className='flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600'
            >
              {sortDir === 'desc' ? (
                <ArrowDownAZ className='h-3 w-3' />
              ) : (
                <ArrowUpAZ className='h-3 w-3' />
              )}
              {sortDir === 'desc' ? 'Newest first' : 'Oldest first'}
            </button>
          </div>
        )}

        {/* Timeline */}
        <div className='flex-1 overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-3 p-5'>
              {[...Array(6)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                <div key={i} className='flex gap-3'>
                  <Skeleton className='mt-1 h-2 w-2 rounded-full' />
                  <div className='flex-1 space-y-1.5'>
                    <Skeleton className='h-3 w-24' />
                    <Skeleton className='h-3 w-48' />
                  </div>
                  <Skeleton className='h-3 w-16' />
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className='flex flex-col items-center justify-center py-16 text-center'>
              <Activity className='mb-3 h-8 w-8 text-slate-300 dark:text-slate-600' />
              <p className='text-[13px] font-medium text-slate-500'>No activity found</p>
              {hasFilters && (
                <button
                  type='button'
                  onClick={clearFilters}
                  className='mt-2 text-[12px] text-[#00ceff] hover:underline'
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className='pb-6'>
              {grouped.map((group) => (
                <div key={group.date}>
                  {/* Date separator */}
                  <div className='sticky top-0 z-10 flex items-center gap-3 bg-white/95 px-5 py-2 backdrop-blur-sm dark:bg-background/95'>
                    <div className='h-px flex-1 bg-slate-100 dark:bg-border' />
                    <span className='text-[11px] font-medium text-slate-400'>{group.date}</span>
                    <div className='h-px flex-1 bg-slate-100 dark:bg-border' />
                  </div>

                  {/* Entries */}
                  <div className='relative px-5'>
                    {/* Vertical timeline line */}
                    <div className='absolute left-[28px] top-0 bottom-0 w-px bg-slate-100 dark:bg-border' />

                    {group.entries.map((entry) => {
                      const meta = ACTION_META[entry.action] ?? fallback(entry.action)
                      return (
                        <div key={entry.id} className='relative flex gap-4 py-3'>
                          {/* Dot */}
                          <div className='relative z-10 mt-1 flex h-4 w-4 shrink-0 items-center justify-center'>
                            <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
                          </div>

                          {/* Content */}
                          <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                            <div className='flex items-center gap-2'>
                              <span
                                className={cn(
                                  'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                                  meta.cls
                                )}
                              >
                                {entry.action}
                              </span>
                              {entry.collection && (
                                <span className='min-w-0 truncate font-mono text-[12px] text-slate-600 dark:text-slate-300'>
                                  {entry.item ? (
                                    <Link
                                      to={`/collections/${entry.collection}/${entry.item}`}
                                      className='text-[#00ceff] hover:underline'
                                      onClick={() => setOpen(false)}
                                    >
                                      {entry.collection}
                                      <span className='text-slate-400'> #{entry.item}</span>
                                    </Link>
                                  ) : (
                                    entry.collection
                                  )}
                                </span>
                              )}
                            </div>

                            {entry.comment && (
                              <p className='text-[11px] text-slate-400'>{entry.comment}</p>
                            )}

                            <div className='flex items-center gap-3'>
                              <span className='text-[11px] text-slate-400'>
                                {formatDateTime(entry.timestamp)}
                              </span>
                              {entry.ip && (
                                <span className='flex items-center gap-1 font-mono text-[10px] text-slate-300 dark:text-slate-600'>
                                  <Globe className='h-2.5 w-2.5' />
                                  {entry.ip}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Relative time */}
                          <span className='shrink-0 pt-0.5 text-[11px] text-slate-400'>
                            {formatRelative(entry.timestamp)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}

              {/* Load more */}
              {hasNextPage && (
                <div className='px-5 pt-2 text-center'>
                  <Button
                    variant='outline'
                    size='sm'
                    className='h-7 text-[12px]'
                    disabled={isFetchingNextPage}
                    onClick={() => fetchNextPage()}
                  >
                    {isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
