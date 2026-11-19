import { LoadErrorNote, TrackerChip } from '@nivaro/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import type { MouseEvent } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { SeverityDot, SourceTag, StatusBadge } from '../issues/badges'
import { SuggestedChip } from '../issues/GitlabSection'
import { useIssueGitlab } from '../issues/gitlab'
import { useIssueLabels } from '../issues/issue-display'
import { localDayStart } from './api'
import {
  cardCounts,
  effectiveFilter,
  filterOptions,
  type IssueRowInput,
  type IssueRowView,
  type IssuesFilter,
  issueLink,
  issueRowView,
  listQuery,
  pageLink,
  ROW_CAP,
  readStoredFilter,
  type SeverityCount,
  writeStoredFilter
} from './issues-model'
import { useOverviewLiveRefresh } from './live-refresh'
import { Bone, EmptyNote, Section, SectionLink } from './parts'
import type { OverviewSectionProps } from './registry'
import { fmt } from './text'

/**
 * Issues (administrators) — the open issue log on the Overview, built like "Your work": what is
 * open by severity in the heading, a quick filter (remembered per person), the issues seen most
 * recently with how often they happened, to how many people, from where, and whether GitLab
 * has them. Compact rows in the side column, a table in the main column (Customize moves it).
 * Every row opens the issue on /issues, filtered like the card.
 */

const ISSUES_KEY = ['overview', 'issues'] as const

/** The table needs this much card width; narrower (a busy main column, a phone) reads compact. */
const TABLE_MIN_WIDTH = 760

/** The element's width, null until measured (no ResizeObserver = never measured). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

interface ListAnswer {
  rows: IssueRowInput[]
  total: number
}

const SEVERITY_TONE: Record<string, string> = {
  critical: 'text-red-700 dark:text-red-400',
  high: 'text-orange-700 dark:text-orange-400',
  medium: 'text-amber-700 dark:text-amber-300',
  low: 'text-slate-600 dark:text-slate-400'
}

const EMPTY_TEXT: Record<IssuesFilter, string> = {
  open: 'No open issues. Server errors, browser crashes and reported problems land here first.',
  'new-today': 'No issues raised today.',
  linked: 'No open issue is in GitLab yet.',
  unlinked: 'Every open issue is in GitLab.',
  suggested: 'No rule suggests sending an open issue to GitLab.'
}

/** A click anywhere on a row opens the issue, unless it landed on a link or button inside it. */
function rowClick(navigate: (to: string) => void, to: string) {
  return (e: MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.button !== 0) return
    if ((e.target as HTMLElement).closest('a,button')) return
    if (window.getSelection()?.toString()) return
    navigate(to)
  }
}

function SeverityMark({ severity }: { severity: string }) {
  return (
    <span className='flex shrink-0' data-tip={`${severity} severity`}>
      <SeverityDot severity={severity} />
      <span className='sr-only'>{severity} severity</span>
    </span>
  )
}

function LastSeen({ iso, className }: { iso: string; className?: string }) {
  return (
    <time
      dateTime={iso}
      data-tip={`Last seen ${formatDateTime(iso)}`}
      className={cn(
        'shrink-0 tabular-nums text-[11px] text-slate-500 dark:text-slate-400',
        className
      )}
    >
      {formatRelative(iso)}
    </time>
  )
}

export function appTip(row: IssueRowView): string | null {
  if (!row.app) return null
  return row.release ? `${row.app}, build ${row.release}` : row.app
}

export function AppTag({ row }: { row: IssueRowView }) {
  if (!row.app) return null
  return (
    <span
      data-tip={appTip(row) ?? undefined}
      className='max-w-[7rem] truncate whitespace-nowrap rounded border border-slate-200 px-1.5 py-px text-[10.5px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
    >
      {row.app}
    </span>
  )
}

export function GitlabCell({ row }: { row: IssueRowView }) {
  if (!row.gitlab) return null
  if (row.gitlab.kind === 'linked') return <TrackerChip tracker={row.gitlab.tracker} />
  if (row.gitlab.kind === 'suggested') return <SuggestedChip />
  return (
    <span
      data-issue-not-in-gitlab
      data-tip='Not sent to GitLab. Open the issue to send it.'
      className='whitespace-nowrap text-[11px] text-slate-500 dark:text-slate-400'
    >
      Not in GitLab
    </span>
  )
}

function TitleLink({ row, to }: { row: IssueRowView; to: string }) {
  return (
    <Link
      to={to}
      data-tip={row.fullTitle}
      className='min-w-0 truncate rounded text-[12.5px] font-medium text-slate-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-100'
    >
      {row.headline}
    </Link>
  )
}

const ROW_HOVER =
  'cursor-pointer hover:bg-slate-50 focus-within:bg-slate-50 dark:hover:bg-white/[0.04] dark:focus-within:bg-white/[0.04]'

