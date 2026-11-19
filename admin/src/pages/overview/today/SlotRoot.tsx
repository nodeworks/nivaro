import { ErrorNotice } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, CircleCheck, CircleX, ExternalLink, Search, Timer, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import type { TodayDrill } from './model'
import {
  cadenceWords,
  durationWords,
  filterSlotMarks,
  groupSlotMarks,
  isFiltered,
  jobTag,
  KIND_LABEL,
  kindCounts,
  type LookItem,
  markTitle,
  needsALook,
  outcomeOf,
  outcomeWords,
  SLOT_KINDS,
  type SlotFilters,
  type SlotGroup,
  type SlotMark,
  type SlotOutcome,
  type SlotSort,
  slotJobs,
  slotPeople,
  slowRunIds,
  sortGroups,
  sortSlotMarks
} from './slot-model'
import type { TodayCtx } from './TodaySheet'

/**
 * One half-hour slot of "Today on this instance" (GET /overview/timeline/slot, read from the
 * strip's own remembered answer, so the count matches the bar). Leads with what needs a look —
 * failures, then runs far slower than their job usually is — then a count per kind, then the
 * events with identical routine runs folded into one line ("Staged imports · 18 runs · all
 * succeeded · every ~10 s"). Search, kind, outcome, job, person, sort and view live in the URL
 * (`td_*`), so Back from a run returns to the same narrowed list. Every row drills to its last
 * leaf: a run → its detail and log, a config change → its activity entry, an import or deploy →
 * its own page.
 */

interface Slot {
  start: string
  end: string
  total: number
  marks: SlotMark[]
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const clockSec = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })

const FLAT_PAGE = 100
const RUNS_SHOWN = 20

const OUTCOME_DOT: Record<SlotOutcome, string> = {
  failed: 'bg-rose-500 dark:bg-rose-400',
  slow: 'bg-amber-500 dark:bg-amber-400',
  ok: 'bg-emerald-500/70 dark:bg-emerald-400/70'
}
const OUTCOME_WORD: Record<SlotOutcome, string> = { failed: 'Failed', slow: 'Slow', ok: 'OK' }

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
const ROW_HOVER =
  'hover:bg-slate-50 focus-visible:bg-slate-50 dark:hover:bg-white/[0.03] dark:focus-visible:bg-white/[0.05]'

// Grouped and flat column templates (header and rows share them).
const GROUP_COLS =
  'grid-cols-[minmax(0,1fr)_40px_minmax(48px,auto)] sm:grid-cols-[minmax(0,1fr)_60px_150px_76px_64px] md:grid-cols-[minmax(0,1fr)_60px_150px_110px_76px_64px]'
const FLAT_COLS =
  'grid-cols-[68px_minmax(0,1fr)_64px] sm:grid-cols-[80px_64px_minmax(0,1fr)_68px_76px] md:grid-cols-[80px_64px_minmax(0,1fr)_140px_68px_76px]'

