import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Transform } from '../api'
import { TRANSFORM_CHOICES, transformLabel } from './labels'
import { arrayMove } from './spec-ops'
import { FmField, FmPopoverContent, Hint, NumberField, OptionMenu, TextField } from './ui'

// The steps a value goes through, in order, as chips: "Trim spaces → First 30
// characters". Chips with a setting open a small editor; ⌥←/⌥→ reorder.

function hasParams(t: Transform): boolean {
  return !['trim', 'upper', 'lower', 'next_open_day', 'editor_text'].includes(t.op)
}

function ParamEditor({ t, onChange }: { t: Transform; onChange: (t: Transform) => void }) {
  switch (t.op) {
    case 'truncate':
      return (
        <FmField label='Keep the first'>
          <NumberField
            value={t.n}
            min={0}
            onChange={(n) => onChange({ ...t, n: n ?? 0 })}
            ariaLabel='Characters'
          />
          <Hint className='mt-1'>characters</Hint>
        </FmField>
      )
    case 'prefix':
    case 'suffix':
      return (
        <FmField label={t.op === 'prefix' ? 'Text before the value' : 'Text after the value'}>
          <TextField mono value={t.text} onChange={(text) => onChange({ ...t, text })} autoFocus />
        </FmField>
      )
    case 'pad_start':
      return (
        <div className='grid grid-cols-2 gap-2'>
          <FmField label='Length'>
            <NumberField
              value={t.n}
              min={0}
              onChange={(n) => onChange({ ...t, n: n ?? 0 })}
              ariaLabel='Length'
            />
          </FmField>
          <FmField label='Pad with'>
            <TextField
              mono
              value={t.char}
              maxLength={1}
              onChange={(char) => onChange({ ...t, char })}
              aria-label='Pad character'
            />
          </FmField>
          <Hint className='col-span-2'>
            Adds the character at the start until it is long enough.
          </Hint>
        </div>
      )
    case 'replace':
      return (
        <div className='grid grid-cols-2 gap-2'>
          <FmField label='Find'>
            <TextField
              mono
              value={t.from}
              onChange={(from) => onChange({ ...t, from })}
              autoFocus
            />
          </FmField>
          <FmField label='Replace with'>
            <TextField mono value={t.to} onChange={(to) => onChange({ ...t, to })} />
          </FmField>
        </div>
      )
    case 'date':
      return (
        <FmField label='Date format'>
          <TextField
            mono
            value={t.format}
            onChange={(format) => onChange({ ...t, format })}
            autoFocus
          />
          <Hint className='mt-1'>yyyy-MM-dd → 2026-10-22 · MM/dd/yyyy → 10/22/2026</Hint>
        </FmField>
      )
    case 'add_days':
    case 'at_least_days_out':
      return (
        <FmField
          label={t.op === 'add_days' ? 'Days to add (negative goes back)' : 'Days from today'}
        >
          <NumberField
            value={t.n}
            onChange={(n) => onChange({ ...t, n: n ?? 0 })}
            ariaLabel='Days'
          />
        </FmField>
      )
    case 'join':
      return (
        <FmField label='Put between items'>
          <TextField mono value={t.sep} onChange={(sep) => onChange({ ...t, sep })} autoFocus />
        </FmField>
      )
    default:
      return null
  }
}

const chipClass =
  'inline-flex h-6 max-w-full items-center rounded border border-slate-200 bg-slate-50 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'

export function TransformChips({
  transforms,
  onChange
}: {
  transforms: Transform[]
  onChange: (t: Transform[]) => void
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const set = (i: number, t: Transform) => onChange(transforms.map((x, j) => (j === i ? t : x)))
  const move = (i: number, d: -1 | 1) => {
    const to = i + d
    if (to < 0 || to >= transforms.length) return
    onChange(arrayMove(transforms, i, to))
  }
  return (
    <div className='flex flex-wrap items-center gap-1'>
      {transforms.map((t, i) => {
        const label = transformLabel(t)
        const body = <span className='min-w-0 truncate px-1.5'>{label}</span>
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: transforms carry no id; order is the identity
          <span key={i} className='inline-flex items-center gap-1'>
            {i > 0 && (
              <span className='text-[11px] text-slate-400' aria-hidden>
                →
              </span>
            )}
            <span className={chipClass}>
              {hasParams(t) ? (
                <Popover open={openIdx === i} onOpenChange={(o) => setOpenIdx(o ? i : null)}>
                  <PopoverTrigger asChild>
                    <button
                      type='button'
                      className='flex h-full min-w-0 items-center rounded-l hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted'
                      onKeyDown={(e) => {
                        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                          e.preventDefault()
                          move(i, e.key === 'ArrowLeft' ? -1 : 1)
                        }
                      }}
                      aria-label={`${label} — change`}
                    >
                      {body}
                    </button>
                  </PopoverTrigger>
                  <FmPopoverContent className='w-[240px] p-3' side='bottom'>
                    <ParamEditor t={t} onChange={(nt) => set(i, nt)} />
                  </FmPopoverContent>
                </Popover>
              ) : (
                <button
                  type='button'
                  aria-label={`${label} — ⌥← ⌥→ to reorder`}
                  className='flex h-full min-w-0 cursor-default items-center rounded-l focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                  onKeyDown={(e) => {
                    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                      e.preventDefault()
                      move(i, e.key === 'ArrowLeft' ? -1 : 1)
                    }
                  }}
                >
                  {body}
                </button>
              )}
              <button
                type='button'
                aria-label={`Remove ${label}`}
                onClick={() => onChange(transforms.filter((_, j) => j !== i))}
                className='inline-flex h-full w-5 items-center justify-center rounded-r text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted'
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          </span>
        )
      })}
      <OptionMenu
        options={TRANSFORM_CHOICES.map((c) => ({ value: c.label, label: c.label, hint: c.hint }))}
        onSelect={(labelPicked) => {
          const choice = TRANSFORM_CHOICES.find((c) => c.label === labelPicked)
          if (!choice) return
          const t = choice.make()
          onChange([...transforms, t])
          if (hasParams(t)) setOpenIdx(transforms.length)
        }}
        search='Find a step…'
        width='w-[260px]'
        ariaLabel='Add a step'
        triggerClassName={cn(
          'inline-flex h-6 items-center gap-1 rounded border border-dashed border-slate-300 px-1.5 text-[12px] text-slate-500 hover:border-slate-400 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-slate-600 dark:text-muted-foreground dark:hover:text-foreground'
        )}
      >
        <Plus className='h-3 w-3' />
        {transforms.length ? 'Then' : 'Add a step'}
      </OptionMenu>
    </div>
  )
}
