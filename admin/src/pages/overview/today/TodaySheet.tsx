import {
  type ActivityDrillTarget,
  ActivityEntryDetail,
  ActivityTable,
  type ActivityTableFilters,
  type ActivityTableState,
  DEFAULT_TABLE_STATE,
  recordPhrase,
  useActivityLabels
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import type { OverviewStats } from '../api'
import { IssueLevel, IssuesRoot } from './IssuesLevels'
import { JobsRoot, RunLevel } from './JobsLevels'
import {
  parseTodayDrill,
  ROOT_TITLES,
  type TodayDrill,
  type TodayLevel,
  todayLevels,
  toLevel,
  upOne,
  withTodayDrill
} from './model'
import { PeopleRoot } from './PeopleRoot'
import { RecordsRoot } from './RecordsRoot'
import { SlotRoot } from './SlotRoot'

/**
 * The Overview "Today" drill sheet (`?today=records|people|jobs|issues|slot`). Every Today tile
 * opens it on what the number IS — the same source over the same window (`stats.day_start` →
 * `stats.computed_at`) — and every row goes one level deeper, to the last leaf: a person's
 * activity, a record's changes, a job run, an issue, one activity entry. Breadcrumbs and Back
 * walk up; each depth is a link (the drill lives in the URL).
 */

export interface TodayCtx {
  drill: TodayDrill
  go: (d: TodayDrill | null, opts?: { replace?: boolean }) => void
  stats: OverviewStats
  isAdmin: boolean
  /** The figure's window: its day start → when it was computed. */
  window: { from: string; to: string }
}

/** A table preset locked to the figure's window. */
export function windowLock(ctx: TodayCtx, extra: ActivityTableFilters = {}): ActivityTableFilters {
  return { from: ctx.window.from, to: ctx.window.to, ...extra }
}

/** The shared Activity table inside the sheet: its own state, entries open one level down. */
export function SheetActivityTable({
  ctx,
  locked,
  storageKey
}: {
  ctx: TodayCtx
  locked: ActivityTableFilters
  storageKey: string
}) {
  const [state, setState] = useState<ActivityTableState>({ ...DEFAULT_TABLE_STATE, pageSize: 25 })
  return (
    <ActivityTable
      state={state}
      onStateChange={setState}
      locked={locked}
      storageKey={storageKey}
      onOpenEntry={(id) => ctx.go({ ...ctx.drill, entry: id })}
      className='min-h-[420px]'
    />
  )
}

function PersonLevel({ ctx }: { ctx: TodayCtx }) {
  const id = ctx.drill.person as string
  const navigate = useNavigate()
  const labels = useActivityLabels(useMemo(() => [{ action: 'read', user: id }], [id]))
  const name = labels?.users?.[id] ?? labels?.users?.[id.toLowerCase()] ?? 'This person'
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
          Everything {name} did today, newest first — reads included.
        </p>
        <button
          type='button'
          onClick={() => navigate(`/users/${id}`)}
          className='inline-flex items-center gap-1 text-[12px] font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
        >
          Open profile <ExternalLink className='h-3 w-3' aria-hidden />
        </button>
      </div>
      <SheetActivityTable
        ctx={ctx}
        locked={windowLock(ctx, { users: [id] })}
        storageKey='overview-today-person'
      />
    </div>
  )
}

function RecordLevel({ ctx }: { ctx: TodayCtx }) {
  const rec = ctx.drill.rec as { collection: string; item: string }
  const navigate = useNavigate()
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
          Every change to this record today.
        </p>
        <button
          type='button'
          onClick={() => navigate(`/collections/${rec.collection}/${encodeURIComponent(rec.item)}`)}
          className='inline-flex items-center gap-1 text-[12px] font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
        >
          Open record <ExternalLink className='h-3 w-3' aria-hidden />
        </button>
      </div>
      <SheetActivityTable
        ctx={ctx}
        locked={windowLock(ctx, {
          collections: [rec.collection],
          item: rec.item,
          records_only: ctx.drill.kind === 'records'
        })}
        storageKey='overview-today-record'
      />
    </div>
  )
}

