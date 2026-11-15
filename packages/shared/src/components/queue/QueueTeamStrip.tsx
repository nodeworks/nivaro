import { readOnlinePresence } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLiveEvent } from '../../lib/live'
import { useLivePreference } from '../../lib/live-preference'
import { type PresenceState, usePresenceStates } from '../../lib/use-online-users'
import { cn } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * "Who is on this queue's team, and are they here?" (rt7 #17)
 *
 * GET /queues/:id/team lists the people seated in the owner groups of the queue's workflows
 * (already trimmed to who this viewer may see in presence, never machine accounts), with
 * out-of-office and who covers. Online / away comes from the shared `['presence-online']` read
 * (viewer-filtered on the server; someone missing from it simply reads as "not online").
 *
 * Live in Normal: presence moves the dots, `owners:changed` (delegation, out of office, seats)
 * re-reads the list. Calm and Off keep the strip STATIC — the dots show how things were when the
 * screen loaded and nothing re-reads until the next load. Renders nothing for an empty team.
 */

export interface TeamMember {
  id: string
  name: string
  out_of_office: boolean
  ooo_end: string | null
  covered_by: { id: string; name: string } | null
}

export type TeamStatus = 'online' | 'away' | 'out' | 'offline'

export const TEAM_STATUS_LABEL: Record<TeamStatus, string> = {
  online: 'Online',
  away: 'Away',
  out: 'Out of office',
  offline: 'Not online'
}

const STATUS_RANK: Record<TeamStatus, number> = { online: 0, away: 1, out: 2, offline: 3 }

/** One person's status: out of office beats presence; idle or "appear away" reads as away. */
export function teamStatus(m: TeamMember, state: PresenceState | undefined): TeamStatus {
  if (m.out_of_office) return 'out'
  if (state === 'online') return 'online'
  if (state === 'idle') return 'away'
  return 'offline'
}

function untilText(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Out of office until Nov 20 · Beth Cole covers" — the roster's second line for an absent person. */
export function outLine(m: TeamMember): string {
  const until = m.ooo_end ? untilText(m.ooo_end) : null
  const base = until ? `Out of office until ${until}` : 'Out of office'
  return m.covered_by ? `${base} · ${m.covered_by.name} covers` : base
}

export interface TeamRow {
  member: TeamMember
  status: TeamStatus
}

/** Members with their status, most present first, then by name (pure). */
export function teamRows(
  members: TeamMember[],
  states: ReadonlyMap<string, PresenceState>
): TeamRow[] {
  return members
    .map((member) => ({
      member,
      status: teamStatus(member, states.get(member.id.toUpperCase()))
    }))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.member.name.localeCompare(b.member.name)
    )
}

/** "3 online · 1 away · 1 out" — only the kinds that exist (pure). */
export function teamSummary(rows: TeamRow[]): string {
  const n = (s: TeamStatus) => rows.filter((r) => r.status === s).length
  const parts: string[] = []
  if (n('online')) parts.push(`${n('online')} online`)
  if (n('away')) parts.push(`${n('away')} away`)
  if (n('out')) parts.push(`${n('out')} out`)
  return parts.length ? parts.join(' · ') : 'No one online'
}

const DOT: Record<TeamStatus, string> = {
  online: 'bg-emerald-500',
  away: 'bg-amber-500',
  offline: 'bg-slate-300 dark:bg-slate-600',
  out: 'border border-slate-400 bg-white dark:border-slate-500 dark:bg-card'
}

const GROUP_LABEL: Record<TeamStatus, string> = {
  online: 'Online',
  away: 'Away',
  out: 'Out of office',
  offline: 'Not online'
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''))
    .toUpperCase()
    .slice(0, 2)
}

/**
 * One face. `surface` names what it sits on, so the ring around the face and the cut-out around
 * its status dot match that surface in both themes (no halo). `z` stacks earlier faces on top,
 * so a status dot is never covered by the next face.
 */
function Face({
  row,
  size = 24,
  surface = 'strip',
  z
}: {
  row: TeamRow
  size?: number
  surface?: 'strip' | 'popover'
  z?: number
}) {
  const { member, status } = row
  const px = `${size}px`
  const ring = surface === 'popover' ? 'ring-popover' : 'ring-white dark:ring-card'
  return (
    <span
      className={cn('relative inline-flex shrink-0', status === 'out' && 'opacity-75')}
      style={{ width: px, height: px, zIndex: z }}
    >
      <UserAvatar
        userId={member.id}
        alt={member.name}
        className={cn('rounded-full object-cover ring-2', ring)}
        style={{ width: px, height: px }}
        fallback={
          <span
            className={cn(
              'inline-flex select-none items-center justify-center rounded-full bg-slate-200 font-semibold text-[10px] text-slate-700 ring-2 dark:bg-slate-700 dark:text-slate-200',
              ring
            )}
            style={{ width: px, height: px }}
          >
            {initialsOf(member.name)}
          </span>
        }
      />
      <span
        aria-hidden
        className={cn(
          '-bottom-px -right-px absolute h-2.5 w-2.5 rounded-full ring-2',
          ring,
          DOT[status]
        )}
      />
    </span>
  )
}

const INLINE_FACES = 6
const GROUP_ORDER: TeamStatus[] = ['online', 'away', 'out', 'offline']
const EMPTY: Map<string, PresenceState> = new Map()

