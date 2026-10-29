import { useQuery } from '@tanstack/react-query'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Cog,
  Eye,
  KeyRound,
  Upload,
  Workflow
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import {
  type ActivityEntryInput,
  type ActivityGroup,
  type ActivityLabels,
  activityLabelRefs,
  activityWhy,
  actorName,
  actorOf,
  groupActivity,
  renderActivityGroupSentence,
  renderActivitySentence
} from '../lib/activity-sentence'
import { post } from '../lib/commands'
import { cn } from '../lib/utils'
import { AgentBadge } from './AgentBadge'
import { UserAvatar } from './UserAvatar'

/**
 * One audit-trail entry as a sentence ("Pat moved PO 4471 from Draft to Approved"), who
 * really did it (View-as, API key, assistant, import, flow, scheduled job), why (change
 * reason, transition note, linked approval) and when, in the reader's time zone. A burst
 * (`group` with more than one entry: one bulk action, import run, flow run, MCP request…)
 * reads as one line that expands to its entries.
 *
 * `actions` is a slot rendered at the row's end (Undo, Open…). Labels come from
 * `useActivityLabels` (POST /api/activity/labels, read as the viewer).
 */
export interface ActivityEntryProps {
  entry: ActivityEntryInput
  labels?: ActivityLabels | null
  /** The entry's whole burst, newest first (the entry itself included). */
  group?: ActivityEntryInput[]
  onOpen?: (entry: ActivityEntryInput) => void
  actions?: ReactNode
  /** Show the time at the row's end (default true). */
  showTime?: boolean
  className?: string
}

function timeText(ts: ActivityEntryInput['timestamp']): { short: string; full: string } | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const sameDay = new Date().toDateString() === d.toDateString()
  return {
    short: sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        }),
    full: d.toLocaleString()
  }
}

const ICON_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-300'

function ActorIcon({ entry, name }: { entry: ActivityEntryInput; name: string }) {
  const kind = actorOf(entry).kind
  const icon =
    kind === 'view_as' ? (
      <Eye className='h-3.5 w-3.5' />
    ) : kind === 'api_key' ? (
      <KeyRound className='h-3.5 w-3.5' />
    ) : kind === 'mcp' ? (
      <Bot className='h-3.5 w-3.5' />
    ) : kind === 'import' ? (
      <Upload className='h-3.5 w-3.5' />
    ) : kind === 'flow' ? (
      <Workflow className='h-3.5 w-3.5' />
    ) : kind === 'cron' ? (
      <Clock className='h-3.5 w-3.5' />
    ) : kind === 'system' ? (
      <Cog className='h-3.5 w-3.5' />
    ) : null
  if (icon)
    return (
      <span className={ICON_CLASS} data-activity-actor={kind} aria-hidden>
        {icon}
      </span>
    )
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <UserAvatar
      userId={entry.user ?? entry.user_id ?? null}
      className='h-6 w-6'
      fallback={
        <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/10 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
          {initials}
        </span>
      }
    />
  )
}

function WhyLines({ entry }: { entry: ActivityEntryInput }) {
  const why = activityWhy(entry)
  if (!why.reason && !why.note && !why.approval) return null
  return (
    <span className='mt-0.5 block space-y-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
      {why.note && (
        <span className='block truncate italic' data-activity-why='note' data-tip={why.note}>
          “{why.note}”
        </span>
      )}
      {why.reason && (
        <span className='block truncate' data-activity-why='reason' data-tip={why.reason}>
          Reason: {why.reason}
        </span>
      )}
      {why.approval && (
        <span className='block truncate' data-activity-why='approval'>
          Approval: {why.approval}
        </span>
      )}
    </span>
  )
}