function EntryLevel({ ctx }: { ctx: TodayCtx }) {
  const navigate = useNavigate()
  const onDrill = (t: ActivityDrillTarget) => {
    if (t.person)
      ctx.go({ kind: ctx.drill.kind, tab: ctx.drill.tab, at: ctx.drill.at, person: t.person })
    else if (t.record)
      ctx.go({ kind: ctx.drill.kind, tab: ctx.drill.tab, at: ctx.drill.at, rec: t.record })
    else if (t.group_key)
      navigate(`/activity?view=table&group_key=${encodeURIComponent(t.group_key)}&t_fold=0`)
  }
  return (
    <div className='mx-auto w-full max-w-3xl bg-white sm:my-4 sm:rounded-lg sm:border sm:border-slate-200 dark:bg-card sm:dark:border-border'>
      <ActivityEntryDetail
        key={ctx.drill.entry}
        id={ctx.drill.entry as number}
        onOpenEntry={(id) => ctx.go({ ...ctx.drill, entry: id })}
        onDrill={onDrill}
      />
    </div>
  )
}

function useCrumbName(ctx: TodayCtx, level: TodayLevel): string {
  const d = ctx.drill
  const refs = useMemo(() => {
    const out: Array<{ action: string; user?: string; collection?: string; item?: string }> = []
    if (d.person) out.push({ action: 'read', user: d.person })
    if (d.rec) out.push({ action: 'read', collection: d.rec.collection, item: d.rec.item })
    return out
  }, [d.person, d.rec])
  const labels = useActivityLabels(refs, { enabled: refs.length > 0 })
  switch (level) {
    case 'root':
      return d.kind === 'slot' && d.at
        ? `${new Date(d.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} on this instance`
        : ROOT_TITLES[d.kind]
    case 'person':
      return (
        (d.person && (labels?.users?.[d.person] ?? labels?.users?.[d.person.toLowerCase()])) ||
        'Person'
      )
    case 'record':
      return (d.rec && recordPhrase(d.rec.collection, d.rec.item, labels)) || 'Record'
    case 'run':
      return `Run #${d.run}`
    case 'issue':
      return `Issue #${d.issue}`
    case 'entry':
      return `Entry #${d.entry}`
  }
}

function Crumb({ ctx, level, last }: { ctx: TodayCtx; level: TodayLevel; last: boolean }) {
  const name = useCrumbName(ctx, level)
  return (
    <li className='flex min-w-0 items-center gap-1'>
      {level !== 'root' && (
        <ChevronRight className='h-3 w-3 shrink-0 text-slate-300 dark:text-slate-600' aria-hidden />
      )}
      {last ? (
        <span
          aria-current='page'
          className='truncate font-semibold text-slate-900 dark:text-slate-50'
        >
          {name}
        </span>
      ) : (
        <button
          type='button'
          onClick={() => ctx.go(toLevel(ctx.drill, level))}
          className='truncate text-slate-500 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-400 dark:hover:text-slate-100'
        >
          {name}
        </button>
      )}
    </li>
  )
}

function Body({ ctx }: { ctx: TodayCtx }) {
  const levels = todayLevels(ctx.drill)
  const last = levels[levels.length - 1]
  let node: ReactNode
  switch (last) {
    case 'entry':
      node = <EntryLevel ctx={ctx} />
      break
    case 'person':
      node = <PersonLevel ctx={ctx} />
      break
    case 'record':
      node = <RecordLevel ctx={ctx} />
      break
    case 'run':
      node = <RunLevel ctx={ctx} />
      break
    case 'issue':
      node = <IssueLevel ctx={ctx} />
      break
    default:
      node =
        ctx.drill.kind === 'records' ? (
          <RecordsRoot ctx={ctx} />
        ) : ctx.drill.kind === 'people' ? (
          <PeopleRoot ctx={ctx} />
        ) : ctx.drill.kind === 'jobs' ? (
          <JobsRoot ctx={ctx} />
        ) : ctx.drill.kind === 'issues' ? (
          <IssuesRoot ctx={ctx} />
        ) : (
          <SlotRoot ctx={ctx} />
        )
  }
  // A new depth slides in from the side it came from (reduced motion: no slide). A slot's
  // filters (search, kinds, person…) narrow the same level: they never remount it.
  const { slot: _filters, ...place } = ctx.drill
  if (ctx.drill.kind === 'slot') delete place.who
  return (
    <div
      key={levels.join('/') + JSON.stringify(place)}
      className='nvr-today-level flex min-h-0 flex-1 flex-col'
    >
      {node}
    </div>
  )
}

