import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Activity, ArrowDownAZ, ArrowUpAZ, ChevronRight, Globe, ShieldCheck, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import {
  type ActivityEntryInput,
  type ActivityLabels,
  activityWhy,
  actorName,
  groupActivity,
  junctionOf,
  linkChanges,
  linkPairText,
  parseTransitionComment,
  readableTitle,
  recordPhrase,
  renderActivityGroupSentence,
  renderActivitySentence,
  transitionVerb
} from '../../lib/activity-sentence'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { useActivityLabels } from '../ActivityEntry'
import { ErrorNotice } from '../ErrorNotice'
import { SimpleSelect } from '../ui/SimpleSelect'
import { EmptyLine, SectionCard } from './primitives'

/**
 * The person page's Activity feed (GET /api/user-activity/:id, administrators). Every row is
 * the shared activity sentence (lib/activity-sentence.ts) with labels read as the viewer
 * (POST /api/activity/labels) — so a link-table write reads "Removed Division Zone 1 from
 * Workflow CM26-79704", and the link rows of one write fold into one line, exactly as on the
 * Activity page. Access changes made TO the person (a grant, a User Scopes change, a role
 * change — `about_them` rows) read as the server phrased them, with who made them.
 */

interface FeedEntry extends ActivityEntryInput {
  id: number
  action: string
  timestamp: string
  collection: string | null
  item: string | null
  comment: string | null
  ip: string | null
  record_label?: string | null
  collection_label?: string | null
  about_them?: boolean
  summary?: string
  detail?: string | null
  by?: string | null
}
interface ActivitySummary {
  total: number
  actions: Array<{ action: string; count: number }>
  collections: Array<{ collection: string; collection_label?: string | null; count: number }>
}

/** Whether an activity row opens its record: not a system object (a query
 *  run, a setting — no record page shows those) and not a delete (the record
 *  is gone; the link only ever said "Record not found"). */
export function activityLinkable(entry: {
  action: string
  collection: string | null
  item: string | null
}): boolean {
  if (!entry.collection || !entry.item) return false
  if (/^(nivaro|directus)_/i.test(entry.collection)) return false
  return entry.action !== 'delete'
}

/** The filter chips' words: plain verbs, never action keys. */
const ACTION_WORDS: Record<string, string> = {
  read: 'Opened',
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  login: 'Signed in',
  logout: 'Signed out',
  comment: 'Commented',
  transition: 'Moved',
  'pipeline-transition': 'Moved',
  'access-request': 'Asked for access',
  'access-request-grant': 'Access granted',
  'access-request-deny': 'Access declined',
  'notification-read': 'Read notifications',
  'copy-access': 'Access copied'
}
export function actionWord(action: string): string {
  return ACTION_WORDS[action] ?? readableTitle(action)
}

type Tone = 'create' | 'update' | 'delete' | 'signin' | 'access' | 'other'
const TONE_DOT: Record<Tone, string> = {
  create: 'bg-emerald-500',
  update: 'bg-slate-400 dark:bg-slate-500',
  delete: 'bg-red-500',
  signin: 'bg-violet-500',
  access: 'bg-amber-500',
  other: 'bg-slate-400'
}
function toneOf(entries: FeedEntry[], labels?: ActivityLabels | null): Tone {
  const head = entries[0]
  if (head.about_them) return 'access'
  const actions = new Set(entries.map((e) => e.action))
  if (entries.length > 1 && junctionOf(head, labels))
    return actions.size > 1 ? 'update' : toneOf([head])
  if (head.action === 'create') return 'create'
  if (head.action === 'delete') return 'delete'
  if (head.action === 'login' || head.action === 'logout') return 'signin'
  if (/^access-request/.test(head.action)) return 'access'
  if (head.action === 'update' || head.action.includes('transition')) return 'update'
  return 'other'
}

/** The shared sentence without the actor — on a person's own page the actor is them. Edits
 *  and moves use the same plain verbs as "What they did" (Edited, Approved, Moved). */
