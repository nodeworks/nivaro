import { createNivaro } from '@nivaro/sdk'
import { EventPathSheet, NivaroProvider, QueryErrorState } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, History, Search } from 'lucide-react'
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { type RecentFailedRequest, recentFailedRequests } from '@/lib/recent-requests'
import { cn, formatRelative } from '@/lib/utils'
import { EffectsSection, LiveSection } from './request-story/EffectsSection'
import { LeafPanel } from './request-story/LeafPanel'
import {
  type Leaf,
  labelRequestOf,
  leafExists,
  leafKey,
  normalizeRid,
  parseLeaf,
  pathTemplate
} from './request-story/logic'
import { RelatedSection } from './request-story/RelatedSection'
import { SqlSection } from './request-story/SqlSection'
import { TimeSection } from './request-story/TimeSection'
import type { Labels, Story } from './request-story/types'
import { Hint, MethodTag, Panel, rowKeys, StatusPill } from './request-story/ui'
import { Verdict } from './request-story/Verdict'

/**
 * Request story (#19, Health hub tab): one request id → everything the system kept about it, each
 * part down to its last leaf — the verdict, where the time went (phase waterfall), the SQL it ran
 * (text only), what it wrote and set off (writes, pipeline moves, flows, pushes, partner calls,
 * people told, emails), live updates and related requests. GET /api/ops/request-story/:id (+
 * /related). URL state: ?id=<request id>&leaf=<request|caller|error|phase:N|sql:N|effect:KEY|
 * emit:NAME>, so a link reopens the same view. What was not kept is said, never guessed.
 */

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/** Width of the story area from which the open leaf sits beside the story, not over it. */
const RAIL_MIN_WIDTH = 1120

/**
 * Story + rail columns for a story area `width` px wide: the rail takes a third; from 1700 px the
 * story stops at a readable 1100 px and the rail at 640 px instead of stretching cells edge to edge.
 */