export function TodaySheet({
  stats,
  isAdmin
}: {
  stats: OverviewStats | undefined
  isAdmin: boolean
}) {
  const [params, setParams] = useSearchParams()
  const drill = parseTodayDrill(params)
  // Only figures the person sees open: a non-administrator has records and issues.
  const allowed = !!drill && (isAdmin || drill.kind === 'records' || drill.kind === 'issues')
  const go = (d: TodayDrill | null, opts?: { replace?: boolean }) =>
    setParams(withTodayDrill(params, d), { replace: opts?.replace })
  const figure = drill && stats ? figureFor(stats, drill.kind) : null
  const ctx: TodayCtx | null =
    drill && stats
      ? {
          drill,
          go,
          stats,
          isAdmin,
          window: { from: stats.day_start, to: stats.computed_at }
        }
      : null
  const levels = drill ? todayLevels(drill) : []
  return (
    <Sheet open={allowed && !!ctx} onOpenChange={(o) => !o && go(null)}>
      <SheetContent
        side='right'
        className='flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1120px,94vw)]'
        data-today-sheet={drill?.kind}
        onEscapeKeyDown={(e) => {
          // Esc in a search box with words in it clears the words, not the sheet.
          const el = document.activeElement
          if (el instanceof HTMLInputElement && 'escClears' in el.dataset && el.value)
            e.preventDefault()
        }}
      >
        {ctx && drill && (
          <>
            <header className='flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2.5 pr-12 dark:border-border dark:bg-card'>
              <button
                type='button'
                onClick={() => {
                  const up = upOne(drill)
                  go(up)
                }}
                aria-label={levels.length > 1 ? 'Back one level' : 'Close'}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-muted hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:hover:text-slate-50',
                  levels.length <= 1 && 'invisible'
                )}
              >
                <ChevronLeft className='h-4 w-4' />
              </button>
              <SheetTitle asChild>
                <nav aria-label='Where you are' className='min-w-0 flex-1'>
                  <ol className='flex min-w-0 items-center gap-1 text-[13px]'>
                    {levels.map((l, i) => (
                      <Crumb key={l} ctx={ctx} level={l} last={i === levels.length - 1} />
                    ))}
                  </ol>
                </nav>
              </SheetTitle>
              <SheetDescription className='sr-only'>
                What the number on the Overview is made of, one level at a time.
              </SheetDescription>
              {figure && levels.length === 1 && (
                <span className='shrink-0 text-[12px] tabular-nums text-slate-500 dark:text-slate-400'>
                  {formatNumber(figure)}
                </span>
              )}
            </header>
            <div className='flex min-h-0 flex-1 flex-col overflow-y-auto bg-slate-50 dark:bg-background'>
              <Body ctx={ctx} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function figureFor(stats: OverviewStats, kind: TodayDrill['kind']): number | null {
  const key =
    kind === 'records'
      ? 'records_changed'
      : kind === 'people'
        ? 'people_active'
        : kind === 'jobs'
          ? 'failed_jobs'
          : kind === 'issues'
            ? 'open_issues'
            : null
  return key ? (stats.figures.find((f) => f.key === key)?.value ?? null) : null
}

/** People online now (presence), for the people sheet's "here now" dot. */
export function useOnlineNow(enabled: boolean) {
  return useQuery({
    queryKey: ['overview', 'today', 'online'],
    queryFn: () =>
      api
        .get<{ data: Array<{ user_id: string; is_idle?: boolean; last_seen: string }> }>(
          '/presence/online'
        )
        .then((r) => new Map((r.data.data ?? []).map((u) => [String(u.user_id).toLowerCase(), u]))),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false
  })
}

/** The URL helper the tiles link with. */
export function todayHref(params: URLSearchParams, d: TodayDrill): string {
  return `?${withTodayDrill(params, d).toString()}`
}