function predicateOf(entries: FeedEntry[], labels?: ActivityLabels | null): string {
  const head = entries[0]
  if (entries.length === 1 && !junctionOf(head, labels)) {
    const record = recordPhrase(head.collection, head.item, labels)
    if (head.action === 'update' && record) {
      const s = renderActivitySentence(head, labels)
      const who = actorName(head, labels)
      const rest = s.startsWith(`${who} `) ? s.slice(who.length + 1) : s
      return rest.startsWith('updated ') ? `Edited ${rest.slice(8)}` : capitalise(rest)
    }
    if (/transition$/.test(head.action) && record) {
      const t = parseTransitionComment(head.comment)
      return `${transitionVerb(t.via)} ${record}`
    }
  }
  const full =
    entries.length > 1
      ? renderActivityGroupSentence(entries, labels)
      : renderActivitySentence(head, labels)
  const who = actorName(head, labels)
  return capitalise(full.startsWith(`${who} `) ? full.slice(who.length + 1) : full)
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A move's states, under its line ("Waiting on Level 2 Approval → Waiting on Level 5"). */
function statesOf(e: FeedEntry): string | null {
  if (!/transition$/.test(e.action)) return null
  const t = parseTransitionComment(e.comment)
  return t.from && t.to ? `${t.from} → ${t.to}` : t.to ? `→ ${t.to}` : null
}

/** One member of a folded write: a link row without its record (the line above names it). */
function childText(e: FeedEntry, labels?: ActivityLabels | null): string {
  const c = junctionOf(e, labels) ? linkChanges([e], labels) : null
  const clause = c?.rest[0] ?? (c?.pairs[0] ? linkPairText(c.pairs[0]) : null)
  if (!clause) return predicateOf([e], labels)
  return clause.charAt(0).toUpperCase() + clause.slice(1)
}

/** Where the row goes: the record, or for link rows the record they hang off. */
function targetOf(
  entries: FeedEntry[],
  labels?: ActivityLabels | null
): { collection: string; itemId: string } | null {
  for (const e of entries) {
    const j = junctionOf(e, labels)
    if (j) {
      if (j.parent_id && labels?.records?.[`${j.parent_collection}:${j.parent_id}`] !== null)
        return { collection: j.parent_collection, itemId: String(j.parent_id) }
      continue
    }
    if (labels?.records?.[`${e.collection}:${e.item}`] === null) return null
    if (activityLinkable(e)) return { collection: e.collection!, itemId: e.item! }
  }
  return null
}

const PAGE_LIMIT = 50

export function ActivityFeedCard({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const [action, setAction] = useState('')
  const [collection, setCollection] = useState('')
  const [sort, setSort] = useState<'desc' | 'asc'>('desc')
  const hasFilters = !!action || !!collection

  const { data: summary } = useQuery<ActivitySummary>({
    queryKey: ['nvr-user-activity-summary', userId],
    queryFn: () =>
      client
        .request<{ data: ActivitySummary }>(get(`/user-activity/${userId}/summary`))
        .then((r) => r.data)
  })
  const pages = useInfiniteQuery({
    queryKey: ['nvr-user-activity', userId, action, collection, sort],
    queryFn: ({ pageParam }) =>
      client.request<{ data: FeedEntry[]; total: number; page: number; limit: number }>(
        get(`/user-activity/${userId}`, {
          page: pageParam,
          limit: PAGE_LIMIT,
          ...(action && { action }),
          ...(collection && { collection }),
          sort
        })
      ),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined)
  })
  const entries = useMemo(() => pages.data?.pages.flatMap((p) => p.data) ?? [], [pages.data])
  const total = pages.data?.pages[0]?.total ?? summary?.total ?? 0
  // Records named as the viewer reads them; about-them rows already carry their words.
  const own = useMemo(() => entries.filter((e) => !e.about_them), [entries])
  const labels = useActivityLabels(own)

  const days = useMemo(() => {
    const out: Array<{ date: string; groups: FeedEntry[][] }> = []
    for (const g of groupActivity(entries, { labels })) {
      const head = g.entries[0]
      const date = new Date(head.timestamp).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      })
      const last = out[out.length - 1]
      // An about-them row never folds with the person's own rows.
      const split = g.entries.some((e) => e.about_them) ? g.entries.map((e) => [e]) : [g.entries]
      if (last?.date === date) last.groups.push(...split)
      else out.push({ date, groups: split })
    }
    return out
  }, [entries, labels])

  return (
    <SectionCard
      icon={<Activity className='h-4 w-4' />}
      title='Activity'
      hint={total ? `${total.toLocaleString()} event${total === 1 ? '' : 's'}` : undefined}
      testId='activity'
      actions={
        <button
          type='button'
          onClick={() => setSort((d) => (d === 'desc' ? 'asc' : 'desc'))}
          className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-slate-500 hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-400 dark:hover:bg-muted'
        >
          {sort === 'desc' ? (
            <ArrowDownAZ className='h-3.5 w-3.5' />
          ) : (
            <ArrowUpAZ className='h-3.5 w-3.5' />
          )}
          {sort === 'desc' ? 'Newest first' : 'Oldest first'}
        </button>
      }
    >
      {summary && summary.actions.length > 0 && (
        <div className='mb-3 flex flex-wrap items-center gap-1.5'>
          {summary.actions.map((a) => (
            <button
              key={a.action}
              type='button'
              aria-pressed={action === a.action}
              onClick={() => setAction(action === a.action ? '' : a.action)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                action === a.action
                  ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
              )}
            >
              {actionWord(a.action)}
              <span className='tabular-nums text-slate-500 dark:text-slate-400'>
                {a.count.toLocaleString()}
              </span>
            </button>
          ))}
          {summary.collections.length > 1 && (
            <SimpleSelect
              ariaLabel='Collection'
              value={collection}
              onChange={setCollection}
              options={[
                { value: '', label: 'Every collection' },
                ...summary.collections.map((c) => ({
                  value: c.collection,
                  label: `${c.collection_label ?? c.collection} · ${c.count}`
                }))
              ]}
              className='ml-auto h-7 w-[200px] text-[11.5px]'
            />
          )}
          {hasFilters && (
            <button
              type='button'
              onClick={() => {
                setAction('')
                setCollection('')
              }}
              className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            >
              <X className='h-3 w-3' /> Clear
            </button>
          )}
        </div>
      )}

      {pages.isLoading ? (
        <div className='space-y-3' aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className='flex animate-pulse gap-3'>
              <div className='mt-1 h-2 w-2 rounded-full bg-slate-100 dark:bg-muted' />
              <div className='flex-1 space-y-1.5'>
                <div className='h-3 w-48 rounded bg-slate-100 dark:bg-muted' />
                <div className='h-3 w-24 rounded bg-slate-100 dark:bg-muted' />
              </div>
            </div>
          ))}
        </div>
      ) : pages.isError ? (
        <ErrorNotice
          error={pages.error}
          what='this activity'
          onRetry={() => void pages.refetch()}
        />
      ) : entries.length === 0 ? (
        <EmptyLine>
          {hasFilters ? 'Nothing matches those filters.' : 'No activity recorded.'}
        </EmptyLine>
      ) : (
        <div data-activity-feed>
          {days.map((day) => (
            <div key={day.date}>
              <div className='flex items-center gap-3 py-2'>
                <div className='h-px flex-1 bg-slate-100 dark:bg-border' />
                <span className='text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>
                  {day.date}
                </span>
                <div className='h-px flex-1 bg-slate-100 dark:bg-border' />
              </div>
              <ol className='relative ml-1 border-l border-slate-100 dark:border-border'>
                {day.groups.map((g) => (
                  <FeedRow key={g[0].id} entries={g} labels={labels} />
                ))}
              </ol>
            </div>
          ))}
          {pages.hasNextPage && (
            <div className='pt-3 text-center'>
              <button
                type='button'
                disabled={pages.isFetchingNextPage}
                onClick={() => void pages.fetchNextPage()}
                className='inline-flex h-7 items-center rounded-md border border-slate-200 px-3 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
              >
                {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}

function FeedRow({ entries, labels }: { entries: FeedEntry[]; labels?: ActivityLabels | null }) {
  const { urlFor } = useItemNavigation()
  const nav = useNavigation()
  const [open, setOpen] = useState(false)
  const head = entries[0]
  const about = !!head.about_them
  const tone = toneOf(entries, labels)
  // Several kinds of link changed in one write: the record heads the line, the changes below.
  const links = !about && entries.length > 1 ? linkChanges(entries, labels) : null
  const listed = links && links.pairs.length + links.rest.length > 1 ? links : null
  const sentence = about
    ? (head.summary ?? actionWord(head.action))
    : listed
      ? `Changed ${listed.parent}`
      : predicateOf(entries, labels)
  const target = about ? null : targetOf(entries, labels)
  const href = target ? urlFor(target) : null
  const why = about || entries.length > 1 ? null : activityWhy(head)
  const states = !about && entries.length === 1 ? statesOf(head) : null
  const detail = about
    ? head.detail
    : listed
      ? (([first, ...rest]) =>
          [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' · '))([
          ...listed.pairs.map(linkPairText),
          ...listed.rest
        ])
      : [states, why?.reason || why?.note].filter(Boolean).join(' · ') || null
  return (
    <li
      className='relative py-2 pl-4'
      data-activity-row={head.id}
      data-about-them={about || undefined}
    >
      {about ? (
        <ShieldCheck
          aria-hidden
          className='absolute -left-[7px] top-[11px] h-3.5 w-3.5 rounded-full bg-white text-amber-600 dark:bg-card dark:text-amber-400'
        />
      ) : (
        <span
          aria-hidden
          className={cn('absolute -left-[4.5px] top-[15px] h-2 w-2 rounded-full', TONE_DOT[tone])}
        />
      )}
      <div className='flex items-baseline gap-3'>
        <p className='min-w-0 flex-1 text-[12.5px] leading-5 text-slate-700 dark:text-slate-200'>
          {href ? (
            <a
              href={href}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) return
                e.preventDefault()
                nav.navigate(href)
              }}
              className='rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
              data-activity-sentence
            >
              {sentence}
            </a>
          ) : (
            <span data-activity-sentence>{sentence}</span>
          )}
          {about && (
            <span className='ml-1.5 whitespace-nowrap rounded bg-amber-50 px-1 py-px text-[11px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'>
              Their access
            </span>
          )}
        </p>
        <time
          dateTime={head.timestamp}
          className='shrink-0 text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'
          data-tip={`${formatDateTime(head.timestamp)} · ${formatRelative(head.timestamp)}`}
        >
          {new Date(head.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </time>
      </div>
      {detail && (
        <p className='mt-0.5 text-[12px] leading-5 text-slate-500 dark:text-slate-400'>{detail}</p>
      )}
      {entries.length > 1 && (
        <>
          <button
            type='button'
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className='mt-0.5 inline-flex items-center gap-1 rounded-sm text-[11.5px] text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-400 dark:hover:text-slate-200'
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'h-3 w-3 transition-transform motion-reduce:transition-none',
                open && 'rotate-90'
              )}
            />
            {open ? 'Hide each step' : `Show each step (${entries.length})`}
          </button>
          {open && (
            <ul className='mt-1 space-y-0.5 border-l border-slate-200 pl-3 dark:border-border'>
              {/* Oldest first: a swap reads remove, then add. */}
              {[...entries].reverse().map((e) => (
                <li key={e.id} className='text-[12px] leading-5 text-slate-600 dark:text-slate-300'>
                  {childText(e, labels)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {head.ip && (
        <span className='mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-slate-500 dark:text-slate-400'>
          <Globe className='h-2.5 w-2.5' aria-hidden /> {head.ip}
        </span>
      )}
    </li>
  )
}
