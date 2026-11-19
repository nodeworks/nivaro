import { Bot, Clock, Cog, FileInput, KeyRound, UserRoundCog, Workflow } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigation } from '../../context'
import {
  type ActivityLabels,
  actorName,
  actorOf,
  HIDDEN_RECORD,
  readableTitle,
  recordPhrase
} from '../../lib/activity-sentence'
import { ACTOR_KIND_WORDS, type ActorKind, SOURCE_WORDS } from '../../lib/activity-table'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { actionWord } from '../profile/ActivityFeedCard'
import { UserAvatar } from '../UserAvatar'
import type { ActivityRequestRef, ActivityTableRow } from './types'

/** Small pieces the Table and the entry detail share. */

type Tone = 'create' | 'update' | 'delete' | 'move' | 'signin' | 'access' | 'read' | 'other'

export function actionTone(action: string): Tone {
  if (action === 'create' || action === 'restore' || action === 'pipeline-start') return 'create'
  if (action === 'delete') return 'delete'
  if (action === 'update' || action === 'revert' || action === 'undo') return 'update'
  if (action.includes('transition')) return 'move'
  if (action === 'login' || action === 'logout') return 'signin'
  if (/^access/.test(action)) return 'access'
  if (action === 'read' || action.endsWith('-read') || action.endsWith('-view')) return 'read'
  return 'other'
}

const TONE_DOT: Record<Tone, string> = {
  create: 'bg-emerald-500',
  update: 'bg-slate-500 dark:bg-slate-400',
  delete: 'bg-red-500',
  move: 'bg-nvr-cyan',
  signin: 'bg-violet-500',
  access: 'bg-amber-500',
  read: 'bg-slate-300 dark:bg-slate-600',
  other: 'bg-slate-400 dark:bg-slate-500'
}

export function ActionLabel({ action, className }: { action: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-tip={action}>
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[actionTone(action)])}
        aria-hidden
      />
      <span className='truncate'>{actionWord(action) || readableTitle(action)}</span>
    </span>
  )
}

const KIND_ICON: Partial<Record<ActorKind, typeof Bot>> = {
  view_as: UserRoundCog,
  api_key: KeyRound,
  mcp: Bot,
  import: FileInput,
  flow: Workflow,
  cron: Clock,
  system: Cog
}

export function personInitials(name: string): string {
  const parts = name
    .replace(/\(.*\)/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Avatar, who (the shared actor words) and the actor kind when it is not simply a person. */
export function WhoCell({
  row,
  labels,
  compact
}: {
  row: ActivityTableRow
  labels?: ActivityLabels | null
  compact?: boolean
}) {
  const actor = actorOf(row)
  const name = actorName(row, labels)
  const kind = actor.kind as ActorKind
  const Icon = KIND_ICON[kind]
  const personId = row.user ?? null
  return (
    <span className='flex min-w-0 items-center gap-2'>
      {personId && kind !== 'system' ? (
        <UserAvatar
          userId={personId}
          className={cn('shrink-0 rounded-full object-cover', compact ? 'h-5 w-5' : 'h-6 w-6')}
          fallback={
            <span
              className={cn(
                'flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-200',
                compact ? 'h-5 w-5 text-[9px]' : 'h-6 w-6 text-[10px]'
              )}
              aria-hidden
            >
              {personInitials(name)}
            </span>
          }
        />
      ) : (
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400',
            compact ? 'h-5 w-5' : 'h-6 w-6'
          )}
          aria-hidden
        >
          {Icon ? <Icon className='h-3 w-3' /> : null}
        </span>
      )}
      <span className='min-w-0'>
        <span className='block truncate text-slate-800 dark:text-slate-100'>{name}</span>
        {kind !== 'person' && !compact && (
          <span className='flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400'>
            {Icon && <Icon className='h-3 w-3' aria-hidden />}
            {ACTOR_KIND_WORDS[kind] ?? kind}
          </span>
        )}
      </span>
    </span>
  )
}

export function WhenText({ at, className }: { at: string; className?: string }) {
  return (
    <time
      dateTime={at}
      data-tip={formatDateTime(at)}
      className={cn('whitespace-nowrap tabular-nums', className)}
    >
      {formatRelative(at)}
    </time>
  )
}

