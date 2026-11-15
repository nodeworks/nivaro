import { LiveOffNote, UserAvatar, useLivePreference } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Headphones, Pencil, RefreshCw, Search, Users, VenetianMask } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { getSocket } from '@/lib/socket'
import { cn, titleCase } from '@/lib/utils'

/**
 * Team board (realtime round 5, item 21) — administrators only. Who is working on which record
 * right now, grouped by role, team (manager) or a zone-like dimension. Built from live presence
 * on the server (GET /realtime/team-board); nothing is kept. Follows the data quietly: page
 * moves and presence changes refresh it at most every 2 s, rows keep their order (by name), and
 * the person's Live updates setting holds (Off = refresh by hand).
 */

interface BoardRecord {
  collection: string
  item: string
  label: string | null
  editing: boolean
  since: number | null
  tabs: number
}

interface BoardPerson {
  id: string
  name: string
  role: string | null
  manager: { id: string; name: string } | null
  state: 'active' | 'idle' | 'stuck'
  idle_minutes: number | null
  stuck_minutes: number | null
  last_active: string | null
  page: string | null
  app: string | null
  view_as: boolean
  status: { text: string; emoji: string | null } | null
  in_huddle: boolean
  scopes: Record<string, string[]>
  records: BoardRecord[]
  tabs: number
}

interface Board {
  people: BoardPerson[]
  counts: { online: number; on_record: number; editing: number; idle: number; stuck: number }
  dimensions: Array<{ name: string; label: string }>
  at: string
}

const BOARD_KEY = ['realtime-team-board'] as const
const REFRESH_GAP_MS = 2000
const BACKSTOP_MS = 30_000

/** "4m", "1h 12m", "just now" — how long something has been open. */
export function openFor(since: number | null, now: number): string | null {
  if (since == null) return null
  const mins = Math.floor((now - since) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

type GroupBy = 'role' | 'team' | `dim:${string}`

/** The heading a person sits under for a grouping (pure). */
export function groupOf(p: BoardPerson, by: GroupBy): string {
  if (by === 'role') return p.role ?? 'No role'
  if (by === 'team') return p.manager ? `${p.manager.name}'s team` : 'No manager'
  const values = p.scopes[by.slice(4)] ?? []
  return values.length ? values.join(', ') : 'Not set'
}

const LAST_GROUPS = new Set(['No role', 'No manager', 'Not set'])

function useBoardLive(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const socket = getSocket()
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = 0
    // One refresh per REFRESH_GAP_MS however many pings arrive (a page move, an idle flip).
    const poke = () => {
      if (timer) return
      const wait = Math.max(0, REFRESH_GAP_MS - (Date.now() - last))
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        void qc.invalidateQueries({ queryKey: [...BOARD_KEY] }, { cancelRefetch: false })
      }, wait)
    }
    const join = () => socket.emit('presence-map:join')
    if (socket.connected) join()
    socket.on('auth:ok', join)
    socket.on('presence-map:update', poke)
    socket.on('presence:changed', poke)
    return () => {
      if (timer) clearTimeout(timer)
      socket.emit('presence-map:leave')
      socket.off('auth:ok', join)
      socket.off('presence-map:update', poke)
      socket.off('presence:changed', poke)
    }
  }, [enabled, qc])
}