export function SlotRoot({ ctx }: { ctx: TodayCtx }) {
  const navigate = useNavigate()
  const at = ctx.drill.at ?? ''
  const q = useQuery({
    queryKey: ['overview', 'timeline', 'slot', at],
    queryFn: () =>
      api
        .get<{ data: Slot }>('/overview/timeline/slot', { params: { start: at } })
        .then((r) => r.data.data),
    enabled: !!at,
    staleTime: 60_000,
    retry: false
  })

  const filters: SlotFilters = { ...ctx.drill.slot, who: ctx.drill.who }
  const setFilters = (patch: Partial<SlotFilters>) => {
    const next = { ...filters, ...patch }
    const { who, ...slot } = next
    const d: TodayDrill = { ...ctx.drill, slot }
    if (who) d.who = who
    else delete d.who
    ctx.go(d, { replace: true })
  }

  const marks = useMemo(() => q.data?.marks ?? [], [q.data])
  const slow = useMemo(() => slowRunIds(marks), [marks])
  const look = useMemo(() => needsALook(marks, slow), [marks, slow])
  const counts = useMemo(() => kindCounts(marks), [marks])
  const jobs = useMemo(() => slotJobs(marks), [marks])
  const people = useMemo(() => slotPeople(marks), [marks])
  // A few hundred marks: filtering and folding on each render is cheaper than keying a memo
  // on the parsed URL (a new object every render).
  const shown = filterSlotMarks(marks, filters, slow)
  const groups = sortGroups(groupSlotMarks(shown, slow), filters.sort)

  const open = (m: SlotMark) => {
    if (m.run_id) ctx.go({ ...ctx.drill, run: m.run_id })
    else if (m.activity_id) ctx.go({ ...ctx.drill, entry: m.activity_id })
    else navigate(m.href)
  }

  // Arrow keys walk the rows (Needs a look + the list); Enter opens the focused one.
  const rootRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const t = e.target as HTMLElement
    if (t.closest('[role="listbox"],[role="combobox"]')) return
    const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-slot-row]') ?? [])]
    if (rows.length === 0) return
    const i = rows.indexOf(t)
    const next =
      e.key === 'ArrowDown'
        ? rows[Math.min(rows.length - 1, i + 1)]
        : i <= 0
          ? rows[0]
          : rows[i - 1]
    e.preventDefault()
    next?.focus()
    next?.scrollIntoView({ block: 'nearest' })
  }

  if (q.isLoading) return <SlotSkeleton />
  if (q.error || !q.data)
    return (
      <div className='p-4'>
        <ErrorNotice
          error={q.error}
          what='this part of the timeline'
          onRetry={() => void q.refetch()}
        />
      </div>
    )

  const failedCount = marks.filter((m) => m.failed).length
  const slowCount = slow.size
  const filtered = isFiltered(filters)
  const presentKinds = SLOT_KINDS.filter((k) => counts[k] > 0)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the row buttons inside
    <div ref={rootRef} onKeyDown={onKeyDown} className='flex flex-col gap-4 p-4'>
      {/* What happened in the window */}
      <section aria-label='This half hour' className='flex flex-col gap-2'>
        <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
          <p className='text-[13px] text-slate-600 dark:text-slate-300'>
            <span className='font-semibold text-slate-900 dark:text-slate-50'>
              {clock(q.data.start)} – {clock(q.data.end)}
            </span>
            {' · '}
            <span className='tabular-nums'>{formatNumber(q.data.total)}</span>{' '}
            {q.data.total === 1 ? 'event' : 'events'}
            {jobs.length > 0 && (
              <>
                {' from '}
                <span className='tabular-nums'>{formatNumber(jobs.length)}</span>{' '}
                {jobs.length === 1 ? 'job' : 'jobs'}
                {presentKinds.length > 1 && ' and more'}
              </>
            )}
          </p>
          <button
            type='button'
            onClick={() => navigate('/jobs/timeline')}
            className={cn(
              'inline-flex items-center gap-1 rounded text-[12px] font-medium text-nvr-cyan hover:underline',
              FOCUS
            )}
          >
            Open the jobs timeline <ExternalLink className='h-3 w-3' aria-hidden />
          </button>
        </div>
        <div className='grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
          <StatCell
            label='Failed'
            value={failedCount}
            tone={failedCount ? 'failed' : undefined}
            disabled={failedCount === 0}
            pressed={filters.outcome === 'failed'}
            onPress={() =>
              setFilters({ outcome: filters.outcome === 'failed' ? undefined : 'failed' })
            }
          />
          <StatCell
            label='Slow'
            hint='At least 3× what the job usually takes here, or over a minute'
            value={slowCount}
            tone={slowCount ? 'slow' : undefined}
            disabled={slowCount === 0}
            pressed={filters.outcome === 'slow'}
            onPress={() => setFilters({ outcome: filters.outcome === 'slow' ? undefined : 'slow' })}
          />
          {SLOT_KINDS.filter((k) => counts[k] > 0 || filters.kinds?.includes(k)).map((k) => (
            <StatCell
              key={k}
              label={KIND_LABEL[k].many}
              value={counts[k]}
              disabled={counts[k] === 0}
              pressed={!!filters.kinds?.includes(k)}
              onPress={() => {
                const cur = filters.kinds ?? []
                const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
                setFilters({ kinds: next.length ? next : undefined })
              }}
            />
          ))}
        </div>
      </section>

      <NeedsALook items={look} onOpen={open} />

      <section aria-label='Events' className='flex flex-col'>
        <Toolbar
          filters={filters}
          setFilters={setFilters}
          jobs={jobs}
          people={people}
          shown={shown.length}
          groups={groups.length}
          total={marks.length}
          onOpenPerson={(id) => ctx.go({ ...ctx.drill, person: id })}
        />
        {shown.length === 0 ? (
          <div className='rounded-b-lg border border-t-0 border-slate-200 bg-white px-4 py-10 text-center dark:border-border dark:bg-card'>
            <p className='text-[13px] text-slate-700 dark:text-slate-200'>
              {marks.length === 0
                ? 'Nothing ran in this half hour.'
                : 'Nothing in this half hour matches.'}
            </p>
            {filtered && (
              <button
                type='button'
                onClick={() =>
                  setFilters({
                    q: undefined,
                    kinds: undefined,
                    outcome: undefined,
                    src: undefined,
                    who: undefined
                  })
                }
                className={cn(
                  'mt-2 rounded text-[12.5px] font-medium text-nvr-cyan hover:underline',
                  FOCUS
                )}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : filters.view === 'all' ? (
          <FlatList marks={shown} sort={filters.sort} slow={slow} onOpen={open} />
        ) : (
          <GroupList groups={groups} slow={slow} onOpen={open} />
        )}
      </section>
    </div>
  )
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function StatCell({
  label,
  value,
  tone,
  hint,
  pressed,
  disabled,
  onPress
}: {
  label: string
  value: number
  tone?: 'failed' | 'slow'
  hint?: string
  pressed: boolean
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <button
      type='button'
      onClick={onPress}
      disabled={disabled && !pressed}
      aria-pressed={pressed}
      data-tip={hint}
      className={cn(
        'flex flex-col items-start gap-0.5 bg-white px-3 py-2 text-left transition-colors dark:bg-card',
        'hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-white dark:hover:bg-white/[0.03] dark:disabled:hover:bg-card',
        'focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60',
        pressed && 'bg-nvr-cyan/[0.08] hover:bg-nvr-cyan/[0.12] dark:bg-nvr-cyan/[0.12]'
      )}
    >
      <span
        className={cn(
          'text-[11.5px]',
          pressed ? 'font-medium text-slate-900 dark:text-slate-50' : 'text-slate-500',
          disabled && !pressed && 'text-slate-400 dark:text-slate-500'
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'text-[18px] font-semibold leading-6 tabular-nums',
          tone === 'failed'
            ? 'text-rose-600 dark:text-rose-400'
            : tone === 'slow'
              ? 'text-amber-600 dark:text-amber-400'
              : disabled
                ? 'text-slate-300 dark:text-slate-600'
                : 'text-slate-900 dark:text-slate-50'
        )}
      >
        {formatNumber(value)}
      </span>
    </button>
  )
}

// ─── Needs a look ────────────────────────────────────────────────────────────

function NeedsALook({ items, onOpen }: { items: LookItem[]; onOpen: (m: SlotMark) => void }) {
  if (items.length === 0)
    return (
      <p className='flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12.5px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'>
        <CircleCheck
          className='h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400'
          aria-hidden
        />
        Only routine runs in this half hour — nothing needs a look.
      </p>
    )
  return (
    <section
      aria-labelledby='slot-look'
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <h3
        id='slot-look'
        className='flex items-center gap-2 border-b border-slate-100 px-4 py-2 text-[12.5px] font-semibold text-slate-900 dark:border-border dark:text-slate-50'
      >
        Needs a look
        <span className='rounded-full bg-rose-50 px-1.5 text-[11px] font-medium tabular-nums text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'>
          {formatNumber(items.length)}
        </span>
      </h3>
      <ul className='divide-y divide-slate-100 dark:divide-border'>
        {items.map((it) => (
          <li key={it.key}>
            <button
              type='button'
              data-slot-row
              onClick={() => onOpen(it.latest)}
              className={cn(
                'group flex w-full items-start gap-3 px-4 py-2.5 text-left',
                ROW_HOVER,
                FOCUS
              )}
            >
              {it.tone === 'failed' ? (
                <CircleX
                  className='mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400'
                  aria-label='Failed'
                />
              ) : (
                <Timer
                  className='mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400'
                  aria-label='Slow'
                />
              )}
              <span className='min-w-0 flex-1'>
                <span className='flex flex-wrap items-baseline gap-x-2'>
                  <span className='text-[13px] font-medium text-slate-900 dark:text-slate-50'>
                    {it.title}
                  </span>
                  <ExtTag tag={jobTag(it.job_id, it.extension)} />
                  <span className='text-[12px] text-slate-500 dark:text-slate-400'>
                    {it.tone === 'failed'
                      ? it.count === 1
                        ? 'failed'
                        : `failed ${it.count}× in this half hour`
                      : it.count === 1
                        ? 'ran slow'
                        : `ran slow ${it.count}×`}
                  </span>
                </span>
                <span
                  className={cn(
                    'mt-0.5 line-clamp-2 break-words text-[12px]',
                    it.tone === 'failed'
                      ? 'text-rose-700 dark:text-rose-300'
                      : 'text-slate-600 dark:text-slate-300'
                  )}
                >
                  {it.tone === 'failed'
                    ? (it.error ?? 'It did not say why — open the run for its log.')
                    : `Took ${durationWords(it.longest_ms)}${it.usual_ms != null ? ` — usually ${durationWords(it.usual_ms)}` : ''}`}
                </span>
              </span>
              <span className='shrink-0 text-right text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'>
                {clockSec(it.latest.at)}
                <span className='block text-nvr-cyan opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'>
                  {it.latest.run_id ? 'Open run' : 'Open'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ExtTag({ tag, wide }: { tag?: { text: string; tip: string }; wide?: boolean }) {
  if (!tag) return null
  return (
    <span
      className={cn(
        // In list rows the name wins on a phone: the tag shows from tablet width up.
        wide ? 'hidden sm:inline-block' : 'inline-block',
        'shrink-0 rounded bg-slate-100 px-1.5 text-[10.5px] font-medium leading-[18px] text-slate-500 dark:bg-white/[0.07] dark:text-slate-400'
      )}
      data-tip={tag.tip}
    >
      {tag.text}
    </span>
  )
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  filters,
  setFilters,
  jobs,
  people,
  shown,
  groups,
  total,
  onOpenPerson
}: {
  filters: SlotFilters
  setFilters: (p: Partial<SlotFilters>) => void
  jobs: Array<{ id: string; name: string; count: number }>
  people: Array<{ id: string; name: string; count: number }>
  shown: number
  groups: number
  total: number
  onOpenPerson: (id: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(filters.q ?? '')
  const urlQ = filters.q ?? ''
  // The URL wins when it changes from outside (Back, a link); typing writes it after a pause.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setText(urlQ)
  }, [urlQ])
  const setRef = useRef(setFilters)
  setRef.current = setFilters
  useEffect(() => {
    if (text === urlQ) return
    const t = setTimeout(() => setRef.current({ q: text.trim() ? text : undefined }), 250)
    return () => clearTimeout(t)
  }, [text, urlQ])
  // "/" jumps to the search box from anywhere in the sheet.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.closest('input,textarea,[contenteditable="true"]') || t.isContentEditable)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = isFiltered(filters)
  const person = filters.who
    ? people.find((p) => p.id.toLowerCase() === filters.who?.toLowerCase())
    : null
  const grouped = filters.view !== 'all'
  return (
    // Sticky from tablet width up; on a phone three rows of controls would eat the screen.
    <div className='relative z-10 -mx-4 bg-slate-50 px-4 pt-1 sm:sticky sm:top-0 dark:bg-background'>
      <div className='flex flex-wrap items-center gap-2 pb-2'>
        <div className='relative min-w-[180px] flex-1 sm:max-w-[280px]'>
          <Search
            className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
            aria-hidden
          />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && text) {
                setText('')
                setFilters({ q: undefined })
              }
              if (e.key === 'ArrowDown') {
                // Straight into the list (past Needs a look, which sits above the search).
                e.preventDefault()
                e.stopPropagation()
                document.querySelector<HTMLElement>('[data-slot-list] [data-slot-row]')?.focus()
              }
            }}
            data-esc-clears
            placeholder='Find a job, error or person'
            aria-label='Find in this half hour'
            className='h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-8 text-[12.5px] placeholder:text-slate-400 focus-visible:border-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/30 dark:border-border dark:bg-card'
          />
          <kbd className='pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-200 px-1 text-[10.5px] leading-4 text-slate-400 dark:border-border'>
            /
          </kbd>
        </div>
        <SimpleSelect
          value={filters.outcome ?? ''}
          onChange={(v) => setFilters({ outcome: (v || undefined) as SlotOutcome | undefined })}
          options={[
            { value: '', label: 'Any outcome' },
            { value: 'failed', label: 'Failed' },
            { value: 'slow', label: 'Slow' },
            { value: 'ok', label: 'Succeeded' }
          ]}
          ariaLabel='Outcome'
          className='h-8 w-[132px] bg-white text-[12.5px] dark:bg-card'
        />
        {jobs.length > 1 && (
          <SimpleSelect
            value={filters.src ?? ''}
            onChange={(v) => setFilters({ src: v || undefined })}
            options={[
              { value: '', label: 'Every job' },
              ...jobs.map((j) => ({ value: j.id, label: `${j.name} (${formatNumber(j.count)})` }))
            ]}
            ariaLabel='Job'
            className='h-8 w-[180px] bg-white text-[12.5px] dark:bg-card'
            contentClassName='max-h-[320px]'
          />
        )}
        {people.length > 0 && (
          <SimpleSelect
            value={filters.who ?? ''}
            onChange={(v) => setFilters({ who: v || undefined })}
            options={[
              { value: '', label: 'Anyone' },
              ...people.map((p) => ({ value: p.id, label: `${p.name} (${formatNumber(p.count)})` }))
            ]}
            ariaLabel='Person'
            className='h-8 w-[160px] bg-white text-[12.5px] dark:bg-card'
          />
        )}
        <SimpleSelect
          value={filters.sort ?? 'new'}
          onChange={(v) => setFilters({ sort: v === 'new' ? undefined : (v as SlotSort) })}
          options={[
            { value: 'new', label: 'Newest first' },
            { value: 'old', label: 'Oldest first' },
            { value: 'long', label: 'Longest first' },
            { value: 'kind', label: 'By kind' },
            ...(grouped ? [{ value: 'count', label: 'Most runs' }] : [])
          ]}
          ariaLabel='Sort'
          className='h-8 w-[132px] bg-white text-[12.5px] dark:bg-card'
        />
        <fieldset className='inline-flex h-8 items-center rounded-md border border-slate-200 bg-white p-0.5 text-[12px] dark:border-border dark:bg-card'>
          <legend className='sr-only'>Show</legend>
          {(
            [
              ['grouped', 'Folded'],
              ['all', 'Every event']
            ] as const
          ).map(([v, label]) => {
            const on = (filters.view ?? 'grouped') === v
            return (
              <button
                key={v}
                type='button'
                aria-pressed={on}
                onClick={() =>
                  setFilters({
                    view: v === 'all' ? 'all' : undefined,
                    sort: v === 'all' && filters.sort === 'count' ? undefined : filters.sort
                  })
                }
                className={cn(
                  'h-full rounded px-2.5 font-medium',
                  FOCUS,
                  on
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-50'
                )}
              >
                {label}
              </button>
            )
          })}
        </fieldset>
      </div>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-[12px] text-slate-500 dark:text-slate-400'>
        <span className='tabular-nums'>
          {filtered
            ? `${formatNumber(shown)} of ${formatNumber(total)} ${total === 1 ? 'event' : 'events'}`
            : `${formatNumber(total)} ${total === 1 ? 'event' : 'events'}`}
          {grouped &&
            shown > groups &&
            ` · folded into ${formatNumber(groups)} ${groups === 1 ? 'row' : 'rows'}`}
        </span>
        {person && (
          <button
            type='button'
            onClick={() => onOpenPerson(person.id)}
            className={cn('rounded font-medium text-nvr-cyan hover:underline', FOCUS)}
          >
            Everything {person.name} did today
          </button>
        )}
        {filtered && (
          <button
            type='button'
            onClick={() => {
              setText('')
              setFilters({
                q: undefined,
                kinds: undefined,
                outcome: undefined,
                src: undefined,
                who: undefined
              })
            }}
            className={cn(
              'inline-flex items-center gap-1 rounded font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-50',
              FOCUS
            )}
          >
            <X className='h-3 w-3' aria-hidden /> Clear filters
          </button>
        )}
      </div>
      {shown > 0 && (grouped ? <GroupHeader /> : <FlatHeader />)}
    </div>
  )
}

const HEAD =
  'grid items-center gap-3 rounded-t-lg border border-slate-200 bg-slate-100/80 px-4 py-1.5 text-[11px] font-medium text-slate-500 dark:border-border dark:bg-[#151b26] dark:text-slate-400'

function GroupHeader() {
  return (
    <div className={cn(HEAD, GROUP_COLS)} aria-hidden>
      <span>What ran</span>
      <span className='text-right'>Runs</span>
      <span>Outcome</span>
      <span className='hidden md:block'>Pace</span>
      <span className='hidden text-right sm:block'>Usually</span>
      <span className='hidden text-right sm:block'>Last</span>
    </div>
  )
}

function FlatHeader() {
  return (
    <div className={cn(HEAD, FLAT_COLS)} aria-hidden>
      <span>Time</span>
      <span className='hidden sm:block'>Kind</span>
      <span>What</span>
      <span className='hidden md:block'>Who</span>
      <span className='hidden text-right sm:block'>Took</span>
      <span>Outcome</span>
    </div>
  )
}

// ─── Lists ───────────────────────────────────────────────────────────────────

const LIST =
  'divide-y divide-slate-100 overflow-hidden rounded-b-lg border border-t-0 border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'

function OutcomeMark({ outcome, label }: { outcome: SlotOutcome; label?: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-[12px]',
        outcome === 'failed'
          ? 'font-medium text-rose-700 dark:text-rose-300'
          : outcome === 'slow'
            ? 'font-medium text-amber-700 dark:text-amber-300'
            : 'text-slate-500 dark:text-slate-400'
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', OUTCOME_DOT[outcome])} aria-hidden />
      <span className='truncate'>{label ?? OUTCOME_WORD[outcome]}</span>
    </span>
  )
}

function GroupList({
  groups,
  slow,
  onOpen
}: {
  groups: SlotGroup[]
  slow: Set<number>
  onOpen: (m: SlotMark) => void
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  const toggle = (k: string) =>
    setOpenKeys((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  return (
    <ul className={LIST} data-slot-list>
      {groups.map((g) => {
        const many = g.count > 1
        const expanded = many && openKeys.has(g.key)
        const outcome: SlotOutcome = g.failed ? 'failed' : g.slow ? 'slow' : 'ok'
        const cadence = cadenceWords(g.cadence_ms)
        return (
          <li key={g.key}>
            <button
              type='button'
              data-slot-row
              aria-expanded={many ? expanded : undefined}
              onClick={() => (many ? toggle(g.key) : onOpen(g.marks[0]))}
              onKeyDown={(e) => {
                if (!many) return
                if (e.key === 'ArrowRight' && !expanded) {
                  e.preventDefault()
                  toggle(g.key)
                } else if (e.key === 'ArrowLeft' && expanded) {
                  e.preventDefault()
                  toggle(g.key)
                }
              }}
              className={cn(
                'group grid w-full items-center gap-3 px-4 py-2 text-left',
                GROUP_COLS,
                ROW_HOVER,
                FOCUS,
                expanded && 'bg-slate-50/70 dark:bg-white/[0.02]'
              )}
            >
              <span className='flex min-w-0 items-center gap-2'>
                <Chevron open={expanded} drill={!many} />
                <span className='min-w-0'>
                  <span className='flex min-w-0 items-center gap-2'>
                    <span
                      className='truncate text-[13px] font-medium text-slate-900 dark:text-slate-50'
                      data-tip={g.description}
                    >
                      {g.title}
                    </span>
                    <ExtTag wide tag={jobTag(g.job_id, g.extension)} />
                  </span>
                  {g.kind !== 'job' && (
                    <span className='block text-[11.5px] text-slate-500 dark:text-slate-400'>
                      {KIND_LABEL[g.kind].one}
                      {!many && g.marks[0].user_name ? ` · ${g.marks[0].user_name}` : ''}
                    </span>
                  )}
                </span>
              </span>
              <span className='text-right text-[12.5px] tabular-nums text-slate-700 dark:text-slate-200'>
                {many ? `${formatNumber(g.count)}×` : '1'}
              </span>
              <OutcomeMark
                outcome={outcome}
                label={
                  outcome === 'ok' ? (
                    <>
                      <span className='sm:hidden'>OK</span>
                      <span className='hidden sm:inline'>{outcomeWords(g)}</span>
                    </>
                  ) : (
                    outcomeWords(g)
                  )
                }
              />
              <span className='hidden text-[12px] text-slate-500 md:block dark:text-slate-400'>
                {cadence ?? '—'}
              </span>
              <span className='hidden text-right text-[12px] tabular-nums text-slate-500 sm:block dark:text-slate-400'>
                {durationWords(g.median_ms)}
              </span>
              <span className='hidden text-right text-[12px] tabular-nums text-slate-500 sm:block dark:text-slate-400'>
                {clock(g.last_at)}
              </span>
            </button>
            {expanded && <GroupRuns group={g} slow={slow} onOpen={onOpen} />}
          </li>
        )
      })}
    </ul>
  )
}

function Chevron({ open, drill }: { open: boolean; drill: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
        drill ? 'text-slate-300 group-hover:text-slate-500 dark:text-slate-600' : 'text-slate-400',
        open && 'rotate-90'
      )}
      aria-hidden
    />
  )
}

function GroupRuns({
  group,
  slow,
  onOpen
}: {
  group: SlotGroup
  slow: Set<number>
  onOpen: (m: SlotMark) => void
}) {
  const [all, setAll] = useState(false)
  const list = all ? group.marks : group.marks.slice(0, RUNS_SHOWN)
  return (
    <div className='border-t border-slate-100 bg-slate-50/60 pb-1.5 dark:border-border dark:bg-white/[0.015]'>
      {group.description && (
        <p className='px-4 pb-1 pl-[42px] pt-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
          {group.description}
        </p>
      )}
      <ol className='pl-[30px]'>
        {list.map((m, i) => {
          const o = outcomeOf(m, slow)
          return (
            <li key={`${m.at}-${m.run_id ?? m.activity_id ?? i}`}>
              <button
                type='button'
                data-slot-row
                onClick={() => onOpen(m)}
                className={cn(
                  'group/run grid w-full grid-cols-[86px_64px_minmax(0,1fr)_14px] items-baseline gap-3 rounded-md px-3 py-1 text-left text-[12px]',
                  'hover:bg-white focus-visible:bg-white dark:hover:bg-white/[0.04] dark:focus-visible:bg-white/[0.05]',
                  FOCUS
                )}
              >
                <span className='tabular-nums text-slate-500 dark:text-slate-400'>
                  {clockSec(m.at)}
                </span>
                <span className='text-right tabular-nums text-slate-600 dark:text-slate-300'>
                  {durationWords(m.duration_ms)}
                </span>
                <span className='flex min-w-0 items-baseline gap-2'>
                  <OutcomeMark outcome={o} />
                  {m.error && (
                    <span className='truncate text-rose-700 dark:text-rose-300' data-tip={m.error}>
                      {m.error}
                    </span>
                  )}
                  {m.manual && (
                    <span className='truncate text-slate-500 dark:text-slate-400'>
                      started by {m.user_name ?? 'a person'}
                    </span>
                  )}
                  {m.kind !== 'job' && m.user_name && (
                    <span className='truncate text-slate-500 dark:text-slate-400'>
                      {m.user_name}
                    </span>
                  )}
                </span>
                <Chevron open={false} drill />
              </button>
            </li>
          )
        })}
      </ol>
      {group.marks.length > RUNS_SHOWN && !all && (
        <button
          type='button'
          onClick={() => setAll(true)}
          className={cn(
            'ml-[42px] mt-1 rounded text-[12px] font-medium text-nvr-cyan hover:underline',
            FOCUS
          )}
        >
          Show all {formatNumber(group.marks.length)} runs
        </button>
      )}
    </div>
  )
}

function FlatList({
  marks,
  sort,
  slow,
  onOpen
}: {
  marks: SlotMark[]
  sort?: SlotSort
  slow: Set<number>
  onOpen: (m: SlotMark) => void
}) {
  const [limit, setLimit] = useState(FLAT_PAGE)
  const sorted = useMemo(() => sortSlotMarks(marks, sort), [marks, sort])
  const list = sorted.slice(0, limit)
  const left = sorted.length - list.length
  return (
    <>
      <ul className={LIST} data-slot-list>
        {list.map((m, i) => {
          const o = outcomeOf(m, slow)
          return (
            <li key={`${m.at}-${m.run_id ?? m.activity_id ?? i}`}>
              <button
                type='button'
                data-slot-row
                onClick={() => onOpen(m)}
                className={cn(
                  'group grid w-full items-center gap-3 px-4 py-1.5 text-left text-[12.5px]',
                  FLAT_COLS,
                  ROW_HOVER,
                  FOCUS
                )}
              >
                <span className='text-[12px] tabular-nums text-slate-500 dark:text-slate-400'>
                  {clockSec(m.at)}
                </span>
                <span className='hidden text-[12px] text-slate-500 sm:block dark:text-slate-400'>
                  {KIND_LABEL[m.kind].one}
                </span>
                <span className='flex min-w-0 items-center gap-2'>
                  <span
                    className='truncate text-slate-900 dark:text-slate-50'
                    data-tip={m.error ?? m.description}
                  >
                    {markTitle(m)}
                  </span>
                  <ExtTag wide tag={jobTag(m.job_id, m.extension)} />
                </span>
                <span className='hidden truncate text-[12px] text-slate-500 md:block dark:text-slate-400'>
                  {m.user_name ?? (m.kind === 'job' ? 'Schedule' : '—')}
                </span>
                <span className='hidden text-right text-[12px] tabular-nums text-slate-600 sm:block dark:text-slate-300'>
                  {durationWords(m.duration_ms)}
                </span>
                <OutcomeMark outcome={o} />
              </button>
            </li>
          )
        })}
      </ul>
      {left > 0 && (
        <button
          type='button'
          onClick={() => setLimit((n) => n + FLAT_PAGE)}
          className={cn(
            'mt-2 self-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-white/[0.04]',
            FOCUS
          )}
        >
          Show {formatNumber(Math.min(FLAT_PAGE, left))} more · {formatNumber(left)} left
        </button>
      )}
    </>
  )
}

function SlotSkeleton() {
  return (
    <div className='flex flex-col gap-4 p-4' aria-busy>
      <span className='sr-only'>Loading this half hour</span>
      <div className='h-4 w-64 animate-pulse rounded bg-slate-200/70 dark:bg-white/[0.06]' />
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6 dark:border-border dark:bg-border'>
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div key={i} className='h-[58px] animate-pulse bg-white dark:bg-card' />
        ))}
      </div>
      <div className='h-16 animate-pulse rounded-lg bg-white dark:bg-card' />
      <div className='space-y-px overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div key={i} className='h-10 animate-pulse bg-white dark:bg-card' />
        ))}
      </div>
    </div>
  )
}
