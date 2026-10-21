import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, History } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post, put } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'

/**
 * Idle channel archive suggestions (#2485) and channel membership history
 * (#2784): the owner's banner, the owner's members-panel history, and the
 * admin "Channels" tab in chat analytics.
 */

function errorText(e: unknown, fallback: string): string {
  return (e as { response?: { error?: string } })?.response?.error ?? fallback
}

// ── Owner: the suggestion banner ───────────────────────────────────────────

export function ArchiveSuggestionBanner({
  channelId,
  channelName,
  suggestedAt
}: {
  channelId: number
  channelName: string
  suggestedAt: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const answer = useMutation({
    mutationFn: (action: 'archive' | 'keep') =>
      client.request(post(`/chat/channels/${channelId}/archive-suggestion`, { action })),
    onSuccess: (_d, action) => {
      toast.success(action === 'archive' ? 'Channel archived' : 'Channel kept open')
      void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
      void qc.invalidateQueries({ queryKey: ['nvr-chat-directory'] })
    },
    onError: (e) => toast.error(errorText(e, 'Could not save your answer'))
  })
  return (
    <div
      className='flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/40'
      data-chat-archive-suggestion
    >
      <Archive className='h-3.5 w-3.5 shrink-0 text-slate-500' strokeWidth={2} />
      <p className='min-w-0 flex-1 text-[12px] text-slate-700 dark:text-slate-200'>
        #{channelName} has been quiet. Archive it to tidy the list, or keep it open. Suggested{' '}
        {formatRelative(suggestedAt)}.
      </p>
      <span className='flex shrink-0 gap-1.5'>
        <button
          type='button'
          disabled={answer.isPending}
          onClick={() => answer.mutate('archive')}
          className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white disabled:opacity-50'
          data-chat-archive-accept
        >
          Archive
        </button>
        <button
          type='button'
          disabled={answer.isPending}
          onClick={() => answer.mutate('keep')}
          className='h-7 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
          data-chat-archive-keep
        >
          Keep open
        </button>
      </span>
    </div>
  )
}

// ── Membership history ─────────────────────────────────────────────────────

export interface MembershipEvent {
  id: number
  at: string
  kind: 'joined' | 'left' | 'added' | 'removed' | 'auto_joined' | 'bulk_added'
  channel: string
  channel_name?: string
  user_id: string | null
  user_name: string | null
  by_id: string | null
  by_name: string | null
  count?: number
  note?: string | null
}

export function eventText(e: MembershipEvent): string {
  const who = e.user_name ?? 'Someone'
  const by = e.by_name ?? 'someone'
  switch (e.kind) {
    case 'joined':
      return `${who} joined`
    case 'left':
      return `${who} left`
    case 'added':
      return `${by} added ${who}${e.note ? ` (${e.note})` : ''}`
    case 'removed':
      return `${by} removed ${who}`
    case 'auto_joined':
      return `${who} joined by default role`
    case 'bulk_added':
      return `${by} added ${e.count ?? 0} people (${e.note ?? 'a group'})`
  }
}

function EventList({ events, showChannel }: { events: MembershipEvent[]; showChannel?: boolean }) {
  return (
    <ul className='divide-y divide-slate-100 dark:divide-border'>
      {events.map((e) => (
        <li
          key={e.id}
          className='flex items-baseline gap-2 px-2 py-1.5 text-[12px]'
          data-chat-membership-event={e.kind}
        >
          <span className='min-w-0 flex-1 text-slate-700 dark:text-slate-200'>
            {showChannel && (
              <span className='mr-1.5 font-medium text-slate-900 dark:text-slate-50'>
                #{e.channel_name ?? e.channel}
              </span>
            )}
            {eventText(e)}
          </span>
          <span
            className='shrink-0 text-[11px] text-slate-500 dark:text-slate-400'
            data-tip={new Date(e.at).toLocaleString()}
          >
            {formatRelative(e.at)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Members panel, owners and admins: who came and went, and who did it. */
export function MembershipHistory({ channelId, border }: { channelId: number; border: string }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['nvr-chat-membership-history', channelId],
    queryFn: () =>
      client
        .request<{ data: MembershipEvent[] }>(get(`/chat/channels/${channelId}/membership-history`))
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 30_000
  })
  return (
    <div data-chat-membership-history>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className='inline-flex items-center gap-1 text-[11.5px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
      >
        <History className='h-3.5 w-3.5' />{' '}
        {open ? 'Hide who joined and left' : 'Who joined and left'}
      </button>
      {open && (
        <div className={cn('mt-1.5 max-h-60 overflow-y-auto rounded-lg border', border)}>
          {isLoading ? (
            <div className='space-y-1.5 p-2'>
              <Skeleton className='h-4 w-3/4' />
              <Skeleton className='h-4 w-2/3' />
            </div>
          ) : isError ? (
            <p className='p-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
              Could not load the history.
            </p>
          ) : !data || data.length === 0 ? (
            <p className='p-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
              No joins or leaves recorded yet.
            </p>
          ) : (
            <EventList events={data} />
          )}
        </div>
      )}
    </div>
  )
}

// ── Admin: Channels tab in chat analytics ──────────────────────────────────

interface ArchiveRow {
  id: number
  key: string
  name: string
  owner_name: string | null
  last_post_at: string | null
  suggested_at: string | null
  kept_at: string | null
}
interface ArchiveOverview {
  idle_days: number
  suggested: ArchiveRow[]
  archived: ArchiveRow[]
}

function Card({
  title,
  note,
  children
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='mb-3 flex items-baseline justify-between gap-3'>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
        {note && <p className='text-[11px] text-slate-500 dark:text-slate-400'>{note}</p>}
      </div>
      {children}
    </section>
  )
}

function ChannelRows({ rows, empty }: { rows: ArchiveRow[]; empty: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const reopen = useMutation({
    mutationFn: (id: number) =>
      client.request(post(`/chat/channels/${id}/archive-suggestion`, { action: 'keep' })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-chat-archive-overview'] }),
    onError: (e) => toast.error(errorText(e, 'Could not keep that channel open'))
  })
  if (rows.length === 0)
    return <p className='py-2 text-[12px] text-slate-500 dark:text-slate-400'>{empty}</p>
  return (
    <ul className='divide-y divide-slate-100 dark:divide-border'>
      {rows.map((r) => (
        <li key={r.id} className='flex items-baseline gap-3 py-1.5 text-[12px]'>
          <span className='min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100'>
            #{r.name}
          </span>
          <span className='hidden shrink-0 text-slate-500 sm:inline dark:text-slate-400'>
            {r.owner_name ?? 'No owner'}
          </span>
          <span className='shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
            {r.last_post_at ? `last post ${formatRelative(r.last_post_at)}` : 'no posts'}
          </span>
          {r.suggested_at && (
            <button
              type='button'
              disabled={reopen.isPending}
              onClick={() => reopen.mutate(r.id)}
              className='shrink-0 rounded text-[11.5px] font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 dark:text-slate-300 dark:hover:text-white'
            >
              {reopen.isPending && reopen.variables === r.id ? 'Keeping…' : 'Keep open'}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function ChannelsAdminTab() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const overview = useQuery({
    queryKey: ['nvr-chat-archive-overview'],
    queryFn: () =>
      client
        .request<{ data: ArchiveOverview }>(get('/chat/admin/archive-overview'))
        .then((r) => r.data),
    staleTime: 30_000
  })
  const [days, setDays] = useState<string | null>(null)
  const idle = overview.data?.idle_days
  const shownDays = days ?? (idle === undefined ? '' : String(idle))
  const daysNum = days === null || days.trim() === '' ? null : Number(days)
  const daysBad = daysNum !== null && (!Number.isInteger(daysNum) || daysNum < 0 || daysNum > 3650)
  const refresh = (d?: ArchiveOverview) => {
    if (d) qc.setQueryData(['nvr-chat-archive-overview'], d)
    else void qc.invalidateQueries({ queryKey: ['nvr-chat-archive-overview'] })
  }
  const save = useMutation({
    mutationFn: (v: number | null) =>
      client
        .request<{ data: ArchiveOverview }>(put('/chat/admin/archive-settings', { idle_days: v }))
        .then((r) => r.data),
    onSuccess: (d) => {
      refresh(d)
      setDays(null)
      toast.success('Saved')
    },
    onError: (e) => toast.error(errorText(e, 'Could not save'))
  })
  const sweep = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { suggested: number; overview: ArchiveOverview } }>(
          post('/chat/admin/archive-suggest-now')
        )
        .then((r) => r.data),
    onSuccess: (d) => {
      refresh(d.overview)
      toast.success(
        d.suggested === 0
          ? 'No quiet channels found'
          : `${d.suggested} ${d.suggested === 1 ? 'suggestion' : 'suggestions'} sent`
      )
    },
    onError: (e) => toast.error(errorText(e, 'Could not run the check'))
  })
  const [period, setPeriod] = useState(30)
  const history = useQuery({
    queryKey: ['nvr-chat-membership-history-all', period],
    queryFn: () =>
      client
        .request<{ data: MembershipEvent[] }>(
          get('/chat/admin/membership-history', { days: period })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000
  })
  return (
    <div className='space-y-4' data-chat-channels-admin>
      <Card
        title='Quiet channels'
        note={
          idle === 0
            ? 'Suggestions are off'
            : `Owners are asked after ${idle ?? 90} days with no posts`
        }
      >
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          <label className='flex items-center gap-1.5 text-[12px] text-slate-700 dark:text-slate-200'>
            Suggest archiving after
            <input
              type='number'
              min={0}
              max={3650}
              value={shownDays}
              onChange={(e) => setDays(e.target.value)}
              aria-invalid={daysBad || undefined}
              className={cn(
                'h-7 w-16 rounded-md border bg-white px-2 text-[12px] tabular-nums outline-none focus:border-nvr-cyan dark:bg-card',
                daysBad
                  ? 'border-red-400 dark:border-red-500/60'
                  : 'border-slate-200 dark:border-border'
              )}
              aria-label='Idle days before an archive suggestion'
            />
            days (0 turns it off)
          </label>
          <button
            type='button'
            disabled={days === null || daysBad || save.isPending}
            onClick={() => save.mutate(daysNum)}
            className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white disabled:opacity-40'
          >
            Save
          </button>
          <button
            type='button'
            disabled={sweep.isPending}
            onClick={() => sweep.mutate()}
            className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-200 dark:hover:bg-muted'
          >
            {sweep.isPending ? 'Checking…' : 'Check now'}
          </button>
        </div>
        {overview.isLoading ? (
          <div className='space-y-1.5'>
            <Skeleton className='h-4 w-2/3' />
            <Skeleton className='h-4 w-1/2' />
          </div>
        ) : overview.isError ? (
          <p className='text-[12px] text-slate-500 dark:text-slate-400'>
            Could not load the channel lists.
          </p>
        ) : (
          <div className='space-y-4'>
            <div>
              <p className='mb-1 text-[12px] font-medium text-slate-600 dark:text-slate-300'>
                Waiting on the owner ({overview.data?.suggested.length ?? 0})
              </p>
              <ChannelRows
                rows={overview.data?.suggested ?? []}
                empty='No archive suggestions are waiting.'
              />
            </div>
            <div>
              <p className='mb-1 text-[12px] font-medium text-slate-600 dark:text-slate-300'>
                Archived ({overview.data?.archived.length ?? 0})
              </p>
              <ChannelRows
                rows={overview.data?.archived ?? []}
                empty='No channels are archived. Archived channels stay searchable and can be reopened in their settings.'
              />
            </div>
          </div>
        )}
      </Card>
      <Card title='Membership changes' note='Who joined, left, was added or removed'>
        <div className='mb-2 flex gap-1'>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setPeriod(d)}
              aria-pressed={period === d}
              className={cn(
                'h-6 rounded-md px-2 text-[11.5px] font-medium',
                period === d
                  ? 'bg-slate-100 text-slate-900 dark:bg-muted dark:text-slate-50'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
              )}
            >
              {d} days
            </button>
          ))}
        </div>
        {history.isLoading ? (
          <Skeleton className='h-16 w-full' />
        ) : history.isError ? (
          <p className='text-[12px] text-slate-500 dark:text-slate-400'>
            Could not load membership changes.
          </p>
        ) : (history.data ?? []).length === 0 ? (
          <p className='py-2 text-[12px] text-slate-500 dark:text-slate-400'>
            No joins or leaves in the last {period} days.
          </p>
        ) : (
          <div className='max-h-[420px] overflow-y-auto'>
            <EventList events={history.data ?? []} showChannel />
          </div>
        )}
      </Card>
    </div>
  )
}
