import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'
import { useLayoutEditorHost } from '../host'
import { parseSaveFailure } from '../useLayoutDraft'
import { type DiffSide, type LayoutDiffExplanation, useExplainLayoutDiff } from './assist-api'

/**
 * Why two forms differ, in words (#2693). `ExplainDiffView` renders an
 * explanation (the AI's summary and points when AI is set up, the exact
 * differences always, and the History notes behind them); `ExplainDiffButton`
 * asks for one. History compare uses the button on a version and the layout
 * now; Compare two forms (#2659) and Merge two forms (#2661) pass two layouts.
 */

const quiet = 'text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'

export function ExplainDiffView({ data }: { data: LayoutDiffExplanation }) {
  const [showExact, setShowExact] = useState(!data.summary)
  const [showNotes, setShowNotes] = useState(false)
  if (data.sentences.length === 0)
    return (
      <p className={quiet}>
        Nothing differs between {data.a.title} and {data.b.title}.
      </p>
    )
  return (
    <div className='space-y-2' data-explain-diff=''>
      {data.summary && (
        <p className='flex gap-1.5 text-[12.5px] leading-snug text-slate-800 dark:text-foreground'>
          <Sparkles className='mt-0.5 h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
          <span>{data.summary}</span>
        </p>
      )}
      {data.points.length > 0 && (
        <ul className='list-disc space-y-0.5 pl-5 text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
          {data.points.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered sentences, may repeat
            <li key={`${i}:${p}`}>{p}</li>
          ))}
        </ul>
      )}
      {data.ai_error && <p className={quiet}>{data.ai_error}</p>}
      {data.summary && (
        <button
          type='button'
          onClick={() => setShowExact((v) => !v)}
          className='text-[11.5px] text-slate-500 underline dark:text-muted-foreground'
        >
          {showExact
            ? 'Hide the exact differences'
            : `Show the ${data.sentences.length} exact differences`}
        </button>
      )}
      {showExact && (
        <ul className='space-y-0.5 text-[12px] leading-snug text-slate-700 dark:text-foreground'>
          {data.sentences.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered sentences, may repeat
            <li key={`${i}:${s}`}>{s}</li>
          ))}
        </ul>
      )}
      {data.notes.length > 0 && (
        <>
          <button
            type='button'
            onClick={() => setShowNotes((v) => !v)}
            className='block text-[11.5px] text-slate-500 underline dark:text-muted-foreground'
          >
            {showNotes ? 'Hide History notes' : `History notes (${data.notes.length})`}
          </button>
          {showNotes && (
            <ul className='space-y-0.5 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
              {data.notes.map((n) => (
                <li key={`${n.layout_id}:${n.version}`}>
                  v{n.version} · {n.note}
                  {n.times ? ` (${n.times} saves)` : ''}
                  {n.at ? ` · ${new Date(n.at).toLocaleDateString()}` : ''}
                  {n.by ? ` · ${n.by}` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

export function ExplainDiffButton({
  a,
  b,
  label = 'Explain in words',
  className
}: {
  a: DiffSide
  b: DiffSide
  label?: string
  className?: string
}) {
  const host = useLayoutEditorHost()
  const explain = useExplainLayoutDiff()
  if (!host.isAdmin) return null
  const sameAsLast =
    explain.variables &&
    JSON.stringify([explain.variables.a, explain.variables.b]) === JSON.stringify([a, b])
  return (
    <div className={cn('space-y-2', className)}>
      {!(explain.data && sameAsLast) && (
        <button
          type='button'
          data-explain-diff-button=''
          disabled={explain.isPending}
          onClick={() => explain.mutate({ a, b })}
          className='inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-60 dark:border-border dark:hover:bg-muted'
        >
          <Sparkles className='h-3 w-3 text-nvr-cyan' />
          {explain.isPending ? 'Explaining…' : label}
        </button>
      )}
      {explain.isError && (
        <p className='text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>
          {parseSaveFailure(explain.error, 'Could not explain the differences').message}
        </p>
      )}
      {explain.data && sameAsLast && <ExplainDiffView data={explain.data} />}
    </div>
  )
}
