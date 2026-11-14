import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn, formatRelative, titleCase } from '@/lib/utils'
import { overviewKeys } from './api'
import {
  changedSinceViewed,
  type EditedRecord,
  groupRecent,
  type RecentRecord,
  type RecentTab,
  readRecentTab,
  writeRecentTab
} from './model'
import { Bone, EmptyNote, Section } from './parts'

/**
 * Recently viewed — the records this person opened last, with each one's state. Three or more
 * from one collection fold under that collection's name; a dot marks a record that changed
 * after they last looked (when the API says so).
 *
 * #22 — a second tab, "Edited by me": the records they CHANGED (created, edited, moved,
 * commented on), newest first, each saying what they did (GET /record-views/edited, read as
 * them). The tab picked is remembered on this browser.
 */

const LIMIT = 10

function StatePill({ state }: { state: RecentRecord['state'] }) {
  if (!state) return null
  // The state's colour rides a dot; the words stay neutral so they read in both themes
  // whatever colour the pipeline chose.
  const color = state.color ?? '#64748b'
  return (
    <span className='inline-flex max-w-[40%] shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:border-border dark:text-slate-200'>
      <span className='h-1.5 w-1.5 shrink-0 rounded-full' style={{ backgroundColor: color }} />
      <span className='truncate'>{state.label}</span>
    </span>
  )
}

function Row({ r, nested }: { r: RecentRecord; nested?: boolean }) {
  const changed = changedSinceViewed(r)
  return (
    <li>
      <Link
        to={`/collections/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.item_id)}`}
        className={cn(
          'flex items-center gap-3 py-2 pr-4 text-left transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/[0.04] dark:focus-visible:bg-white/[0.04]',
          nested ? 'pl-7' : 'pl-4'
        )}
        data-recent-record={`${r.collection}:${r.item_id}`}
      >
        <span className='flex w-2 shrink-0 justify-center' aria-hidden={!changed}>
          {changed && (
            <>
              <span
                className='h-1.5 w-1.5 rounded-full bg-nvr-cyan'
                data-tip='Changed since you looked'
              />
              <span className='sr-only'>Changed since you looked:</span>
            </>
          )}
        </span>
        <span className='min-w-0 flex-1'>
          <span
            className={cn(
              'block truncate text-[12.5px] text-slate-800 dark:text-slate-100',
              changed ? 'font-semibold' : 'font-medium'
            )}
          >
            {r.label}
          </span>
          {!nested && (
            <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
              {titleCase(r.collection.replace(/_/g, ' '))}
            </span>
          )}
        </span>
        <StatePill state={r.state} />
        <span className='w-14 shrink-0 text-right text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
          {formatRelative(r.last_viewed_at)}
        </span>
      </Link>
    </li>
  )
}

function TabSwitch({ tab, onTab }: { tab: RecentTab; onTab: (t: RecentTab) => void }) {
  const item = (value: RecentTab, label: string) => (
    <button
      type='button'
      role='tab'
      aria-selected={tab === value}
      data-recent-tab={value}
      onClick={() => onTab(value)}
      className={cn(
        'rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
        tab === value
          ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-slate-100'
          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
      )}
    >
      {label}
    </button>
  )
  return (
    <div
      role='tablist'
      aria-label='Which records'
      className='inline-flex items-center gap-0.5 rounded-md bg-slate-100 p-0.5 dark:bg-white/[0.06]'
    >
      {item('viewed', 'Viewed')}
      {item('edited', 'Edited by me')}
    </div>
  )
}

function EditedRow({ r }: { r: EditedRecord }) {
  return (
    <li>
      <Link
        to={`/collections/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.item_id)}`}
        className='flex items-center gap-3 py-2 pl-4 pr-4 text-left transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/[0.04] dark:focus-visible:bg-white/[0.04]'
        data-edited-record={`${r.collection}:${r.item_id}`}
      >
        <span className='min-w-0 flex-1'>
          <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
            {r.label}
          </span>
          <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
            {r.collection_label} · {r.did}
          </span>
        </span>
        <StatePill state={r.state} />
        <span className='w-14 shrink-0 text-right text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
          {formatRelative(r.last_edited_at)}
        </span>
      </Link>
    </li>
  )
}

