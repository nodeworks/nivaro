import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Bell,
  ClipboardList,
  Download,
  ListFilter,
  Loader2,
  ScanSearch,
  Send,
  Users
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, humanHours, titleCase } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect, SimpleSelectXs } from '../ui/SimpleSelect'
import { EmptyLine, PersonChip, Pill, SectionCard } from './primitives'
import { errorText, type PersonProfile } from './types'

// ─── Working on ──────────────────────────────────────────────────────────────

interface WorkingOnItem {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_label: string | null
  state_color: string | null
  sla_status: 'ok' | 'warning' | 'breached' | null
  aging_hours: number | null
}

const SLA_TONE: Record<string, string> = {
  breached: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
}

/** The open records this person is a resolved owner of — what waits on them. */
const WORKING_ON_FETCH = 500
const WORKING_ON_SHOWN = 30

type WorkingSort = 'urgent' | 'oldest' | 'newest' | 'name'

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function WorkingOnCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const { urlFor } = useItemNavigation()
  const { data, isLoading } = useQuery<{ items: WorkingOnItem[]; total: number; hidden: number }>({
    queryKey: ['nvr-person-working-on', p.id, WORKING_ON_FETCH],
    queryFn: () =>
      client
        .request<{ data: { items: WorkingOnItem[]; total: number; hidden: number } }>(
          get(`/users/${p.id}/working-on?limit=${WORKING_ON_FETCH}`)
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  const [collection, setCollection] = useState('')
  const [state, setState] = useState('')
  const [pastSla, setPastSla] = useState(false)
  const [sort, setSort] = useState<WorkingSort>('urgent')
  const [showAll, setShowAll] = useState(false)

  const all = data?.items ?? []
  const collections = [...new Set(all.map((i) => i.collection))].sort()
  const states = [
    ...new Map(
      all
        .filter((i) => !collection || i.collection === collection)
        .filter((i) => i.state)
        .map((i) => [i.state as string, i.state_label ?? (i.state as string)])
    )
  ].sort((a, b) => a[1].localeCompare(b[1]))
  const filtered = all
    .filter((i) => !collection || i.collection === collection)
    .filter((i) => !state || i.state === state)
    .filter((i) => !pastSla || i.sla_status === 'breached')
  const rank = (v: string | null) => (v === 'breached' ? 0 : v === 'warning' ? 1 : 2)
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'name') return a.label.localeCompare(b.label)
    if (sort === 'oldest') return (b.aging_hours ?? 0) - (a.aging_hours ?? 0)
    if (sort === 'newest') return (a.aging_hours ?? 0) - (b.aging_hours ?? 0)
    return rank(a.sla_status) - rank(b.sla_status) || (b.aging_hours ?? 0) - (a.aging_hours ?? 0)
  })
  const shown = showAll ? sorted : sorted.slice(0, WORKING_ON_SHOWN)
  const narrowed = !!collection || !!state || pastSla

  const first = p.first_name ?? p.name
  const breached = all.filter((i) => i.sla_status === 'breached').length
  const total = data?.total ?? 0
  // The server caps the fetch; say so rather than filter a partial list silently.
  const partial = total > all.length

  // Queues that read these collections — "open this as a queue, filtered to them".
  const { data: queues } = useQuery<
    Array<{ id: string; name: string; source_collections?: string[] }>
  >({
    queryKey: ['nvr-person-working-on-queues'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string; source_collections?: string[] }> }>(
          get('/queues')
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    enabled: all.length > 0,
    staleTime: 5 * 60_000
  })
  const wanted = new Set(filtered.map((i) => i.collection))
  const queueChoices = (queues ?? []).filter((q) =>
    (q.source_collections ?? []).some((c) => wanted.has(c))
  )
  function queueHref(queueId: string): string | null {
    const path = `/queues/${queueId}?owner=${encodeURIComponent(p.id)}`
    return nav.consoleUrl ? nav.consoleUrl(path) : path
  }

  function exportCsv() {
    const header = ['Collection', 'Record', 'State', 'SLA', 'Hours in state', 'Link']
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const lines = sorted.map((it) =>
      [
        titleCase(it.collection),
        it.label,
        it.state_label ?? it.state ?? '',
        it.sla_status === 'breached' ? 'Past SLA' : it.sla_status === 'warning' ? 'SLA soon' : '',
        it.aging_hours ?? '',
        `${origin}${urlFor({ collection: it.collection, itemId: it.item_id })}`
      ]
        .map(csvCell)
        .join(',')
    )
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${first.replace(/[^\w-]+/g, '-').toLowerCase()}-working-on.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <SectionCard
      icon={<ClipboardList className='h-4 w-4' />}
      title='Working on'
      hint={
        total > 0
          ? `${total} open record${total === 1 ? '' : 's'} waiting on ${first}${breached ? ` · ${breached} past SLA` : ''}`
          : undefined
      }
      testId='working-on'
    >
      {isLoading ? (
        <div className='space-y-2' aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className='h-5 animate-pulse rounded bg-slate-100 dark:bg-muted' />
          ))}
        </div>
      ) : !data || all.length === 0 ? (
        <EmptyLine>
          {data && data.hidden > 0
            ? `Nothing you can see — ${data.hidden} record${data.hidden === 1 ? '' : 's'} sit in collections your role cannot read.`
            : `Nothing waits on ${first} right now.`}
        </EmptyLine>
      ) : (
        <>
          <div className='mb-2 flex flex-wrap items-center gap-1.5' data-person-working-on-tools>
            {collections.length > 1 && (
              <SimpleSelectXs
                ariaLabel='Collection'
                value={collection}
                onChange={(v) => {
                  setCollection(v)
                  setState('')
                }}
                options={[
                  { value: '', label: 'All collections' },
                  ...collections.map((c) => ({ value: c, label: titleCase(c) }))
                ]}
              />
            )}
            {states.length > 1 && (
              <SimpleSelectXs
                ariaLabel='State'
                value={state}
                onChange={setState}
                options={[
                  { value: '', label: 'Any state' },
                  ...states.map(([v, l]) => ({ value: v, label: l }))
                ]}
              />
            )}
            {breached > 0 && (
              <button
                type='button'
                aria-pressed={pastSla}
                data-person-working-on-breached
                onClick={() => setPastSla((v) => !v)}
                className={cn(
                  'h-7 rounded-md border px-2 text-[11.5px] font-medium transition-colors',
                  pastSla
                    ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300'
                    : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
                )}
              >
                Past SLA only
              </button>
            )}
            <SimpleSelectXs
              ariaLabel='Sort'
              value={sort}
              onChange={(v) => setSort(v as WorkingSort)}
              options={[
                { value: 'urgent', label: 'Most urgent' },
                { value: 'oldest', label: 'Longest in state' },
                { value: 'newest', label: 'Newest in state' },
                { value: 'name', label: 'Name' }
              ]}
            />
            <span className='flex-1' />
            <button
              type='button'
              data-person-working-on-csv
              onClick={exportCsv}
              disabled={sorted.length === 0}
              className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-600 hover:bg-muted disabled:opacity-50 dark:text-slate-300'
            >
              <Download className='h-3.5 w-3.5' /> CSV
            </button>
            {queueChoices.length > 0 && <OpenInQueue choices={queueChoices} hrefFor={queueHref} />}
          </div>
          {sorted.length === 0 ? (
            <EmptyLine>Nothing matches these filters.</EmptyLine>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-border/60' data-person-working-on>
              {shown.map((it) => {
                const href = urlFor({ collection: it.collection, itemId: it.item_id })
                return (
                  <li
                    key={`${it.collection}:${it.item_id}`}
                    className='flex items-center gap-3 py-1.5'
                  >
                    <a
                      href={href}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) return
                        e.preventDefault()
                        nav.navigate(href)
                      }}
                      className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-700 hover:text-nvr-navy hover:underline dark:text-slate-200 dark:hover:text-nvr-cyan'
                    >
                      {it.label}
                    </a>
                    {it.state && (
                      <span
                        className='shrink-0 rounded-full px-2 py-px text-[10.5px] font-semibold'
                        style={{
                          backgroundColor: `${it.state_color ?? '#94a3b8'}22`,
                          color: it.state_color ?? '#475569'
                        }}
                      >
                        {it.state_label ?? it.state}
                      </span>
                    )}
                    {it.sla_status && it.sla_status !== 'ok' && (
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold',
                          SLA_TONE[it.sla_status]
                        )}
                      >
                        {it.sla_status === 'breached' ? 'past SLA' : 'SLA soon'}
                      </span>
                    )}
                    {it.aging_hours != null && (
                      <span className='shrink-0 text-[11px] tabular-nums text-slate-400'>
                        {humanHours(it.aging_hours)}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <div className='flex flex-wrap items-center gap-x-3 pt-2 text-[11.5px] text-slate-400'>
            {sorted.length > shown.length && (
              <button
                type='button'
                data-person-working-on-all
                onClick={() => setShowAll(true)}
                className='font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
              >
                Show all {sorted.length}
              </button>
            )}
            {narrowed && sorted.length > 0 && (
              <span>
                {sorted.length} of {all.length} match
              </span>
            )}
            {partial && (
              <span>
                Showing the {all.length} most urgent of {total}
              </span>
            )}
          </div>
        </>
      )}
    </SectionCard>
  )
}

