import { AiMarkdown } from '@nivaro/shared'
import { useMutation } from '@tanstack/react-query'
import { ArrowUpRight, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { ExplainButton } from '@/components/explain-button'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { fmtMs, grafanaTraceUrl, shortId } from './links'
import { PartError, TONE } from './ui'

/**
 * Ask AI about the telemetry (#2544): POST /api/telemetry/ask runs read-only tools over the
 * request log, traces, metrics and container logs and answers with the evidence. Follow-up
 * questions carry the last few turns. Every trace the tools touched is offered below the answer
 * with Explain and Open in Grafana.
 */

interface CitedTrace {
  id: string
  route: string | null
  ms: number | null
  status: number | null
}
interface AskAnswer {
  answer: string
  traces: CitedTrace[]
  tools: Array<{ tool: string; ok: boolean }>
  model: string
}
interface Turn {
  id: string
  question: string
  answer: AskAnswer
}

const SUGGESTIONS = [
  'Anything wrong right now?',
  'Why was the API slow in the last hour?',
  'Which routes failed most today?',
  'What did the database look like at the busiest point today?'
]

const TOOL_LABEL: Record<string, string> = {
  telemetry_status: 'stack status',
  request_stats: 'request log',
  find_requests: 'requests',
  slow_traces: 'traces',
  get_trace: 'trace detail',
  metric_series: 'metrics',
  search_logs: 'container logs'
}
const label = (tool: string) => TOOL_LABEL[tool] ?? tool
const uniq = (xs: string[]) => [...new Set(xs)]

function Checked({ tools }: { tools: AskAnswer['tools'] }) {
  if (!tools.length)
    return (
      <p className={cn('m-0 mt-2 text-[11px]', TONE.warn.text)}>
        It didn’t check any data. Treat this as a guess.
      </p>
    )
  const ok = uniq(tools.filter((t) => t.ok).map((t) => label(t.tool)))
  const failed = uniq(tools.filter((t) => !t.ok).map((t) => label(t.tool)))
  return (
    <p className='m-0 mt-2 text-[11px] text-muted-foreground'>
      Checked: {ok.join(', ') || 'nothing'}
      {failed.length > 0 && (
        <span className={TONE.warn.text}> · couldn’t check: {failed.join(', ')}</span>
      )}
    </p>
  )
}

export function AskTelemetry({ grafanaUrl }: { grafanaUrl: string | null }) {
  const [question, setQuestion] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const ask = useMutation({
    mutationFn: async (q: string) => {
      const history = turns.slice(-3).flatMap((t) => [
        { role: 'user' as const, content: t.question },
        { role: 'assistant' as const, content: t.answer.answer }
      ])
      const res = await api.post<{ data: AskAnswer }>('/telemetry/ask', { question: q, history })
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        question: q,
        answer: res.data.data
      }
    },
    onSuccess: (turn) => {
      setTurns((ts) => [...ts, turn].slice(-6))
      setQuestion('')
    },
    onSettled: () => setPendingQuestion(null)
  })
  const serverErr = (ask.error as { response?: { data?: { error?: string } } } | null)?.response
    ?.data?.error

  const submit = (e?: FormEvent, q = question) => {
    e?.preventDefault()
    const text = q.trim()
    if (text.length < 3 || ask.isPending) return
    setPendingQuestion(text)
    ask.mutate(text)
  }

  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
        <Sparkles className='h-4 w-4 shrink-0 text-muted-foreground' aria-hidden='true' />
        <h2 className='m-0 shrink-0 text-[13px] font-semibold'>Ask about this instance</h2>
        <span className='hidden min-w-0 truncate text-[11.5px] text-muted-foreground sm:inline'>
          Reads the request log, traces, metrics and logs.
        </span>
        {turns.length > 0 && (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() => setTurns([])}
            disabled={ask.isPending}
            className='ml-auto h-7 px-2 text-[12px] [&_svg]:size-3.5'
          >
            <RotateCcw aria-hidden='true' />
            Start over
          </Button>
        )}
      </header>
      <div className='grid gap-3 p-4'>
        <div role='log' aria-live='polite' aria-relevant='additions' className='grid gap-3'>
          {turns.map((t) => (
            <div key={t.id} className='grid gap-2'>
              <Bubble text={t.question} />
              <div className='min-w-0 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-border'>
                <p className='m-0 mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
                  AI answer · can be wrong
                </p>
                <AiMarkdown content={t.answer.answer} className='text-[13px]' autolink={false} />
                {t.answer.traces.length > 0 && (
                  <div className='mt-3 grid gap-2 border-t border-slate-100 pt-2.5 dark:border-border'>
                    <div className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
                      Traces it looked at
                    </div>
                    {t.answer.traces.map((tr) => (
                      <TraceRow key={tr.id} trace={tr} grafanaUrl={grafanaUrl} />
                    ))}
                  </div>
                )}
                <Checked tools={t.answer.tools} />
              </div>
            </div>
          ))}
          {pendingQuestion && (
            <div className='grid gap-2'>
              <Bubble text={pendingQuestion} />
              <div
                role='status'
                className='flex items-center gap-2 rounded-lg border border-dashed border-slate-200 px-3 py-2.5 text-[12.5px] text-muted-foreground dark:border-border'
              >
                <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
                Checking the request log, traces and metrics…
              </div>
            </div>
          )}
        </div>

        {turns.length === 0 && !pendingQuestion && (
          <div className='flex flex-wrap gap-1.5'>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type='button'
                disabled={ask.isPending}
                onClick={() => submit(undefined, s)}
                className='rounded-full border border-slate-200 px-2.5 py-1 text-[12px] text-muted-foreground hover:border-nvr-cyan hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-60 dark:border-border'
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit} className='flex min-w-0 items-center gap-2'>
          <label htmlFor='telemetry-ask' className='sr-only'>
            Question about this instance
          </label>
          <input
            id='telemetry-ask'
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={1000}
            placeholder={
              turns.length ? 'Ask a follow-up…' : 'e.g. Why was it slow between 14:00 and 14:30?'
            }
            className='h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background'
          />
          <Button
            type='submit'
            size='sm'
            disabled={ask.isPending || question.trim().length < 3}
            className='h-9 shrink-0 bg-nvr-cyan text-[12.5px] text-white hover:bg-nvr-cyan/90 [&_svg]:size-3.5'
          >
            {ask.isPending && <Loader2 className='animate-spin' aria-hidden='true' />}
            {ask.isPending ? 'Looking…' : 'Ask'}
          </Button>
        </form>
        {ask.isError && (
          <div role='alert'>
            <PartError error={serverErr ?? 'Couldn’t reach the assistant. Try again.'} />
          </div>
        )}
      </div>
    </section>
  )
}

