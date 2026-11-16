import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  LifeBuoy,
  Search,
  SlidersHorizontal,
  UserRound,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { useLiveFade, useSettledRows } from '../../lib/live-screen'
import { useBackgroundArm } from '../../lib/live-views'
import { useBelowMd } from '../../lib/use-below-md'
import { cn } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { ConfirmButton } from '../profile/primitives'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { SimpleSelect } from '../ui/SimpleSelect'
import { PersonDisc, PersonPick, PICK_TRIGGER, PickCaret, type PickChoice } from './PersonPick'
import {
  activeFilterCount,
  type BulkAction,
  bulkResultLine,
  defaultFilters,
  exactTime,
  type ListFilters,
  type ListTab,
  listParams,
  PRIORITY_FILTERS,
  readFilters,
  SORTS,
  STATUS_FILTERS,
  shortAgo,
  type TicketSort,
  writeFilters
} from './support-list'
import { StatusPill } from './TicketDetailSheet'
import type {
  SupportBulkResult,
  SupportCategory,
  SupportTicket,
  SupportWorkload,
  TicketStatus
} from './types'

const PAGE = 50
const CLOSED = new Set<TicketStatus>(['done', 'cancelled'])

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const SELECT_TRIGGER =
  'h-8 w-auto max-w-[12rem] gap-1.5 rounded-md border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 dark:border-border dark:bg-background dark:text-slate-200'

/**
 * The support request list (Desk and My requests): search, filters, sort, "who has what" (Desk)
 * and bulk changes (Desk). Rows open the ticket sheet through `onOpen`.
 */