export function ActivityEntry({
  entry,
  labels,
  group,
  onOpen,
  actions,
  showTime = true,
  className
}: ActivityEntryProps) {
  const [open, setOpen] = useState(false)
  const burst = group && group.length > 1 ? group : null
  const sentence = burst
    ? renderActivityGroupSentence(burst, labels)
    : renderActivitySentence(entry, labels)
  const name = actorName(entry, labels)
  const time = timeText(entry.timestamp)
  const clickable = !!onOpen || !!burst
  const activate = () => {
    if (burst) setOpen((v) => !v)
    else onOpen?.(entry)
  }
  return (
    <div className={cn('min-w-0', className)} data-activity-entry={entry.id ?? ''}>
      <div className='flex w-full items-start gap-2.5 rounded-md px-2 py-2'>
        <ActorIcon entry={entry} name={name} />
        <span className='min-w-0 flex-1 text-[12.5px] leading-5 text-slate-700 dark:text-slate-200'>
          {clickable ? (
            <button
              type='button'
              onClick={activate}
              aria-expanded={burst ? open : undefined}
              className='inline-flex max-w-full items-start gap-1 text-left hover:underline'
            >
              {burst &&
                (open ? (
                  <ChevronDown className='mt-[3px] h-3.5 w-3.5 shrink-0 text-slate-400' />
                ) : (
                  <ChevronRight className='mt-[3px] h-3.5 w-3.5 shrink-0 text-slate-400' />
                ))}
              <span data-activity-sentence>{sentence}</span>
            </button>
          ) : (
            <span data-activity-sentence>{sentence}</span>
          )}
          {!burst && <WhyLines entry={entry} />}
        </span>
        <AgentBadge label={entry.via_agent} />
        {showTime && time && (
          <span
            className='shrink-0 pt-px text-[11px] tabular-nums text-slate-400'
            data-tip={time.full}
          >
            {time.short}
          </span>
        )}
        {actions && <span className='flex shrink-0 items-center gap-1'>{actions}</span>}
      </div>
      {burst && open && (
        <div className='ml-[18px] border-l border-slate-200 pl-3 dark:border-border'>
          {burst.map((e, i) => (
            <ActivityEntry
              key={String(e.id ?? i)}
              entry={e}
              labels={labels}
              onOpen={onOpen}
              showTime={showTime}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** A list of entries with bursts folded (groupActivity) — each group one ActivityEntry. */
export function ActivityFeed({
  entries,
  labels,
  onOpen,
  actionsFor,
  empty,
  className
}: {
  entries: ActivityEntryInput[]
  labels?: ActivityLabels | null
  onOpen?: (entry: ActivityEntryInput) => void
  /** The `actions` slot for a group's head entry. */
  actionsFor?: (group: ActivityGroup) => ReactNode
  empty?: ReactNode
  className?: string
}) {
  const groups = useMemo(() => groupActivity(entries), [entries])
  if (groups.length === 0) return <>{empty ?? null}</>
  return (
    <div className={cn('divide-y divide-slate-100 dark:divide-border', className)}>
      {groups.map((g) => (
        <ActivityEntry
          key={g.key}
          entry={g.entries[0]}
          group={g.entries.length > 1 ? g.entries : undefined}
          labels={labels}
          onOpen={onOpen}
          actions={actionsFor?.(g)}
        />
      ))}
    </div>
  )
}

/**
 * Labels for a page of entries, read AS THE VIEWER (POST /api/activity/labels): records they
 * cannot see come back null ("a record you can't see"), people by display name, collection /
 * field / choice labels. Adds the viewer's time zone. One request per distinct page.
 */
export function useActivityLabels(
  entries: ActivityEntryInput[],
  opts: { enabled?: boolean } = {}
): ActivityLabels | undefined {
  const client = useOptionalNivaroClient()
  const body = useMemo(() => activityLabelRefs(entries), [entries])
  const key = useMemo(() => JSON.stringify(body), [body])
  const empty = body.refs.length === 0 && body.users.length === 0 && body.collections.length === 0
  const { data } = useQuery({
    queryKey: ['activity-labels', key],
    queryFn: async () =>
      (
        (await client!.request(post<{ data: ActivityLabels }>('/activity/labels', body))) as {
          data: ActivityLabels
        }
      ).data,
    enabled: !!client && !empty && opts.enabled !== false,
    staleTime: 60_000,
    retry: false
  })
  return useMemo(() => {
    let timeZone: string | null = null
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null
    } catch {
      timeZone = null
    }
    return data ? { ...data, timeZone } : undefined
  }, [data])
}
