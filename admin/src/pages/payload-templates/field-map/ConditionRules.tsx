import { ChevronDown, Plus, X } from 'lucide-react'
import type { ConditionRule } from '../api'
import { OPS, opInfo } from './labels'
import { PathPicker } from './PathPicker'
import { type ItemScope, OptionMenu, smallAction, TextField } from './ui'

// Condition rules (the shared `{field, op, value}` shape) as plain rows:
// "[Field] [is more than] [0]". All rules must pass.

export function ConditionRules({
  rules,
  onChange,
  scope,
  addLabel = 'Add a rule',
  empty
}: {
  rules: ConditionRule[]
  onChange: (rules: ConditionRule[]) => void
  scope?: ItemScope | null
  addLabel?: string
  empty?: string
}) {
  const set = (i: number, patch: Partial<ConditionRule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className='space-y-1.5'>
      {rules.length === 0 && empty && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{empty}</p>
      )}
      {rules.map((r, i) => {
        const info = opInfo(r.op)
        return (
          // Rules have no ids; position is their identity inside this small list.
          // biome-ignore lint/suspicious/noArrayIndexKey: rules carry no id
          <div key={i} className='flex items-center gap-1.5'>
            <span
              className={`w-6 shrink-0 text-[11.5px] text-slate-400 ${i === 0 ? 'invisible' : ''}`}
              aria-hidden
            >
              and
            </span>
            <PathPicker
              value={r.field}
              onChange={(field) => set(i, { field })}
              scope={scope}
              ariaLabel='Rule field'
              className='w-[42%] shrink-0'
            />
            <OptionMenu
              value={r.op}
              options={OPS.map((o) => ({ value: o.op, label: o.label }))}
              onSelect={(op) => set(i, opInfo(op)?.noValue ? { op, value: null } : { op })}
              ariaLabel='Rule test'
              width='w-[180px]'
              triggerClassName='inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-700 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
            >
              {info?.label ?? r.op}
              <ChevronDown className='h-3 w-3 text-slate-400' />
            </OptionMenu>
            {!info?.noValue && (
              <TextField
                mono
                value={r.value == null ? '' : String(r.value)}
                onChange={(v) => set(i, { value: v })}
                placeholder={r.op === 'in' ? 'a, b, c' : 'value'}
                aria-label='Rule value'
                className='flex-1'
              />
            )}
            <button
              type='button'
              aria-label='Remove rule'
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
              className='ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
        )
      })}
      <button
        type='button'
        className={`${smallAction} -ml-2`}
        onClick={() => onChange([...rules, { field: '', op: 'eq', value: '' }])}
      >
        <Plus className='h-3.5 w-3.5' />
        {addLabel}
      </button>
    </div>
  )
}
