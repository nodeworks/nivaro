import { Check, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { explainProvenance, type RuleProvenance } from '../../lib/rule-provenance'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * The "auto" / "overridden" chip on a grid row editor field, opening into
 * where the value came from: the rule, the source that answered (one line,
 * the winner first), and — folded — the sources the chain checked before it.
 * A tooltip cannot carry that much and stay readable, so it is a popover.
 */
export function RuleProvenanceChip({
  kind,
  provenance,
  labelOf,
  fieldLabel,
  onReset
}: {
  kind: 'auto' | 'overridden'
  provenance: RuleProvenance | null | undefined
  labelOf?: (v: unknown) => string
  fieldLabel?: (f: string) => string
  /** Overridden only: put the rule's value back. */
  onReset?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [showTried, setShowTried] = useState(false)
  const story = provenance ? explainProvenance(provenance, { labelOf, fieldLabel }) : null
  const chip = (
    <span
      className={cn(
        'rounded px-1 py-px text-[9px] font-medium normal-case tracking-normal',
        kind === 'auto'
          ? 'bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
        story && 'cursor-pointer hover:underline decoration-dotted underline-offset-2'
      )}
      data-provenance-tip={story ? 'full' : 'basic'}
      data-tip={
        story
          ? `${kind === 'auto' ? 'Set by a rule' : 'Differs from the rule'} — click to see how`
          : kind === 'auto'
            ? 'Set automatically by a row rule'
            : 'Differs from what the row rules would set'
      }
    >
      {kind}
    </span>
  )
  if (!story) return chip
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setShowTried(false)
      }}
    >
      <PopoverTrigger asChild>
        <button type='button' data-provenance-chip-btn className='inline-flex'>
          {chip}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        sideOffset={6}
        className='w-[380px] max-w-[92vw] p-0 text-[12px]'
        data-provenance-popover
      >
        <div className='px-3.5 pt-3 pb-2.5'>
          <p className='text-[13px] font-semibold leading-snug text-slate-900 dark:text-slate-100'>
            {story.value}
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>{story.rule}</p>
        </div>
        <div className='border-t border-slate-100 px-3.5 py-2.5 dark:border-border/60'>
          <div className='flex items-start gap-2'>
            <Check
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0',
                kind === 'auto' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'
              )}
              aria-hidden
            />
            <p className='leading-snug text-slate-800 dark:text-slate-200' data-provenance-winner>
              {story.winner}
            </p>
          </div>
          {story.tried.length > 0 && (
            <div className='mt-2 pl-[22px]'>
              <button
                type='button'
                onClick={() => setShowTried((v) => !v)}
                aria-expanded={showTried}
                className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 transition-transform duration-150',
                    showTried && 'rotate-90'
                  )}
                  aria-hidden
                />
                Checked first, no answer ({story.tried.length})
              </button>
              {showTried && (
                <ol
                  className='mt-1.5 space-y-1 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'
                  data-provenance-tried
                >
                  {story.tried.map((line, i) => (
                    <li key={`${i}-${line}`} className='flex gap-2'>
                      <span
                        className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600'
                        aria-hidden
                      />
                      <span>{line}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
        {kind === 'overridden' && onReset && (
          <div className='border-t border-slate-100 px-3.5 py-2 dark:border-border/60'>
            <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              This row holds a different value than the rule would set.
            </p>
            <button
              type='button'
              onClick={() => {
                setOpen(false)
                onReset()
              }}
              className='mt-1.5 text-[11.5px] font-medium text-nvr-cyan hover:underline'
            >
              Put the rule's value back
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
