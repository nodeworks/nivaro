import { createNivaro } from '@nivaro/sdk'
import { EventPathSheet, NivaroProvider } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, GitBranch, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { recentFailedRequests } from '@/lib/recent-requests'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Request story (#19, Health hub tab): one request id → one plain-words timeline across the API
 * log row, the kept trace (phases, hooks, SQL statement text), and everything the request wrote
 * and set off (writes, pipeline moves, pushes, partner calls, notifications). GET
 * /api/ops/request-story/:id. What was not kept is said, never guessed.
 */

type Kind =
  | 'request'
  | 'phase'
  | 'hook'
  | 'sql'
  | 'write'
  | 'transition'
  | 'flow'
  | 'push'
  | 'call'
  | 'notify'
  | 'mail'
  | 'emit'
  | 'error'
  | 'other'

interface StoryEvent {
  kind: Kind
  offset_ms: number | null
  at: string | null
  text: string
  ms?: number | null
  failed?: boolean
  record?: { collection: string; item: string; label?: string | null } | null
}

interface Story {
  request_id: string
  found: boolean
  headline: string
  status: number | null
  at: string | null
  total_ms: number | null
  route: string | null
  who: string | null
  chain_id: string | null
  timeline: StoryEvent[]
  sql: {
    count: number
    ms: number
    statements: Array<{ sql: string; n: number; ms: number }>
  } | null
  hooks: Array<{ name: string; ms: number }>
  emits: Array<{ event: string; n: number }>
  notified: number
  sources: { log: string; trace: string; chain: string }
  missing: string[]
}

const KIND_LABEL: Record<Kind, string> = {
  request: 'Request',
  phase: 'Phase',
  hook: 'Hook',
  sql: 'SQL',
  write: 'Write',
  transition: 'Pipeline',
  flow: 'Flow',
  push: 'Push',
  call: 'Partner',
  notify: 'Notified',
  mail: 'Email',
  emit: 'Live',
  error: 'Error',
  other: 'Step'
}

const RID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

function msText(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function RequestStoryPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const id = (params.get('id') ?? '').trim()
  const [draft, setDraft] = useState(id)
  const [pathOpen, setPathOpen] = useState(false)
  const recent = useMemo(() => recentFailedRequests(), [])
  const valid = RID_RE.test(id)

  const q = useQuery({
    queryKey: ['ops', 'request-story', id],
    enabled: valid,
    queryFn: () =>
      api
        .get<{ data: Story }>(`/ops/request-story/${encodeURIComponent(id)}`)
        .then((r) => r.data.data)
  })
  const err = (q.error as { response?: { data?: { error?: string } } } | null)?.response?.data
    ?.error

  const open = (next: string) => {
    const v = next.trim()
    setDraft(v)
    setParams(v ? { id: v } : {})
  }

  const s = q.data
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar description='Paste a request id — from an error, an API log row or a trace — to read what that one request did: who sent it, the hooks and SQL it ran, what it wrote, which partners it called and who heard about it.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 px-4 py-4 sm:px-6 dark:bg-background'>
        <form
          className='flex max-w-[720px] flex-wrap items-center gap-2'
          onSubmit={(e) => {
            e.preventDefault()
            open(draft)
          }}
        >
          <label htmlFor='rs-id' className='sr-only'>
            Request id
          </label>
          <Input
            id='rs-id'
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='e.g. 1b4e28ba-2fa1-11d2-883f-0016d3cca427'
            className='h-8 min-w-0 flex-1 basis-[320px] font-mono text-[12px]'
            spellCheck={false}
            autoComplete='off'
          />
          <Button
            type='submit'
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={!RID_RE.test(draft.trim())}
          >
            <Search className='mr-1.5 h-3.5 w-3.5' aria-hidden />
            Show story
          </Button>
        </form>
        {draft.trim() && !RID_RE.test(draft.trim()) && (
          <p className='mt-1.5 text-[11.5px] text-muted-foreground'>
            A request id is a uuid (the 32-character trace id works too).
          </p>
        )}

        {recent.length > 0 && (
          <div className='mt-3 max-w-[720px]'>
            <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
              Your recent failures in this tab
            </p>
            <ul className='mt-1 flex flex-wrap gap-1.5'>
              {recent.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <button
                    type='button'
                    onClick={() => open(r.id)}
                    className={cn(
                      'rounded-md border px-2 py-0.5 text-left text-[11.5px] hover:bg-muted',
                      r.id === id
                        ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-foreground'
                        : 'border-slate-200 bg-white text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'
                    )}
                    data-tip={r.id}
                  >
                    <span className='font-semibold tabular-nums text-red-600 dark:text-red-400'>
                      {r.status}
                    </span>{' '}
                    <span className='font-mono'>
                      {r.method} {r.path}
                    </span>{' '}
                    · {formatRelative(r.at)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className='mt-5'>
          {!id ? null : !valid ? null : q.isLoading ? (
            <div className='space-y-2' role='status' aria-label='Loading'>
              <Skeleton className='h-6 w-2/3' />
              <Skeleton className='h-20 w-full' />
              <Skeleton className='h-40 w-full' />
            </div>
          ) : q.isError ? (
            <p className='text-[12.5px] text-red-600 dark:text-red-400'>
              {err ?? 'Could not read this request story.'}
            </p>
          ) : s ? (
            <StoryView story={s} onShowPath={() => setPathOpen(true)} navigate={navigate} />
          ) : null}
        </div>
      </div>
      <NivaroProvider client={sharedClient}>
        <EventPathSheet
          target={pathOpen && s?.chain_id ? { chainId: s.chain_id } : null}
          event={pathOpen && s ? { label: s.headline } : null}
          onClose={() => setPathOpen(false)}
          onOpenRecord={(c, rid) => navigate(`/collections/${c}/${rid}`)}
          onOpenEvent={() => {}}
        />
      </NivaroProvider>
    </div>
  )
}

function StoryView({
  story: s,
  onShowPath,
  navigate
}: {
  story: Story
  onShowPath: () => void
  navigate: (to: string) => void
}) {
  const failed = (s.status ?? 0) >= 400
  return (
    <div className='space-y-4'>
      <div>
        <h2
          className={cn(
            'm-0 text-[15px] font-semibold leading-snug',
            failed ? 'text-red-700 dark:text-red-400' : 'text-slate-900 dark:text-foreground'
          )}
          data-request-story-headline=''
        >
          {s.headline}
        </h2>
        <p className='mt-0.5 font-mono text-[11px] text-muted-foreground'>{s.request_id}</p>
      </div>

      {s.found && (
        <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
          {(
            [
              ['Status', s.status ?? '—'],
              ['When', s.at ? new Date(s.at).toLocaleString() : '—'],
              ['Took', msText(s.total_ms)],
              ['Who', s.who ?? '—'],
              ['Route', s.route ?? '—'],
              ['SQL', s.sql ? `${s.sql.count} statements · ${msText(s.sql.ms)}` : 'not kept'],
              ['Hooks', s.hooks.length ? String(s.hooks.length) : s.sql ? 'none' : 'not kept'],
              ['People notified', String(s.notified)]
            ] as Array<[string, string | number]>
          ).map(([k, v]) => (
            <div key={k} className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
              <dt className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                {k}
              </dt>
              <dd
                className='m-0 truncate text-[12.5px] text-slate-800 dark:text-foreground'
                data-tip={String(v)}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {s.missing.length > 0 && (
        <div
          className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          data-request-story-missing=''
        >
          <p className='m-0 flex items-center gap-1.5 font-semibold'>
            <AlertTriangle className='h-3.5 w-3.5' aria-hidden />
            Not part of this story
          </p>
          <ul className='m-0 mt-1 list-disc space-y-0.5 pl-5'>
            {s.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {s.timeline.length > 0 && (
        <section aria-label='Timeline'>
          <div className='flex items-center gap-3'>
            <h3 className='m-0 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
              What happened
            </h3>
            {s.chain_id && (
              <button
                type='button'
                onClick={onShowPath}
                className='inline-flex items-center gap-1 text-[11.5px] font-medium text-slate-600 underline decoration-nvr-cyan/60 underline-offset-2 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
              >
                <GitBranch className='h-3 w-3' aria-hidden />
                Show the full path
              </button>
            )}
          </div>
          <ol className='m-0 mt-2 list-none divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white p-0 dark:divide-border dark:border-border dark:bg-card'>
            {s.timeline.map((e, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the timeline is a fixed, ordered answer
                key={i}
                className='flex min-w-0 items-baseline gap-3 px-3 py-1.5 text-[12px]'
                data-request-story-event={e.kind}
              >
                <span className='w-[64px] shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground'>
                  {e.offset_ms != null ? `+${msText(e.offset_ms)}` : ''}
                </span>
                <span
                  className={cn(
                    'w-[68px] shrink-0 text-[10.5px] font-semibold uppercase tracking-wide',
                    e.failed || e.kind === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-slate-400'
                  )}
                >
                  {KIND_LABEL[e.kind] ?? e.kind}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 break-words',
                    e.failed
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-slate-700 dark:text-foreground'
                  )}
                >
                  {e.text}
                  {e.record && (
                    <>
                      {' '}
                      <button
                        type='button'
                        onClick={() =>
                          navigate(`/collections/${e.record?.collection}/${e.record?.item}`)
                        }
                        className='text-[11.5px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                      >
                        Open
                      </button>
                    </>
                  )}
                </span>
                {e.ms != null && (
                  <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>
                    {msText(e.ms)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {s.sql && s.sql.statements.length > 0 && (
        <details className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <summary className='cursor-pointer px-3 py-2 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
            Heaviest SQL ({s.sql.statements.length} shapes — text only, never the values)
          </summary>
          <ul className='m-0 list-none space-y-2 border-t border-slate-100 p-3 dark:border-border'>
            {s.sql.statements.map((st) => (
              <li key={st.sql} className='min-w-0'>
                <p className='m-0 text-[11px] text-muted-foreground'>
                  {st.n}× · {msText(st.ms)}
                </p>
                <pre className='m-0 mt-0.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700 dark:bg-muted/40 dark:text-slate-300'>
                  {st.sql}
                </pre>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className='text-[11.5px] text-muted-foreground'>
        More on this request:{' '}
        <Link to='/traffic-map' className='underline underline-offset-2'>
          Traffic Map
        </Link>{' '}
        (Inspect → request) ·{' '}
        <Link to='/health/errors' className='underline underline-offset-2'>
          Error clusters
        </Link>
      </p>
    </div>
  )
}
