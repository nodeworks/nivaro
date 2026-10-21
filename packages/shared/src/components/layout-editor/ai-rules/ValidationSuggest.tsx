import { useMutation } from '@tanstack/react-query'
import { ShieldCheck, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useLayoutEditorHost } from '../host'
import { aiFailure, aiGhostBtn, aiPrimaryBtn, aiQuiet, aiTriggerBtn } from './AiAskPopover'
import type { ValidationAnswer, ValidationRuleDraft } from './api'

/**
 * Validation suggestions (#2680): checks inferred from the SHAPES of a field's
 * stored values (patterns, ranges, lengths — computed on the server; the AI
 * sees shapes, never values), each with how many existing values it would
 * refuse. Suggest-only: Apply adds the check to the field's global writer,
 * which saves it for every form after its own confirm.
 */

export function failWords(fails: number, nonEmpty: number, capped: boolean): string {
  if (fails === 0)
    return `Every one of ${capped ? 'the newest ' : ''}${nonEmpty.toLocaleString()} values passes`
  return `${fails.toLocaleString()} of ${capped ? 'the newest ' : ''}${nonEmpty.toLocaleString()} values would fail`
}

export function ValidationSuggest({
  layoutId,
  field,
  onApply,
  disabled
}: {
  layoutId: number
  field: string
  /** Adds checks after `current` (what is stored); the global writer confirms the save. */
  onApply: (rules: ValidationRuleDraft[], current: ValidationRuleDraft[], label: string) => void
  disabled?: boolean
}) {
  const client = useNivaroClient()
  const host = useLayoutEditorHost()
  const [open, setOpen] = useState(false)
  const [applied, setApplied] = useState<Set<number>>(new Set())
  const load = useMutation({
    mutationFn: () =>
      client
        .request<{ data: ValidationAnswer }>(
          post(`/ai-design/layouts/${layoutId}/validation`, { field })
        )
        .then((r) => r.data)
  })
  if (!host.isAdmin) return null
  const data = load.data
  const nonEmpty = data ? data.checked - data.empty : 0
  const pending = data ? data.suggestions.filter((_, i) => !applied.has(i)) : []

  const applyIdx = (idx: number[]) => {
    if (!data || !idx.length) return
    const rules = idx.map((i) => data.suggestions[i].rule)
    const label =
      idx.length === 1
        ? `Check ${data.label}: ${data.suggestions[idx[0]].sentence}`
        : `Add ${idx.length} checks to ${data.label}`
    // Rules applied earlier in this popover are already in the writer's pending patch.
    const before = [...data.current, ...[...applied].map((i) => data.suggestions[i].rule)]
    onApply(rules, before, label)
    setApplied((s) => new Set([...s, ...idx]))
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v && !load.data && !load.isPending) load.mutate()
        if (!v) setApplied(new Set())
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={aiTriggerBtn}
          disabled={disabled}
          data-tip='Checks learned from the values stored today'
          data-ai-validation-trigger=''
        >
          <ShieldCheck className='h-3.5 w-3.5 text-nvr-cyan' />
          Suggest checks
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[420px] max-w-[calc(100vw-32px)] overflow-hidden p-0'
        data-ai-validation-popover=''
      >
        <div className='border-b border-slate-200 px-3 py-2.5 dark:border-border'>
          <p className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
            <ShieldCheck className='h-3.5 w-3.5 text-nvr-cyan' />
            Checks learned from stored values
          </p>
          {data && (
            <p className={cn(aiQuiet, 'mt-0.5')}>
              From {data.capped ? 'the newest ' : ''}
              {data.checked.toLocaleString()} records ({data.empty.toLocaleString()} empty).
              {data.current.length > 0 &&
                ` ${data.current.length} check${data.current.length === 1 ? '' : 's'} already set.`}
            </p>
          )}
        </div>
        <div className='max-h-[min(60vh,460px)] space-y-2 overflow-y-auto overscroll-contain px-3 py-3'>
          {load.isPending && <p className={aiQuiet}>Reading the stored values…</p>}
          {load.isError && (
            <p className='text-[12.5px] text-red-700 dark:text-red-300'>
              {aiFailure(load.error, 'Could not read the values')}
            </p>
          )}
          {data && !data.ai_configured && !data.ai_error && (
            <p className={aiQuiet}>AI is not set up here: these come from the patterns alone.</p>
          )}
          {data?.ai_error && <p className={aiQuiet}>{data.ai_error}</p>}
          {data && data.suggestions.length === 0 && (
            <p className={aiQuiet}>No check fits these values well enough to suggest.</p>
          )}
          {data && data.suggestions.length > 0 && (
            <ul className='space-y-1.5' data-ai-validation-list=''>
              {data.suggestions.map((s, i) => (
                <li
                  key={`${s.rule.type}:${String(s.rule.value ?? '')}`}
                  className='rounded-md border border-slate-200 px-2.5 py-2 dark:border-border'
                >
                  <div className='flex items-start gap-2'>
                    <div className='min-w-0 flex-1 space-y-0.5'>
                      <p className='flex items-center gap-1 break-words text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                        {s.source === 'ai' && (
                          <Sparkles
                            className='h-3 w-3 shrink-0 text-nvr-cyan'
                            aria-label='From AI'
                          />
                        )}
                        {s.sentence}
                      </p>
                      {s.rule.message && <p className={aiQuiet}>Says: “{s.rule.message}”</p>}
                      <p
                        className={cn(
                          'text-[12px]',
                          s.fails > 0
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-slate-500 dark:text-muted-foreground'
                        )}
                        data-ai-validation-fails={s.fails}
                      >
                        {failWords(s.fails, nonEmpty, data.capped)}
                      </p>
                    </div>
                    {applied.has(i) ? (
                      <span className='shrink-0 pt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                        Added
                      </span>
                    ) : (
                      <button
                        type='button'
                        className={cn(aiGhostBtn, 'shrink-0')}
                        onClick={() => applyIdx([i])}
                        data-ai-validation-apply={i}
                      >
                        Apply
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data && pending.length > 1 && (
            <div className='flex justify-end pt-1'>
              <button
                type='button'
                className={aiPrimaryBtn}
                data-ai-validation-apply-all=''
                onClick={() =>
                  applyIdx(data.suggestions.map((_, i) => i).filter((i) => !applied.has(i)))
                }
              >
                Apply all {pending.length}
              </button>
            </div>
          )}
          {applied.size > 0 && (
            <p className={aiQuiet}>
              Added to the field’s pending change: confirm it below to save.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
