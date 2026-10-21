import { AiMarkdown, parseAiMarkdown } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Code2, Copy, LayoutDashboard, Loader2, Plus, Radio } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, type Dashboard } from '@/lib/api'
import { getSocket } from '@/lib/socket'

/**
 * Ask AI answer extras (2026-10-21 program):
 *  - AddToDashboard (#2738): a chart answer becomes a dashboard widget that stores the QUERY
 *    behind it and recomputes as whoever views it;
 *  - CopyAsCode (#2766): an answer's reads as SDK / REST code, built on the server for the
 *    reader (anything they cannot see is left out);
 *  - LiveFromOthers (#2739): someone else's answer in a shared thread, as it streams, as far
 *    as the server confirmed it against this reader's access.
 */

interface TraceLike {
  tool: string
  input: Record<string, unknown>
  summary: string
}

const errorOf = (err: unknown, fallback = 'Failed') =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

// ── #2738 Add a chart answer to a dashboard ─────────────────────────────────

export interface PinSource {
  tool: 'aggregate' | 'run_custom_query'
  input: Record<string, unknown>
}

/** The first chart an answer drew, if any. */
export function answerChart(content: string) {
  for (const b of parseAiMarkdown(content)) if (b.kind === 'chart') return b.spec
  return null
}

const ok = (t: TraceLike) => !t.summary?.startsWith('error:')

/**
 * The read a chart came from: a grouped aggregate (preferring one with as many groups as the
 * chart has points), else the last saved query. Null = nothing to pin (the chart was drawn
 * from rows the model shaped by hand).
 */
export function pinSourceFor(trace: TraceLike[] | undefined, points: number): PinSource | null {
  const good = (trace ?? []).filter(ok)
  const grouped = good.filter(
    (t) =>
      t.tool === 'aggregate' &&
      typeof t.input.group_by === 'string' &&
      typeof t.input.collection === 'string'
  )
  if (grouped.length) {
    const countOf = (t: TraceLike) => Number(/(\d+) group\(s\)/.exec(t.summary)?.[1] ?? Number.NaN)
    const pick =
      [...grouped].reverse().find((t) => countOf(t) === points) ?? grouped[grouped.length - 1]
    return { tool: 'aggregate', input: pick.input }
  }
  const saved = [...good].reverse().find((t) => t.tool === 'run_custom_query')
  return saved ? { tool: 'run_custom_query', input: saved.input } : null
}

