import { type ManagedUser, readUser } from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CalendarClock, Check, UserRound, Users } from 'lucide-react'
import { useState } from 'react'
import { useItemEditAuth, useNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { DelegationCard } from '../ProfileView'
import { UserChip } from '../item-edit/GroupSection'

/**
 * Delegation console — one page for absence coverage: who is out, who is
 * scheduled out, who covers whom, delegations about to expire, the people
 * whose absence leaves approvals with nobody (and how much), records blocked
 * right now (admin), and "set my delegate" for the viewer. Admins can assign
 * a delegate for someone else inline. Reads GET /delegation/overview and,
 * for admins, GET /coverage-gaps. Needs `<NivaroProvider>` (+
 * ItemEditAuthContext for the admin extras, NavigationContext for links).
 */

interface Person {
  id: string
  name: string
  email: string | null
}
interface Entry {
  user: Person
  currently_out: boolean
  ooo_start: string | null
  ooo_end: string | null
  delegate: Person | null
  delegate_expires_at: string | null
  delegate_ok: boolean
  delegate_problem: 'none' | 'expired' | 'suspended' | 'out' | null
  group_seats: number
  states: string[]
  pending_estimate: number
}
interface Overview {
  days: number
  generated_at: string
  out_now: Entry[]
  upcoming: Entry[]
  covering: Array<{
    delegate: Person
    covers: Array<Person & { expires_at: string | null; currently_out: boolean }>
  }>
  expiring: Array<{
    user: Person
    delegate: Person
    expires_at: string
    expired: boolean
    currently_out: boolean
  }>
  uncovered: Entry[]
  totals: {
    out_now: number
    upcoming: number
    covering: number
    expiring: number
    uncovered: number
    pending_uncovered: number
  }
}
interface GapReport {
  open_instances: number
  evaluated: number
  truncated: boolean
  blocked: Array<{
    collection: string
    item: string
    label: string
    state: string | null
    kind: string
    owners: Array<{ id: string; name: string; reason: string }>
  }>
  no_owner_count: number
}

const fmtDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'
const PROBLEM_TEXT: Record<NonNullable<Entry['delegate_problem']>, string> = {
  none: 'no delegate',
  expired: 'delegation expired',
  suspended: 'delegate is suspended',
  out: 'delegate is out too'
}

function Tile({ label, value, tone, hint }: { label: string; value: string | number; tone?: 'warn' | 'bad'; hint?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>{label}</p>
      <p
        className={cn(
          'mt-1 text-[22px] font-semibold tabular-nums',
          tone === 'bad'
            ? 'text-red-600 dark:text-red-400'
            : tone === 'warn'
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-slate-900 dark:text-foreground'
        )}
      >
        {value}
      </p>
      {hint && <p className='text-[11px] text-slate-400'>{hint}</p>}
    </div>
  )
}

function Card({ title, hint, children, tone }: { title: string; hint?: string; children: React.ReactNode; tone?: 'bad' }) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-white dark:bg-card',
        tone === 'bad' ? 'border-red-300 dark:border-red-500/40' : 'border-slate-200 dark:border-border'
      )}
    >
      <header className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
        {hint && <p className='text-[11px] text-slate-400'>{hint}</p>}
      </header>
      {children}
    </div>
  )
}

function DelegateStatus({ e }: { e: Entry }) {
  if (!e.delegate)
    return (
      <span className='inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-red-600 dark:text-red-400'>
        <AlertTriangle className='h-3 w-3' /> No delegate
      </span>
    )
  return (
    <span className='inline-flex flex-wrap items-center gap-1.5'>
      <UserChip userId={e.delegate.id} size='compact' />
      {e.delegate_ok ? (
        <span className='inline-flex items-center gap-0.5 text-[10.5px] text-emerald-700 dark:text-emerald-400'>
          <Check className='h-3 w-3' /> covering
          {e.delegate_expires_at ? ` until ${fmtDate(e.delegate_expires_at)}` : ''}
        </span>
      ) : (
        <span className='inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-px text-[10.5px] font-semibold text-amber-700 dark:text-amber-400'>
          <AlertTriangle className='h-3 w-3' /> {PROBLEM_TEXT[e.delegate_problem ?? 'none']}
        </span>
      )}
    </span>
  )
}