function railCols(width: number): string {
  return width >= 1700
    ? 'grid-cols-[minmax(0,1100px)_minmax(420px,640px)]'
    : 'grid-cols-[minmax(0,1fr)_minmax(360px,32%)]'
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

export function RequestStoryPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const rawId = (params.get('id') ?? '').trim()
  const id = normalizeRid(rawId)
  const [draft, setDraft] = useState(rawId)
  const [pathOpen, setPathOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { ref: areaRef, width } = useWidth<HTMLDivElement>()
  const wide = width >= RAIL_MIN_WIDTH
  // The list is read once per id: a failure made while reading a story joins the next visit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the id changes
  const recent = useMemo(() => recentFailedRequests(), [id])

  useEffect(() => setDraft(rawId), [rawId])

  const q = useQuery({
    queryKey: ['ops', 'request-story', id],
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: Story }>(`/ops/request-story/${encodeURIComponent(id ?? '')}`)
        .then((r) => r.data.data)
  })
  const s = q.data

  const labelReq = useMemo(() => (s ? labelRequestOf(s) : null), [s])
  const labels = useQuery({
    queryKey: ['ops', 'request-story', id, 'labels'],
    enabled: !!labelReq && labelReq.refs.length > 0,
    staleTime: 5 * 60_000,
    queryFn: () => api.post<{ data: Labels }>('/activity/labels', labelReq).then((r) => r.data.data)
  })

  const parsed = parseLeaf(params.get('leaf'))
  const leaf: Leaf | null = s && parsed && leafExists(s, parsed) ? parsed : null
  /** On a wide screen the rail always shows something: the request itself by default. */
  const shown: Leaf | null = leaf ?? (wide && s?.found ? { type: 'request' } : null)

  const openStory = useCallback(
    (next: string) => {
      const rid = normalizeRid(next) ?? next.trim()
      setDraft(rid)
      setParams(rid ? { id: rid } : {})
    },
    [setParams]
  )
  const openLeaf = useCallback(
    (l: Leaf) => {
      const p = new URLSearchParams(params)
      p.set('leaf', leafKey(l))
      setParams(p)
    },
    [params, setParams]
  )
  const closeLeaf = useCallback(() => {
    const p = new URLSearchParams(params)
    p.delete('leaf')
    setParams(p)
  }, [params, setParams])

  // Esc closes the open leaf (a sheet handles its own); "/" jumps to the id box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (e.key === 'Escape' && wide && leaf && !typing) {
        closeLeaf()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide, leaf, closeLeaf])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (normalizeRid(draft)) openStory(draft)
  }
  const draftBad = draft.trim() !== '' && !normalizeRid(draft)
  const showPath = s?.chain_id ? () => setPathOpen(true) : null

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description='Everything one API request did, from who sent it to the last thing it set off. Paste its id — from an error’s details, an API log row or a trace.'
        actions={
          <form className='flex w-full flex-wrap items-center gap-2 sm:w-auto' onSubmit={submit}>
            <label htmlFor='rs-id' className='sr-only'>
              Request id
            </label>
            <Input
              id='rs-id'
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder='Paste a request id'
              aria-keyshortcuts='/'
              data-tip='Press / to jump here'
              aria-invalid={draftBad || undefined}
              aria-describedby={draftBad ? 'rs-id-hint' : undefined}
              className={cn(
                'h-8 min-w-0 flex-1 basis-full font-mono text-[12px] sm:w-[340px] sm:flex-none sm:basis-auto',
                draftBad && 'border-amber-400 focus-visible:ring-amber-400/50'
              )}
              spellCheck={false}
              autoComplete='off'
            />
            <Button
              type='submit'
              size='sm'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={!normalizeRid(draft)}
            >
              <Search className='mr-1.5 h-3.5 w-3.5' aria-hidden />
              Show story
            </Button>
            {recent.length > 0 && id && (
              <RecentPopover recent={recent} current={id} onOpen={openStory} />
            )}
          </form>
        }
      >
        {draftBad && (
          <p
            id='rs-id-hint'
            className='m-0 mt-1.5 text-[11.5px] text-amber-700 dark:text-amber-400'
          >
            A request id is a uuid like 1b4e28ba-2fa1-11d2-883f-0016d3cca427 (the 32-character trace
            id works too).
          </p>
        )}
      </HubToolbar>

      <div ref={areaRef} className='min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {!id ? (
          <Start recent={recent} onOpen={openStory} invalid={!!rawId} />
        ) : q.isLoading ? (
          <Loading wide={wide} width={width} />
        ) : q.isError ? (
          <div className='px-4 py-6 sm:px-6'>
            <QueryErrorState
              error={q.error}
              what='this request story'
              onRetry={() => void q.refetch()}
            />
          </div>
        ) : s && !s.found ? (
          <NotFound story={s} recent={recent} onOpen={openStory} />
        ) : s ? (
          <div className={cn('grid items-start gap-6 px-4 py-5 sm:px-6', wide && railCols(width))}>
            <article className='grid min-w-0 gap-7' aria-label='Request story'>
              <Verdict story={s} onOpen={openLeaf} onShowPath={showPath} />
              {/* A missing trace is said in "Where the time went" itself. */}
              {s.missing.some((m) => !/trac/i.test(m)) && (
                <Missing items={s.missing.filter((m) => !/trac/i.test(m))} />
              )}
              <TimeSection story={s} leaf={shown} onOpen={openLeaf} />
              <EffectsSection
                story={s}
                labels={labels.data ?? null}
                leaf={shown}
                onOpen={openLeaf}
              />
              <SqlSection story={s} leaf={shown} onOpen={openLeaf} />
              <LiveSection story={s} leaf={shown} onOpen={openLeaf} />
              <RelatedSection
                rid={s.request_id}
                startedAt={s.request?.started_at ? Date.parse(s.request.started_at) : null}
                onOpenRequest={openStory}
                onShowPath={showPath}
              />
            </article>
            {wide && shown && (
              <aside
                aria-label='Details'
                className='sticky top-5 max-h-[calc(100dvh-13rem)] min-w-0 overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white pb-2 shadow-[0_1px_2px_rgb(15_23_42/0.04),0_4px_16px_-6px_rgb(15_23_42/0.08)] dark:border-border dark:bg-card dark:shadow-none'
              >
                <LeafPanel
                  story={s}
                  leaf={shown}
                  labels={labels.data ?? null}
                  onOpen={openLeaf}
                  onClose={closeLeaf}
                  onShowPath={showPath}
                  closable={!!leaf && leaf.type !== 'request'}
                />
              </aside>
            )}
          </div>
        ) : null}
      </div>

      {!wide && s && (
        <Sheet open={!!leaf} onOpenChange={(o) => !o && closeLeaf()}>
          <SheetContent side='right' className='w-full overflow-y-auto p-0 sm:max-w-[520px]'>
            <SheetTitle className='sr-only'>Details</SheetTitle>
            <SheetDescription className='sr-only'>
              One part of the request story, with where it lives in the app.
            </SheetDescription>
            {leaf && (
              <div className='pr-8'>
                <LeafPanel
                  story={s}
                  leaf={leaf}
                  labels={labels.data ?? null}
                  onOpen={openLeaf}
                  onClose={closeLeaf}
                  onShowPath={showPath}
                  closable={false}
                />
              </div>
            )}
          </SheetContent>
        </Sheet>
      )}

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

