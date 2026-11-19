import { useQuery } from '@tanstack/react-query'
import { Check, Copy, MessagesSquare, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { describeError } from '../../../lib/error-message'
import { cn } from '../../../lib/utils'
import { OutcomeChip, Segmented } from '../../delivery-analytics/ui'
import { ErrorDetails } from '../../ErrorNotice'
import { QueryErrorState } from '../../QueryErrorState'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../ui/sheet'
import { Skeleton } from '../../ui/skeleton'
import { featureLabel, num, resultLabel, resultOf, secs, tok, usd, whenShort } from './format'
import { RawJson } from './RawJson'
import { ThreadView } from './ThreadView'
import { TranscriptView } from './TranscriptView'
import type { CallDetail } from './types'

/**
 * One AI call in a side drawer: what the person asked, every tool step and
 * what the model answered (readable), or the stored request and response
 * (raw, masked, on a toggle). Beside it: tokens, cost, cache and time, the
 * model and how it was routed, the request id, the other calls of the same
 * question, the thumbs. For an Ask AI call, "Open conversation" turns the
 * drawer into the whole thread. Opening a call is logged on the server.
 */

const RESULT_TONE: Record<string, string> = {
  error: 'failed',
  max_tokens: 'dropped',
  stopped: 'suppressed',
  end_turn: 'delivered',
  tool_use: 'deferred'
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type='button'
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          setDone(false)
        }
      }}
      className='inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted dark:hover:text-foreground'
    >
      {done ? <Check className='h-3 w-3' aria-hidden /> : <Copy className='h-3 w-3' aria-hidden />}
    </button>
  )
}

