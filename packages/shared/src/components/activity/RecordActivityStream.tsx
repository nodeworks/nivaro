import { useQuery } from '@tanstack/react-query'
import { Activity, ChevronUp } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { type ActivityEntryInput, groupActivity } from '../../lib/activity-sentence'
import { post } from '../../lib/commands'
import { liveQueryMeta } from '../../lib/live-queries'
import { slideIn, useTopInserts } from '../../lib/live-screen'
import { cn, titleCase } from '../../lib/utils'
import { ActivityEntry, useActivityLabels } from '../ActivityEntry'
import { ErrorNotice } from '../ErrorNotice'
import { activityLinkable } from '../profile/ActivityFeedCard'

/**
 * One live stream of what changed across a set of related records — a project and its
 * workflows, requests, invoices and budgets (realtime program 2026-11-14, idea 21).
 *
 * `POST /api/activity/feed` resolves the sources AS THE VIEWER, so the stream never names a
 * record they cannot open. Rows are the shared activity sentences (groupActivity folds a burst or
 * a link-table write into one line, labels read as the viewer). The type chips filter it.
 *
 * Live and quiet: another person's save refetches the newest page through the live-query bridge
 * (coalesced, spread, at most every 20 s). New rows slide in at the top only while the person is
 * scrolled to the top; otherwise they wait behind a "3 new" pill and nothing on screen moves.
 * Older rows load on request and are kept, so the head refreshing never drops what was read.
 */

export interface FeedSourceInput {
  collection: string
  filter?: Record<string, unknown>
}

interface FeedType {
  collection: string
  records: number
  truncated: boolean
}
interface FeedAnswer {
  data: FeedEntry[]
  next: number | null
  types: FeedType[]
}
type FeedEntry = ActivityEntryInput & { id: number }

const PAGE = 30
const entryKey = (e: FeedEntry) => String(e.id)

