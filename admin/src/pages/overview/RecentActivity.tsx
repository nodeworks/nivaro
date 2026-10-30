import {
  ActivityEntry,
  groupActivity,
  LoadErrorNote,
  loadErrorText,
  useActivityLabels
} from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { type ActivityEntry as ActivityRow, api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { overviewKeys } from './api'
import { HIDDEN_ACTIONS, isShownEvent, type PulseEvent, usePulse, useThrottledCall } from './live'
import { Bone, EmptyNote, Section, SectionLink } from './parts'

/**
 * Recent activity, in plain sentences (the same feed as /activity), for one of three scopes:
 * Everyone (administrators), Mine, or My records (records I own, created or starred). The choice
 * is remembered per person on this device. New entries fade in at the top as they happen.
 */

export type ActivityScope = 'everyone' | 'mine' | 'my_records'

const SCOPES: Array<{ key: ActivityScope; label: string; adminOnly?: boolean }> = [
  { key: 'everyone', label: 'Everyone', adminOnly: true },
  { key: 'mine', label: 'Mine' },
  { key: 'my_records', label: 'My records' }
]

const LIMIT = 15
const scopeKey = (userId: string) => `nivaro_overview_activity_scope:${userId}`

function readScope(userId: string, isAdmin: boolean): ActivityScope {
  try {
    const v = localStorage.getItem(scopeKey(userId)) as ActivityScope | null
    if (v && SCOPES.some((s) => s.key === v && (isAdmin || !s.adminOnly))) return v
  } catch {
    /* storage blocked */
  }
  return isAdmin ? 'everyone' : 'my_records'
}

const EMPTY: Record<ActivityScope, { text: string; action: { label: string; to: string } }> = {
  everyone: {
    text: 'Nothing has changed yet. Changes appear here as people make them.',
    action: { label: 'Open the activity log', to: '/activity' }
  },
  mine: {
    text: 'You have not changed anything lately. Your edits, moves and uploads show up here.',
    action: { label: 'Browse collections', to: '/collections' }
  },
  my_records: {
    text: 'No changes on your records yet. Records you create, own or star show their changes here.',
    action: { label: 'Browse collections', to: '/collections' }
  }
}

export function RecentActivitySection({
  userId,
  isAdmin,
  className
}: {
  userId: string
  isAdmin: boolean
  className?: string
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [scope, setScopeState] = useState<ActivityScope>(() => readScope(userId, isAdmin))
  // Live entries from the pulse (Everyone only), and the ids on screen when the list first drew
  // (those never animate; later arrivals fade in). Both start over with a new scope.
  const [live, setLive] = useState<PulseEvent[]>([])
  const firstIds = useRef<Set<number> | null>(null)
  const setScope = (s: ActivityScope) => {
    setScopeState(s)
    setLive([])
    firstIds.current = null
    try {
      localStorage.setItem(scopeKey(userId), s)
    } catch {
      /* session only */
    }
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: overviewKeys.activity(scope),
    queryFn: () =>
      api
        .get<{ data: ActivityRow[] }>('/activity', {
          params: {
            limit: LIMIT,
            sort: '-timestamp',
            exclude_actions: HIDDEN_ACTIONS.join(','),
            ...(scope === 'everyone' ? {} : { scope })
          }
        })
        .then((r) => r.data.data),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    // Administrators get the pulse; everyone else a gentle refresh.
    refetchInterval: isAdmin ? 5 * 60_000 : 60_000
  })

  // Live: on Everyone, pulse entries join the list at once; on the narrower scopes the pulse only
  // says "something changed" and the list re-reads (the server decides what belongs in it).
  const refresh = useThrottledCall(
    () => void qc.invalidateQueries({ queryKey: overviewKeys.activity(scope) }),
    10_000
  )
  usePulse(
    isAdmin,
    (e) => {
      if (!isShownEvent(e)) return
      if (scope === 'everyone') setLive((prev) => [e, ...prev].slice(0, LIMIT))
      else refresh()
    },
    userId
  )

  const entries = useMemo(() => {
    const base = (data ?? []) as Array<ActivityRow & { id: number }>
    const ids = new Set(base.map((e) => e.id))
    const fresh = live.filter((e) => !ids.has(e.id))
    return [...fresh, ...base].slice(0, LIMIT) as Array<{ id: number; action: string }>
  }, [data, live])

  if (firstIds.current === null && data) firstIds.current = new Set(entries.map((e) => e.id))
  const groups = useMemo(() => groupActivity(entries as never[]), [entries])
  const labels = useActivityLabels(entries as never[])
  const scopes = SCOPES.filter((s) => isAdmin || !s.adminOnly)

  return (
    <Section
      id='activity'
      title='Recent activity'
      className={className}
      bodyClassName='flex-1'
      action={
        <div className='flex items-center gap-3'>
          <div
            role='radiogroup'
            aria-label='Whose activity'
            className='inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-white/[0.03]'
          >
            {scopes.map((s) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form field
              <button
                key={s.key}
                type='button'
                role='radio'
                aria-checked={scope === s.key}
                onClick={() => setScope(s.key)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                  scope === s.key
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          {isAdmin && <SectionLink to='/activity'>View all</SectionLink>}
        </div>
      }
    >
      {isLoading && !data ? (
        <div className='divide-y divide-slate-100 px-2 py-1 dark:divide-border' aria-hidden>
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <div key={k} className='flex items-start gap-2.5 px-2 py-2.5'>
              <Bone className='h-6 w-6 shrink-0 rounded-full' />
              <div className='flex-1 space-y-1.5'>
                <Bone className='h-3.5 w-[70%]' />
                <Bone className='h-2.5 w-24' />
              </div>
            </div>
          ))}
        </div>
      ) : error && !data ? (
        <div className='p-4'>
          <LoadErrorNote
            message={loadErrorText(error, 'recent activity')}
            onRetry={() => void refetch()}
          />
        </div>
      ) : groups.length === 0 ? (
        <EmptyNote action={EMPTY[scope].action}>{EMPTY[scope].text}</EmptyNote>
      ) : (
        <div className='divide-y divide-slate-100 px-2 py-1 dark:divide-border' aria-live='polite'>
          {groups.map((g) => {
            const head = g.entries[0] as { id: number }
            const isNew = !!firstIds.current && !firstIds.current.has(head.id)
            return (
              <ActivityEntry
                key={g.key}
                entry={g.entries[0]}
                group={g.entries.length > 1 ? g.entries : undefined}
                labels={labels}
                onOpen={
                  isAdmin
                    ? (e) => e.id != null && navigate(`/activity/${e.id}`)
                    : (e) =>
                        e.collection &&
                        e.item &&
                        !/^(nivaro_|directus_)/.test(e.collection) &&
                        navigate(`/collections/${e.collection}/${e.item}`)
                }
                className={cn(isNew && 'duration-500 ease-out animate-in fade-in')}
              />
            )
          })}
        </div>
      )}
    </Section>
  )
}