function OpenInQueue({
  choices,
  hrefFor
}: {
  choices: Array<{ id: string; name: string }>
  hrefFor: (queueId: string) => string | null
}) {
  const nav = useNavigation()
  const [open, setOpen] = useState(false)
  const go = (id: string) => {
    const href = hrefFor(id)
    if (!href) return
    setOpen(false)
    if (/^https?:/.test(href)) window.open(href, '_blank', 'noopener')
    else nav.navigate(href)
  }
  const usable = choices.filter((q) => hrefFor(q.id) != null)
  if (usable.length === 0) return null
  if (usable.length === 1)
    return (
      <button
        type='button'
        data-person-working-on-queue={usable[0].id}
        onClick={() => go(usable[0].id)}
        className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-nvr-navy hover:bg-muted dark:text-nvr-cyan'
      >
        <ListFilter className='h-3.5 w-3.5' /> Open in {usable[0].name}
      </button>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-person-working-on-queue-menu
          className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-nvr-navy hover:bg-muted dark:text-nvr-cyan'
        >
          <ListFilter className='h-3.5 w-3.5' /> Open in queue
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-60 p-1'>
        {usable.map((q) => (
          <button
            key={q.id}
            type='button'
            data-person-working-on-queue={q.id}
            onClick={() => go(q.id)}
            className='block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted'
          >
            {q.name}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

// ─── Team load ───────────────────────────────────────────────────────────────

interface TeamLoadRow {
  id: string
  name: string
  email: string | null
  title: string | null
  status: string
  out: boolean
  ooo_end: string | null
  delegate: { id: string; name: string } | null
  open: number
  breached: number
  warning: number
  hidden: number
  oldest_hours: number | null
  uncovered: boolean
}

const shortDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null

/**
 * A manager's team at a glance: one row per direct report — what waits on
 * them, how much of it is past SLA, and whether they are out with nobody
 * covering. `userId` may be 'me'. Renders nothing for someone with no reports.
 */
export function TeamLoadCard({
  userId,
  firstName,
  expectedRows = 3
}: {
  userId: string
  firstName?: string | null
  /** How many skeleton rows to show while it loads (the known report count). */
  expectedRows?: number
}) {
  const client = useNivaroClient()
  const { data, isLoading, isError } = useQuery<{
    reports: TeamLoadRow[]
    total_reports: number
    truncated: boolean
  }>({
    queryKey: ['nvr-person-team-load', userId],
    queryFn: () =>
      client
        .request<{ data: { reports: TeamLoadRow[]; total_reports: number; truncated: boolean } }>(
          get(`/users/${userId}/team-load`)
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  if (!isLoading && (isError || !data || data.total_reports === 0)) return null
  const rows = data?.reports ?? []
  const open = rows.reduce((n, r) => n + r.open, 0)
  const breached = rows.reduce((n, r) => n + r.breached, 0)
  const uncovered = rows.filter((r) => r.uncovered).length
  const whose = userId === 'me' ? 'your' : firstName ? `${firstName}'s` : 'their'
  return (
    <SectionCard
      icon={<Users className='h-4 w-4' />}
      title='Team load'
      hint={
        data
          ? [
              `${data.total_reports} direct report${data.total_reports === 1 ? '' : 's'}`,
              `${open} open`,
              breached ? `${breached} past SLA` : null,
              uncovered ? `${uncovered} out with no cover` : null
            ]
              .filter(Boolean)
              .join(' · ')
          : `What waits on ${whose} team`
      }
      testId='team-load'
    >
      {isLoading ? (
        <div className='space-y-2.5' aria-busy>
          {[0, 1, 2, 3, 4, 5].slice(0, Math.min(6, Math.max(1, expectedRows))).map((n) => (
            <div key={n} className='flex items-center gap-3'>
              <div className='h-5 w-5 animate-pulse rounded-full bg-slate-100 dark:bg-muted' />
              <div className='h-4 flex-1 animate-pulse rounded bg-slate-100 dark:bg-muted' />
              <div className='h-4 w-16 animate-pulse rounded bg-slate-100 dark:bg-muted' />
            </div>
          ))}
          <p className='text-[11px] text-slate-400'>Working out who owns what…</p>
        </div>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border/60' data-person-team-load>
          {rows.map((r) => {
            const ooo = r.out || r.status === 'suspended'
            return (
              <li
                key={r.id}
                className='flex items-center gap-3 py-2'
                data-team-load-row={r.id}
                data-team-load-uncovered={r.uncovered ? 'true' : undefined}
              >
                <div className='min-w-0 flex-1'>
                  <PersonChip person={{ id: r.id, name: r.name, email: r.email }} meta={r.title} />
                  {ooo && (
                    <p
                      className={cn(
                        'mt-0.5 pl-7 text-[11px]',
                        r.uncovered
                          ? 'font-semibold text-red-700 dark:text-red-400'
                          : 'text-amber-700 dark:text-amber-400'
                      )}
                      data-team-load-ooo
                    >
                      {r.status === 'suspended'
                        ? 'Suspended'
                        : `Out${r.ooo_end ? ` until ${shortDay(r.ooo_end)}` : ''}`}
                      {r.delegate
                        ? ` · ${r.delegate.name} covers`
                        : r.open > 0
                          ? ' · nobody covers their records'
                          : ''}
                    </p>
                  )}
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  {r.breached > 0 && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-px text-[10.5px] font-semibold',
                        SLA_TONE.breached
                      )}
                      data-team-load-breached={r.breached}
                    >
                      {r.breached} past SLA
                    </span>
                  )}
                  {r.warning > 0 && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-px text-[10.5px] font-semibold',
                        SLA_TONE.warning
                      )}
                    >
                      {r.warning} SLA soon
                    </span>
                  )}
                  <span
                    className={cn(
                      'w-16 text-right text-[12px] tabular-nums',
                      r.open > 0
                        ? 'font-semibold text-slate-700 dark:text-slate-200'
                        : 'text-slate-400'
                    )}
                    data-team-load-open={r.open}
                    title={
                      r.hidden > 0
                        ? `${r.hidden} more in collections your role cannot read`
                        : undefined
                    }
                  >
                    {r.open} open
                  </span>
                  <span
                    className='w-14 text-right text-[11px] tabular-nums text-slate-400'
                    title='Longest a record of theirs has sat in its current state'
                  >
                    {r.oldest_hours != null ? humanHours(r.oldest_hours) : ''}
                  </span>
                </div>
              </li>
            )
          })}
          {data?.truncated && (
            <li className='pt-2 text-[11.5px] text-slate-400'>
              Showing the first {rows.length} of {data.total_reports}.
            </li>
          )}
        </ul>
      )}
    </SectionCard>
  )
}

// ─── Why do they see this? ───────────────────────────────────────────────────

interface Explain {
  access: boolean
  reasons: Array<{
    type: string
    message: string
    dimension_label?: string
    allowed_values?: string[]
    record_values?: string[]
  }>
  act?: { can_see: boolean; can_update: boolean; available: boolean; summary?: string } | null
}

/** Admin: pick a record and get this person's read / act verdict with the gate that decided it. */
export function WhyCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const { data: collections = [] } = useQuery<Array<{ collection: string; name: string }>>({
    queryKey: ['nvr-collections-brief'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string | null }> }>(
          get('/collections')
        )
        .then((r) =>
          r.data
            .filter((c) => !c.collection.startsWith('nivaro_'))
            .map((c) => ({ collection: c.collection, name: c.display_name || c.collection }))
            .sort((a, b) => a.name.localeCompare(b.name))
        ),
    staleTime: 5 * 60_000
  })
  const [collection, setCollection] = useState('')
  const [id, setId] = useState('')
  const [asked, setAsked] = useState<{ collection: string; id: string } | null>(null)
  const { data, isFetching, error } = useQuery<Explain>({
    queryKey: ['nvr-person-why', p.id, asked?.collection, asked?.id],
    queryFn: () =>
      client
        .request<{ data: Explain }>(
          get(`/access-explain/${asked!.collection}/${encodeURIComponent(asked!.id)}`, {
            user_id: p.id,
            act: '1'
          })
        )
        .then((r) => r.data),
    enabled: !!asked
  })
  const first = p.first_name ?? p.name
  return (
    <SectionCard
      icon={<ScanSearch className='h-4 w-4' />}
      title='Why do they see this?'
      hint={`Ask any record as ${first} — the gate that decided it answers`}
      testId='why'
    >
      <form
        className='flex flex-wrap items-end gap-2'
        onSubmit={(e) => {
          e.preventDefault()
          if (collection && id.trim()) setAsked({ collection, id: id.trim() })
        }}
      >
        <div className='min-w-[180px] flex-1'>
          <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Collection
          </span>
          <SimpleSelect
            ariaLabel='Collection'
            value={collection}
            onChange={setCollection}
            options={[
              { value: '', label: 'Pick a collection…' },
              ...collections.map((c) => ({ value: c.collection, label: c.name }))
            ]}
            className='h-8 text-[12.5px]'
          />
        </div>
        <label className='w-[160px]'>
          <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Record id
          </span>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder='371431'
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] dark:border-border dark:bg-background'
          />
        </label>
        <button
          type='submit'
          disabled={!collection || !id.trim() || isFetching}
          data-person-why-ask
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white disabled:opacity-50'
        >
          {isFetching ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : null} Explain
        </button>
      </form>
      {error && (
        <p className='mt-3 text-[12px] text-red-600 dark:text-red-400'>
          {errorText(error, 'Could not explain')}
        </p>
      )}
      {data && asked && (
        <div className='mt-3 space-y-2' data-person-why-result={data.access ? 'yes' : 'no'}>
          <p
            className={cn(
              'rounded-md px-3 py-2 text-[12.5px] font-medium',
              data.access
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                : 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300'
            )}
          >
            {data.access
              ? `${first} can see ${asked.collection.replace(/_/g, ' ')} ${asked.id}.`
              : `${first} cannot see ${asked.collection.replace(/_/g, ' ')} ${asked.id}.`}
            {data.act?.summary && (
              <span className='ml-1 font-normal opacity-90'>{data.act.summary}</span>
            )}
          </p>
          {data.reasons.length > 0 && (
            <ul className='space-y-1.5'>
              {data.reasons.map((r, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: reasons carry no id
                  key={i}
                  className='text-[12px] text-slate-600 dark:text-slate-300'
                >
                  <Pill tone='neutral'>{r.type.replace(/_/g, ' ')}</Pill> {r.message}
                  {r.dimension_label && r.allowed_values && (
                    <span className='block pl-1 text-[11.5px] text-slate-400'>
                      {r.dimension_label}: allowed {r.allowed_values.join(', ')}
                      {r.record_values?.length ? ` · record has ${r.record_values.join(', ')}` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  )
}

// ─── Notify from the profile ─────────────────────────────────────────────────

/** "Send a message" that lands in their inbox / email per their notification rules. */
export function NotifyButton({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const send = useMutation({
    mutationFn: () =>
      client.request(
        post('/notifications', {
          recipient: p.id,
          subject: subject.trim(),
          message: message.trim() || undefined,
          category: 'system'
        })
      ),
    onSuccess: () => {
      toast.success(`Sent to ${p.first_name ?? p.name}`)
      setOpen(false)
      setSubject('')
      setMessage('')
    },
    onError: (e) => toast.error(errorText(e, 'Could not send'))
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-person-notify
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-border dark:text-slate-300 dark:hover:bg-muted'
        >
          <Bell className='h-3.5 w-3.5' /> Notify
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[340px] p-3'>
        <form
          className='space-y-2'
          onSubmit={(e) => {
            e.preventDefault()
            if (subject.trim()) send.mutate()
          }}
        >
          <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
            Notify {p.first_name ?? p.name}
          </p>
          <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
            Lands in their inbox, and in email or push the way their own rules say.
          </p>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder='Subject'
            aria-label='Subject'
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] dark:border-border dark:bg-background'
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder='Message (optional)'
            aria-label='Message'
            rows={3}
            className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12.5px] dark:border-border dark:bg-background'
          />
          <div className='flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='h-7 rounded-md px-2 text-[11.5px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            >
              Cancel
            </button>
            <button
              type='submit'
              disabled={!subject.trim() || send.isPending}
              className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white disabled:opacity-50'
            >
              {send.isPending ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <Send className='h-3 w-3' />
              )}{' '}
              Send
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