function RowsSkeleton() {
  return (
    <ul className='divide-y divide-slate-100 dark:divide-border/60' aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className='flex items-center gap-3 py-2.5 pl-8 pr-4'>
          <span className='min-w-0 flex-1 space-y-1.5'>
            <Bone className='h-3.5 w-48 max-w-full' />
            <Bone className='h-2.5 w-24' />
          </span>
          <Bone className='h-4 w-16 rounded-full' />
          <Bone className='h-3 w-10' />
        </li>
      ))}
    </ul>
  )
}

function EditedList() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: overviewKeys.edited,
    queryFn: () =>
      api
        .get<{ data: EditedRecord[] }>('/record-views/edited', { params: { limit: LIMIT } })
        .then((r) => r.data.data ?? []),
    staleTime: 30_000
  })
  if (isLoading) return <RowsSkeleton />
  if (isError)
    return (
      <EmptyNote action={{ label: 'Try again', onClick: () => void refetch() }}>
        Your recent edits did not load.
      </EmptyNote>
    )
  const rows = data ?? []
  if (rows.length === 0)
    return (
      <EmptyNote action={{ label: 'Browse collections', to: '/collections' }}>
        Records you create, edit, move or comment on will show up here.
      </EmptyNote>
    )
  return (
    <ul className='divide-y divide-slate-100 dark:divide-border/60'>
      {rows.map((r) => (
        <EditedRow key={`${r.collection}:${r.item_id}`} r={r} />
      ))}
    </ul>
  )
}

export function RecentlyViewedSection() {
  const [tab, setTab] = useState<RecentTab>(readRecentTab)
  const pick = (t: RecentTab) => {
    setTab(t)
    writeRecentTab(t)
  }
  return (
    <Section
      id='recent'
      title={tab === 'edited' ? 'Recently edited by me' : 'Recently viewed'}
      action={<TabSwitch tab={tab} onTab={pick} />}
    >
      {tab === 'edited' ? <EditedList /> : <ViewedList />}
    </Section>
  )
}

function ViewedList() {
  const { data, isLoading } = useQuery({
    queryKey: overviewKeys.recent,
    queryFn: () =>
      api
        .get<{ data: RecentRecord[] }>('/record-views/recent', { params: { limit: LIMIT } })
        .then((r) => r.data.data ?? []),
    staleTime: 30_000
  })
  const rows = data ?? []
  const blocks = groupRecent(rows)
  return (
    <>
      {isLoading ? (
        <RowsSkeleton />
      ) : rows.length === 0 ? (
        <EmptyNote action={{ label: 'Browse collections', to: '/collections' }}>
          Records you open will show up here, with their current state.
        </EmptyNote>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border/60'>
          {blocks.map((b) =>
            b.kind === 'single' ? (
              <Row key={`${b.record.collection}:${b.record.item_id}`} r={b.record} />
            ) : (
              <li key={`g:${b.collection}`}>
                <div className='flex items-center justify-between px-4 pb-1 pt-2.5'>
                  <Link
                    to={`/collections/${encodeURIComponent(b.collection)}`}
                    className='rounded text-[11.5px] font-medium text-slate-600 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-300 dark:hover:text-white'
                  >
                    {titleCase(b.collection.replace(/_/g, ' '))}
                  </Link>
                  <span className='text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
                    {b.records.length}
                  </span>
                </div>
                <ul>
                  {b.records.map((r) => (
                    <Row key={`${r.collection}:${r.item_id}`} r={r} nested />
                  ))}
                </ul>
              </li>
            )
          )}
        </ul>
      )}
    </>
  )
}
