import {
  AiMarkdown,
  type DrillSource,
  type LiveSource,
  type SlashCommand,
  useLiveCollection
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ExternalLink, ListTree, Loader2, Radio } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Ask AI panel parts (w2 ai-panel): starter questions per page (#1887),
 * follow-up chips (#1834), inline choice cards (#1937), the slash-command list
 * (#1884), the chart drill sheet (#1943) and live answers (#1996). Every
 * number and row here is fetched through the API as the signed-in person.
 */

export interface AskChoice {
  question: string
  options: Array<{ label: string; value: string; send: string }>
  collection?: string
  field?: string
}

// ── Starter questions ────────────────────────────────────────────────────────

const FALLBACK_STARTERS = [
  'How many records are in each collection?',
  'What changed in the last 7 days?',
  'Show the 5 most recent workflows and their states'
]

export function StarterQuestions({
  page,
  collection,
  id,
  onPick
}: {
  page: string
  collection?: string
  id?: string
  onPick: (q: string) => void
}) {
  const { data } = useQuery({
    queryKey: ['ask-starters', page, collection ?? '', id ?? ''],
    queryFn: () =>
      api
        .get<{ data: Array<{ question: string; source: string }> }>('/ai/starters', {
          params: { page, collection, id }
        })
        .then((r) => r.data.data),
    staleTime: 5 * 60_000,
    retry: false
  })
  const questions = data?.length ? data.map((s) => s.question) : FALLBACK_STARTERS
  return (
    <div className='mx-auto mt-4 flex max-w-md flex-col gap-2' data-ask-starters>
      {questions.map((s) => (
        <button
          key={s}
          type='button'
          onClick={() => onPick(s)}
          className='rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[13px] text-slate-600 transition-colors hover:border-[#00ceff] dark:border-border dark:bg-card dark:text-slate-300'
        >
          {s}
        </button>
      ))}
    </div>
  )
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

export function FollowUps({
  questions,
  onPick,
  disabled
}: {
  questions: string[]
  onPick: (q: string) => void
  disabled?: boolean
}) {
  if (!questions.length) return null
  return (
    <div
      className='mt-2 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2 dark:border-border'
      data-ask-followups
    >
      {questions.map((q) => (
        <button
          key={q}
          type='button'
          disabled={disabled}
          onClick={() => onPick(q)}
          className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] text-slate-600 transition-colors hover:border-[#00ceff] hover:text-slate-900 disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:text-slate-100'
        >
          <ArrowRight className='h-3 w-3 shrink-0 text-nvr-cyan' />
          {q}
        </button>
      ))}
    </div>
  )
}

// ── Choices ──────────────────────────────────────────────────────────────────

export function ChoiceCard({
  choice,
  onPick,
  disabled
}: {
  choice: AskChoice
  onPick: (send: string) => void
  disabled?: boolean
}) {
  return (
    <div
      className='mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 dark:border-border dark:bg-muted/40'
      data-ask-choice
    >
      <div className='mb-1.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
        {choice.question}
      </div>
      <div className='flex flex-wrap gap-1.5'>
        {choice.options.map((o) => (
          <button
            key={o.value}
            type='button'
            disabled={disabled}
            onClick={() => onPick(o.send)}
            className='rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[12px] text-slate-700 transition-colors hover:border-[#00ceff] disabled:cursor-default disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-200'
            data-ask-choice-option
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Slash commands ───────────────────────────────────────────────────────────

export function SlashMenu({
  matches,
  index,
  onPick
}: {
  matches: SlashCommand[]
  index: number
  onPick: (c: SlashCommand) => void
}) {
  if (!matches.length) return null
  return (
    <div
      className='mx-auto mb-2 w-full max-w-3xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card'
      data-ask-slash
    >
      {matches.map((c, i) => (
        <button
          key={c.name}
          type='button'
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(c)
          }}
          className={cn(
            'flex w-full items-center gap-3 px-3 py-1.5 text-left text-[12.5px]',
            i === index ? 'bg-accent' : 'hover:bg-muted'
          )}
        >
          <span className='font-mono font-medium text-slate-800 dark:text-slate-100'>
            /{c.name}
          </span>
          <span className='text-slate-500 dark:text-slate-400'>{c.hint}</span>
        </button>
      ))}
    </div>
  )
}

// ── Chart drill ──────────────────────────────────────────────────────────────

interface DrillBody {
  collection: string
  group: { value: string | null; label: string | null }
  total: number
  rows: Array<Record<string, unknown>>
  list_path: string | null
}

function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    const l = (v as { label?: unknown }).label
    return typeof l === 'string' ? l : ''
  }
  return String(v)
}

export function ChartDrillSheet({
  target,
  onClose
}: {
  target: { source: DrillSource; label: string } | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { data, isLoading, error } = useQuery({
    queryKey: ['ask-chart-drill', target?.source, target?.label],
    enabled: !!target,
    retry: false,
    queryFn: () =>
      api
        .post<{ data: DrillBody }>('/ai/chart-drill', {
          ...target?.source,
          label: target?.label
        })
        .then((r) => r.data.data)
  })
  const columns = useMemo(() => {
    const first = data?.rows[0]
    if (!first) return []
    const keys = Object.keys(first).filter((k) => !k.startsWith('_'))
    const scalar = keys.filter(
      (k) => typeof first[k] !== 'object' || first[k] == null || 'label' in (first[k] as object)
    )
    return [...scalar.filter((k) => k === 'id'), ...scalar.filter((k) => k !== 'id')].slice(0, 6)
  }, [data])
  const errMsg = (error as { response?: { data?: { error?: string } } } | null)?.response?.data
    ?.error
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side='right' className='flex w-full flex-col gap-3 sm:max-w-xl' data-ask-drill>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[15px]'>
            <ListTree className='h-4 w-4 text-nvr-cyan' />
            {target?.label}
          </SheetTitle>
          <SheetDescription className='text-[12px]'>
            {data
              ? `${data.total.toLocaleString()} ${data.collection.replace(/_/g, ' ')} behind this point — read with your access.`
              : 'Reading the rows behind this point with your access…'}
          </SheetDescription>
        </SheetHeader>
        {isLoading && (
          <div className='flex items-center gap-2 text-[13px] text-slate-400'>
            <Loader2 className='h-3.5 w-3.5 animate-spin' /> Reading…
          </div>
        )}
        {errMsg && <div className='text-[13px] text-slate-500'>{errMsg}</div>}
        {data && (
          <>
            <div className='min-h-0 flex-1 overflow-auto rounded-md border border-slate-200 dark:border-border'>
              <table className='w-full text-[12px]'>
                <thead className='sticky top-0 bg-slate-50 dark:bg-muted'>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} className='px-2 py-1.5 text-left font-medium text-slate-500'>
                        {c.replace(/_/g, ' ')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr
                      // biome-ignore lint/suspicious/noArrayIndexKey: static rows
                      key={i}
                      className='cursor-pointer border-t border-slate-100 hover:bg-muted dark:border-border'
                      onClick={() => navigate(`/collections/${data.collection}/${String(r.id)}`)}
                    >
                      {columns.map((c) => (
                        <td key={c} className='max-w-[180px] truncate px-2 py-1.5'>
                          {cellText(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.rows.length === 0 && (
                <div className='p-4 text-center text-[12.5px] text-slate-500'>No rows.</div>
              )}
            </div>
            <div className='flex items-center justify-between gap-2'>
              <span className='text-[11px] text-slate-500'>
                {data.total > data.rows.length
                  ? `First ${data.rows.length} of ${data.total.toLocaleString()}`
                  : ''}
              </span>
              <Button
                size='sm'
                disabled={!data.list_path}
                onClick={() => data.list_path && navigate(data.list_path)}
                data-tip={data.list_path ? undefined : 'Too many records to open as one list'}
                data-ask-drill-list
              >
                <ExternalLink className='mr-1 h-3.5 w-3.5' /> Open as list
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ── Live answers ─────────────────────────────────────────────────────────────

interface LiveBody {
  value?: number | null
  groups?: Array<{ key: string | null; label: string; value: number }>
  note?: string | null
  at: string
}

/**
 * A number or chart answer that keeps itself current: when the records behind
 * it change (the merged live hooks), its aggregate is re-run AS THE PERSON,
 * debounced, and the fresh figures show under the answer marked "updated …".
 * Nothing runs while the tab is hidden or once the answer is closed (unmount).
 */
export function LiveAnswer({ sources }: { sources: LiveSource[] }) {
  const [results, setResults] = useState<Array<LiveBody | null>>([])
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)
  const staleRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collections = useMemo(() => [...new Set(sources.map((s) => s.input.collection))], [sources])
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources

  const refresh = useCallback(async () => {
    staleRef.current = false
    setBusy(true)
    try {
      const out = await Promise.all(
        sourcesRef.current.map(
          (s, i) =>
            // The server throttles per person; a staggered start keeps a 3-source answer under it.
            new Promise<LiveBody | null>((resolve) =>
              setTimeout(
                () =>
                  api
                    .post<{ data: LiveBody }>('/ai/live-answer', { input: s.input })
                    .then((r) => resolve(r.data.data))
                    .catch(() => resolve(null)),
                i * 1600
              )
            )
        )
      )
      setResults(out)
    } finally {
      setBusy(false)
    }
  }, [])

  const schedule = useCallback(() => {
    if (document.visibilityState !== 'visible') {
      staleRef.current = true
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void refresh(), 1500)
  }, [refresh])

  useLiveCollection(collections, schedule, { debounceMs: 800, includeOwn: true, enabled: !paused })

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && staleRef.current && !paused) schedule()
    }
    document.addEventListener('visibilitychange', onVisible)
    const clock = setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(clock)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [schedule, paused])

  const fresh = results.filter((r): r is LiveBody => !!r)
  const latest = fresh
    .map((r) => r.at)
    .sort()
    .at(-1)
  return (
    <div
      className='mt-2 rounded-md border border-dashed border-slate-200 px-2.5 py-1.5 text-[11.5px] text-slate-500 dark:border-border dark:text-slate-400'
      data-ask-live
    >
      <div className='flex items-center gap-1.5'>
        <Radio className={cn('h-3 w-3', paused ? 'text-slate-400' : 'text-emerald-500')} />
        <span>
          {paused
            ? 'Live updates paused'
            : latest
              ? `Live · updated ${formatRelative(latest)}`
              : 'Live · refreshes when these records change'}
        </span>
        {busy && <Loader2 className='h-3 w-3 animate-spin' />}
        <button
          type='button'
          className='ml-auto underline decoration-dotted underline-offset-2 hover:text-slate-800 dark:hover:text-slate-200'
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {fresh.map((r, i) =>
        r.groups ? (
          <div key={sources[i]?.input.group_by ?? i} className='mt-1'>
            <AiMarkdown
              content={`\`\`\`chart\n${JSON.stringify({
                type: 'bar',
                title: `${sources[i]?.input.op ?? 'count'} by ${sources[i]?.input.group_by}`,
                data: r.groups.map((g) => ({ label: g.label, value: g.value }))
              })}\n\`\`\``}
              autolink={false}
            />
          </div>
        ) : (
          <div
            key={sources[i]?.input.collection ?? i}
            className='mt-0.5 text-[13px] font-medium text-slate-800 dark:text-slate-100'
          >
            {sources[i]?.input.op}({sources[i]?.input.field ?? '*'}) now:{' '}
            {r.value == null ? '—' : r.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </div>
        )
      )}
      {fresh.some((r) => r.note) && (
        <div className='mt-0.5 text-[10.5px]'>{fresh.find((r) => r.note)?.note}</div>
      )}
    </div>
  )
}