/** Admin: assign / change someone's delegate inline. */
function AssignDelegate({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [delegate, setDelegate] = useState<string | null>(entry.delegate?.id ?? null)
  const [expires, setExpires] = useState(entry.delegate_expires_at?.slice(0, 10) ?? '')
  const save = useMutation({
    mutationFn: () =>
      client.request(
        post(`/delegation/${entry.user.id}/delegate`, {
          delegate_id: delegate,
          delegate_expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null
        })
      ),
    onSuccess: () => {
      setOpen(false)
      onDone()
    }
  })
  if (!open)
    return (
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='text-[11.5px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-800 dark:hover:text-slate-200'
      >
        {entry.delegate ? 'Change' : 'Assign delegate'}
      </button>
    )
  return (
    <div className='flex flex-wrap items-end gap-2' data-nvr-assign-delegate>
      <div className='w-[220px]'>
        <RelationCombobox
          collection='nivaro_users'
          value={delegate}
          onChange={(v) => setDelegate(v == null ? null : String(v))}
          placeholder='Pick a delegate…'
        />
      </div>
      <input
        type='date'
        value={expires}
        onChange={(e) => setExpires(e.target.value)}
        aria-label='Delegation expires'
        className='h-9 rounded-md border border-slate-200 bg-background px-2 text-[12px] dark:border-border'
      />
      <button
        type='button'
        disabled={save.isPending}
        onClick={() => save.mutate()}
        className='h-9 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white disabled:opacity-50'
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      <button
        type='button'
        onClick={() => setOpen(false)}
        className='h-9 text-[12px] text-slate-400 hover:text-slate-600'
      >
        Cancel
      </button>
      {save.isError && (
        <span className='text-[11.5px] text-red-600'>
          {(save.error as { response?: { error?: string } })?.response?.error ?? 'Save failed'}
        </span>
      )}
    </div>
  )
}

function EntryTable({ rows, isAdmin, onChanged, showWindow }: { rows: Entry[]; isAdmin: boolean; onChanged: () => void; showWindow: boolean }) {
  if (rows.length === 0) return <p className='px-4 py-4 text-[12px] text-slate-400'>Nobody.</p>
  return (
    <table className='w-full text-[12px]'>
      <thead>
        <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
          <th className='px-4 py-1.5 font-semibold'>Person</th>
          {showWindow && <th className='px-2 py-1.5 font-semibold'>Out</th>}
          <th className='px-2 py-1.5 font-semibold'>Delegate</th>
          <th className='px-2 py-1.5 font-semibold'>Covers</th>
          <th className='px-2 py-1.5 text-right font-semibold'>Pending</th>
          {isAdmin && <th className='px-2 py-1.5 font-semibold' />}
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.user.id} className='border-t border-slate-100 align-top dark:border-border'>
            <td className='px-4 py-2'>
              <UserChip userId={e.user.id} size='compact' />
            </td>
            {showWindow && (
              <td className='px-2 py-2 whitespace-nowrap text-slate-600 dark:text-muted-foreground'>
                {e.ooo_start || e.ooo_end
                  ? `${fmtDate(e.ooo_start)} → ${e.ooo_end ? fmtDate(e.ooo_end) : 'open'}`
                  : e.currently_out
                    ? 'until switched off'
                    : '—'}
              </td>
            )}
            <td className='px-2 py-2'>
              <DelegateStatus e={e} />
            </td>
            <td className='px-2 py-2 text-slate-500'>
              {e.group_seats > 0 ? (
                <span title={e.states.join(', ')} data-tip={e.states.join(', ')}>
                  {e.group_seats} seat{e.group_seats === 1 ? '' : 's'}
                  {e.states.length > 0 && (
                    <span className='ml-1 text-[11px] text-slate-400'>
                      · {e.states.slice(0, 3).join(', ')}
                      {e.states.length > 3 ? ` +${e.states.length - 3}` : ''}
                    </span>
                  )}
                </span>
              ) : (
                <span className='text-slate-300'>—</span>
              )}
            </td>
            <td
              className={cn(
                'px-2 py-2 text-right tabular-nums',
                e.pending_estimate > 0 && !e.delegate_ok
                  ? 'font-semibold text-red-600 dark:text-red-400'
                  : 'text-slate-600 dark:text-muted-foreground'
              )}
            >
              {e.pending_estimate}
            </td>
            {isAdmin && (
              <td className='px-2 py-2'>
                <AssignDelegate entry={e} onDone={onChanged} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export interface DelegationConsoleViewProps {
  className?: string
  /** Host toast hook. */
  onNotice?: (message: string) => void
}

export function DelegationConsoleView({ className, onNotice }: DelegationConsoleViewProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const auth = useItemEditAuth()
  const nav = useNavigation()
  const isAdmin = !!auth?.isAdmin
  const [days, setDays] = useState<7 | 14 | 30>(14)

  const { data, isLoading } = useQuery({
    queryKey: ['delegation-overview', days],
    queryFn: () =>
      client.request<{ data: Overview }>(get('/delegation/overview', { days })).then((r) => r.data)
  })
  const { data: me } = useQuery({
    queryKey: ['nvr-profile-user', 'me'],
    queryFn: () =>
      client.request(readUser('me' as never)).then((r) => (r as { data: ManagedUser }).data)
  })
  const { data: gaps } = useQuery({
    queryKey: ['coverage-gaps'],
    queryFn: () => client.request<{ data: GapReport }>(get('/coverage-gaps')).then((r) => r.data),
    enabled: isAdmin,
    staleTime: 60_000
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['delegation-overview'] })
    void qc.invalidateQueries({ queryKey: ['nvr-profile-user'] })
    void qc.invalidateQueries({ queryKey: ['coverage-gaps'] })
    onNotice?.('Saved')
  }
  const gapsPath = nav.consoleUrl ? nav.consoleUrl('/coverage-gaps') : '/coverage-gaps'

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col', className)} data-nvr-delegation-console>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Users className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Delegation
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Who is out, who covers them, what expires soon, and whose absence leaves approvals
              with nobody — plus your own delegate.
            </p>
          </div>
          <span className='flex-1' />
          <div className='inline-flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {([7, 14, 30] as const).map((d) => (
              <button
                key={d}
                type='button'
                onClick={() => setDays(d)}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium',
                  days === d
                    ? 'bg-slate-900 text-white dark:bg-nvr-cyan dark:text-[#172940]'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                )}
              >
                next {d}d
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {isLoading || !data ? (
          <p className='text-[13px] text-slate-400'>Loading…</p>
        ) : (
          <div className='space-y-5'>
            <div className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'>
              <Tile label='Out now' value={data.totals.out_now} />
              <Tile label={`Out in next ${days}d`} value={data.totals.upcoming} />
              <Tile label='People covering' value={data.totals.covering} />
              <Tile
                label='Expiring'
                value={data.totals.expiring}
                tone={data.expiring.some((e) => e.expired) ? 'bad' : data.totals.expiring ? 'warn' : undefined}
                hint={`delegations ending in ${days}d`}
              />
              <Tile
                label='Uncovered'
                value={data.totals.uncovered}
                tone={data.totals.uncovered ? 'bad' : undefined}
                hint='out (or by tomorrow) with no working delegate'
              />
              <Tile
                label='Approvals at risk'
                value={data.totals.pending_uncovered}
                tone={data.totals.pending_uncovered ? 'bad' : undefined}
                hint='open items in states they cover'
              />
            </div>

            {data.uncovered.length > 0 && (
              <Card
                tone='bad'
                title='Would go unowned — no working delegate'
                hint='Out now, or entering an OOO window within 24 hours, with nobody able to act for them. Pending = open items sitting in states they help cover.'
              >
                <EntryTable rows={data.uncovered} isAdmin={isAdmin} onChanged={refresh} showWindow />
              </Card>
            )}

            <div className='grid grid-cols-1 gap-4 xl:grid-cols-2'>
              <div className='space-y-4'>
                <Card title='Out now' hint='Currently out of office.'>
                  <EntryTable rows={data.out_now} isAdmin={isAdmin} onChanged={refresh} showWindow />
                </Card>
                <Card title={`Coming up (next ${days} days)`} hint='Scheduled OOO windows — the flag flips on entry and clears on exit.'>
                  <EntryTable rows={data.upcoming} isAdmin={isAdmin} onChanged={refresh} showWindow />
                </Card>
              </div>
              <div className='space-y-4'>
                {me && <DelegationCard user={me} onSaved={refresh} />}
                <Card title='Who covers whom' hint='Active delegations: the delegate and everyone routing to them right now.'>
                  {data.covering.length === 0 ? (
                    <p className='px-4 py-4 text-[12px] text-slate-400'>No active delegations.</p>
                  ) : (
                    <ul className='divide-y divide-slate-100 dark:divide-border'>
                      {data.covering.map((c) => (
                        <li key={c.delegate.id} className='flex flex-wrap items-start gap-2 px-4 py-2 text-[12px]'>
                          <UserChip userId={c.delegate.id} size='compact' />
                          <span className='mt-1 text-slate-400'>covers</span>
                          <span className='flex flex-wrap gap-1'>
                            {c.covers.map((p) => (
                              <span key={p.id} className='inline-flex items-center gap-1'>
                                <UserChip userId={p.id} size='compact' />
                                {p.expires_at && (
                                  <span className='text-[10.5px] text-slate-400'>until {fmtDate(p.expires_at)}</span>
                                )}
                              </span>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title='Expiring delegations' hint={`Ending within ${days} days — an expired one while the person is still out means approvals are stalling.`}>
                  {data.expiring.length === 0 ? (
                    <p className='px-4 py-4 text-[12px] text-slate-400'>Nothing expiring.</p>
                  ) : (
                    <ul className='divide-y divide-slate-100 dark:divide-border'>
                      {data.expiring.map((x) => (
                        <li key={x.user.id} className='flex flex-wrap items-center gap-2 px-4 py-2 text-[12px]'>
                          <CalendarClock className={cn('h-3.5 w-3.5', x.expired ? 'text-red-500' : 'text-amber-500')} />
                          <UserChip userId={x.user.id} size='compact' />
                          <span className='text-slate-400'>→</span>
                          <UserChip userId={x.delegate.id} size='compact' />
                          <span className={cn('ml-auto text-[11.5px]', x.expired ? 'font-semibold text-red-600 dark:text-red-400' : 'text-slate-500')}>
                            {x.expired ? `expired ${fmtDate(x.expires_at)}${x.currently_out ? ' · still out' : ''}` : `ends ${fmtDate(x.expires_at)}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>

            {isAdmin && (
              <Card
                title='Records blocked right now'
                hint='Open records whose entire owner set cannot act (out with no working delegate, suspended, inactive). Live resolution over open instances.'
              >
                {!gaps ? (
                  <p className='px-4 py-4 text-[12px] text-slate-400'>Resolving owners…</p>
                ) : gaps.blocked.length === 0 ? (
                  <p className='px-4 py-4 text-[12px] text-slate-400'>
                    Nothing blocked — every open record has at least one owner who can act.
                    {gaps.no_owner_count > 0 && ` (${gaps.no_owner_count} resolve no owners at all — an owner-matrix coverage question, see Coverage Gaps.)`}
                  </p>
                ) : (
                  <>
                    <table className='w-full text-[12px]'>
                      <thead>
                        <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
                          <th className='px-4 py-1.5 font-semibold'>Record</th>
                          <th className='px-2 py-1.5 font-semibold'>State</th>
                          <th className='px-2 py-1.5 font-semibold'>Owners who cannot act</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gaps.blocked.slice(0, 40).map((g) => (
                          <tr key={`${g.collection}:${g.item}`} className='border-t border-slate-100 dark:border-border'>
                            <td className='px-4 py-1.5'>
                              <button
                                type='button'
                                onClick={() => nav.navigate(`/collections/${g.collection}/${g.item}`)}
                                className='text-nvr-navy underline decoration-dotted underline-offset-2 dark:text-nvr-cyan'
                              >
                                {g.label}
                              </button>
                              <span className='ml-1 text-[10.5px] text-slate-400'>{g.collection.replace(/_/g, ' ')}</span>
                            </td>
                            <td className='px-2 py-1.5 text-slate-600 dark:text-muted-foreground'>{g.state ?? '—'}</td>
                            <td className='px-2 py-1.5 text-slate-600 dark:text-muted-foreground'>
                              {g.owners.map((o) => `${o.name} (${o.reason.replace(/_/g, ' ')})`).join(', ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {(gaps.blocked.length > 40 || gapsPath) && (
                      <p className='px-4 py-2 text-[11.5px] text-slate-400'>
                        {gaps.blocked.length > 40 ? `Showing 40 of ${gaps.blocked.length}. ` : ''}
                        {gapsPath && (
                          <button type='button' onClick={() => nav.navigate(gapsPath)} className='underline decoration-dotted underline-offset-2'>
                            Full coverage-gap report →
                          </button>
                        )}
                      </p>
                    )}
                  </>
                )}
              </Card>
            )}
            <p className='flex items-center gap-1 text-[11px] text-slate-400'>
              <UserRound className='h-3 w-3' /> Computed live at {new Date(data.generated_at).toLocaleTimeString()}.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