function Bubble({ text }: { text: string }) {
  return (
    <div className='max-w-[85%] justify-self-end break-words rounded-lg bg-slate-100 px-3 py-1.5 text-[12.5px] dark:bg-muted'>
      <span className='sr-only'>You asked:</span>
      {text}
    </div>
  )
}

function TraceRow({ trace, grafanaUrl }: { trace: CitedTrace; grafanaUrl: string | null }) {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const href = grafanaTraceUrl(grafanaUrl, trace.id)
  const name = trace.route ?? `trace ${shortId(trace.id)}`
  return (
    <div className='min-w-0'>
      <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]'>
        {trace.ms != null && (
          <span className='shrink-0 font-semibold tabular-nums'>{fmtMs(trace.ms)}</span>
        )}
        <span className='min-w-0 truncate font-mono'>{name}</span>
        {trace.status != null && trace.status >= 500 && (
          <span className='shrink-0 rounded bg-red-100 px-1.5 py-px text-[10.5px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-400'>
            {trace.status}
          </span>
        )}
        <span className='shrink-0 font-mono text-[11px] text-muted-foreground'>
          {shortId(trace.id)}
        </span>
        <span className='ml-auto flex shrink-0 items-center gap-1'>
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panel}
            aria-label={`${open ? 'Hide explanation for' : 'Explain'} ${name}`}
            className={cn(
              'rounded px-1.5 py-0.5 font-medium text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
              open && 'bg-nvr-cyan/10'
            )}
          >
            {open ? 'Hide' : 'Explain'}
          </button>
          {href && (
            <a
              href={href}
              target='_blank'
              rel='noopener noreferrer'
              aria-label={`Open ${name} in Grafana`}
              className='inline-flex items-center rounded px-1 py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            >
              <ArrowUpRight className='h-3.5 w-3.5' aria-hidden='true' />
            </a>
          )}
        </span>
      </div>
      {open && (
        <div id={panel} className='mt-1.5'>
          <ExplainButton kind='trace' params={{ id: trace.id }} autoRun />
        </div>
      )}
    </div>
  )
}