function Facts({
  d,
  onOpenCall,
  onOpenThread
}: {
  d: CallDetail
  onOpenCall: (id: number) => void
  onOpenThread: () => void
}) {
  const c = d.call
  const parts = c.prompt_parts?.p ?? []
  const partMax = Math.max(1, ...parts.map((p) => p[1]))
  const cells: Array<[string, string, string?]> = [
    ['Input', tok(c.input_tokens), 'Tokens sent, cached ones included'],
    ['Cached', tok(c.cache_read_tokens), 'Read from the prompt cache at a tenth of the price'],
    ['Output', tok(c.output_tokens)],
    ['Cache write', tok(c.cache_write_tokens)],
    ['Cost', usd(c.cost_usd, 4), 'At list price'],
    ['Time', secs(c.latency_ms)]
  ]
  return (
    <aside className='flex min-w-0 flex-col gap-4 text-[12px]' aria-label='About this call'>
      {d.conversation && (
        <button
          type='button'
          onClick={onOpenThread}
          data-ai-open-thread
          className='inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:bg-nvr-cyan/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 focus-visible:ring-offset-2'
        >
          <MessagesSquare className='h-4 w-4' aria-hidden /> Open conversation
        </button>
      )}
      {!d.conversation && c.feature === 'chat' && (
        <button
          type='button'
          onClick={onOpenThread}
          data-ai-open-thread
          className='inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
          data-tip='No saved thread: shows the turns the model was sent with this question'
        >
          <MessagesSquare className='h-4 w-4' aria-hidden /> Show the chat so far
        </button>
      )}
      <div className='grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        {cells.map(([label, value, tip]) => (
          <div key={label} className='bg-white px-2.5 py-2 dark:bg-card' data-tip={tip}>
            <div className='text-[10.5px] text-slate-500 dark:text-muted-foreground'>{label}</div>
            <div className='mt-0.5 font-semibold tabular-nums text-slate-900 dark:text-foreground'>
              {value}
            </div>
          </div>
        ))}
      </div>
      {parts.length > 0 && (
        <section>
          <h4 className='mb-1.5 text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
            Where the input tokens went
          </h4>
          <ul className='flex flex-col gap-1'>
            {parts.map(([name, tokens]) => (
              <li
                key={name}
                className='grid grid-cols-[110px_1fr_auto] items-center gap-2 text-[11px]'
              >
                <span className='truncate text-slate-600 dark:text-muted-foreground'>
                  {name.replace(/_/g, ' ')}
                </span>
                <span
                  className='block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
                  aria-hidden
                >
                  <span
                    className='block h-full rounded-full bg-nvr-cyan/70'
                    style={{ width: `${Math.max(2, Math.round((tokens / partMax) * 100))}%` }}
                  />
                </span>
                <span className='tabular-nums text-slate-500'>{tok(tokens)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <dl className='grid grid-cols-[88px_1fr] gap-x-2 gap-y-1.5'>
        <dt className='text-slate-500 dark:text-muted-foreground'>Model</dt>
        <dd className='min-w-0 break-words font-mono text-[11px]'>
          {c.model}
          <span className='font-sans text-slate-500'> · {c.provider}</span>
        </dd>
        {c.routing && (
          <>
            <dt className='text-slate-500 dark:text-muted-foreground'>Routing</dt>
            <dd>
              {c.routing.tier === 'cheap'
                ? `Started on the quick model (${c.routing.cheap_model})`
                : `Moved up to ${c.routing.main_model}${c.routing.reason ? ` — ${c.routing.reason.replace(/_/g, ' ')}` : ''}`}
            </dd>
          </>
        )}
        <dt className='text-slate-500 dark:text-muted-foreground'>Feature</dt>
        <dd>
          {featureLabel(c.feature)}
          {c.route && (
            <span className='block truncate font-mono text-[10.5px] text-slate-400'>{c.route}</span>
          )}
        </dd>
        {c.request_id && (
          <>
            <dt className='text-slate-500 dark:text-muted-foreground'>Request id</dt>
            <dd className='flex min-w-0 items-center gap-1'>
              <span className='truncate font-mono text-[10.5px]'>{c.request_id}</span>
              <CopyText text={c.request_id} label='request id' />
            </dd>
          </>
        )}
        <dt className='text-slate-500 dark:text-muted-foreground'>Call id</dt>
        <dd className='font-mono text-[11px]'>{c.id}</dd>
      </dl>
      {d.question_calls.length > 1 && (
        <section>
          <h4 className='mb-1 text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
            This question took {d.question_calls.length} calls
          </h4>
          <p className='mb-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
            {usd(d.question_totals.cost_usd)} · {tok(d.question_totals.tokens)} tokens ·{' '}
            {secs(d.question_totals.latency_ms)} in the model
          </p>
          <ol className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'>
            {d.question_calls.map((s, i) => (
              <li key={s.id}>
                <button
                  type='button'
                  onClick={() => onOpenCall(s.id)}
                  aria-current={s.id === c.id ? 'true' : undefined}
                  className={cn(
                    'grid w-full grid-cols-[18px_1fr_auto] items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/40',
                    s.id === c.id && 'bg-nvr-cyan/10 font-medium'
                  )}
                >
                  <span className='tabular-nums text-slate-400'>{i + 1}</span>
                  <span className='min-w-0 truncate'>
                    {resultLabel(resultOf(s))}
                    {s.tools.length ? ` · ${s.tools.join(', ')}` : ''}
                  </span>
                  <span className='tabular-nums text-slate-500'>{secs(s.latency_ms)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {d.feedback.length > 0 && (
        <section>
          <h4 className='mb-1 text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
            Feedback
          </h4>
          <ul className='flex flex-col gap-1'>
            {d.feedback.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: feedback in order
              <li key={i} className='flex items-start gap-1.5 text-[11.5px]'>
                {f.rating > 0 ? (
                  <ThumbsUp
                    className='mt-0.5 h-3 w-3 text-green-700 dark:text-[#b9d3a6]'
                    aria-label='Thumbs up'
                  />
                ) : (
                  <ThumbsDown
                    className='mt-0.5 h-3 w-3 text-red-700 dark:text-[#eaa3a3]'
                    aria-label='Thumbs down'
                  />
                )}
                <span>
                  <span className='font-medium'>{f.user_name}</span>
                  {f.comment ? ` — ${f.comment}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}

/**
 * A logged call the provider refused. The title is the plain reading of the
 * failure (describeError); the provider's own words follow as a quote, since
 * reading them is the point of the log; the reference sits in the details.
 */
function ProviderError({ text }: { text: string | null }) {
  const d = describeError(
    { message: text ?? '', status: /\b(4\d\d)\b/.exec(text ?? '')?.[1] ? 400 : 502 },
    'The AI provider did not answer this call'
  )
  return (
    <div
      role='status'
      className='rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-900 dark:border-[#e08383]/30 dark:bg-[#e08383]/10 dark:text-[#eaa3a3]'
    >
      <p className='font-semibold'>
        {/^AI gateway|provider/i.test(d.title) ? 'The AI provider refused this call' : d.title}
      </p>
      {text && (
        <p className='mt-1 break-words font-mono text-[11.5px] text-red-800 dark:text-[#eaa3a3]'>
          {text}
        </p>
      )}
      <ErrorDetails description={{ ...d, technical: undefined }} className='mt-1.5' />
    </div>
  )
}

function CallView({
  callId,
  onOpenCall,
  onOpenThread
}: {
  callId: number
  onOpenCall: (id: number) => void
  onOpenThread: () => void
}) {
  const client = useNivaroClient()
  const [mode, setMode] = useState<'readable' | 'raw'>('readable')
  const q = useQuery({
    queryKey: ['nvr-ai-call-log-detail', callId, mode === 'raw'],
    queryFn: () =>
      client.request<{ data: CallDetail }>(
        get(`/ai/call-log/${callId}`, mode === 'raw' ? { raw: '1' } : {})
      ),
    placeholderData: (prev) => (prev?.data.call.id === callId ? prev : undefined)
  })
  const d = q.data?.data
  const c = d?.call
  const question = d?.transcript.steps.find((s) => s.kind === 'question')
  const title =
    question && question.kind === 'question' && question.text
      ? question.text
      : c
        ? `${featureLabel(c.feature)} call`
        : 'Loading the call…'
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='shrink-0 border-b border-slate-200 px-5 pb-3 pt-4 pr-12 dark:border-border'>
        <SheetTitle className='line-clamp-2 text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          {title}
        </SheetTitle>
        <SheetDescription asChild>
          <div className='mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {c ? (
              <>
                <OutcomeChip outcome={RESULT_TONE[resultOf(c)] ?? 'neutral'}>
                  {resultLabel(resultOf(c))}
                </OutcomeChip>
                <span>{featureLabel(c.feature)}</span>
                <span aria-hidden>·</span>
                <span>{c.user_name ?? 'System'}</span>
                <span aria-hidden>·</span>
                <span>{whenShort(c.created_at)}</span>
                <span aria-hidden>·</span>
                <span className='tabular-nums'>
                  {usd(c.cost_usd, 4)} · {secs(c.latency_ms)}
                  {c.tool_calls
                    ? ` · ${num(c.tool_calls)} tool ${c.tool_calls === 1 ? 'call' : 'calls'}`
                    : ''}
                </span>
              </>
            ) : (
              <span>&nbsp;</span>
            )}
          </div>
        </SheetDescription>
        <div className='mt-3'>
          <Segmented
            ariaLabel='How to show the call'
            value={mode}
            onChange={setMode}
            options={[
              { value: 'readable', label: 'Readable' },
              {
                value: 'raw',
                label: 'View raw',
                tip: 'The stored request and response, system prompt and tool list included (secrets masked)'
              }
            ]}
          />
        </div>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-4 dark:bg-background sm:px-5'>
        {q.isLoading && !d ? (
          <div className='flex flex-col gap-3'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-28 w-full' />
            <Skeleton className='h-40 w-full' />
          </div>
        ) : q.isError ? (
          <QueryErrorState error={q.error} what='this call' onRetry={() => void q.refetch()} />
        ) : d && c ? (
          <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]'>
            <div className='flex min-w-0 flex-col gap-3'>
              {c.status === 'error' && <ProviderError text={c.error} />}
              {mode === 'raw' ? (
                d.raw ? (
                  <div className='flex flex-col gap-3 animate-in fade-in-0 duration-150 motion-reduce:animate-none'>
                    <RawJson
                      label='Request'
                      value={d.raw.request.value}
                      text={d.raw.request.text}
                      cut={d.raw.request.cut}
                      foldKeys={['system', 'tools']}
                    />
                    <RawJson
                      label={c.status === 'error' ? 'Error' : 'Response'}
                      value={d.raw.response.value}
                      text={d.raw.response.text}
                      cut={d.raw.response.cut}
                    />
                  </div>
                ) : (
                  <Skeleton className='h-60 w-full' />
                )
              ) : (
                <TranscriptView
                  t={d.transcript}
                  askedBy={c.user_name}
                  onShowRaw={() => setMode('raw')}
                  onNextCall={(() => {
                    const i = d.question_calls.findIndex((x) => x.id === c.id)
                    const next = i >= 0 ? d.question_calls[i + 1] : undefined
                    return next ? () => onOpenCall(next.id) : undefined
                  })()}
                />
              )}
            </div>
            <Facts d={d} onOpenCall={onOpenCall} onOpenThread={onOpenThread} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function CallDrawer({
  callId,
  threadOpen,
  onClose,
  onOpenCall,
  onThread
}: {
  callId: number | null
  threadOpen: boolean
  onClose: () => void
  onOpenCall: (id: number) => void
  onThread: (open: boolean) => void
}) {
  return (
    <Sheet open={callId != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side='right'
        aria-describedby={undefined}
        data-ai-call-drawer=''
        className='flex w-[100vw] flex-col gap-0 p-0 data-[state=closed]:duration-200 data-[state=open]:duration-300 motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none sm:max-w-[1040px] sm:w-[96vw]'
      >
        {callId != null &&
          (threadOpen ? (
            <ThreadView
              callId={callId}
              onBack={() => onThread(false)}
              onOpenCall={(id) => {
                onOpenCall(id)
              }}
            />
          ) : (
            <CallView
              key={callId}
              callId={callId}
              onOpenCall={onOpenCall}
              onOpenThread={() => onThread(true)}
            />
          ))}
      </SheetContent>
    </Sheet>
  )
}