export function RecordActivityStream({
  sources,
  records,
  typeLabels,
  live = true,
  empty,
  className,
  maxHeightClass = 'max-h-[30rem]',
  onOpenRecord
}: {
  sources: FeedSourceInput[]
  records?: Array<{ collection: string; id: string | number }>
  /** Chip names by collection ("workflows" → "Workflows"). */
  typeLabels?: Record<string, string>
  live?: boolean
  empty?: string
  className?: string
  maxHeightClass?: string
  /** Open a row's record (a host's drill-down sheet). Default: the host's record route. */
  onOpenRecord?: (target: { collection: string; itemId: string }) => void
}) {
  const client = useNivaroClient()
  const nav = useItemNavigation()
  const scopeKey = useMemo(
    () => JSON.stringify({ sources, records: records ?? [] }),
    [sources, records]
  )
  const [picked, setPicked] = useState<string[]>([])
  const view = `${scopeKey}|${picked.join(',')}`

  const read = useCallback(
    (before?: number) =>
      client
        .request(
          post<FeedAnswer>('/activity/feed', {
            sources,
            records: (records ?? []).map((r) => ({ collection: r.collection, id: String(r.id) })),
            collections: picked,
            limit: PAGE,
            ...(before ? { before } : {})
          })
        )
        .then((r) => r as unknown as FeedAnswer),
    [client, sources, records, picked]
  )

  const reads = useMemo(
    () => [
      ...new Set([...sources.map((s) => s.collection), ...(records ?? []).map((r) => r.collection)])
    ],
    [sources, records]
  )
  const head = useQuery({
    queryKey: ['record-activity-feed', view],
    queryFn: () => read(),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    meta: live ? liveQueryMeta({ reads, minGapMs: 20_000, jitterMs: 4_000 }) : undefined
  })

  // Every row ever shown for this view: the head refreshing never drops what was read.
  const [seen, setSeen] = useState<{ view: string; rows: Map<number, FeedEntry> }>({
    view,
    rows: new Map()
  })
  const [older, setOlder] = useState<{ view: string; next: number | null | undefined }>({
    view,
    next: undefined
  })
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<unknown>(null)
  useEffect(() => {
    const data = head.data
    if (!data || head.isPlaceholderData) return
    setSeen((prev) => {
      const rows = prev.view === view ? new Map(prev.rows) : new Map<number, FeedEntry>()
      for (const r of data.data) rows.set(Number(r.id), r)
      return { view, rows }
    })
  }, [head.data, head.isPlaceholderData, view])

  const typesRef = useRef<FeedType[]>([])
  if (head.data?.types?.length) typesRef.current = head.data.types
  const types = typesRef.current

  const merged = useMemo(() => {
    if (seen.view !== view) return undefined
    return [...seen.rows.values()].sort((a, b) => Number(b.id) - Number(a.id))
  }, [seen, view])

  const feed = useTopInserts(merged, entryKey, { enabled: live, resetKey: view })
  const rows = merged ? feed.rows : []
  const groups = useMemo(() => groupActivity(rows), [rows])
  const labelsOn = rows.length > 0
  const labels = useActivityLabels(rows, { enabled: labelsOn })
  const listRef = useRef<HTMLDivElement | null>(null)
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el
      feed.rootRef(el)
    },
    [feed.rootRef]
  )
  useEffect(() => {
    slideIn(listRef.current, feed.arrived)
  }, [feed.arrived])

  const hasMore =
    older.view === view && older.next !== undefined ? older.next !== null : head.data?.next != null
  const loadOlder = async () => {
    if (!merged?.length || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const oldest = merged.reduce((m, r) => Math.min(m, Number(r.id)), Number.MAX_SAFE_INTEGER)
      const page = await read(oldest)
      setSeen((prev) => {
        const m = prev.view === view ? new Map(prev.rows) : new Map<number, FeedEntry>()
        for (const r of page.data) m.set(Number(r.id), r)
        return { view, rows: m }
      })
      setOlder({ view, next: page.next })
    } catch (err) {
      setOlderError(err)
    } finally {
      setLoadingOlder(false)
    }
  }

  const toggle = (c: string) =>
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))

  const open = (e: ActivityEntryInput) => {
    if (
      !activityLinkable({
        action: e.action ?? '',
        collection: e.collection ?? null,
        item: e.item == null ? null : String(e.item)
      })
    )
      return
    const target = { collection: String(e.collection), itemId: String(e.item) }
    if (onOpenRecord) onOpenRecord(target)
    else nav.open(target)
  }

  const loading = merged === undefined && !head.isError
  return (
    <section
      data-record-activity-stream
      className={cn(
        'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      <header className='flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <Activity className='h-4 w-4 shrink-0 text-nvr-navy dark:text-nvr-cyan' aria-hidden />
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>Activity</h3>
        {types.length > 1 && (
          <div
            className='ml-auto flex min-w-0 flex-wrap items-center gap-1'
            role='group'
            aria-label='Filter by type'
          >
            <TypeChip active={picked.length === 0} onClick={() => setPicked([])}>
              All
            </TypeChip>
            {types.map((t) => (
              <TypeChip
                key={t.collection}
                active={picked.includes(t.collection)}
                onClick={() => toggle(t.collection)}
                title={`${t.records.toLocaleString('en-US')} ${t.records === 1 ? 'record' : 'records'}${
                  t.truncated ? ' (the newest are followed)' : ''
                }`}
              >
                {typeLabels?.[t.collection] ?? titleCase(t.collection)}
              </TypeChip>
            ))}
          </div>
        )}
      </header>

      {loading ? (
        <div className='space-y-3 p-4' aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className='h-4 animate-pulse rounded bg-slate-100 dark:bg-white/[0.06]' />
          ))}
        </div>
      ) : head.isError && !merged?.length ? (
        <div className='p-4'>
          <ErrorNotice error={head.error} what='the activity' onRetry={() => head.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <p className='px-4 py-8 text-center text-[12.5px] text-slate-500 dark:text-slate-400'>
          {empty ?? 'Nothing has changed here yet.'}
        </p>
      ) : (
        <div className={cn('relative overflow-y-auto', maxHeightClass)}>
          {feed.held > 0 && (
            // Zero-height and sticky: floats over the list, never pushes it.
            <div className='sticky top-2 z-10 flex h-0 justify-center overflow-visible'>
              <button
                type='button'
                data-activity-new-pill={feed.held}
                onClick={feed.reveal}
                className='mt-1 inline-flex h-7 items-center gap-1 rounded-full border border-nvr-cyan/40 bg-white px-3 text-[12px] font-medium text-nvr-navy shadow-sm transition-colors hover:bg-nvr-cyan/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan dark:bg-card dark:text-nvr-cyan'
              >
                <ChevronUp className='h-3.5 w-3.5' aria-hidden />
                {feed.held} new
              </button>
            </div>
          )}
          <div
            ref={setList}
            data-activity-stream-list
            className='divide-y divide-slate-100 px-2 dark:divide-border'
          >
            {groups.map((g) => (
              <div key={g.key} data-live-key={String(g.entries[0].id ?? g.key)}>
                <ActivityEntry
                  entry={g.entries[0]}
                  group={g.entries.length > 1 ? g.entries : undefined}
                  labels={labels}
                  onOpen={open}
                />
              </div>
            ))}
          </div>
          {(hasMore || olderError != null) && (
            <div className='flex justify-center border-t border-slate-100 px-4 py-2.5 dark:border-border/60'>
              {olderError != null ? (
                <ErrorNotice error={olderError} what='earlier activity' onRetry={loadOlder} />
              ) : (
                <button
                  type='button'
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className='rounded-md px-3 py-1 text-[12px] font-medium text-nvr-navy hover:bg-slate-50 disabled:opacity-60 dark:text-nvr-cyan dark:hover:bg-white/[0.05]'
                >
                  {loadingOlder ? 'Loading…' : 'Show earlier'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function TypeChip({
  active,
  onClick,
  title,
  children
}: {
  active: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan',
        active
          ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-transparent dark:text-slate-300 dark:hover:bg-white/[0.05]'
      )}
    >
      {children}
    </button>
  )
}
