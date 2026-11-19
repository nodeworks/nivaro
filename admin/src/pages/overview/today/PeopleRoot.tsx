import { ErrorNotice, UserAvatar } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronRight, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatNumber, formatRelative } from '@/lib/utils'
import { type PeopleSort, type PersonRow, sortPeople, windowSubtitle } from './model'
import { type TodayCtx, useOnlineNow } from './TodaySheet'

/**
 * "People active today" → who they are: one row per person the figure counts (anyone with an
 * activity entry in the window, reads included), with role, first and last seen, how much they
 * did, how many records they changed and opened, and whether they are here now. Sort any column,
 * filter by words or role; a row opens that person's activity today.
 */

interface TodayPeople {
  window: { from: string; to: string }
  people: PersonRow[]
  total: number
  capped: boolean
}

const COLS: Array<{ key: PeopleSort; label: string; className?: string; numeric?: boolean }> = [
  { key: 'name', label: 'Person' },
  { key: 'role', label: 'Role', className: 'hidden md:table-cell' },
  { key: 'first', label: 'First seen', className: 'hidden lg:table-cell' },
  { key: 'last', label: 'Last seen' },
  { key: 'actions', label: 'Entries', numeric: true },
  { key: 'changed', label: 'Records changed', numeric: true, className: 'hidden sm:table-cell' },
  { key: 'opened', label: 'Records opened', numeric: true, className: 'hidden md:table-cell' }
]

/** What a row that is not a plain person is (the name already says it; this says why). */
const KIND_NOTE: Record<string, string> = {
  deleted: 'Account deleted — its entries stay in the log',
  redacted: 'Redacted by the retention policy',
  placeholder: 'Placeholder account',
  machine: 'Service account',
  unnamed: 'The account has no name or email'
}

/** First / last seen inside today's window: the time of day, the relative time in the tip. */
function ClockTime({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      data-tip={`${formatRelative(at)} · ${formatDateTime(at)}`}
      className='tabular-nums'
    >
      {new Date(at).toDateString() === new Date().toDateString()
        ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : new Date(at).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })}
    </time>
  )
}

