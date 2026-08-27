import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { UserX } from 'lucide-react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'

interface UnavailableOwner {
  id: string
  name: string
  reason: 'suspended' | 'inactive' | 'redacted' | 'ooo_no_delegate'
}

interface GapItem {
  collection: string
  item: string
  label: string
  state: string | null
  kind: string
  owners: UnavailableOwner[]
}

interface Report {
  open_instances: number
  evaluated: number
  truncated: boolean
  blocked: GapItem[]
  no_owner_count: number
  by_user: Array<{
    id: string
    name: string
    reason: UnavailableOwner['reason']
    blocked_count: number
  }>
}

const REASON_LABEL: Record<UnavailableOwner['reason'], string> = {
  suspended: 'suspended',
  inactive: 'inactive',
  redacted: 'redacted',
  ooo_no_delegate: 'out of office, no delegate'
}

function ReasonChip({ reason }: { reason: UnavailableOwner['reason'] }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-medium',
        reason === 'ooo_no_delegate'
          ? 'bg-amber-400/15 text-amber-700 dark:text-amber-400'
          : 'bg-red-500/10 text-red-600 dark:text-red-400'
      )}
    >
      {REASON_LABEL[reason]}
    </span>
  )
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <p className='text-[11px] uppercase tracking-wide text-muted-foreground'>{label}</p>
      <p className={cn('mt-1 text-[20px] font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  )
}

/**
 * Records whose entire owner set cannot act. Delegation covers the planned
 * absence; this page catches the unplanned ones — an owner suspended or out
 * of office with no working delegate — before "why is this still in review"
 * gets asked three weeks late.
 */
interface RunwayEntry {
  user_id: string
  name: string
  ooo_start: string | null
  ooo_end: string | null
  currently_out: boolean
  delegate_name: string | null
  delegate_ok: boolean
  group_seats: number
  states: string[]
  pending_estimate: number
}

export function CoverageGapsPage() {
  const [tab, setTab] = useState<'now' | 'runway'>('now')
  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery<Report>({
    queryKey: ['coverage-gaps'],
    queryFn: () => api.get<{ data: Report }>('/coverage-gaps').then((r) => r.data.data),
    enabled: tab === 'now',
    // Availability flips with every status change; computed live server-side,
    // so a manual refresh answers "did my fix take" immediately.
    staleTime: 60_000
  })
  const runway = useQuery<{ days: number; entries: RunwayEntry[] }>({
    queryKey: ['coverage-runway'],
    queryFn: () =>
      api
        .get<{ data: { days: number; entries: RunwayEntry[] } }>('/coverage-gaps/runway?days=21')
        .then((r) => r.data.data),
    enabled: tab === 'runway',
    staleTime: 5 * 60_000
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <UserX className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-lg font-semibold'>Coverage Gaps</h1>
            <p className='text-[11px] text-muted-foreground'>
              {tab === 'now'
                ? 'Open records every owner of which is suspended, redacted, or out with no delegate.'
                : 'Scheduled absences over the next three weeks vs the approval load they touch — the gap BEFORE it happens.'}
            </p>
          </div>
        </div>
        <div className='flex items-center gap-3'>
          <div className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {(
              [
                ['now', 'Right now'],
                ['runway', 'Runway']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type='button'
                onClick={() => setTab(key)}
                className={
                  tab === key
                    ? 'rounded bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'
                    : 'rounded px-2.5 py-1 text-[12px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'now' && dataUpdatedAt > 0 && (
            <span className='text-[11px] text-muted-foreground'>
              Checked {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            type='button'
            onClick={() => refetch()}
            disabled={isFetching}
            className='rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
          >
            {isFetching ? 'Checking…' : 'Re-check'}
          </button>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {tab === 'runway' ? (
          <RunwayTab
            entries={runway.data?.entries ?? []}
            days={runway.data?.days ?? 21}
            loading={runway.isLoading}
          />
        ) : isLoading || !data ? (
          <div className='grid grid-cols-3 gap-4'>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className='h-20 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]'
              />
            ))}
          </div>
        ) : (
          <>
            <div className='mb-5 grid grid-cols-3 gap-4'>
              <Tile label='Open records checked' value={formatNumber(data.evaluated)} />
              <Tile
                label='Blocked — no available owner'
                value={formatNumber(data.blocked.length)}
                tone={
                  data.blocked.length > 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }
              />
              <Tile
                label='No owners resolve at all'
                value={formatNumber(data.no_owner_count)}
                tone={data.no_owner_count > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
              />
            </div>

            {data.by_user.length > 0 && (
              <div className='mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
                <p className='mb-2 text-[12px] font-medium'>Who the work is stuck on</p>
                <div className='flex flex-wrap gap-2'>
                  {data.by_user.map((u) => (
                    <span
                      key={u.id}
                      className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-[12px] dark:border-border'
                    >
                      <span className='font-medium'>{u.name}</span>
                      <ReasonChip reason={u.reason} />
                      <span className='tabular-nums text-muted-foreground'>
                        {u.blocked_count} record{u.blocked_count === 1 ? '' : 's'}
                      </span>
                    </span>
                  ))}
                </div>
                <p className='mt-2 text-[11px] text-muted-foreground'>
                  Fix at the person: set a delegate on their profile, reactivate them, or reassign
                  owners on the records below.
                </p>
              </div>
            )}

            {data.blocked.length === 0 ? (
              <div className='rounded-lg border border-slate-200 bg-white p-8 text-center dark:border-border dark:bg-card'>
                <p className='text-[13px] font-medium text-emerald-600 dark:text-emerald-400'>
                  Every open record has at least one available owner.
                </p>
                {data.no_owner_count > 0 && (
                  <p className='mt-1 text-[12px] text-muted-foreground'>
                    {formatNumber(data.no_owner_count)} record(s) resolve no owners at all — that is
                    owner-matrix coverage, not absence; see the pipeline Owner Matrix.
                  </p>
                )}
              </div>
            ) : (
              <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                <table className='w-full text-[12px]'>
                  <thead>
                    <tr className='border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-muted-foreground dark:border-border'>
                      <th className='px-3 py-2'>Record</th>
                      <th className='px-3 py-2'>State</th>
                      <th className='px-3 py-2'>Unavailable owners</th>
                    </tr>
                  </thead>
                  <tbody className='tabular-nums'>
                    {data.blocked.map((b) => (
                      <tr
                        key={`${b.collection}-${b.item}`}
                        className='border-b border-slate-100 last:border-0 dark:border-border/60'
                      >
                        <td className='px-3 py-2'>
                          <Link
                            to={`/collections/${b.collection}/${b.item}`}
                            className='text-[#00a5cc] underline decoration-dotted underline-offset-2'
                          >
                            {b.label}
                          </Link>
                          <span className='ml-2 text-[11px] text-muted-foreground'>
                            {b.collection}
                          </span>
                        </td>
                        <td className='px-3 py-2'>{b.state ?? '—'}</td>
                        <td className='px-3 py-2'>
                          <span className='flex flex-wrap items-center gap-1.5'>
                            {b.owners.map((o) => (
                              <span key={o.id} className='inline-flex items-center gap-1'>
                                {o.name} <ReasonChip reason={o.reason} />
                              </span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}


// ─── OOO runway (#727) ───────────────────────────────────────────────────────

function RunwayTab({
  entries,
  days,
  loading
}: {
  entries: RunwayEntry[]
  days: number
  loading: boolean
}) {
  if (loading) {
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((i) => (
          <div key={i} className='h-14 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
        ))}
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <p className='flex items-center gap-1.5 text-[13px] font-medium text-emerald-600 dark:text-emerald-400'>
        <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
        Nobody who holds owner seats is scheduled out over the next {days} days.
      </p>
    )
  }
  const risky = entries.filter((e) => !e.delegate_ok && e.pending_estimate > 0)
  const fmtDay = (v: string | null) =>
    v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
  return (
    <div className='max-w-[900px] space-y-3'>
      {risky.length > 0 && (
        <p className='text-[12.5px] text-slate-700 dark:text-foreground'>
          <span className='font-semibold text-red-600 dark:text-red-400'>{risky.length}</span>{' '}
          upcoming absence{risky.length === 1 ? '' : 's'} with real load and{' '}
          <span className='font-medium'>no working delegate</span> — set delegates before these
          windows open.
        </p>
      )}
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <table className='w-full text-[12.5px]'>
          <thead>
            <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border/60'>
              <th className='px-3 py-2 font-semibold'>Person</th>
              <th className='px-3 py-2 font-semibold'>Out</th>
              <th className='px-3 py-2 font-semibold'>Delegate</th>
              <th className='px-3 py-2 text-right font-semibold'>Seats</th>
              <th className='px-3 py-2 text-right font-semibold'>Load touched</th>
              <th className='px-3 py-2 font-semibold'>Covers</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 tabular-nums dark:divide-border/60'>
            {entries.map((e) => {
              const risk = !e.delegate_ok && e.pending_estimate > 0
              return (
                <tr key={e.user_id} className={risk ? 'bg-red-50/50 dark:bg-red-500/5' : undefined}>
                  <td className='px-3 py-2 font-medium text-slate-800 dark:text-foreground'>
                    {e.name}
                    {e.currently_out && (
                      <span className='ml-1.5 rounded bg-amber-100 px-1 py-px text-[9.5px] font-semibold uppercase text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'>
                        out now
                      </span>
                    )}
                  </td>
                  <td className='whitespace-nowrap px-3 py-2 text-slate-600 dark:text-muted-foreground'>
                    {fmtDay(e.ooo_start)} → {fmtDay(e.ooo_end)}
                  </td>
                  <td className='px-3 py-2'>
                    {e.delegate_ok ? (
                      <span className='text-emerald-600 dark:text-emerald-400'>
                        {e.delegate_name}
                      </span>
                    ) : e.delegate_name ? (
                      <span
                        className='text-red-600 dark:text-red-400'
                        title='Delegate is suspended, expired, or also out'
                      >
                        {e.delegate_name} (unavailable)
                      </span>
                    ) : (
                      <span className='text-red-600 dark:text-red-400'>none</span>
                    )}
                  </td>
                  <td className='px-3 py-2 text-right text-slate-600 dark:text-muted-foreground'>
                    {e.group_seats.toLocaleString()}
                  </td>
                  <td className='px-3 py-2 text-right font-semibold text-slate-800 dark:text-foreground'>
                    {e.pending_estimate.toLocaleString()}
                  </td>
                  <td className='max-w-[240px] truncate px-3 py-2 text-[11.5px] text-slate-500 dark:text-muted-foreground' title={e.states.join(', ')}>
                    {e.states.join(', ') || '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className='text-[11px] text-slate-400'>
        “Load touched” counts open records currently sitting in states this person helps cover — an
        estimate of exposure, not exact ownership. Delegates are set from each person's Profile or
        the admin Users page.
      </p>
    </div>
  )
}
