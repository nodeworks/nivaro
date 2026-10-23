import { memo, useState } from 'react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Field } from '../api'
import { ConditionRules } from './ConditionRules'
import { rulesText } from './labels'
import { FmPopoverContent, Hint, type ItemScope, quietButton } from './ui'

// When a key is sent: always, only when it has a value, or only when rules pass.

type Include = Field['include']
type Mode = 'always' | 'not_empty' | 'when'

function modeOf(inc: Include): Mode {
  if (inc === 'not_empty') return 'not_empty'
  if (inc && typeof inc === 'object') return 'when'
  return 'always'
}

export function includeShort(inc: Include): string {
  const m = modeOf(inc)
  if (m === 'always') return 'Always'
  if (m === 'not_empty') return 'If it has a value'
  const rules = typeof inc === 'object' && inc ? (inc.when ?? []) : []
  return rules.length ? `When ${rulesText(rules)}` : 'When…'
}

const OPTIONS: { id: Mode; label: string; hint: string }[] = [
  { id: 'always', label: 'Always send it', hint: 'Even when the value is empty' },
  {
    id: 'not_empty',
    label: 'Only when it has a value',
    hint: 'Left out when it is null, empty text or an empty list'
  },
  { id: 'when', label: 'Only when…', hint: 'Sent when every rule below passes' }
]

function IncludeControlImpl({
  include,
  onChange,
  scope,
  className
}: {
  include: Include
  onChange: (inc: Include) => void
  scope: ItemScope | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const mode = modeOf(include)
  const when = typeof include === 'object' && include ? (include.when ?? []) : []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-include-control=''
          aria-label={`Sent: ${includeShort(include)}`}
          className={cn(
            quietButton,
            mode !== 'always' && 'text-slate-700 dark:text-slate-200',
            open && 'bg-slate-100 dark:bg-muted',
            className
          )}
        >
          <span className='min-w-0 truncate'>{includeShort(include)}</span>
        </button>
      </PopoverTrigger>
      <FmPopoverContent className='w-[400px] p-3'>
        <p className='mb-2 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          When is this key sent?
        </p>
        <div className='space-y-px'>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type='button'
              aria-pressed={mode === o.id}
              onClick={() => {
                if (o.id === mode) return
                onChange(o.id === 'when' ? { when: when.length ? when : [] } : o.id)
              }}
              className={cn(
                'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                mode === o.id ? 'bg-accent' : 'hover:bg-muted'
              )}
            >
              <span
                className={cn(
                  'mt-[3px] h-3 w-3 shrink-0 rounded-full border',
                  mode === o.id
                    ? 'border-[4px] border-nvr-cyan'
                    : 'border-slate-300 dark:border-slate-600'
                )}
                aria-hidden
              />
              <span>
                <span className='block text-[12.5px] text-slate-800 dark:text-foreground'>
                  {o.label}
                </span>
                <span className='block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  {o.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
        {mode === 'when' && (
          <div className='mt-2 border-t border-slate-100 pt-2.5 dark:border-border'>
            <ConditionRules
              rules={when}
              scope={scope}
              onChange={(rules) => onChange({ when: rules })}
              empty='No rules yet — with none, the key is always sent.'
            />
          </div>
        )}
        {mode === 'not_empty' && (
          <Hint className='mt-2'>Zero and false still count as a value.</Hint>
        )}
      </FmPopoverContent>
    </Popover>
  )
}

export const IncludeControl = memo(IncludeControlImpl)
