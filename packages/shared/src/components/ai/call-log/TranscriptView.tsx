import { AlertTriangle, ChevronRight, FileText, MessageSquare, Wrench } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'
import { AiMarkdown } from '../AiMarkdown'
import { num } from './format'
import type { ToolStep, Transcript } from './types'

/**
 * One call as the person and the model saw it: the earlier turns (folded),
 * the question, every tool step since (what was asked, what came back), and
 * what this call answered, rendered as the person saw it. What is left out
 * — the system prompt, tool definitions, cache markers — is counted at the
 * foot, with the raw view one click away.
 */

/** A height-animated fold (grid rows 0fr → 1fr); content stays mounted only while open. */
export function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      )}
      aria-hidden={!open}
    >
      <div className='min-h-0 overflow-hidden'>{open ? children : null}</div>
    </div>
  )
}

function ToolCard({
  step,
  index,
  onNextCall
}: {
  step: ToolStep
  index: number
  onNextCall?: () => void
}) {
  const [peek, setPeek] = useState(false)
  const r = step.result
  return (
    <li
      data-ai-tool-step={step.name}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-2 px-3 pt-2.5'>
        <Wrench className='h-3.5 w-3.5 text-slate-400' aria-hidden />
        <span className='font-mono text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
          {step.name}
        </span>
        <span className='text-[11px] text-slate-400'>step {index}</span>
        {step.from_this_call && (
          <span
            className='rounded-full border border-sky-200 bg-sky-50 px-2 py-px text-[10.5px] font-medium text-sky-800 dark:border-[#8fa6c9]/30 dark:bg-[#8fa6c9]/10 dark:text-[#b3c4dd]'
            data-tip='This call asked for the tool; its result went into the next call of the same question'
          >
            asked by this call
          </span>
        )}
      </div>
      {step.input.length > 0 && (
        <dl className='mx-3 mt-2 grid grid-cols-[minmax(80px,max-content)_1fr] gap-x-3 gap-y-0.5 text-[11.5px]'>
          {step.input.map(([k, v]) => (
            <div key={k} className='contents'>
              <dt className='text-slate-500 dark:text-muted-foreground'>{k}</dt>
              <dd className='min-w-0 break-words font-mono text-[11px] text-slate-800 dark:text-slate-200'>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className='mt-2 border-t border-slate-100 px-3 py-2 text-[12px] dark:border-border/60'>
        {r == null ? (
          <span className='text-slate-500 dark:text-muted-foreground'>
            {step.from_this_call ? (
              <>
                The result went into the next call.{' '}
                {onNextCall && (
                  <button
                    type='button'
                    onClick={onNextCall}
                    className='rounded text-nvr-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
                  >
                    Open it
                  </button>
                )}
              </>
            ) : (
              'No result was stored for this step.'
            )}
          </span>
        ) : r.error ? (
          <span className='inline-flex items-start gap-1.5 text-red-700 dark:text-[#eaa3a3]'>
            <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
            <span className='break-words'>{r.text}</span>
          </span>
        ) : (
          <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
            <span className='font-medium text-slate-800 dark:text-slate-100'>
              {r.rows != null ? `Returned ${r.text}` : 'Returned'}
            </span>
            {r.columns.length > 0 && (
              <span className='min-w-0 truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
                {r.columns.join(' · ')}
              </span>
            )}
            {r.rows == null && (
              <span className='w-full break-words text-[11.5px] text-slate-600 dark:text-slate-300'>
                {r.text}
              </span>
            )}
            {r.sample.length > 0 && (
              <button
                type='button'
                onClick={() => setPeek(!peek)}
                aria-expanded={peek}
                className='ml-auto inline-flex items-center gap-0.5 rounded text-[11px] text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 transition-transform duration-150 motion-reduce:transition-none',
                    peek && 'rotate-90'
                  )}
                  aria-hidden
                />
                {peek
                  ? 'Hide rows'
                  : r.sample.length === 1
                    ? 'Peek at the row'
                    : `Peek at ${Math.min(5, r.sample.length)} rows`}
              </button>
            )}
          </div>
        )}
        {r && r.sample.length > 0 && (
          <Fold open={peek}>
            <div className='mt-2 overflow-x-auto rounded border border-slate-100 dark:border-border/60'>
              <table className='w-full text-left text-[11px]'>
                <thead className='bg-slate-50 text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
                  <tr>
                    {r.columns.map((c) => (
                      <th key={c} className='whitespace-nowrap px-2 py-1 font-medium'>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
                  {r.sample.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed peek of stored rows
                    <tr key={i}>
                      {r.columns.map((c) => (
                        <td key={c} className='max-w-[220px] truncate px-2 py-1'>
                          {row[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Fold>
        )}
      </div>
    </li>
  )
}

export function TranscriptView({
  t,
  askedBy,
  onShowRaw,
  onNextCall
}: {
  t: Transcript
  askedBy: string | null
  onShowRaw: () => void
  /** Opens the next call of the same question (where this call's tool results went). */
  onNextCall?: () => void
}) {
  const [earlierOpen, setEarlierOpen] = useState(false)
  let toolIndex = 0
  const hiddenParts = [
    t.hidden.system_chars > 0 && `the system prompt (${num(t.hidden.system_chars)} characters)`,
    t.hidden.tool_definitions > 0 &&
      `${t.hidden.tool_definitions} tool definition${t.hidden.tool_definitions === 1 ? '' : 's'}`,
    t.hidden.cache_markers > 0 &&
      `${t.hidden.cache_markers} cache marker${t.hidden.cache_markers === 1 ? '' : 's'}`
  ].filter(Boolean) as string[]
  return (
    <div className='flex min-w-0 flex-col gap-3' data-ai-transcript>
      {t.unreadable && (
        <p className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-[#d4936a]/30 dark:bg-[#d4936a]/10 dark:text-[#e2b192]'>
          This call was logged before the readable log: its stored request ran out of room inside
          the system prompt, so the messages were not kept.{' '}
          <button type='button' onClick={onShowRaw} className='underline'>
            View raw
          </button>
        </p>
      )}
      {t.earlier.length > 0 && (
        <div className='rounded-lg border border-dashed border-slate-300 dark:border-border'>
          <button
            type='button'
            onClick={() => setEarlierOpen(!earlierOpen)}
            aria-expanded={earlierOpen}
            className='flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-[12px] text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted/40'
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none',
                earlierOpen && 'rotate-90'
              )}
              aria-hidden
            />
            Earlier in this conversation · {t.earlier.length}{' '}
            {t.earlier.length === 1 ? 'message' : 'messages'} the model was also sent
          </button>
          <Fold open={earlierOpen}>
            <ol className='flex flex-col gap-2 px-3 pb-3'>
              {t.earlier.map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: turns in their stored order
                <li key={i} className='text-[12px]'>
                  <div className='mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                    {e.role === 'user' ? (askedBy ?? 'The person') : 'Ask AI'}
                  </div>
                  {e.role === 'user' ? (
                    <p className='whitespace-pre-wrap text-slate-700 dark:text-slate-300'>
                      {e.text}
                    </p>
                  ) : (
                    <AiMarkdown
                      content={e.text}
                      className='text-[12px] text-slate-600 dark:text-slate-300'
                    />
                  )}
                </li>
              ))}
            </ol>
          </Fold>
        </div>
      )}
      {t.steps.length === 0 && !t.unreadable && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          This call carried no message from a person (a background job or a one-shot helper).
        </p>
      )}
      <ol className='flex flex-col gap-3'>
        {t.steps.map((s, i) => {
          if (s.kind === 'question')
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps in their stored order
              <li key={i} data-ai-question>
                <div className='mb-1 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  <MessageSquare className='h-3.5 w-3.5' aria-hidden />
                  {askedBy ? `${askedBy} asked` : 'Asked'}
                </div>
                <div className='rounded-lg bg-slate-100 px-3 py-2.5 text-[13px] leading-relaxed text-slate-900 dark:bg-muted dark:text-foreground'>
                  <p className='whitespace-pre-wrap break-words'>
                    {s.text || '(no words, only files)'}
                  </p>
                  {s.attachments.length > 0 && (
                    <ul className='mt-2 flex flex-wrap gap-1.5'>
                      {s.attachments.map((a, j) => (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: attachments in order
                          key={j}
                          className='inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'
                        >
                          <FileText className='h-3 w-3' aria-hidden />
                          {a.name ?? a.media_type ?? a.type}
                          {a.size_kb != null ? ` · ${num(a.size_kb)} KB` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            )
          if (s.kind === 'note')
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: steps in their stored order
                key={i}
                className='pl-1 text-[12px] italic text-slate-500 dark:text-muted-foreground'
              >
                {s.text}
              </li>
            )
          if (s.kind === 'tool') {
            toolIndex++
            // biome-ignore lint/suspicious/noArrayIndexKey: steps in their stored order
            return <ToolCard key={i} step={s} index={toolIndex} onNextCall={onNextCall} />
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps in their stored order
            <li key={i} data-ai-answer>
              <div className='mb-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
                {s.final ? 'Ask AI answered' : 'Ask AI said, then called tools'}
              </div>
              <div className='rounded-lg border border-slate-200 bg-white px-3.5 py-3 dark:border-border dark:bg-card'>
                <AiMarkdown content={s.text} className='text-[13px]' />
              </div>
            </li>
          )
        })}
      </ol>
      {(hiddenParts.length > 0 || t.cut.request || t.cut.response) && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {hiddenParts.length > 0 && <>Left out here: {hiddenParts.join(', ')}. </>}
          {(t.cut.request || t.cut.response) &&
            `The stored ${t.cut.request && t.cut.response ? 'request and response were' : t.cut.request ? 'request was' : 'response was'} cut at the log's size limit. `}
          <button
            type='button'
            onClick={onShowRaw}
            className='rounded text-nvr-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
          >
            View raw
          </button>
        </p>
      )}
    </div>
  )
}