export function TeamBoardTab() {
  const live = useLivePreference()
  const [groupBy, setGroupBy] = useState<GroupBy>('role')
  const [onRecordOnly, setOnRecordOnly] = useState(false)
  const [search, setSearch] = useState('')
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: [...BOARD_KEY],
    queryFn: () => api.get<{ data: Board }>('/realtime/team-board').then((r) => r.data.data),
    refetchInterval: live.off ? false : BACKSTOP_MS,
    refetchIntervalInBackground: false
  })
  useBoardLive(!live.off)

  // Idle minutes and "open for" tick between refreshes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // A person whose records changed since the last answer gets a soft fade (Normal only; the
  // global html[data-live-mode] rule turns it off in Calm and Off).
  const prevSig = useRef<Map<string, string> | null>(null)
  const [changed, setChanged] = useState<{ ids: Set<string>; at: number }>({
    ids: new Set(),
    at: 0
  })
  useEffect(() => {
    if (!data) return
    const sig = new Map(
      data.people.map((p) => [
        p.id,
        p.records.map((r) => `${r.collection}:${r.item}:${r.editing ? 1 : 0}`).join('|')
      ])
    )
    const prev = prevSig.current
    prevSig.current = sig
    if (!prev || live.quiet) return
    const ids = new Set<string>()
    for (const [id, s] of sig) if (prev.has(id) && prev.get(id) !== s) ids.add(id)
    if (ids.size) setChanged({ ids, at: Date.now() })
  }, [data, live.quiet])

  const people = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.people ?? []).filter(
      (p) =>
        (!onRecordOnly || p.records.length > 0) &&
        (!q || p.name.toLowerCase().includes(q) || (p.role ?? '').toLowerCase().includes(q))
    )
  }, [data, onRecordOnly, search])

  const groups = useMemo(() => {
    const map = new Map<string, BoardPerson[]>()
    for (const p of people) {
      const g = groupOf(p, groupBy)
      const list = map.get(g) ?? []
      list.push(p)
      map.set(g, list)
    }
    return [...map].sort(
      ([a], [b]) =>
        Number(LAST_GROUPS.has(a)) - Number(LAST_GROUPS.has(b)) ||
        a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
  }, [people, groupBy])

  const groupOptions: Array<[GroupBy, string]> = [
    ['role', 'Role'],
    ['team', 'Team'],
    ...(data?.dimensions ?? []).map(
      (d) => [`dim:${d.name}` as GroupBy, d.label] as [GroupBy, string]
    )
  ]

  if (isLoading)
    return (
      <div className='space-y-3' aria-busy='true'>
        <Skeleton className='h-9 w-full max-w-xl' />
        <Skeleton className='h-40 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
    )
  if (isError || !data)
    return (
      <div className='rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center dark:border-border'>
        <p className='text-[13px] font-medium text-slate-700 dark:text-foreground'>
          The team board did not load
        </p>
        <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Presence may be busy for a moment.
        </p>
        <button
          type='button'
          onClick={() => void refetch()}
          className='mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:text-foreground'
        >
          <RefreshCw className='h-3.5 w-3.5' />
          Try again
        </button>
      </div>
    )

  const c = data.counts
  return (
    <div className='space-y-5' data-team-board='ready'>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-[13px] text-slate-700 dark:text-foreground'>
            <span className='font-semibold tabular-nums'>{c.online}</span> online
            <Sep />
            <span className='font-semibold tabular-nums'>{c.on_record}</span> on a record
            <Sep />
            <span className='font-semibold tabular-nums'>{c.editing}</span> editing
            <Sep />
            <span className='tabular-nums'>{c.idle}</span> idle
            {c.stuck > 0 && (
              <>
                <Sep />
                <span className='font-medium tabular-nums text-amber-700 dark:text-amber-300'>
                  {c.stuck} stuck
                </span>
              </>
            )}
          </p>
          <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Who is working on which record right now, from live presence. Nothing here is kept.
          </p>
        </div>
        <div className='flex shrink-0 flex-wrap items-center justify-end gap-2'>
          {live.off && <LiveOffNote variant='header' />}
          <button
            type='button'
            onClick={() => void refetch()}
            aria-label='Refresh the team board'
            data-tip='Refresh'
            className='inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:text-muted-foreground'
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className='flex flex-wrap items-center gap-2'>
        <label className='relative flex h-8 w-full items-center sm:w-56'>
          <span className='sr-only'>Find a person</span>
          <Search className='pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400' />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Find a person or role'
            className='h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2.5 text-[12.5px] text-slate-800 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-foreground dark:placeholder:text-muted-foreground'
          />
        </label>
        <fieldset
          aria-label='Group by'
          className='m-0 inline-flex h-8 min-w-0 items-center rounded-md border border-slate-200 p-0.5 dark:border-border'
        >
          <span className='px-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Group by
          </span>
          {groupOptions.map(([key, label]) => (
            <button
              key={key}
              type='button'
              aria-pressed={groupBy === key}
              onClick={() => setGroupBy(key)}
              className={cn(
                'h-full rounded px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                groupBy === key
                  ? 'bg-[#00ceff]/10 text-[#0e7490] dark:text-[#67e8f9]'
                  : 'text-slate-600 hover:bg-muted dark:text-muted-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <button
          type='button'
          aria-pressed={onRecordOnly}
          onClick={() => setOnRecordOnly((v) => !v)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            onRecordOnly
              ? 'border-[#00ceff]/40 bg-[#00ceff]/10 text-[#0e7490] dark:text-[#67e8f9]'
              : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-muted-foreground'
          )}
        >
          <FileText className='h-3.5 w-3.5' />
          On a record only
        </button>
      </div>

      {data.people.length === 0 ? (
        <div className='rounded-lg border border-dashed border-slate-200 px-4 py-10 text-center dark:border-border'>
          <Users className='mx-auto h-6 w-6 text-slate-300 dark:text-muted-foreground' />
          <p className='mt-2 text-[13px] font-medium text-slate-700 dark:text-foreground'>
            Nobody is signed in right now
          </p>
          <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            People appear here as soon as they open the app, with the records they have open.
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className='rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center dark:border-border'>
          <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            {onRecordOnly && !search
              ? 'Nobody has a record open right now.'
              : 'Nobody online matches that.'}
          </p>
          <button
            type='button'
            onClick={() => {
              setSearch('')
              setOnRecordOnly(false)
            }}
            className='mt-2 text-[12px] font-medium text-[#0e7490] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-[#67e8f9]'
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className='space-y-5'>
          {groups.map(([name, list]) => (
            <section key={name} aria-label={`${name}, ${list.length} online`}>
              <h2 className='mb-1.5 flex items-baseline gap-2 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                {name}
                <span className='text-[11.5px] font-normal tabular-nums text-slate-400 dark:text-muted-foreground'>
                  {list.length}
                </span>
              </h2>
              <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
                {list.map((p) => (
                  <PersonRow
                    key={p.id}
                    p={p}
                    now={now}
                    pulse={changed.ids.has(p.id) ? changed.at : 0}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function Sep() {
  return (
    <span aria-hidden className='mx-1.5 text-slate-300 dark:text-muted-foreground/50'>
      ·
    </span>
  )
}

const STATE_DOT: Record<BoardPerson['state'], string> = {
  active: 'bg-emerald-500',
  idle: 'bg-slate-300 dark:bg-slate-500',
  stuck: 'bg-amber-500'
}

/** "12m", "3h 28m". */
function minutes(m: number): string {
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function stateText(p: BoardPerson): string {
  if (p.state === 'stuck') return `Stuck ${minutes(p.stuck_minutes ?? 10)}`
  if (p.state === 'idle') return p.idle_minutes != null ? `Idle ${minutes(p.idle_minutes)}` : 'Idle'
  return 'Active'
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function PersonRow({ p, now, pulse }: { p: BoardPerson; now: number; pulse: number }) {
  return (
    <li
      className='grid grid-cols-1 gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[minmax(180px,240px)_1fr_auto] sm:items-center'
      data-person={p.id}
    >
      <div className='flex min-w-0 items-center gap-2.5'>
        <span className='relative shrink-0'>
          <UserAvatar
            userId={p.id}
            alt={p.name}
            className='h-7 w-7'
            fallback={
              <span className='flex h-7 w-7 items-center justify-center rounded-full bg-nvr-navy text-[10px] font-semibold text-white'>
                {initials(p.name)}
              </span>
            }
          />
          <span
            aria-hidden
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-card',
              STATE_DOT[p.state]
            )}
          />
        </span>
        <div className='min-w-0'>
          <Link
            to={`/users/${p.id}`}
            className='block truncate text-[12.5px] font-medium text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground'
          >
            {p.name}
          </Link>
          <p className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {[p.role, p.status ? `${p.status.emoji ?? ''} ${p.status.text}`.trim() : null]
              .filter(Boolean)
              .join(' · ') || '—'}
          </p>
        </div>
      </div>

      <div
        key={pulse || undefined}
        className={cn(
          '-mx-1 flex min-w-0 max-w-full flex-wrap items-center gap-1.5 justify-self-start rounded px-1',
          pulse > 0 && 'nvr-value-pulse-bg'
        )}
      >
        {p.records.length > 0 ? (
          p.records.map((r) => <RecordChip key={`${r.collection}:${r.item}`} r={r} now={now} />)
        ) : (
          <span className='truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
            {p.page ? `On ${p.page}` : 'No page reported'}
          </span>
        )}
      </div>

      <div className='flex flex-wrap items-center gap-1.5 sm:justify-end'>
        {p.view_as && (
          <span
            data-tip='An administrator is viewing the app as this person. What that tab opens shows here as them.'
            className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-violet-800 ring-1 ring-inset ring-violet-200 dark:text-violet-300 dark:ring-violet-500/30'
          >
            <VenetianMask className='h-3 w-3' />
            View-as
          </span>
        )}
        {p.in_huddle && (
          <span
            data-tip='In a huddle'
            className='inline-flex items-center rounded px-1 py-0.5 text-slate-500 ring-1 ring-inset ring-slate-200 dark:text-muted-foreground dark:ring-border'
          >
            <Headphones className='h-3 w-3' />
            <span className='sr-only'>In a huddle</span>
          </span>
        )}
        <span
          className={cn(
            'whitespace-nowrap text-[11.5px] tabular-nums',
            p.state === 'stuck'
              ? 'font-medium text-amber-700 dark:text-amber-300'
              : p.state === 'idle'
                ? 'text-slate-400 dark:text-muted-foreground'
                : 'text-emerald-700 dark:text-emerald-400'
          )}
          data-tip={
            p.state === 'stuck'
              ? 'At the keyboard, same record, nothing saved for a while'
              : p.state === 'idle'
                ? 'No input for a while'
                : undefined
          }
        >
          {stateText(p)}
        </span>
        {p.tabs > 1 && (
          <span className='text-[11px] tabular-nums text-slate-400 dark:text-muted-foreground'>
            {p.tabs} tabs
          </span>
        )}
      </div>
    </li>
  )
}

function RecordChip({ r, now }: { r: BoardRecord; now: number }) {
  const open = openFor(r.since, now)
  const label = r.label ?? `#${r.item}`
  const sinceText =
    r.since != null
      ? new Date(r.since).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : null
  const tip = [
    `${r.editing ? 'Editing' : 'Viewing'}${sinceText ? ` since ${sinceText}` : ''}`,
    r.tabs > 1 ? `${r.tabs} tabs` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Link
      to={`/collections/${r.collection}/${encodeURIComponent(r.item)}`}
      data-tip={tip}
      aria-label={`${tip}: ${label}`}
      className={cn(
        'group inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        r.editing
          ? 'border-[#00ceff]/40 bg-[#00ceff]/[0.07] text-slate-900 hover:bg-[#00ceff]/[0.12] dark:text-foreground'
          : 'border-slate-200 bg-white text-slate-800 hover:bg-muted dark:border-border dark:bg-card dark:text-foreground'
      )}
    >
      {r.editing ? (
        <Pencil className='h-3 w-3 shrink-0 text-[#0e7490] dark:text-[#67e8f9]' />
      ) : (
        <FileText className='h-3 w-3 shrink-0 text-slate-400 dark:text-muted-foreground' />
      )}
      <span className='truncate font-medium'>{label}</span>
      <span className='hidden shrink-0 text-[11px] text-slate-400 sm:inline dark:text-muted-foreground'>
        {titleCase(r.collection.replace(/_/g, ' '))}
      </span>
      {open && (
        <span className='hidden shrink-0 text-[11px] sm:inline tabular-nums text-slate-400 dark:text-muted-foreground'>
          {open}
        </span>
      )}
    </Link>
  )
}