export function RequestList({
  tab,
  openId,
  onOpen
}: {
  tab: ListTab
  openId: number | null
  onOpen: (id: number) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const phone = useBelowMd()
  const desk = tab === 'desk'
  const [filters, setFiltersState] = useState<ListFilters>(() => readFilters(tab, storage()))
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [result, setResult] = useState<string | null>(null)

  const setFilters = (next: Partial<ListFilters>) => {
    setFiltersState((f) => {
      const merged = { ...f, ...next }
      writeFilters(tab, merged, storage())
      return merged
    })
    setPage(1)
  }

  const params = { ...listParams(tab, filters, search), page: String(page), limit: String(PAGE) }
  const viewKey = JSON.stringify(params)
  const list = useQuery({
    queryKey: ['support-tickets', params],
    queryFn: () =>
      client.request<{ data: SupportTicket[]; total: number }>(get('/support/tickets', params))
  })
  const { data: workload } = useQuery({
    queryKey: ['support-workload'],
    queryFn: () =>
      client.request<{ data: SupportWorkload }>(get('/support/workload')).then((r) => r.data),
    enabled: desk
  })
  const { data: types = [] } = useQuery({
    queryKey: ['support-categories', 'any'],
    queryFn: () =>
      client
        .request<{ data: SupportCategory[] }>(get('/support/categories', { any: '1' }))
        .then((r) => r.data ?? [])
  })

  // A new view starts with nothing selected and no old result line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey is the trigger
  useEffect(() => {
    setSelected(new Set())
    setResult(null)
  }, [viewKey])

  // Rows never move under the pointer (useSettledRows): a request someone else picked up or
  // closed stays, dimmed, until the person moves on; a selected row never leaves.
  const held = useMemo(() => [...selected].map(String), [selected])
  const settled = useSettledRows<SupportTicket>(list.data?.data, (t) => String(t.id), {
    resetKey: viewKey,
    held
  })
  const fadeRef = useLiveFade(useBackgroundArm(list.dataUpdatedAt, viewKey))
  const listRef = useCallback(
    (el: HTMLElement | null) => {
      settled.containerRef(el)
      fadeRef(el)
    },
    [settled.containerRef, fadeRef]
  )

  const people: PickChoice[] = useMemo(() => {
    const load = new Map((workload?.assignees ?? []).map((a) => [a.id, a.open]))
    return (workload?.workers ?? []).map((w) => ({
      value: w.id,
      label: w.name,
      person: true,
      hint: load.get(w.id) ? `${load.get(w.id)} open` : undefined
    }))
  }, [workload])
  const nameOfAssignee = (v: string) =>
    v === 'me'
      ? 'Me'
      : v === 'unassigned'
        ? 'Unassigned'
        : (workload?.workers.find((w) => w.id === v)?.name ??
          workload?.assignees.find((a) => a.id === v)?.name ??
          'Someone')

  const bulk = useMutation({
    mutationFn: ({
      ids,
      body
    }: {
      ids: number[]
      body: Record<string, unknown>
      action: BulkAction
    }) =>
      client
        .request<{ data: SupportBulkResult }>(post('/support/tickets/bulk', { ids, ...body }))
        .then((r) => r.data),
    onSuccess: (r, v) => {
      setResult(bulkResultLine(v.action, r))
      const changed = r.results.filter((x) => x.outcome !== 'refused').map((x) => String(x.id))
      settled.release(changed)
      setSelected(new Set())
      for (const key of [
        'support-tickets',
        'support-summary',
        'support-workload',
        'support-ticket'
      ])
        void qc.invalidateQueries({ queryKey: [key] })
    },
    onError: (err) => toastError(err, 'Could not change those requests')
  })
  const runBulk = (action: BulkAction) => {
    const ids = [...selected]
    if (!ids.length) return
    const body =
      action.kind === 'status'
        ? { status: action.status }
        : action.kind === 'assign'
          ? { assignee: action.assignee }
          : { priority: action.priority }
    bulk.mutate({ ids, body, action })
  }

  const rows = settled.rows
  const liveIds = rows.filter((r) => r.state !== 'departed').map((r) => r.row.id)
  const allSelected = liveIds.length > 0 && liveIds.every((id) => selected.has(id))
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(liveIds))

  const filterCount = activeFilterCount(tab, filters)
  const clear = () => {
    const d = defaultFilters(tab)
    setFilters({
      status: d.status,
      assignee: d.assignee,
      category: d.category,
      priority: d.priority
    })
    setSearch('')
  }
  const sortBy = (s: TicketSort) => setFilters({ sort: s })

  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  const filterControls = (
    <>
      <SimpleSelect
        value={filters.status}
        onChange={(v) => setFilters({ status: v })}
        options={STATUS_FILTERS}
        ariaLabel='Status'
        className={cn(SELECT_TRIGGER, phone && 'w-full max-w-none')}
        triggerProps={{ 'data-support-filter': 'status' }}
      />
      {desk && (
        <PersonPick
          value={filters.assignee}
          ariaLabel='Assignee'
          fixed={[
            { value: '', label: 'Anyone' },
            { value: 'me', label: 'Me' },
            { value: 'unassigned', label: 'Unassigned' }
          ]}
          people={people}
          onPick={(v) => setFilters({ assignee: v })}
          trigger={
            <button
              type='button'
              data-support-filter='assignee'
              className={cn(PICK_TRIGGER, phone && 'w-full max-w-none')}
            >
              {filters.assignee &&
              filters.assignee !== 'unassigned' &&
              filters.assignee !== 'me' ? (
                <PersonDisc
                  id={filters.assignee}
                  name={nameOfAssignee(filters.assignee)}
                  size={16}
                />
              ) : (
                <UserRound className='h-3.5 w-3.5 shrink-0 opacity-60' />
              )}
              <span className='min-w-0 flex-1 truncate text-left'>
                {filters.assignee ? nameOfAssignee(filters.assignee) : 'Anyone'}
              </span>
              <PickCaret />
            </button>
          }
        />
      )}
      <SimpleSelect
        value={filters.category}
        onChange={(v) => setFilters({ category: v })}
        options={[
          { value: '', label: 'Any type' },
          ...types.map((c) => ({ value: String(c.id), label: c.name }))
        ]}
        ariaLabel='Type'
        className={cn(SELECT_TRIGGER, phone && 'w-full max-w-none')}
        triggerProps={{ 'data-support-filter': 'type' }}
      />
      <SimpleSelect
        value={filters.priority}
        onChange={(v) => setFilters({ priority: v })}
        options={PRIORITY_FILTERS}
        ariaLabel='Priority'
        className={cn(SELECT_TRIGGER, phone && 'w-full max-w-none')}
        triggerProps={{ 'data-support-filter': 'priority' }}
      />
    </>
  )

  return (
    <div data-support-list-view={tab}>
      {/* Toolbar: search, filters, sort. On a phone the filters fold into one button. */}
      <div className='mt-4 flex flex-wrap items-center gap-2'>
        <label
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 focus-within:border-nvr-cyan sm:max-w-[16rem] dark:border-border dark:bg-background',
            phone && 'basis-full'
          )}
        >
          <Search className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            placeholder='Search requests or #id'
            aria-label='Search requests'
            className='min-w-0 flex-1 bg-transparent text-[12.5px] text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100'
          />
          {search && (
            <button
              type='button'
              onClick={() => setSearch('')}
              aria-label='Clear search'
              className='rounded p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
            >
              <X className='h-3 w-3' />
            </button>
          )}
        </label>
        {phone ? (
          <button
            type='button'
            data-support-filters-toggle
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
            className={cn(
              PICK_TRIGGER,
              filterCount > 0 && 'border-nvr-cyan/60 text-nvr-navy dark:text-nvr-cyan'
            )}
          >
            <SlidersHorizontal className='h-3.5 w-3.5' />
            Filters
            {filterCount > 0 && (
              <span className='rounded-full bg-nvr-cyan/15 px-1.5 text-[10.5px] font-semibold tabular-nums'>
                {filterCount}
              </span>
            )}
          </button>
        ) : (
          filterControls
        )}
        {!phone && filterCount + (search ? 1 : 0) > 0 && (
          <button
            type='button'
            data-support-clear
            onClick={clear}
            className='h-8 px-1 text-[12px] text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-muted-foreground dark:hover:text-slate-100'
          >
            Clear filters
          </button>
        )}
        <div className='ml-auto flex items-center gap-1.5'>
          <span className='hidden text-[12px] text-slate-500 sm:inline dark:text-muted-foreground'>
            Sort
          </span>
          <SimpleSelect
            value={filters.sort}
            onChange={(v) => sortBy(v as TicketSort)}
            options={SORTS}
            ariaLabel='Sort'
            className={SELECT_TRIGGER}
            triggerProps={{ 'data-support-sort': filters.sort }}
          />
        </div>
      </div>
      {phone && filtersOpen && (
        <div
          className='mt-2 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
          data-support-filters-panel
        >
          {filterControls}
          {filterCount > 0 && (
            <button
              type='button'
              onClick={clear}
              className='justify-self-start text-[12px] text-slate-500 underline underline-offset-2 dark:text-muted-foreground'
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {desk && workload && (
        <WorkloadStrip
          workload={workload}
          active={filters.assignee}
          onPick={(v) => setFilters({ assignee: filters.assignee === v ? '' : v })}
        />
      )}

      <div
        ref={listRef}
        className='mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      >
        {list.isLoading ? (
          <div className='space-y-2 p-4' aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className='h-9 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
            ))}
          </div>
        ) : list.isError && !list.data ? (
          <div className='p-4'>
            <ErrorNotice
              error={list.error}
              what='the requests'
              onRetry={() => void list.refetch()}
            />
          </div>
        ) : !rows.length ? (
          <EmptyList
            tab={tab}
            filtered={filterCount > 0 || !!search.trim()}
            unassignedOnly={filters.assignee === 'unassigned'}
            closed={['closed', 'done', 'cancelled'].includes(filters.status)}
            onClear={clear}
          />
        ) : phone ? (
          <ul className='divide-y divide-slate-100 dark:divide-border/60' data-support-list>
            {rows.map(({ row: t, state }) => (
              <TicketCard
                key={t.id}
                t={t}
                desk={desk}
                departed={state === 'departed'}
                open={openId === t.id}
                selected={selected.has(t.id)}
                onToggle={() => toggle(t.id)}
                onOpen={() => onOpen(t.id)}
              />
            ))}
          </ul>
        ) : (
          <table className='w-full table-fixed text-[12.5px]' data-support-list>
            <thead>
              <tr className='border-b border-slate-200 bg-slate-50 text-left text-[11.5px] text-slate-500 dark:border-border dark:bg-white/[0.03] dark:text-muted-foreground'>
                {desk && (
                  <th className='w-9 py-2 pl-3 pr-0'>
                    <input
                      type='checkbox'
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label={
                        allSelected ? 'Clear selection' : 'Select every request on this page'
                      }
                      className='h-3.5 w-3.5 cursor-pointer align-middle accent-nvr-navy dark:accent-nvr-cyan'
                    />
                  </th>
                )}
                <SortTh
                  className='w-16'
                  label='#'
                  active={filters.sort === 'newest' || filters.sort === 'oldest'}
                  dir={filters.sort === 'oldest' ? 'asc' : 'desc'}
                  onClick={() => sortBy(filters.sort === 'newest' ? 'oldest' : 'newest')}
                  tip='Sort by when it was raised'
                />
                <th className='px-3 py-2 font-medium'>Request</th>
                {desk && (
                  <th className='hidden w-[15%] px-3 py-2 font-medium lg:table-cell'>Requester</th>
                )}
                <th className='w-[17%] px-3 py-2 font-medium'>{desk ? 'Assignee' : 'With'}</th>
                <th className='w-28 px-3 py-2 font-medium'>Status</th>
                <SortTh
                  className='w-24'
                  label='Priority'
                  active={filters.sort === 'priority'}
                  dir='desc'
                  onClick={() => sortBy('priority')}
                  tip='Urgent first'
                />
                {desk ? (
                  <SortTh
                    className='w-24 pr-4 text-right'
                    label='Waiting'
                    active={filters.sort === 'attention'}
                    dir='desc'
                    onClick={() => sortBy('attention')}
                    tip='Needs attention: urgent, then unassigned, then longest waiting'
                    right
                  />
                ) : (
                  <SortTh
                    className='w-24 pr-4 text-right'
                    label='Updated'
                    active={filters.sort === 'updated'}
                    dir='desc'
                    onClick={() => sortBy('updated')}
                    tip='Latest activity first'
                    right
                  />
                )}
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
              {rows.map(({ row: t, state }) => (
                <TicketRow
                  key={t.id}
                  t={t}
                  desk={desk}
                  departed={state === 'departed'}
                  open={openId === t.id}
                  selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onOpen={() => onOpen(t.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > 0 && (
        <div className='mt-2 flex items-center gap-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          <span className='tabular-nums'>
            {total <= PAGE
              ? `${total} request${total === 1 ? '' : 's'}`
              : `${(page - 1) * PAGE + 1}–${Math.min(page * PAGE, total)} of ${total}`}
          </span>
          {pages > 1 && (
            <span className='flex items-center gap-1'>
              <button
                type='button'
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className='rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-white/5'
              >
                Previous
              </button>
              <button
                type='button'
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                className='rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-white/5'
              >
                Next
              </button>
            </span>
          )}
          {result && !selected.size && (
            <span
              className='text-slate-700 dark:text-slate-200'
              data-support-bulk-result
              role='status'
            >
              {result}
            </span>
          )}
        </div>
      )}

      {desk && selected.size > 0 && (
        <BulkBar
          count={selected.size}
          busy={bulk.isPending}
          people={people}
          onRun={runBulk}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  )
}

function SortTh({
  label,
  active,
  dir,
  onClick,
  tip,
  className,
  right
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  onClick: () => void
  tip: string
  className?: string
  right?: boolean
}) {
  const Icon = dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th
      className={cn('px-3 py-2 font-medium', className)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type='button'
        onClick={onClick}
        data-tip={tip}
        className={cn(
          'inline-flex items-center gap-1 rounded hover:text-slate-900 dark:hover:text-slate-100',
          right && 'flex-row-reverse',
          active && 'text-slate-900 dark:text-slate-100'
        )}
      >
        {label}
        <Icon className={cn('h-3 w-3', active ? 'opacity-80' : 'opacity-0')} />
      </button>
    </th>
  )
}

function WaitingCell({ t, desk }: { t: SupportTicket; desk: boolean }) {
  const closed = CLOSED.has(t.status)
  const at = closed
    ? (t.completed_at ?? t.updated_at ?? t.created_at)
    : desk
      ? (t.waiting_since ?? t.created_at)
      : (t.updated_at ?? t.created_at)
  const label = closed
    ? `Closed ${exactTime(at)}`
    : desk
      ? `Waiting since ${exactTime(at)}`
      : `Updated ${exactTime(at)}`
  return (
    <time
      dateTime={at ?? undefined}
      data-tip={label}
      className='relative tabular-nums text-slate-500 dark:text-muted-foreground'
    >
      {shortAgo(at)}
      <span className='sr-only'> ({label})</span>
    </time>
  )
}

function Priority({ p }: { p: SupportTicket['priority'] }) {
  if (p === 'urgent')
    return (
      <span className='inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400'>
        <AlertTriangle className='h-3 w-3' /> Urgent
      </span>
    )
  return <span className='text-slate-500 capitalize dark:text-muted-foreground'>{p}</span>
}

function Assignee({ t }: { t: SupportTicket }) {
  if (!t.assignee)
    return (
      <span className='inline-flex items-center rounded-full border border-dashed border-slate-300 px-2 py-px text-[11.5px] text-slate-500 dark:border-slate-600 dark:text-muted-foreground'>
        Unassigned
      </span>
    )
  return (
    <span className='flex min-w-0 items-center gap-1.5'>
      <PersonDisc id={t.assignee} name={t.assignee_name} />
      <span className='truncate text-slate-700 dark:text-slate-200'>
        {t.assignee_name ?? 'Someone'}
      </span>
    </span>
  )
}

function secondLine(t: SupportTicket, withRequester: boolean): string {
  return [
    t.record_label ?? 'General Support',
    t.category_name,
    withRequester ? t.requester_name : null,
    t.replies ? `${t.replies} repl${t.replies === 1 ? 'y' : 'ies'}` : null
  ]
    .filter(Boolean)
    .join(' · ')
}

interface RowProps {
  t: SupportTicket
  desk: boolean
  departed: boolean
  open: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}

function TicketRow({ t, desk, departed, open, selected, onToggle, onOpen }: RowProps) {
  return (
    <tr
      data-support-row={t.id}
      data-departed={departed || undefined}
      onClick={onOpen}
      className={cn(
        'cursor-pointer align-middle',
        selected
          ? 'bg-[#ecfbff] dark:bg-[#0f2a33]'
          : open
            ? 'bg-slate-50 dark:bg-white/[0.04]'
            : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
        departed && 'opacity-50'
      )}
    >
      {desk && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: only stops the row's open; the checkbox is the keyboard control
        <td className='py-2 pl-3 pr-0' onClick={(e) => e.stopPropagation()}>
          <input
            type='checkbox'
            checked={selected}
            onChange={onToggle}
            disabled={departed}
            aria-label={`Select request ${t.id}`}
            className='h-3.5 w-3.5 cursor-pointer align-middle accent-nvr-navy dark:accent-nvr-cyan'
          />
        </td>
      )}
      <td className='px-3 py-2 font-mono text-[11.5px] tabular-nums text-slate-400'>{t.id}</td>
      <td className='min-w-0 px-3 py-2'>
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          className='block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan rounded'
        >
          <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-slate-100'>
            {t.title}
          </span>
          <span className='mt-0.5 block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {secondLine(t, false)}
          </span>
        </button>
      </td>
      {desk && (
        <td className='hidden truncate px-3 py-2 text-slate-700 lg:table-cell dark:text-slate-200'>
          {t.requester_name ?? '—'}
        </td>
      )}
      <td className='px-3 py-2'>
        <Assignee t={t} />
      </td>
      <td className='px-3 py-2'>
        <StatusPill status={t.status} label={t.status_label} />
      </td>
      <td className='px-3 py-2'>
        <Priority p={t.priority} />
      </td>
      <td className='py-2 pl-3 pr-4 text-right'>
        <WaitingCell t={t} desk={desk} />
      </td>
    </tr>
  )
}

function TicketCard({ t, desk, departed, open, selected, onToggle, onOpen }: RowProps) {
  return (
    <li
      data-support-row={t.id}
      data-departed={departed || undefined}
      className={cn(
        'flex gap-3 px-3 py-3',
        selected ? 'bg-[#ecfbff] dark:bg-[#0f2a33]' : open && 'bg-slate-50 dark:bg-white/[0.04]',
        departed && 'opacity-50'
      )}
    >
      {desk && (
        <input
          type='checkbox'
          checked={selected}
          onChange={onToggle}
          disabled={departed}
          aria-label={`Select request ${t.id}`}
          className='mt-0.5 h-4 w-4 shrink-0 accent-nvr-navy dark:accent-nvr-cyan'
        />
      )}
      <button type='button' onClick={onOpen} className='min-w-0 flex-1 text-left'>
        <span className='flex items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          <span className='font-mono tabular-nums'>#{t.id}</span>
          {t.priority === 'urgent' && <Priority p='urgent' />}
          <span className='ml-auto flex items-center gap-2'>
            <WaitingCell t={t} desk={desk} />
            <StatusPill status={t.status} label={t.status_label} />
          </span>
        </span>
        <span className='mt-1 line-clamp-2 block text-[13.5px] font-medium text-slate-900 dark:text-slate-100'>
          {t.title}
        </span>
        <span className='mt-0.5 block truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
          {secondLine(t, desk)}
        </span>
        <span className='mt-1.5 block text-[12px]'>
          <Assignee t={t} />
        </span>
      </button>
    </li>
  )
}

function WorkloadStrip({
  workload,
  active,
  onPick
}: {
  workload: SupportWorkload
  active: string
  onPick: (v: string) => void
}) {
  const chip = (on: boolean) =>
    cn(
      'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-1 pr-2.5 text-[12px] transition-colors',
      on
        ? 'border-nvr-cyan/70 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:border-slate-500'
    )
  const count = (n: number) => (
    <span className='font-semibold tabular-nums text-slate-900 dark:text-slate-100'>{n}</span>
  )
  const tip = (open: number, urgent: number, oldest: string | null) =>
    [
      `${open} open`,
      urgent ? `${urgent} urgent` : null,
      oldest ? `longest waiting ${shortAgo(oldest)}` : null
    ]
      .filter(Boolean)
      .join(' · ')
  const u = workload.unassigned
  if (!u.open && !workload.assignees.length) return null
  return (
    <div
      className='mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:thin]'
      data-support-workload
    >
      <span className='mr-1 shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Who has what
      </span>
      <button
        type='button'
        data-support-workload-chip='unassigned'
        aria-pressed={active === 'unassigned'}
        data-tip={tip(u.open, u.urgent, u.oldest_waiting)}
        onClick={() => onPick('unassigned')}
        className={cn(chip(active === 'unassigned'), 'pl-2.5')}
      >
        Unassigned {count(u.open)}
        {u.urgent > 0 && <span className='h-1.5 w-1.5 rounded-full bg-red-500' aria-hidden />}
      </button>
      {workload.assignees.map((a) => (
        <button
          key={a.id}
          type='button'
          data-support-workload-chip={a.id}
          aria-pressed={active === a.id}
          data-tip={`${a.name}: ${tip(a.open, a.urgent, a.oldest_waiting)}${a.active ? '' : ' · no longer active'}`}
          onClick={() => onPick(a.id)}
          className={cn(chip(active === a.id), !a.active && 'opacity-70')}
        >
          <PersonDisc id={a.id} name={a.name} size={20} />
          <span className='max-w-[9rem] truncate'>{a.name}</span>
          {count(a.open)}
          {a.urgent > 0 && <span className='h-1.5 w-1.5 rounded-full bg-red-500' aria-hidden />}
        </button>
      ))}
    </div>
  )
}

function BulkBar({
  count,
  busy,
  people,
  onRun,
  onClear
}: {
  count: number
  busy: boolean
  people: PickChoice[]
  onRun: (a: BulkAction) => void
  onClear: () => void
}) {
  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-white/10'
  const armed = '!bg-red-600 !text-white hover:!bg-red-700'
  return (
    <div
      data-support-bulk-bar
      className='sticky bottom-0 z-10 mt-3 flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 shadow-[0_-2px_12px_rgba(15,23,42,0.08)] max-md:-mx-1 dark:border-border dark:bg-card dark:shadow-[0_-2px_12px_rgba(0,0,0,0.4)]'
    >
      <span className='flex items-center pl-2 pr-1 text-[12.5px] font-semibold tabular-nums text-slate-900 dark:text-slate-100'>
        {count} selected
        <button
          type='button'
          onClick={onClear}
          data-tip='Clear selection'
          aria-label='Clear selection'
          className='ml-1 inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-muted-foreground dark:hover:bg-white/10 dark:hover:text-slate-100'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </span>
      <span className='mx-1 h-5 w-px bg-slate-200 dark:bg-border' aria-hidden />
      <ConfirmButton
        onConfirm={() => onRun({ kind: 'status', status: 'done' })}
        disabled={busy}
        className={btn}
        armedClassName={armed}
        confirmLabel={`Close ${count}?`}
        title='Close as done'
      >
        Close
      </ConfirmButton>
      <ConfirmButton
        onConfirm={() => onRun({ kind: 'status', status: 'cancelled' })}
        disabled={busy}
        className={btn}
        armedClassName={armed}
        confirmLabel={`Cancel ${count}?`}
        title='Cancel the requests'
      >
        Cancel
      </ConfirmButton>
      <PersonPick
        value=''
        ariaLabel='Assign to'
        align='start'
        fixed={[
          { value: 'me', label: 'Me' },
          { value: 'unassigned', label: 'Nobody (back to the desk)' }
        ]}
        people={people}
        onPick={(v, label) =>
          onRun(
            v === 'unassigned'
              ? { kind: 'assign', assignee: null, name: '' }
              : { kind: 'assign', assignee: v, name: v === 'me' ? 'you' : label }
          )
        }
        trigger={
          <button type='button' disabled={busy} className={btn} data-support-bulk-assign>
            Assign to… <PickCaret />
          </button>
        }
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type='button' disabled={busy} className={btn}>
            Status <PickCaret />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='text-[12.5px]'>
          {(
            [
              ['open', 'Open'],
              ['in_progress', 'In progress'],
              ['done', 'Done'],
              ['cancelled', 'Cancelled']
            ] as const
          ).map(([v, l]) => (
            <DropdownMenuItem key={v} onSelect={() => onRun({ kind: 'status', status: v })}>
              {l}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type='button' disabled={busy} className={btn}>
            Priority <PickCaret />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='text-[12.5px]'>
          {(['urgent', 'normal', 'low'] as const).map((p) => (
            <DropdownMenuItem key={p} onSelect={() => onRun({ kind: 'priority', priority: p })}>
              <span className='capitalize'>{p}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function EmptyList({
  tab,
  filtered,
  unassignedOnly,
  closed,
  onClear
}: {
  tab: ListTab
  filtered: boolean
  unassignedOnly: boolean
  closed: boolean
  onClear: () => void
}) {
  const title =
    tab === 'desk'
      ? unassignedOnly
        ? 'Every request has been picked up.'
        : filtered
          ? 'No requests match these filters.'
          : closed
            ? 'Nothing closed yet.'
            : 'No open requests. The desk is clear.'
      : filtered
        ? 'None of your requests match.'
        : closed
          ? 'No closed requests yet.'
          : 'You have no open requests.'
  return (
    <div className='flex flex-col items-center gap-2 px-6 py-12 text-center' data-support-empty>
      <LifeBuoy className='h-6 w-6 text-slate-300 dark:text-slate-600' />
      <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>{title}</p>
      {tab === 'mine' && !filtered && (
        <p className='max-w-sm text-[12px] text-slate-500 dark:text-muted-foreground'>
          Use Get help for anything general, or Request help on a record (beside Save) to ask for a
          change to that record.
        </p>
      )}
      {filtered && (
        <button
          type='button'
          onClick={onClear}
          className='text-[12px] font-medium text-nvr-navy underline underline-offset-2 dark:text-nvr-cyan'
        >
          Clear filters
        </button>
      )}
    </div>
  )
}
