import { readOnlinePresence } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
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

const STATUS_RANK: Record<TeamStatus, number> = { online: 0, away: 1, offline: 2, out: 3 }

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
  out: 'border border-slate-400 bg-white dark:border-slate-500 dark:bg-slate-900'
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''))
    .toUpperCase()
    .slice(0, 2)
}

function Face({ row, size = 24 }: { row: TeamRow; size?: number }) {
  const { member, status } = row
  const px = `${size}px`
  return (
    <span
      className={cn('relative inline-flex shrink-0', status === 'out' && 'opacity-60')}
      style={{ width: px, height: px }}
    >
      <UserAvatar
        userId={member.id}
        alt={member.name}
        className='rounded-full object-cover'
        style={{ width: px, height: px }}
        fallback={
          <span
            className='inline-flex select-none items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200'
            style={{ width: px, height: px }}
          >
            {initialsOf(member.name)}
          </span>
        }
      />
      <span
        aria-hidden
        className={cn(
          '-bottom-px -right-px absolute h-2 w-2 rounded-full ring-2 ring-white dark:ring-slate-900',
          DOT[status]
        )}
      />
    </span>
  )
}

const INLINE_FACES = 7
const EMPTY: Map<string, PresenceState> = new Map()

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
            className='flex min-w-0 items-center gap-2.5 rounded-md px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800'
            aria-label={`Team availability: ${teamSummary(rows)}. Show everyone`}
          >
            <span className='flex items-center -space-x-1.5'>
              {shown.map((r) => (
                <span
                  key={r.member.id}
                  data-tip={`${r.member.name} · ${TEAM_STATUS_LABEL[r.status]}`}
                >
                  <Face row={r} />
                </span>
              ))}
            </span>
            {rest > 0 && (
              <span className='text-slate-500 tabular-nums dark:text-slate-400'>+{rest}</span>
            )}
            <span className='truncate text-slate-600 dark:text-slate-300'>{teamSummary(rows)}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[300px] p-1'>
          <ul className='max-h-[320px] overflow-y-auto'>
            {rows.map((r) => (
              <li key={r.member.id} className='flex items-center gap-2.5 rounded-md px-2 py-1.5'>
                <Face row={r} size={26} />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate font-medium text-[13px] text-slate-800 dark:text-slate-100'>
                    {r.member.name}
                  </span>
                  <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
                    {r.status === 'out' ? outLine(r.member) : TEAM_STATUS_LABEL[r.status]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {more > 0 && (
            <p className='px-2 py-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
              and {more} more on this team
            </p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