/** Side column: two lines — what and when, then status, how often, from where, GitLab. */
function CompactRow({
  row,
  to,
  onOpen
}: {
  row: IssueRowView
  to: string
  onOpen: (e: MouseEvent<HTMLElement>) => void
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link is the keyboard way in; the row click only widens the mouse target
    <li data-issue-row={row.id} onClick={onOpen} className={cn('px-4 py-2', ROW_HOVER)}>
      <div className='flex items-start gap-2.5'>
        <span className='pt-[5px]'>
          <SeverityMark severity={row.severity} />
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex min-w-0 items-baseline justify-between gap-3'>
            <TitleLink row={row} to={to} />
            <LastSeen iso={row.lastSeen} />
          </div>
          {/* One line, always: status and GitLab never shrink; the source tag gives way first
              (truncates), then the counts. The app and build ride the source tag's tip. */}
          <div className='mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
            <span className='flex shrink-0'>
              <StatusBadge status={row.status} />
            </span>
            <span className='min-w-0 shrink truncate tabular-nums' data-tip={row.countText}>
              {row.countText}
            </span>
            {row.sourceLabel && (
              <span
                data-tip={appTip(row) ?? row.sourceLabel}
                className='min-w-[2.25rem] shrink-[20] truncate whitespace-nowrap rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground'
              >
                {row.sourceLabel}
              </span>
            )}
            {row.gitlab && (
              <span className='ml-auto flex shrink-0 pl-1'>
                <GitlabCell row={row} />
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

/** Main column (when wide enough): one row per issue, aligned in columns. */
function TableRow({
  row,
  to,
  grid,
  onOpen
}: {
  row: IssueRowView
  to: string
  grid: string
  onOpen: (e: MouseEvent<HTMLElement>) => void
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link is the keyboard way in; the row click only widens the mouse target
    <li
      data-issue-row={row.id}
      onClick={onOpen}
      className={cn('grid items-center gap-x-3 px-4 py-2', grid, ROW_HOVER)}
    >
      <div className='flex min-w-0 items-start gap-2.5'>
        <span className='pt-[5px]'>
          <SeverityMark severity={row.severity} />
        </span>
        <div className='flex min-w-0 flex-col'>
          <TitleLink row={row} to={to} />
          {row.description && (
            <span className='truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
              {row.description}
            </span>
          )}
        </div>
      </div>
      <div>
        <StatusBadge status={row.status} />
      </div>
      <div className='text-[11.5px] tabular-nums text-slate-700 dark:text-slate-200'>
        {row.countText}
      </div>
      <div className='flex min-w-0 items-center gap-1.5'>
        <SourceTag source={row.source} place={row.sourceLabel} />
        <AppTag row={row} />
      </div>
      {row.gitlab && (
        <div className='flex min-w-0'>
          <GitlabCell row={row} />
        </div>
      )}
      <LastSeen iso={row.lastSeen} className='text-right' />
    </li>
  )
}

function FilterStrip({
  value,
  options,
  compact,
  onChange
}: {
  value: IssuesFilter
  options: ReturnType<typeof filterOptions>
  /** Side column: short labels, tighter spacing; one line that scrolls sideways if it must. */
  compact: boolean
  onChange: (f: IssuesFilter) => void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form fieldset
    <div
      role='group'
      aria-label='Show issues'
      className={cn(
        'flex overflow-x-auto whitespace-nowrap border-b border-slate-100 py-2 [scrollbar-width:none] dark:border-border/60 [&::-webkit-scrollbar]:hidden',
        compact ? 'gap-0.5 px-2.5' : 'gap-1 px-3'
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          aria-pressed={value === o.value}
          aria-label={compact && o.short ? o.label : undefined}
          data-tip={compact && o.short ? o.label : undefined}
          data-issues-filter={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'shrink-0 rounded py-0.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60',
            compact ? 'px-1.5' : 'px-2',
            value === o.value
              ? 'bg-nvr-cyan/15 text-slate-900 dark:text-slate-50'
              : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100'
          )}
        >
          {compact && o.short ? o.short : o.label}
        </button>
      ))}
    </div>
  )
}

function HeadingCounts({ severities, open }: { severities: SeverityCount[]; open: number }) {
  if (open === 0 && severities.length === 0) return null
  const loud = severities.filter((c) => c.severity === 'critical' || c.severity === 'high')
  return (
    <span className='inline-flex flex-wrap items-center gap-x-2.5 text-[11.5px] font-medium'>
      {loud.map((c) => (
        <span
          key={c.severity}
          className={cn('inline-flex items-center gap-1 tabular-nums', SEVERITY_TONE[c.severity])}
        >
          <SeverityDot severity={c.severity} />
          {fmt(c.n)} {c.severity}
        </span>
      ))}
      <span className='tabular-nums font-normal text-slate-500 dark:text-slate-400'>
        {fmt(open)} open
      </span>
    </span>
  )
}

export function IssuesSection({ userId, column = 'side' }: Partial<OverviewSectionProps>) {
  const navigate = useNavigate()
  const gitlab = useIssueGitlab()
  const [stored, setStored] = useState(() => readStoredFilter(userId ?? ''))
  const filter = effectiveFilter(stored, gitlab.adminTools)
  const options = filterOptions(gitlab.adminTools)
  const choose = (f: IssuesFilter) => {
    setStored(f)
    writeStoredFilter(userId ?? '', f)
  }

  const cap = ROW_CAP[column]
  const dayStart = localDayStart()
  const qs = listQuery(filter, { limit: cap, dayStart })
  const list = useQuery<ListAnswer>({
    queryKey: [...ISSUES_KEY, 'list', qs],
    queryFn: () =>
      api.get<{ data: IssueRowInput[]; meta?: { total?: number } }>(`/issues?${qs}`).then((r) => {
        const rows = Array.isArray(r.data?.data) ? r.data.data : []
        return { rows, total: Number(r.data?.meta?.total ?? rows.length) || rows.length }
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData
  })
  const summary = useQuery({
    queryKey: [...ISSUES_KEY, 'summary'],
    queryFn: () => api.get<{ data: unknown }>('/issues/summary').then((r) => r.data?.data ?? null),
    staleTime: 60_000
  })
  // The issue log's own topic: a new or changed issue re-reads the card, at most every 15 s.
  useOverviewLiveRefresh({ queryKey: [...ISSUES_KEY], topic: 'issues', gapMs: 15_000 })

  const listed = (list.data?.rows ?? []).slice(0, cap)
  const titleLabels = useIssueLabels(listed)
  const rows = listed.map((i) => issueRowView(i, gitlab.on, titleLabels))
  // Heading "N open" and footer "N more" come from the same answers (see cardCounts).
  const counts = cardCounts({
    summary: summary.data,
    filter,
    listTotal: list.data?.total ?? null,
    shown: rows.length
  })
  const more = counts.more
  // The column decides first; the card's own width has the last word (a main column squeezed
  // by an open side panel reads compact rather than crushing the title).
  const [bodyRef, width] = useWidth<HTMLDivElement>()
  const table = column === 'main' && (width == null || width >= TABLE_MIN_WIDTH)
  const grid = gitlab.on
    ? 'grid-cols-[minmax(0,1fr)_92px_112px_minmax(80px,150px)_116px_64px]'
    : 'grid-cols-[minmax(0,1fr)_92px_112px_minmax(80px,170px)_64px]'

  return (
    <Section
      id='issues'
      title={
        <span className='inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5'>
          Issues
          <HeadingCounts severities={counts.severities} open={counts.open} />
        </span>
      }
      action={
        <SectionLink to={pageLink(filter)}>
          <span className='inline-flex items-center gap-1'>
            Open Issues
            <ArrowRight className='h-3 w-3' aria-hidden />
          </span>
        </SectionLink>
      }
    >
      <div ref={bodyRef} data-issues-layout={table ? 'table' : 'compact'}>
        {options.length > 1 && (
          <FilterStrip value={filter} options={options} compact={!table} onChange={choose} />
        )}
        {list.isLoading ? (
          <div className='space-y-3.5 p-4' aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className='flex items-start gap-2.5'>
                <Bone className='mt-1 h-2 w-2 rounded-full' />
                <div className='flex-1 space-y-1.5'>
                  <Bone className={cn('h-3.5', i % 2 ? 'w-3/5' : 'w-4/5')} />
                  <Bone className='h-3 w-2/5' />
                </div>
                <Bone className='h-3 w-10' />
              </div>
            ))}
          </div>
        ) : list.error && !list.data ? (
          <div className='p-4'>
            <LoadErrorNote error={list.error} what='issues' onRetry={() => void list.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyNote
            action={
              filter === 'open'
                ? { label: 'See the whole issue log', to: '/issues?status=' }
                : { label: 'Show all open issues', onClick: () => choose('open') }
            }
          >
            {EMPTY_TEXT[filter]}
          </EmptyNote>
        ) : (
          <>
            {table && (
              <div
                aria-hidden
                className={cn(
                  'grid gap-x-3 border-b border-slate-100 bg-slate-50/70 px-4 py-1.5 text-[11px] font-medium text-slate-500 dark:border-border/60 dark:bg-white/[0.02] dark:text-slate-400',
                  grid
                )}
              >
                <span className='pl-[18px]'>Issue</span>
                <span>Status</span>
                <span>Happened</span>
                <span>Source</span>
                {gitlab.on && <span>GitLab</span>}
                <span className='text-right'>Last seen</span>
              </div>
            )}
            <ul
              aria-label='Issues'
              className={cn(
                'divide-y divide-slate-100 dark:divide-border/60',
                list.isPlaceholderData && 'opacity-60 transition-opacity'
              )}
            >
              {rows.map((row) => {
                const to = issueLink(row.id, filter)
                const onOpen = rowClick(navigate, to)
                return table ? (
                  <TableRow key={row.id} row={row} to={to} grid={grid} onOpen={onOpen} />
                ) : (
                  <CompactRow key={row.id} row={row} to={to} onOpen={onOpen} />
                )
              })}
            </ul>
            {more > 0 && (
              <div className='border-t border-slate-100 px-4 py-2 dark:border-border/60'>
                <SectionLink to={pageLink(filter)}>{fmt(more)} more in the issue log</SectionLink>
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  )
}