export function sourceWords(row: Pick<ActivityTableRow, 'source' | 'via_agent' | 'actor'>): string {
  const actor = actorOf(row as never)
  if (row.source === 'mcp') {
    const app = String(actor.name ?? row.via_agent ?? '').replace(/^via\s+/i, '')
    return app || SOURCE_WORDS.mcp
  }
  if (row.source === 'api_key' && actor.kind === 'api_key' && actor.name)
    return `API key “${actor.name}”`
  if (row.source === 'background') {
    if (actor.kind === 'cron') return `Job ${actor.name ?? ''}`.trim()
    if (actor.kind === 'import') return actor.name ? `Import “${actor.name}”` : 'An import'
    if (actor.kind === 'flow') return actor.name ? `Flow “${actor.name}”` : 'A flow'
  }
  return SOURCE_WORDS[row.source] ?? row.source
}

/** The record the entry is about, as the reader may see it; opens it when it can be opened. */
export function RecordLink({
  row,
  labels,
  className
}: {
  row: Pick<ActivityTableRow, 'collection' | 'item' | 'action'>
  labels?: ActivityLabels | null
  className?: string
}) {
  const { navigate, itemUrl } = useNavigation()
  const phrase = recordPhrase(row.collection, row.item, labels)
  if (!phrase) return <span className='text-slate-400 dark:text-slate-500'>—</span>
  const openable =
    !!row.collection &&
    !!row.item &&
    phrase !== HIDDEN_RECORD &&
    !/^(nivaro|directus)_/.test(row.collection) &&
    row.action !== 'delete'
  if (!openable)
    return (
      <span className={cn('truncate', className)} data-tip={row.item ?? undefined}>
        {phrase}
      </span>
    )
  const url = itemUrl
    ? itemUrl({ collection: row.collection as string, itemId: row.item as string })
    : `/collections/${row.collection}/${row.item}`
  return (
    <a
      href={url}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        navigate(url)
      }}
      className={cn(
        'truncate text-slate-800 underline-offset-2 hover:text-nvr-cyan hover:underline focus-visible:underline dark:text-slate-100',
        className
      )}
      data-tip={`Open ${phrase}`}
    >
      {phrase}
    </a>
  )
}

export function requestHref(r: ActivityRequestRef): string | null {
  return r.request_id ? `/health/request-story?id=${encodeURIComponent(r.request_id)}` : null
}

export function requestTip(r: ActivityRequestRef): string {
  if (!r.method && !r.path) return 'The request log keeps 14 days — this one is no longer kept.'
  const parts = [`${r.method ?? ''} ${r.path ?? ''}`.trim()]
  if (r.status != null) parts.push(String(r.status))
  if (r.latency_ms != null) parts.push(`${Math.round(r.latency_ms)} ms`)
  return parts.join(' · ')
}

/** The request id, short, linking to its Request story (an admin console page). */
export function RequestCell({ request }: { request: ActivityRequestRef | null }): ReactNode {
  const { navigate, consoleUrl } = useNavigation()
  if (!request) return <span className='text-slate-400 dark:text-slate-500'>—</span>
  const href = requestHref(request)
  const url = href ? (consoleUrl ? consoleUrl(href) : href) : null
  const short = (request.request_id ?? request.chain_id).slice(0, 8)
  if (!url)
    return (
      <span className='font-mono text-[11px] text-slate-500' data-tip={requestTip(request)}>
        {short}
      </span>
    )
  return (
    <a
      href={url}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        navigate(url)
      }}
      className='font-mono text-[11px] text-slate-600 underline-offset-2 hover:text-nvr-cyan hover:underline dark:text-slate-300'
      data-tip={`${requestTip(request)} — open its request story`}
    >
      {short}
      {request.status != null && request.status >= 400 && (
        <span className='ml-1 rounded bg-red-50 px-1 text-[10px] font-medium text-red-700 dark:bg-red-500/15 dark:text-red-300'>
          {request.status}
        </span>
      )}
    </a>
  )
}
