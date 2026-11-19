/**
 * The open leaf: everything the story kept about one part of the request, and where that part
 * lives in the app. Request · caller · error · phase · statement · effect · live update.
 */
import { ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowUpRight, ChevronRight, GitBranch, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { PlanViewer } from '@/components/plan-viewer'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import { EFFECT_ICON } from './EffectsSection'
import {
  authWords,
  browserOf,
  EFFECT_LABEL,
  effectLinks,
  effectSentence,
  fmtClock,
  fmtMs,
  fmtOffset,
  type Leaf,
  pct,
  readableError,
  relatedRefPath,
  statusMeaning,
  statusText,
  trafficMapPath
} from './logic'
import { CATEGORY_LABEL, CATEGORY_SWATCH } from './TimeSection'
import type { Labels, Related, Story, StoryEffect } from './types'
import { CopyText, type FactRow, Facts, Hint, MonoBlock, StatusPill, TonePill } from './ui'

const LINK =
  'inline-flex items-center gap-1 rounded text-[12.5px] font-medium text-sky-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'

function Go({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={LINK}>
      {children}
      <ArrowUpRight className='h-3.5 w-3.5' aria-hidden />
    </Link>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='grid gap-2 border-t border-slate-100 px-4 py-3 dark:border-border'>
      <h4 className='m-0 text-[12px] font-semibold text-slate-700 dark:text-slate-300'>{title}</h4>
      {children}
    </div>
  )
}

function Links({ children }: { children: ReactNode }) {
  return <div className='flex flex-wrap gap-x-4 gap-y-1.5'>{children}</div>
}

/** A step to another leaf inside the panel. */
function Step({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground dark:hover:bg-muted'
    >
      <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
      <span className='min-w-0 flex-1 truncate'>{children}</span>
    </button>
  )
}

export function LeafPanel({
  story,
  leaf,
  labels,
  onOpen,
  onClose,
  onShowPath,
  closable
}: {
  story: Story
  leaf: Leaf
  labels: Labels | null
  onOpen: (l: Leaf) => void
  onClose: () => void
  onShowPath: (() => void) | null
  /** The panel shows a close button (the request leaf on a wide screen has nothing to close to). */
  closable: boolean
}) {
  const head = headOf(story, leaf, labels)
  return (
    <div className='flex min-h-0 flex-col' data-request-story-leaf={leaf.type}>
      <div className='flex items-start gap-3 px-4 pb-3 pt-4'>
        <div className='min-w-0 flex-1'>
          <p className='m-0 text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
            {head.kind}
          </p>
          <h3 className='m-0 mt-0.5 break-words text-[14px] font-semibold leading-snug text-slate-900 dark:text-foreground'>
            {head.title}
          </h3>
        </div>
        {closable && (
          <button
            type='button'
            onClick={onClose}
            aria-label='Close (Esc)'
            data-tip='Close (Esc)'
            className='-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted dark:hover:text-foreground'
          >
            <X className='h-4 w-4' aria-hidden />
          </button>
        )}
      </div>
      <LeafBody story={story} leaf={leaf} labels={labels} onOpen={onOpen} onShowPath={onShowPath} />
    </div>
  )
}

function headOf(story: Story, leaf: Leaf, labels: Labels | null): { kind: string; title: string } {
  const r = story.request
  switch (leaf.type) {
    case 'request':
      return { kind: 'The request', title: r ? r.route : 'Request' }
    case 'caller':
      return {
        kind:
          story.caller?.kind === 'api_key'
            ? 'Caller · API key'
            : story.caller?.kind === 'anonymous'
              ? 'Caller · not signed in'
              : 'Caller · person',
        title: story.caller?.label ?? 'Unknown caller'
      }
    case 'error':
      return {
        kind: 'The answer',
        title: `${story.status ?? ''} ${statusText(story.status)}`.trim()
      }
    case 'phase': {
      const p = story.trace?.phases.find((x) => x.seq === leaf.seq)
      return { kind: `Phase · ${p ? CATEGORY_LABEL[p.category] : ''}`, title: p?.label ?? 'Phase' }
    }
    case 'sql': {
      const s = story.trace?.statements.find((x) => x.index === leaf.index)
      return {
        kind: 'SQL statement',
        title: s
          ? `${s.n > 1 ? `${s.n} runs · ` : ''}${fmtMs(s.ms)} · ${s.tables.join(', ') || 'statement'}`
          : 'Statement'
      }
    }
    case 'effect': {
      const e = story.effects?.find((x) => x.key === leaf.key)
      return {
        kind: e ? EFFECT_LABEL[e.kind] : 'Step',
        title: e ? effectSentence(e, labels) : 'Step'
      }
    }
    case 'emit':
      return { kind: 'Live update', title: leaf.event }
  }
}

function LeafBody({
  story,
  leaf,
  labels,
  onOpen,
  onShowPath
}: {
  story: Story
  leaf: Leaf
  labels: Labels | null
  onOpen: (l: Leaf) => void
  onShowPath: (() => void) | null
}) {
  switch (leaf.type) {
    case 'request':
      return <RequestLeaf story={story} onOpen={onOpen} onShowPath={onShowPath} />
    case 'caller':
      return <CallerLeaf story={story} />
    case 'error':
      return <ErrorLeaf story={story} />
    case 'phase':
      return <PhaseLeaf story={story} seq={leaf.seq} onOpen={onOpen} />
    case 'sql':
      return <SqlLeaf story={story} index={leaf.index} />
    case 'effect':
      return <EffectLeaf story={story} effectKey={leaf.key} labels={labels} onOpen={onOpen} />
    case 'emit': {
      const e = story.emits.find((x) => x.event === leaf.event)
      return (
        <div className='grid gap-3 px-4 pb-4'>
          <Facts
            rows={[
              [
                'Event',
                <span key='v' className='font-mono text-[12px]'>
                  {leaf.event}
                </span>
              ],
              ['Sent', e ? `${e.n} ${e.n === 1 ? 'time' : 'times'}` : null]
            ]}
          />
          <Hint>
            Every open tab watching what changed got this event and refreshed. Only the event name
            is kept — never who was watching or what was sent.
          </Hint>
        </div>
      )
    }
  }
}

function RequestLeaf({
  story,
  onOpen,
  onShowPath
}: {
  story: Story
  onOpen: (l: Leaf) => void
  onShowPath: (() => void) | null
}) {
  const r = story.request
  const failed = (story.status ?? 0) >= 400
  return (
    <>
      <div className='grid gap-3 px-4 pb-3'>
        {r ? (
          <Facts
            rows={[
              ['Answer', <StatusPill key='v' status={r.status} />],
              ['Started', fmtClock(r.started_at)],
              ['Took', fmtMs(r.latency_ms)],
              [
                'Path',
                <span key='v' className='font-mono text-[11.5px]'>
                  {r.path}
                </span>
              ],
              [
                'Route',
                <span key='v' className='font-mono text-[11.5px]'>
                  {r.route}
                </span>
              ],
              r.has_query && ['Query string', 'Sent — its values are not shown here'],
              r.body_kept && ['Body', 'Kept in the API log for replay — not shown here'],
              ['Signed in with', authWords(r.auth)],
              ['Served by', r.instance],
              ['From', r.ip],
              [
                'Browser',
                r.user_agent ? (
                  <span key='v' data-tip={r.user_agent}>
                    {browserOf(r.user_agent) ?? r.user_agent}
                  </span>
                ) : null
              ],
              r.graphql && [
                'GraphQL',
                [
                  r.graphql.kind,
                  r.graphql.operation,
                  r.graphql.depth != null ? `depth ${r.graphql.depth}` : null,
                  r.graphql.selections != null ? `${r.graphql.selections} fields` : null,
                  r.graphql.errors ? `${r.graphql.errors} errors` : null
                ]
                  .filter(Boolean)
                  .join(' · ')
              ],
              r.matched_by &&
                r.matched_by !== 'request_id' && [
                  'Found by',
                  'Its chain and time — the /graphql alias logs no request id of its own'
                ]
            ]}
          />
        ) : (
          <Hint>This request has no API log row, so its method, route and caller are unknown.</Hint>
        )}
        <Facts
          rows={[
            [
              'Request id',
              <span key='v' className='inline-flex items-center gap-1'>
                <span className='font-mono text-[11.5px]'>{story.request_id}</span>
                <CopyText value={story.request_id} label='Copy the request id' />
              </span>
            ],
            story.chain_id && [
              'Chain id',
              <span key='v' className='font-mono text-[11.5px]'>
                {story.chain_id}
              </span>
            ]
          ]}
        />
      </div>
      <Block title='Open'>
        <div className='grid gap-0.5'>
          {story.caller && (
            <Step onClick={() => onOpen({ type: 'caller' })}>
              Who sent it — {story.caller.label}
            </Step>
          )}
          {failed && (
            <Step onClick={() => onOpen({ type: 'error' })}>
              Why it failed — {story.status} {statusText(story.status)}
            </Step>
          )}
        </div>
        <Links>
          <Go to={trafficMapPath(story.request_id)}>Inspect in the Traffic Map</Go>
          {onShowPath && (
            <button type='button' onClick={onShowPath} className={LINK}>
              <GitBranch className='h-3.5 w-3.5' aria-hidden />
              Show the event path
            </button>
          )}
        </Links>
      </Block>
    </>
  )
}

function CallerLeaf({ story }: { story: Story }) {
  const c = story.caller
  const r = story.request
  if (!c)
    return <Hint className='px-4 pb-4'>The caller is not known — the API log row is missing.</Hint>
  return (
    <>
      <div className='grid gap-3 px-4 pb-3'>
        <Facts
          rows={[
            ['Signed in with', authWords(c.auth)],
            c.api_key_id != null && ['API key', `#${c.api_key_id}`],
            c.mcp && [
              'Assistant',
              [c.mcp.client, c.mcp.tool].filter(Boolean).join(' · ') || 'MCP call'
            ],
            c.mcp?.outcome && ['Tool outcome', c.mcp.outcome],
            ['From', r?.ip],
            [
              'Browser',
              r?.user_agent ? (
                <span key='v' data-tip={r.user_agent}>
                  {browserOf(r.user_agent) ?? r.user_agent}
                </span>
              ) : null
            ]
          ]}
        />
        {c.auth === 'masquerade' && (
          <Hint>
            An administrator was viewing the app as this person. Their own name is in the activity
            log, which only administrators can read.
          </Hint>
        )}
      </div>
      <Block title='Open'>
        <Links>
          {c.user_id && (
            <>
              <Go to={`/users/${c.user_id}`}>Profile</Go>
              <Go to={`/users/${c.user_id}?tab=activity`}>Their activity</Go>
              <Go to={`/users/${c.user_id}?tab=did`}>What they did</Go>
            </>
          )}
          {c.api_key_id != null && <Go to={`/api-keys?key=${c.api_key_id}`}>The API key</Go>}
          {c.mcp && <Go to='/mcp'>Assistant connections</Go>}
          {!c.user_id && c.api_key_id == null && (
            <Hint>No account sent this — there is nothing to open beyond its address.</Hint>
          )}
        </Links>
      </Block>
    </>
  )
}

function ErrorLeaf({ story }: { story: Story }) {
  const rid = story.request_id
  const related = useQuery({
    queryKey: ['ops', 'request-story', rid, 'related'],
    staleTime: 60_000,
    queryFn: () =>
      api
        .get<{ data: Related }>(`/ops/request-story/${encodeURIComponent(rid)}/related`)
        .then((r) => r.data.data)
  })
  const issues = related.data?.groups.find((g) => g.key === 'error')?.refs ?? []
  const meaning = statusMeaning(story.status)
  const error = story.request?.error
  return (
    <>
      <div className='grid gap-3 px-4 pb-3'>
        <div className='flex items-center gap-2'>
          <StatusPill status={story.status} />
        </div>
        {meaning && (
          <p className='m-0 text-[12.5px] text-slate-700 dark:text-slate-300'>{meaning}</p>
        )}
        {error ? (
          <div className='grid gap-1'>
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              What it answered
            </p>
            <p className='m-0 text-[12.5px] text-slate-900 dark:text-foreground'>
              {readableError(error)}
            </p>
            {readableError(error) !== error && (
              <details className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                <summary className='cursor-pointer select-none'>
                  As stored (first line, secrets masked)
                </summary>
                <div className='mt-1'>
                  <MonoBlock>{error}</MonoBlock>
                </div>
              </details>
            )}
          </div>
        ) : (
          <Hint>The answer’s text was not kept.</Hint>
        )}
      </div>
      <Block title='Same error'>
        {related.isLoading ? (
          <Skeleton className='h-4 w-2/3' />
        ) : issues.length ? (
          <ul className='m-0 grid list-none gap-0.5 p-0'>
            {issues.map((i) => {
              const to = relatedRefPath(i)
              return (
                <li key={i.id}>
                  {to ? <Go to={to}>{i.label ?? `Issue ${i.id}`}</Go> : (i.label ?? i.id)}
                </li>
              )
            })}
          </ul>
        ) : (
          <Hint>No logged issue matches this error.</Hint>
        )}
        <Links>
          <Go to='/health/errors'>Error clusters</Go>
          <Go to='/issues'>Issue log</Go>
        </Links>
      </Block>
    </>
  )
}

function PhaseLeaf({
  story,
  seq,
  onOpen
}: {
  story: Story
  seq: number
  onOpen: (l: Leaf) => void
}) {
  const t = story.trace
  const phases = t?.phases ?? []
  const i = phases.findIndex((p) => p.seq === seq)
  const p = phases[i]
  if (!t || !p) return <Hint className='px-4 pb-4'>This phase is not part of the story.</Hint>
  let parent = null as (typeof phases)[number] | null
  for (let j = i - 1; j >= 0; j--)
    if (phases[j].depth === p.depth - 1) {
      parent = phases[j]
      break
    }
  const children: typeof phases = []
  for (let j = i + 1; j < phases.length && phases[j].depth > p.depth; j++)
    if (phases[j].depth === p.depth + 1) children.push(phases[j])
  const repeatStmt = p.repeat ? t.statements.find((s) => s.sql === p.repeat?.sql) : null
  return (
    <>
      <div className='grid gap-3 px-4 pb-3'>
        <div className='relative h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
          <span
            className={cn('absolute inset-y-0 rounded-full', CATEGORY_SWATCH[p.category])}
            style={{
              left: `${pct(p.at, t.total_ms)}%`,
              width: `${Math.max(0.5, pct(p.ms, t.total_ms))}%`
            }}
          />
        </div>
        <Facts
          rows={[
            ['Took', `${fmtMs(p.ms)} · ${Math.round(pct(p.ms, t.total_ms))}% of the request`],
            ['Started at', fmtOffset(p.at)],
            ['Ended at', fmtOffset(p.at + p.ms)],
            p.queries != null && ['SQL round trips', String(p.queries)],
            p.detail && ['Detail', p.detail],
            [
              'Recorded as',
              <span key='v' className='font-mono text-[11.5px]'>
                {p.phase}
              </span>
            ]
          ]}
        />
      </div>
      {p.repeat && (
        <Block title={`Ran the same statement ${p.repeat.n} times (${fmtMs(p.repeat.ms)})`}>
          <Hint>
            One statement over and over inside one phase is an N+1: a read per row instead of one
            read for all of them.
          </Hint>
          <MonoBlock>{p.repeat.sql}</MonoBlock>
          {repeatStmt && (
            <Step onClick={() => onOpen({ type: 'sql', index: repeatStmt.index })}>
              Open this statement
            </Step>
          )}
        </Block>
      )}
      {p.wide.length > 0 && (
        <Block title='Read every column of a long-text table'>
          <Hint>
            <span className='font-mono'>select *</span> on these drags their long-text columns over
            the wire: {p.wide.map((w) => `${w.table} (${w.n}×)`).join(', ')}.
          </Hint>
        </Block>
      )}
      {(parent || children.length > 0) && (
        <Block title='Around it'>
          <div className='grid gap-0.5'>
            {parent && (
              <Step onClick={() => onOpen({ type: 'phase', seq: parent.seq })}>
                Inside {parent.label} · {fmtMs(parent.ms)}
              </Step>
            )}
            {children.map((c) => (
              <Step key={c.seq} onClick={() => onOpen({ type: 'phase', seq: c.seq })}>
                {c.label} · {fmtMs(c.ms)}
              </Step>
            ))}
          </div>
        </Block>
      )}
    </>
  )
}

function SqlLeaf({ story, index }: { story: Story; index: number }) {
  const t = story.trace
  const s = t?.statements.find((x) => x.index === index)
  const rid = story.request_id
  const plan = useMutation({
    mutationKey: ['request-story-plan', rid, index],
    mutationFn: () =>
      api
        .post<{
          data: {
            source: 'cache' | 'estimated'
            plan: string | null
            stats: {
              execution_count: number
              avg_elapsed_ms: number
              max_elapsed_ms: number
            } | null
          }
        }>(`/traces/${encodeURIComponent(rid)}/explain`, { index })
        .then((r) => r.data.data)
  })
  if (!t || !s) return <Hint className='px-4 pb-4'>This statement is not part of the story.</Hint>
  const canPlan = s.select && !s.truncated
  return (
    <>
      <div className='grid gap-3 px-4 pb-3'>
        <Facts
          rows={[
            ['Total', `${fmtMs(s.ms)} · ${Math.round(s.share * 100)}% of the SQL wait`],
            ['Runs', String(s.n)],
            ['Average', fmtMs(s.avg_ms)],
            s.tables.length > 0 && [
              'Tables',
              <span key='v' className='flex flex-wrap gap-1'>
                {s.tables.map((tb) => (
                  <span
                    key={tb}
                    className='rounded bg-slate-100 px-1.5 font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-slate-300'
                  >
                    {tb}
                  </span>
                ))}
              </span>
            ]
          ]}
        />
        {(s.repeat_n != null || s.wide || s.truncated) && (
          <div className='flex flex-wrap gap-1.5'>
            {s.repeat_n != null && (
              <TonePill tone='warn'>N+1 — {s.repeat_n} runs inside one phase</TonePill>
            )}
            {s.wide && <TonePill tone='warn'>select * on a long-text table</TonePill>}
            {s.truncated && <TonePill tone='muted'>Text cut when captured</TonePill>}
          </div>
        )}
        <div className='grid gap-1'>
          <div className='flex items-center justify-between'>
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Statement text (values are never kept)
            </p>
            <CopyText value={s.sql} label='Copy the statement' />
          </div>
          <MonoBlock>{s.sql}</MonoBlock>
        </div>
      </div>
      <Block title='Query plan'>
        {!canPlan ? (
          <Hint>
            {s.truncated
              ? 'The statement was cut when it was captured — too long to look up a plan.'
              : 'Plans are looked up for SELECT statements only.'}
          </Hint>
        ) : plan.data ? (
          <div className='grid gap-2'>
            <Hint>
              {plan.data.source === 'cache' && plan.data.stats
                ? `From the plan cache — what this route really got: ${plan.data.stats.execution_count} runs, avg ${plan.data.stats.avg_elapsed_ms} ms, max ${plan.data.stats.max_elapsed_ms} ms.`
                : 'Estimated — the cached plan was evicted, so this is the optimizer’s answer. It can differ from what the route got.'}
            </Hint>
            {plan.data.plan ? <PlanViewer xml={plan.data.plan} /> : <Hint>No plan came back.</Hint>}
          </div>
        ) : plan.isError ? (
          <ErrorNotice error={plan.error} what='the plan' onRetry={() => plan.mutate()} />
        ) : (
          <div>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 text-[12px]'
              disabled={plan.isPending}
              onClick={() => plan.mutate()}
            >
              {plan.isPending ? 'Looking up the plan…' : 'Show the plan'}
            </Button>
          </div>
        )}
        <Links>
          {s.sha && (
            <Go to={trafficMapPath(rid, { kind: 'statement', id: s.sha })}>
              Routes that run it, in the Traffic Map
            </Go>
          )}
        </Links>
      </Block>
    </>
  )
}

function channelTone(status: string): 'ok' | 'bad' | 'muted' {
  if (['delivered', 'sent', 'deferred'].includes(status)) return 'ok'
  if (status === 'failed') return 'bad'
  return 'muted'
}

function EffectLeaf({
  story,
  effectKey,
  labels,
  onOpen
}: {
  story: Story
  effectKey: string
  labels: Labels | null
  onOpen: (l: Leaf) => void
}) {
  const effects = story.effects ?? []
  const e = effects.find((x) => x.key === effectKey)
  if (!e) return <Hint className='px-4 pb-4'>This step is not part of the story.</Hint>
  const f = e.facts
  const parent = e.parent ? effects.find((x) => x.key === e.parent) : null
  const children = effects.filter((x) => x.parent === e.key)
  const links = effectLinks(e)
  const kindRows: FactRow[] = (() => {
    switch (e.kind) {
      case 'write':
        return [
          [
            'Action',
            f.action === 'create' ? 'Created' : f.action === 'delete' ? 'Deleted' : 'Updated'
          ],
          f.id != null && ['Activity entry', `#${f.id}`]
        ]
      case 'transition':
        return [
          ['From', f.from ?? 'Started here'],
          ['To', f.to]
        ]
      case 'flow':
        return [
          ['Status', f.status],
          f.halted_at && ['Stopped at', f.halted_at],
          f.id != null && ['Run', `#${f.id}`]
        ]
      case 'push':
        return [
          ['Status', f.status],
          ['Attempts', f.attempts != null ? String(f.attempts) : null],
          f.http_status != null && ['HTTP status', String(f.http_status)],
          f.submission_id != null && ['Submission', `#${f.submission_id}`]
        ]
      case 'attempt':
        return [['Submission', f.submission_id != null ? `#${f.submission_id}` : null]]
      case 'call':
        return [
          [
            'Answer',
            f.http_status != null ? <StatusPill key='v' status={f.http_status} /> : 'No response'
          ],
          ['Took', fmtMs(f.duration_ms)],
          ['Call', [f.method, f.url].filter(Boolean).join(' ')]
        ]
      case 'notify':
        return [
          ['Person', f.recipient],
          ['Category', f.category],
          ['Lane', f.lane]
        ]
      case 'mail':
        return [
          ['Status', f.status],
          ['Recipients', f.recipients != null ? String(f.recipients) : null],
          ['Template', f.template]
        ]
      default:
        return []
    }
  })()
  const error = f.error ?? (e.failed ? e.reason : null)
  return (
    <>
      <div className='grid gap-3 px-4 pb-3'>
        {e.failed && (
          <TonePill tone='bad' className='w-fit'>
            Failed
          </TonePill>
        )}
        <Facts
          rows={[
            ...kindRows,
            ['When', [fmtOffset(e.offset_ms), fmtClock(e.at)].filter(Boolean).join(' · ')],
            e.who && ['By', e.who]
          ]}
        />
        {e.kind === 'write' && (f.fields?.length ?? 0) > 0 && (
          <div className='grid gap-1'>
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Fields changed (names only — the activity entry has the values)
            </p>
            <div className='flex flex-wrap gap-1'>
              {(f.fields ?? []).map((x) => (
                <span
                  key={x.field}
                  className='rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11.5px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'
                  data-tip={x.field}
                >
                  {x.label}
                </span>
              ))}
            </div>
          </div>
        )}
        {e.kind === 'notify' && (f.channels?.length ?? 0) > 0 && (
          <div className='grid gap-1'>
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              How it reached them
            </p>
            <ul className='m-0 grid list-none gap-1 p-0'>
              {(f.channels ?? []).map((c) => (
                <li key={c.channel} className='flex items-center gap-2 text-[12.5px]'>
                  <TonePill tone={channelTone(c.status)}>{c.status}</TonePill>
                  <span className='text-slate-800 dark:text-foreground'>{c.channel}</span>
                  {c.reason && (
                    <span className='truncate text-slate-500 dark:text-muted-foreground'>
                      {c.reason}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <div className='grid gap-1'>
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              What went wrong (first line, secrets masked)
            </p>
            <MonoBlock>{error}</MonoBlock>
          </div>
        )}
      </div>
      {(parent || children.length > 0) && (
        <Block title={parent ? 'Part of' : `Under it (${children.length})`}>
          <div className='grid gap-0.5'>
            {parent && <StepEffect e={parent} labels={labels} onOpen={onOpen} />}
            {children.map((c) => (
              <StepEffect key={c.key} e={c} labels={labels} onOpen={onOpen} />
            ))}
          </div>
        </Block>
      )}
      {links.length > 0 && (
        <Block title='Open'>
          <Links>
            {links.map((l) => (
              <Go key={l.to} to={l.to}>
                {l.label}
              </Go>
            ))}
          </Links>
        </Block>
      )}
    </>
  )
}

function StepEffect({
  e,
  labels,
  onOpen
}: {
  e: StoryEffect
  labels: Labels | null
  onOpen: (l: Leaf) => void
}) {
  const Icon = EFFECT_ICON[e.kind]
  return (
    <button
      type='button'
      onClick={() => onOpen({ type: 'effect', key: e.key })}
      className='flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground dark:hover:bg-muted'
    >
      <Icon className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
      <span className='min-w-0 flex-1 truncate'>{effectSentence(e, labels)}</span>
      {e.failed && <TonePill tone='bad'>Failed</TonePill>}
      {e.at && <span className='shrink-0 text-[11px] text-slate-400'>{formatRelative(e.at)}</span>}
    </button>
  )
}
