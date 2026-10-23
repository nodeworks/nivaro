import { userErrorMessage } from '@nivaro/shared'
import { ShieldCheck } from 'lucide-react'
import { memo, useState } from 'react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Field } from '../api'
import { rulesSummary } from './labels'
import { FmField, FmPopoverContent, Hint, NumberField, quietButton, TextField } from './ui'

// Checks run on the built body before every push. A failure stops the push and
// is recorded as a failed submission naming the key and the rule.

type Rules = NonNullable<Field['rules']>

function clean(r: Rules): Rules | undefined {
  const out: Rules = {}
  if (r.required) out.required = true
  if (r.max_length != null) out.max_length = r.max_length
  if (r.min != null) out.min = r.min
  if (r.max != null) out.max = r.max
  if (r.allowed?.length) out.allowed = r.allowed
  if (r.pattern) out.pattern = r.pattern
  return Object.keys(out).length ? out : undefined
}

/** Comma-separated allowed values; keeps the typed text (trailing comma, spaces) while typing. */
function AllowedField({
  value,
  onChange
}: {
  value: string[] | undefined
  onChange: (v: string[] | undefined) => void
}) {
  const joined = (value ?? []).join(', ')
  const [text, setText] = useState(joined)
  const [seen, setSeen] = useState(joined)
  if (joined !== seen) {
    setSeen(joined)
    const parsedText = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ')
    if (parsedText !== joined) setText(joined)
  }
  return (
    <TextField
      mono
      value={text}
      placeholder='OPEN, CLOSED'
      aria-label='Allowed values'
      onChange={(t) => {
        setText(t)
        const list = t
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        onChange(list.length ? list : undefined)
      }}
    />
  )
}

function RulesPopoverImpl({
  rules,
  type,
  onChange,
  className
}: {
  rules: Field['rules']
  type: Field['type']
  onChange: (r: Field['rules']) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const r = rules ?? {}
  const set = (patch: Partial<Rules>) => onChange(clean({ ...r, ...patch }))
  const summary = rulesSummary(rules)
  const textLike = type === 'text' || type === 'date' || type === 'json'
  let patternError = ''
  if (r.pattern) {
    try {
      new RegExp(r.pattern)
    } catch (e) {
      patternError = userErrorMessage(e, 'Not a valid pattern')
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-rules-control=''
          aria-label={summary ? `Rules: ${summary}` : 'Add rules'}
          className={cn(
            quietButton,
            summary && 'text-slate-700 dark:text-slate-200',
            open && 'bg-slate-100 dark:bg-muted',
            className
          )}
        >
          <ShieldCheck className='h-3.5 w-3.5 shrink-0 opacity-70' aria-hidden />
          <span className='min-w-0 truncate'>{summary || 'Rules'}</span>
        </button>
      </PopoverTrigger>
      <FmPopoverContent className='w-[320px] p-3'>
        <p className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          Checks before every push
        </p>
        <Hint className='mb-3'>A failure stops the push and records which rule it broke.</Hint>
        <div className='space-y-3'>
          <label className='flex items-center gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'>
            <input
              type='checkbox'
              checked={!!r.required}
              onChange={(e) => set({ required: e.target.checked || undefined })}
              className='h-3.5 w-3.5 rounded border-slate-300 accent-[#00ceff]'
            />
            Required — never send it empty
          </label>
          {textLike && (
            <FmField label='Longest it may be'>
              <div className='flex items-center gap-2'>
                <NumberField
                  value={r.max_length}
                  min={0}
                  onChange={(n) => set({ max_length: n })}
                  ariaLabel='Maximum length'
                  className='w-24'
                  placeholder='No limit'
                />
                <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  characters
                </span>
              </div>
            </FmField>
          )}
          {type === 'number' && (
            <div className='grid grid-cols-2 gap-2'>
              <FmField label='At least'>
                <NumberField value={r.min} onChange={(n) => set({ min: n })} ariaLabel='Minimum' />
              </FmField>
              <FmField label='At most'>
                <NumberField value={r.max} onChange={(n) => set({ max: n })} ariaLabel='Maximum' />
              </FmField>
              {r.min != null && r.max != null && r.min > r.max && (
                <Hint className='col-span-2 text-amber-700 dark:text-amber-300'>
                  “At least” is more than “At most” — nothing can pass.
                </Hint>
              )}
            </div>
          )}
          {type !== 'object' && type !== 'list' && (
            <FmField label='Only these values'>
              <AllowedField value={r.allowed} onChange={(allowed) => set({ allowed })} />
              <Hint className='mt-1'>Separate with commas. Leave empty for any value.</Hint>
            </FmField>
          )}
          {textLike && (
            <FmField label='Must match a pattern'>
              <TextField
                mono
                value={r.pattern ?? ''}
                onChange={(pattern) => set({ pattern: pattern || undefined })}
                placeholder='^\d{9}$'
                aria-label='Pattern'
                aria-invalid={!!patternError}
                className={patternError ? 'border-red-400 focus:border-red-500' : undefined}
              />
              {patternError ? (
                <Hint className='mt-1 text-red-600 dark:text-red-400'>
                  Not a valid pattern: {patternError}
                </Hint>
              ) : (
                <Hint className='mt-1'>
                  A regular expression, e.g. ^\d{'{9}'}$ for nine digits.
                </Hint>
              )}
            </FmField>
          )}
        </div>
      </FmPopoverContent>
    </Popover>
  )
}

export const RulesPopover = memo(RulesPopoverImpl)