export function AddToDashboard({
  source,
  chartType,
  title,
  question
}: {
  source: PinSource
  chartType: 'bar' | 'line' | 'pie'
  title: string
  question: string
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [name, setName] = useState(title)
  useEffect(() => {
    if (open) setName(title)
  }, [open, title])
  const { data: dashboards, isLoading } = useQuery({
    queryKey: ['ask-pin-dashboards'],
    queryFn: () => api.get<{ data: Dashboard[] }>('/dashboards').then((r) => r.data.data),
    enabled: open
  })
  const pin = useMutation({
    mutationFn: async (target: { id: string } | { create: string }) => {
      const id =
        'id' in target
          ? target.id
          : (
              await api.post<{ data: Dashboard }>('/dashboards', {
                name: target.create,
                is_shared: false
              })
            ).data.data.id
      await api.post(`/dashboards/${id}/widgets`, {
        type: 'ai_query',
        title: (name.trim() || title).slice(0, 100),
        filters: { source, chart: chartType, question }
      })
      return id
    },
    onSuccess: (id) => {
      setOpen(false)
      void qc.invalidateQueries({ queryKey: ['dashboards'] })
      void qc.invalidateQueries({ queryKey: ['ask-pin-dashboards'] })
      toast.success('Added to the dashboard — it recomputes for whoever views it', {
        action: { label: 'Open', onClick: () => navigate(`/dashboards/${id}`) }
      })
    },
    onError: (err) => toast.error(errorOf(err, 'Could not add the chart'))
  })
  const q = search.trim().toLowerCase()
  const shown = (dashboards ?? []).filter((d) => !q || d.name.toLowerCase().includes(q))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-ask-pin-chart
          className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          data-tip='Keep this chart on a dashboard — it re-runs the query for each viewer'
        >
          <LayoutDashboard className='h-3 w-3' /> Add to dashboard
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80 p-0'>
        <div className='space-y-1 border-b border-slate-200 p-3 dark:border-border'>
          <label
            htmlFor='ask-pin-title'
            className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'
          >
            Widget title
          </label>
          <Input
            id='ask-pin-title'
            value={name}
            onChange={(e) => setName(e.target.value)}
            className='h-8 text-[12.5px]'
          />
        </div>
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder='Pick a dashboard…' />
          <CommandList>
            {isLoading ? (
              <div className='space-y-1.5 p-2'>
                <Skeleton className='h-6 w-full' />
                <Skeleton className='h-6 w-4/5' />
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {search.trim() ? 'No dashboard by that name.' : 'You have no dashboards yet.'}
                </CommandEmpty>
                <CommandGroup>
                  {shown.map((d) => (
                    <CommandItem
                      key={d.id}
                      value={d.id}
                      disabled={pin.isPending}
                      onSelect={() => pin.mutate({ id: d.id })}
                    >
                      <LayoutDashboard className='mr-2 h-3.5 w-3.5 text-slate-400' />
                      <span className='truncate text-[12.5px]'>{d.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            <CommandGroup>
              <CommandItem
                value='__new__'
                disabled={pin.isPending}
                onSelect={() =>
                  pin.mutate({ create: search.trim() || name.trim() || 'Ask AI charts' })
                }
              >
                <Plus className='mr-2 h-3.5 w-3.5 text-slate-400' />
                <span className='truncate text-[12.5px]'>
                  New dashboard “{search.trim() || name.trim() || 'Ask AI charts'}”
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
        <p className='flex items-center gap-1.5 border-t border-slate-200 px-3 py-2 text-[11px] text-muted-foreground dark:border-border'>
          {pin.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
          The widget keeps the query, not this answer — everyone sees it with their own access.
        </p>
      </PopoverContent>
    </Popover>
  )
}

// ── #2766 Copy an answer's query as code ────────────────────────────────────

interface Snippet {
  tool: string
  title: string
  sdk: string
  rest: string
  curl: string
  omitted: number
}

/** Admins and people with API access may copy code; asked once per session. */
export function useAnswerCodeAccess(): boolean {
  const { data } = useQuery({
    queryKey: ['ask-answer-code-access'],
    queryFn: () =>
      api
        .get<{ data: { allowed: boolean } }>('/ai/answer-code/access')
        .then((r) => r.data.data.allowed)
        .catch(() => false),
    staleTime: 5 * 60_000
  })
  return data === true
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className='relative'>
      <pre className='max-h-56 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2.5 pr-16 font-mono text-[11px] leading-relaxed text-slate-800 dark:border-border dark:bg-background dark:text-slate-200'>
        {text}
      </pre>
      <button
        type='button'
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
            () => toast.error('Copy failed — select the text instead')
          )
        }}
        aria-label={`Copy the ${label}`}
        className='absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600 hover:bg-muted dark:border-border dark:bg-card dark:text-slate-300'
      >
        {copied ? <Check className='h-3 w-3 text-emerald-600' /> : <Copy className='h-3 w-3' />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export function CopyAsCode({
  conversationId,
  messageId
}: {
  conversationId: string
  messageId: string
}) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['ask-answer-code', conversationId, messageId],
    queryFn: () =>
      api
        .get<{ data: { snippets: Snippet[]; skipped: number } }>('/ai/answer-code', {
          params: { conversation_id: conversationId, message_id: messageId }
        })
        .then((r) => r.data.data),
    enabled: open,
    retry: false
  })
  const snippets = data?.snippets ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-ask-copy-code
          className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          data-tip='The filters and aggregates this answer used, as an SDK call or REST request'
        >
          <Code2 className='h-3 w-3' /> Copy as code
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[min(560px,calc(100vw-2rem))] p-3'>
        {isLoading ? (
          <div className='space-y-2'>
            <Skeleton className='h-4 w-1/2' />
            <Skeleton className='h-24 w-full' />
          </div>
        ) : error ? (
          <p className='text-[12.5px] text-rose-600 dark:text-rose-300'>
            {errorOf(error, 'Could not build the code')}
          </p>
        ) : snippets.length === 0 ? (
          <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
            Nothing in this answer reads as an API call — it was not built from record reads,
            aggregates or saved queries
            {data?.skipped ? ', or they use data your access does not cover' : ''}.
          </p>
        ) : (
          <div className='space-y-3'>
            {snippets.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: server order
              <div key={i} className='space-y-1.5'>
                <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                  {s.title}
                </p>
                <Tabs defaultValue='sdk'>
                  <TabsList className='h-7'>
                    <TabsTrigger value='sdk' className='h-6 px-2 text-[11.5px]'>
                      SDK
                    </TabsTrigger>
                    <TabsTrigger value='rest' className='h-6 px-2 text-[11.5px]'>
                      REST
                    </TabsTrigger>
                    <TabsTrigger value='curl' className='h-6 px-2 text-[11.5px]'>
                      curl
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value='sdk' className='mt-1.5'>
                    <CopyBlock text={s.sdk} label='SDK call' />
                  </TabsContent>
                  <TabsContent value='rest' className='mt-1.5'>
                    <CopyBlock text={s.rest} label='REST request' />
                  </TabsContent>
                  <TabsContent value='curl' className='mt-1.5'>
                    <CopyBlock text={s.curl} label='curl command' />
                  </TabsContent>
                </Tabs>
                {s.omitted > 0 && (
                  <p className='text-[11px] text-amber-700 dark:text-amber-400'>
                    {s.omitted} condition{s.omitted === 1 ? '' : 's'} left out — they name data your
                    access does not cover.
                  </p>
                )}
              </div>
            ))}
            <p className='text-[11px] text-muted-foreground'>
              Runs with whatever token you give it (<span className='font-mono'>NIVARO_TOKEN</span>
              ), so the results follow that account's access.
              {data?.skipped
                ? ` ${data.skipped} read${data.skipped === 1 ? '' : 's'} left out for the same reason.`
                : ''}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── #2739 Someone else's answer, live ───────────────────────────────────────

interface LiveEvent {
  conversation_id?: string
  message_id?: string
  by?: { id: string; name: string }
  kind?: 'working' | 'step' | 'delta' | 'end'
  tool?: string
  summary?: string
  text?: string
  round?: number
  state?: string
}

export interface LiveAnswerState {
  messageId: string
  by: { id: string; name: string }
  steps: Array<{ tool: string; summary: string }>
  text: string
  round: number
}

/** The answer another participant is getting in this conversation, as it streams to us. */
export function useLiveFromOthers(
  conversationId: string | null,
  onEnd: () => void
): LiveAnswerState | null {
  const [live, setLive] = useState<LiveAnswerState | null>(null)
  const endRef = useRef(onEnd)
  endRef.current = onEnd
  useEffect(() => {
    setLive(null)
    if (!conversationId) return
    const s = getSocket()
    const handler = (p: LiveEvent) => {
      if (p.conversation_id !== conversationId || !p.message_id || !p.by) return
      const by = p.by
      const mid = p.message_id
      if (p.kind === 'end') {
        setLive((cur) => (cur?.messageId === mid ? null : cur))
        endRef.current()
        return
      }
      setLive((cur) => {
        const base: LiveAnswerState =
          cur && cur.messageId === mid ? cur : { messageId: mid, by, steps: [], text: '', round: 0 }
        if (p.kind === 'step' && p.tool)
          return { ...base, steps: [...base.steps, { tool: p.tool, summary: p.summary ?? '' }] }
        if (p.kind === 'delta' && typeof p.text === 'string') {
          // A new round's text replaces the last round's narration.
          const round = Number(p.round ?? 0)
          return round > base.round
            ? { ...base, round, text: p.text }
            : { ...base, text: base.text + p.text }
        }
        return base
      })
    }
    s.on('ai:live', handler)
    return () => {
      s.off('ai:live', handler)
    }
  }, [conversationId])
  return live
}

export function LiveFromOthers({ live }: { live: LiveAnswerState }) {
  return (
    <div className='flex justify-start' data-ask-live-other>
      <div className='max-w-[85%] rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13.5px] text-slate-800 dark:border-border dark:bg-card dark:text-slate-200'>
        <p className='mb-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
          <Radio className='h-3 w-3 text-nvr-cyan motion-safe:animate-pulse' />
          {live.by.name} asked — answering live, with their access
        </p>
        {live.steps.length > 0 && (
          <div className='mb-1.5 flex flex-wrap gap-1'>
            {live.steps.map((st, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: arrival order
                key={i}
                className='inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 dark:bg-muted dark:text-slate-300'
              >
                <Check className='h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400' />
                {st.summary || st.tool.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}
        {live.text ? (
          <AiMarkdown content={live.text} />
        ) : (
          <p className='flex items-center gap-2 text-[12.5px] text-slate-500 dark:text-slate-400'>
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
            {live.steps.length
              ? 'Putting the answer together…'
              : 'Working on it — what you may see appears here as it is confirmed against your access.'}
          </p>
        )}
      </div>
    </div>
  )
}