function Missing({ items }: { items: string[] }) {
  return (
    <div
      className='flex max-w-[96ch] gap-2.5 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-[12px] text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
      data-request-story-missing=''
    >
      <AlertTriangle
        className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
        aria-hidden
      />
      <div className='min-w-0'>
        <p className='m-0 font-medium'>Not part of this story</p>
        <ul className='m-0 mt-1 list-disc space-y-0.5 pl-4 leading-relaxed'>
          {items.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function RecentRow({
  r,
  current,
  onOpen,
  list
}: {
  r: RecentFailedRequest
  current?: string | null
  onOpen: (id: string) => void
  list: string
}) {
  const { template, ids } = pathTemplate(r.path)
  return (
    <button
      type='button'
      data-rs-row={list}
      onKeyDown={rowKeys}
      onClick={() => onOpen(r.id)}
      aria-current={r.id === current ? 'true' : undefined}
      className={cn(
        'grid w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 px-4 py-2 text-left outline-none hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-muted/50 dark:focus-visible:bg-muted/50',
        r.id === current && 'bg-nvr-cyan/[0.08] dark:bg-nvr-cyan/[0.12]'
      )}
    >
      <StatusPill status={r.status} words={false} />
      <MethodTag method={r.method} />
      <span className='min-w-0'>
        <span className='block truncate font-mono text-[12px] text-slate-800 dark:text-foreground'>
          {template}
        </span>
        <span className='block truncate font-mono text-[10.5px] text-slate-400 dark:text-muted-foreground'>
          {ids.length
            ? `${ids.map((x) => (x.length > 12 ? `${x.slice(0, 8)}…` : x)).join(' · ')} · `
            : ''}
          request {r.id.slice(0, 8)}
        </span>
      </span>
      <span className='text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
        {formatRelative(r.at)}
      </span>
    </button>
  )
}

function RecentList({
  recent,
  current,
  onOpen
}: {
  recent: RecentFailedRequest[]
  current?: string | null
  onOpen: (id: string) => void
}) {
  return (
    <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
      {recent.slice(0, 12).map((r) => (
        <li key={r.id}>
          <RecentRow r={r} current={current} onOpen={onOpen} list='recent' />
        </li>
      ))}
    </ul>
  )
}

function RecentPopover({
  recent,
  current,
  onOpen
}: {
  recent: RecentFailedRequest[]
  current: string
  onOpen: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type='button' size='sm' variant='outline' className='h-8 gap-1.5 text-[12px]'>
          <History className='h-3.5 w-3.5' aria-hidden />
          Recent failures
          <span className='tabular-nums text-slate-400'>{recent.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[min(460px,92vw)] overflow-hidden p-0'>
        <p className='m-0 border-b border-slate-100 px-4 py-2 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          Calls that failed in this browser tab
        </p>
        <div className='max-h-[60vh] overflow-y-auto'>
          <RecentList
            recent={recent}
            current={current}
            onOpen={(rid) => {
              setOpen(false)
              onOpen(rid)
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Start({
  recent,
  onOpen,
  invalid
}: {
  recent: RecentFailedRequest[]
  onOpen: (id: string) => void
  invalid: boolean
}) {
  return (
    <div className='grid max-w-[880px] gap-6 px-4 py-6 sm:px-6'>
      <div className='grid gap-2'>
        <h2 className='m-0 text-[16px] font-semibold text-slate-900 dark:text-foreground'>
          {invalid ? 'That is not a request id' : 'Read one request from start to finish'}
        </h2>
        <p className='m-0 max-w-[72ch] text-[13px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          A request story shows who sent the call, how its time was spent, the SQL it ran, the
          records it wrote, the partners it called and the people it told — and opens each of them
          where it lives. Request ids are under “Details for support” on an error, on API log rows,
          in the Traffic Map and on Slowest requests.
        </p>
      </div>
      <section aria-labelledby='rs-recent'>
        <h3
          id='rs-recent'
          className='m-0 mb-2 text-[13px] font-semibold text-slate-800 dark:text-foreground'
        >
          Calls that failed in this tab
          {recent.length > 0 && (
            <span className='ml-1.5 font-normal tabular-nums text-slate-500'>{recent.length}</span>
          )}
        </h3>
        <Panel>
          {recent.length ? (
            <RecentList recent={recent} onOpen={onOpen} />
          ) : (
            <Hint className='px-4 py-3'>
              None yet. When a call fails in this tab it is listed here, so its id never has to be
              copied by hand.
            </Hint>
          )}
        </Panel>
      </section>
    </div>
  )
}

function NotFound({
  story,
  recent,
  onOpen
}: {
  story: Story
  recent: RecentFailedRequest[]
  onOpen: (id: string) => void
}) {
  return (
    <div className='grid max-w-[880px] gap-5 px-4 py-6 sm:px-6'>
      <div className='grid gap-2'>
        <h2 className='m-0 text-[16px] font-semibold text-slate-900 dark:text-foreground'>
          Nothing is kept about this request
        </h2>
        <p className='m-0 font-mono text-[12px] text-slate-500'>{story.request_id}</p>
        <ul className='m-0 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          {story.missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
      {recent.length > 0 && (
        <section aria-labelledby='rs-recent-nf'>
          <h3
            id='rs-recent-nf'
            className='m-0 mb-2 text-[13px] font-semibold text-slate-800 dark:text-foreground'
          >
            Calls that failed in this tab
          </h3>
          <Panel>
            <RecentList recent={recent} current={story.request_id} onOpen={onOpen} />
          </Panel>
        </section>
      )}
    </div>
  )
}

function Loading({ wide, width }: { wide: boolean; width: number }) {
  return (
    <div
      role='status'
      aria-label='Loading the request story'
      className={cn('grid items-start gap-6 px-4 py-5 sm:px-6', wide && railCols(width))}
    >
      <div className='grid gap-4'>
        <Skeleton className='h-5 w-1/3' />
        <Skeleton className='h-6 w-3/4' />
        <Skeleton className='h-4 w-1/2' />
        <Skeleton className='h-12 w-full' />
        <Skeleton className='h-48 w-full' />
        <Skeleton className='h-32 w-full' />
      </div>
      {wide && <Skeleton className='h-80 w-full' />}
    </div>
  )
}