function Roster({ rows, more, note }: { rows: TeamRow[]; more: number; note: string | null }) {
  const [showOffline, setShowOffline] = useState(false)
  const by = (st: TeamStatus) => rows.filter((r) => r.status === st)
  return (
    <>
      <div className='max-h-[340px] overflow-y-auto'>
        {GROUP_ORDER.map((st) => {
          const list = by(st)
          if (list.length === 0) return null
          const folded = st === 'offline' && !showOffline
          return (
            <section key={st} data-team-group={st}>
              {folded ? (
                <button
                  type='button'
                  onClick={() => setShowOffline(true)}
                  className='flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left font-semibold text-[11px] text-slate-500 uppercase tracking-wide hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800'
                >
                  <span>
                    {GROUP_LABEL[st]} · {list.length}
                  </span>
                  <span className='font-medium normal-case tracking-normal'>Show</span>
                </button>
              ) : (
                <div className='sticky top-0 z-10 flex items-center justify-between bg-popover px-2 py-1.5'>
                  <h4 className='font-semibold text-[11px] text-slate-500 uppercase tracking-wide dark:text-slate-400'>
                    {GROUP_LABEL[st]} · {list.length}
                  </h4>
                  {st === 'offline' && (
                    <button
                      type='button'
                      onClick={() => setShowOffline(false)}
                      className='rounded px-1 font-medium text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                    >
                      Hide
                    </button>
                  )}
                </div>
              )}
              {!folded && (
                <ul>
                  {list.map((r) => (
                    <li
                      key={r.member.id}
                      className='flex items-center gap-2.5 rounded-md px-2 py-1.5'
                    >
                      <Face row={r} size={26} surface='popover' />
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate font-medium text-[13px] text-slate-800 dark:text-slate-100'>
                          {r.member.name}
                        </span>
                        {r.status === 'out' && (
                          <span className='block text-[11px] text-slate-500 dark:text-slate-400'>
                            {outLine(r.member)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
      {more > 0 && (
        <p className='px-2 py-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
          and {more} more on this team
        </p>
      )}
      {note && (
        <p
          data-team-snapshot
          className='border-t px-2 py-1.5 text-[11px] text-slate-500 dark:text-slate-400'
        >
          {note}
        </p>
      )}
    </>
  )
}

export function QueueTeamStrip({ queueId }: { queueId: string }) {
  const client = useNivaroClient()
  const pref = useLivePreference()

  const { data, refetch } = useQuery<{ data: { members: TeamMember[]; more: number } }>({
    queryKey: ['queue-team', queueId],
    queryFn: () => client.request(get(`/queues/${queueId}/team`)),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false
  })

  // Delegation, out of office and owner seats moving: re-read (Normal only).
  useLiveEvent('owners:changed', () => void refetch(), {
    debounceMs: 2000,
    enabled: !pref.quiet
  })

  // Normal: the shared live presence read. Calm / Off: one read, frozen for this screen load.
  const live = usePresenceStates(!pref.quiet)
  const frozen = useQuery({
    queryKey: ['queue-team-presence-frozen', queueId],
    queryFn: () => client.request(readOnlinePresence()),
    enabled: pref.quiet,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    select: (res) => {
      const m = new Map<string, PresenceState>()
      for (const r of (res?.data ?? []) as Array<{
        user_id?: unknown
        is_idle?: boolean
        away?: boolean
      }>) {
        const id = String(r.user_id ?? '').toUpperCase()
        if (id) m.set(id, r.is_idle || r.away ? 'idle' : 'online')
      }
      return m
    }
  })
  const states = pref.quiet ? (frozen.data ?? EMPTY) : live

  const members = data?.data?.members
  const more = data?.data?.more ?? 0
  const rows = useMemo(() => teamRows(members ?? [], states), [members, states])
  if (rows.length === 0) return null

  const shown = rows.slice(0, INLINE_FACES)
  const rest = rows.length - shown.length + more
  // Calm / Off: the dots are a snapshot — say when it was taken.
  const asOf =
    pref.quiet && frozen.dataUpdatedAt
      ? new Date(frozen.dataUpdatedAt).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit'
        })
      : null
  const note = pref.quiet
    ? `${asOf ? `As of ${asOf} · ` : ''}live updates are off in ${pref.calm ? 'Calm' : 'Off'} mode`
    : null
  return (
    <div
      className='flex shrink-0 items-center gap-3 border-slate-100 border-b bg-white px-4 py-1.5 text-[12px] dark:border-slate-800 dark:bg-slate-900'
      data-queue-team
      data-live-quiet={pref.quiet ? '' : undefined}
    >
      <span className='shrink-0 font-medium text-slate-500 dark:text-slate-400'>Team</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex min-w-0 items-center gap-3 rounded-md px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800'
            aria-label={`Team availability: ${teamSummary(rows)}. Show everyone`}
          >
            <span className='shrink-0 whitespace-nowrap text-slate-700 dark:text-slate-200'>
              {teamSummary(rows)}
              {asOf && <span className='text-slate-500 dark:text-slate-400'> · as of {asOf}</span>}
            </span>
            <span className='flex shrink-0 items-center -space-x-1'>
              {shown.map((r, i) => (
                <span
                  key={r.member.id}
                  className='relative'
                  style={{ zIndex: shown.length - i }}
                  data-tip={`${r.member.name} · ${TEAM_STATUS_LABEL[r.status]}`}
                >
                  <Face row={r} z={shown.length - i} />
                </span>
              ))}
            </span>
            {rest > 0 && (
              <span className='shrink-0 whitespace-nowrap text-slate-500 tabular-nums dark:text-slate-400'>
                +{rest} more
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[340px] p-1'>
          <Roster rows={rows} more={more} note={note} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