function initials(name: string) {
  const p = name
    .replace(/\(.*\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()
}

export function PeopleRoot({ ctx }: { ctx: TodayCtx }) {
  const q = useQuery({
    queryKey: ['overview', 'today', 'people', ctx.window],
    queryFn: () =>
      api
        .get<{ data: TodayPeople }>('/overview/today/people', {
          params: { day_start: ctx.window.from, until: ctx.window.to }
        })
        .then((r) => r.data.data),
    staleTime: 30_000
  })
  const online = useOnlineNow(true)
  const [sort, setSort] = useState<PeopleSort>('last')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [text, setText] = useState('')
  const [role, setRole] = useState('')
  const roles = useMemo(
    () =>
      [
        ...new Set((q.data?.people ?? []).map((p) => p.role).filter((r): r is string => !!r))
      ].sort(),
    [q.data]
  )
  const rows = useMemo(
    () => sortPeople(q.data?.people ?? [], sort, dir, text, role || null),
    [q.data, sort, dir, text, role]
  )
  const pressSort = (k: PeopleSort) => {
    if (k === sort) setDir(dir === 'asc' ? 'desc' : 'asc')
    else {
      setSort(k)
      setDir(k === 'name' || k === 'role' ? 'asc' : 'desc')
    }
  }
  const hereNow = rows.filter((r) => online.data?.has(r.id.toLowerCase())).length

  if (q.isLoading)
    return (
      <div className='space-y-2 p-4' aria-busy>
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div key={i} className='h-11 animate-pulse rounded-lg bg-white dark:bg-card' />
        ))}
      </div>
    )
  if (q.error || !q.data)
    return (
      <div className='p-4'>
        <ErrorNotice error={q.error} what='today’s people' onRetry={() => void q.refetch()} />
      </div>
    )

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3 p-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <p className='mr-auto text-[13px] text-slate-600 dark:text-slate-300'>
          <span className='font-semibold tabular-nums text-slate-900 dark:text-slate-50'>
            {formatNumber(q.data.total)}
          </span>{' '}
          {q.data.total === 1 ? 'person' : 'people'} did something{' '}
          {windowSubtitle(q.data.window.from, q.data.window.to)}
          {online.data && (
            <>
              {' · '}
              <span className='tabular-nums'>{formatNumber(hereNow)}</span> here now
            </>
          )}
          {q.data.capped && ' (the 2,000 most recent)'}
        </p>
        <div className='relative'>
          <Search
            className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
            aria-hidden
          />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Find a person'
            aria-label='Find a person'
            className='h-8 w-48 rounded-md border border-slate-200 bg-white pl-8 pr-2 text-[12.5px] focus-visible:border-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/30 dark:border-border dark:bg-card'
          />
        </div>
        {roles.length > 1 && (
          <SimpleSelect
            value={role}
            onChange={setRole}
            options={[
              { value: '', label: 'Every role' },
              ...roles.map((r) => ({ value: r, label: r }))
            ]}
            ariaLabel='Role'
            className='h-8 w-40 bg-white text-[12.5px] dark:bg-card'
          />
        )}
      </div>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <table className='w-full text-[12.5px]'>
          <thead className='bg-slate-50 dark:bg-white/[0.03]'>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  scope='col'
                  aria-sort={sort === c.key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={cn(
                    'whitespace-nowrap border-b border-slate-200 px-3 py-2 text-[11.5px] font-medium text-slate-500 dark:border-border dark:text-slate-400',
                    c.numeric ? 'text-right' : 'text-left',
                    c.className
                  )}
                >
                  <button
                    type='button'
                    onClick={() => pressSort(c.key)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:hover:text-slate-100',
                      sort === c.key && 'text-slate-900 dark:text-slate-100'
                    )}
                  >
                    {c.label}
                    {sort === c.key &&
                      (dir === 'asc' ? (
                        <ArrowUp className='h-3 w-3' aria-hidden />
                      ) : (
                        <ArrowDown className='h-3 w-3' aria-hidden />
                      ))}
                  </button>
                </th>
              ))}
              <th className='w-8 border-b border-slate-200 dark:border-border' aria-hidden />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLS.length + 1} className='px-4 py-10 text-center text-slate-500'>
                  No one matches.
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const here = online.data?.get(p.id.toLowerCase())
                // No directory row: the account was removed since (its entries stay).
                const name = p.name ?? p.email ?? 'A removed account'
                return (
                  <tr
                    key={p.id}
                    tabIndex={0}
                    onClick={() => ctx.go({ ...ctx.drill, person: p.id })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        ctx.go({ ...ctx.drill, person: p.id })
                      }
                    }}
                    className='group cursor-pointer border-b border-slate-100 outline-none last:border-0 hover:bg-slate-50 focus-visible:bg-slate-50 dark:border-border dark:hover:bg-white/[0.03] dark:focus-visible:bg-white/[0.04]'
                    data-today-person={p.id}
                  >
                    <td className='px-3 py-2'>
                      <span className='flex min-w-0 items-center gap-2.5'>
                        <span className='relative shrink-0'>
                          <UserAvatar
                            userId={p.id}
                            className='h-7 w-7 rounded-full object-cover'
                            fallback={
                              <span className='flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-[10.5px] font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-200'>
                                {initials(name)}
                              </span>
                            }
                          />
                          {here && (
                            <span
                              className={cn(
                                'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-card',
                                here.is_idle ? 'bg-amber-400' : 'bg-emerald-500'
                              )}
                              data-tip={here.is_idle ? 'Here, idle' : 'Here now'}
                            >
                              <span className='sr-only'>
                                {here.is_idle ? 'here, idle' : 'here now'}
                              </span>
                            </span>
                          )}
                        </span>
                        <span className='min-w-0'>
                          <span className='block truncate font-medium text-slate-900 dark:text-slate-50'>
                            {name}
                          </span>
                          {p.kind && p.kind !== 'person' && (
                            <span className='block truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
                              {KIND_NOTE[p.kind]}
                            </span>
                          )}
                          {p.kind === 'person' && p.email && p.name && (
                            <span className='block truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
                              {p.email}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className='hidden px-3 py-2 text-slate-600 md:table-cell dark:text-slate-300'>
                      {p.role ?? '—'}
                    </td>
                    <td className='hidden px-3 py-2 text-slate-500 lg:table-cell dark:text-slate-400'>
                      <ClockTime at={p.first_at} />
                    </td>
                    <td className='px-3 py-2 text-slate-500 dark:text-slate-400'>
                      <ClockTime at={p.last_at} />
                    </td>
                    <td
                      className='px-3 py-2 text-right tabular-nums'
                      data-tip={`${formatNumber(p.writes)} not reads`}
                    >
                      {formatNumber(p.actions)}
                    </td>
                    <td className='hidden px-3 py-2 text-right tabular-nums sm:table-cell'>
                      {formatNumber(p.records_changed)}
                    </td>
                    <td className='hidden px-3 py-2 text-right tabular-nums md:table-cell'>
                      {formatNumber(p.records_opened)}
                    </td>
                    <td className='pr-3'>
                      <ChevronRight
                        className='h-4 w-4 text-slate-300 group-hover:text-slate-500'
                        aria-hidden
                      />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
